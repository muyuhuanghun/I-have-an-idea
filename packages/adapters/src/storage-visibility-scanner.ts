import { decodeObjectStoreKeyV1 } from "@ekd/core";
import { Buffer } from "node:buffer";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const VISIBILITY_SCAN_SCHEMA_VERSION = "storage-visibility-scan-v1";

/** ADR-0016 §4: the only marker families ACC-32/33 may plant. */
export const VISIBILITY_MARKER_PREFIXES: readonly string[] = Object.freeze([
  "FILENAME_MARK_",
  "CONTENT_MARK_",
  "PATH_MARK_"
]);

/** ADR-0016 §4: filename extensions that must never appear in an ObjectStore entry name. */
export const VISIBILITY_FORBIDDEN_EXTENSIONS: readonly string[] = Object.freeze([
  ".md",
  ".markdown",
  ".canvas",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg"
]);

const textEncoder = new TextEncoder();

/** ADR-0016 §4: content-type magics checked at byte offset 0 of each store entry. */
export const VISIBILITY_FORBIDDEN_FILE_MAGICS: ReadonlyArray<{ readonly label: string; readonly bytes: Uint8Array }> =
  Object.freeze([
    { label: "pdf", bytes: textEncoder.encode("%PDF") },
    { label: "png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    { label: "jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
    { label: "gif", bytes: textEncoder.encode("GIF8") },
    { label: "riff", bytes: textEncoder.encode("RIFF") },
    { label: "zip", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) }
  ]);

const KEY_LENGTH = 22;
const TMP_SUFFIX = ".tmp";
const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const HEX_PATTERN = /^[0-9a-f]+$/iu;
const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const SAFE_SECRET_LABEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/u;
const MAX_FINDINGS = 10_000;

export type VisibilityScanSurface = "store" | "log";

export type VisibilityMarkerFamily = "filename" | "content" | "path";

export type VisibilityScanFindingKind =
  | "marker"
  | "known_secret"
  | "filename_shape"
  | "extension_token"
  | "magic_bytes";

export interface VisibilityScanFinding {
  readonly surface: VisibilityScanSurface;
  readonly kind: VisibilityScanFindingKind;
  /** Canonical key/tmp name for store findings; never contains an invalid or plaintext-bearing filename. */
  readonly entry?: string;
  /** Marker family, safe secret label, extension, or magic label. Never a marker instance or secret value. */
  readonly pattern: string;
  /** Representation used for a known-secret match. */
  readonly encoding?: "raw" | "hex";
  /** Byte offset of the match within the entry name, entry bytes, or log bytes. */
  readonly offset: number;
}

export interface VisibilityScanKnownSecret {
  readonly label: string;
  /** Hex encoding of the secret byte string; matched case-insensitively and never echoed. */
  readonly hex: string;
}

export interface VisibilityScanControl {
  readonly bytes: Uint8Array;
  readonly plantedMarkers: number;
}

export interface VisibilityScanInput {
  readonly storeRoot: string;
  readonly logBytes: Uint8Array;
  readonly markers: readonly string[];
  readonly knownSecrets: readonly VisibilityScanKnownSecret[];
  readonly control: VisibilityScanControl;
}

export interface StorageVisibilityScanReportV1 {
  readonly schema_version: typeof VISIBILITY_SCAN_SCHEMA_VERSION;
  readonly verdict: "pass" | "fail";
  readonly scanner_error?: string;
  readonly entries_total: number;
  readonly entries_by_kind: { readonly key: number; readonly tmp: number; readonly violation: number };
  readonly total_bytes: number;
  readonly allowed_metadata: ReadonlyArray<{
    readonly name: string;
    readonly size_bytes: number;
    readonly mtime_ms: number;
  }>;
  readonly forbidden_findings: readonly VisibilityScanFinding[];
  readonly findings_truncated: boolean;
  readonly forbidden_counts: { readonly store: number; readonly log: number };
  readonly scanner_selftest: {
    readonly control_markers_planted: number;
    readonly control_markers_found: number;
    readonly marker_results: ReadonlyArray<{
      readonly marker_id: string;
      readonly family: VisibilityMarkerFamily;
      readonly occurrences: number;
    }>;
    readonly pass: boolean;
  };
  readonly inputs: {
    readonly marker_count: number;
    readonly marker_families_covered: readonly VisibilityMarkerFamily[];
    readonly known_secret_labels: readonly string[];
    readonly log_bytes_scanned: number;
  };
}

interface ScanNeedles {
  readonly markers: ReadonlyArray<{
    readonly markerId: string;
    readonly family: VisibilityMarkerFamily;
    readonly lower: Buffer;
  }>;
  readonly secrets: ReadonlyArray<{
    readonly label: string;
    readonly raw: Buffer;
    readonly hexLower: Buffer;
  }>;
}

interface FindingSink {
  readonly findings: VisibilityScanFinding[];
  readonly truncated: { value: boolean };
}

type EntryKind = "key" | "tmp" | "violation";

function makeFinding(
  surface: VisibilityScanSurface,
  kind: VisibilityScanFindingKind,
  entry: string | undefined,
  pattern: string,
  offset: number,
  encoding?: "raw" | "hex"
): VisibilityScanFinding {
  const base = entry === undefined ? { surface, kind, pattern, offset } : { surface, kind, entry, pattern, offset };
  return encoding === undefined ? base : { ...base, encoding };
}

/** ADR-0016 §4: ASCII-only case folding; non-text ciphertext bytes stay byte-for-byte unchanged. */
function lowercaseAsciiBytes(bytes: Uint8Array): Buffer {
  const lowered = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(0);
  const copy = Buffer.from(lowered);
  for (let index = 0; index < copy.length; index += 1) {
    const value = copy[index];
    if (value !== undefined && value >= 0x41 && value <= 0x5a) copy[index] = value + 0x20;
  }
  return copy;
}

function lowercaseText(text: string): Buffer {
  return lowercaseAsciiBytes(textEncoder.encode(text));
}

function markerFamily(marker: string): VisibilityMarkerFamily | undefined {
  if (marker.startsWith("FILENAME_MARK_")) return "filename";
  if (marker.startsWith("CONTENT_MARK_")) return "content";
  if (marker.startsWith("PATH_MARK_")) return "path";
  return undefined;
}

/** Rejects a CLI report path that would lexically modify the store after a successful scan. */
export function isVisibilityReportOutputOutsideStoreV1(storeRoot: string, outputPath: string): boolean {
  const relativeOutput = relative(resolve(storeRoot), resolve(outputPath));
  return (
    relativeOutput !== "" &&
    (relativeOutput === ".." || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput))
  );
}

/** Resolves the output parent so a junction/symlink alias cannot redirect a new report into the store. */
export async function isVisibilityReportOutputResolvedOutsideStoreV1(
  storeRoot: string,
  outputPath: string
): Promise<boolean> {
  if (!isVisibilityReportOutputOutsideStoreV1(storeRoot, outputPath)) return false;
  const [resolvedStore, resolvedOutputParent] = await Promise.all([realpath(storeRoot), realpath(dirname(outputPath))]);
  return isVisibilityReportOutputOutsideStoreV1(resolvedStore, join(resolvedOutputParent, basename(outputPath)));
}

function collectOffsets(haystack: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  if (needle.byteLength === 0) return offsets;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return offsets;
    offsets.push(at);
    from = at + 1;
  }
}

function pushFinding(sink: FindingSink, finding: VisibilityScanFinding): boolean {
  if (sink.findings.length >= MAX_FINDINGS) {
    sink.truncated.value = true;
    return false;
  }
  sink.findings.push(finding);
  return true;
}

/** ADR-0016 §3: the only entry names a Directory ObjectStore may contain. */
function classifyEntryName(name: string): EntryKind {
  const candidate = name.endsWith(TMP_SUFFIX) ? name.slice(0, name.length - TMP_SUFFIX.length) : name;
  if (candidate.length !== KEY_LENGTH || !KEY_PATTERN.test(candidate)) return "violation";
  try {
    decodeObjectStoreKeyV1(candidate);
  } catch {
    return "violation";
  }
  return candidate === name ? "key" : "tmp";
}

function collectContentFindings(
  bytes: Uint8Array,
  surface: VisibilityScanSurface,
  entry: string | undefined,
  needles: ScanNeedles,
  checkMagic: boolean,
  sink: FindingSink
): void {
  const rawHaystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const loweredHaystack = lowercaseAsciiBytes(bytes);
  for (const marker of needles.markers) {
    for (const offset of collectOffsets(loweredHaystack, marker.lower)) {
      if (!pushFinding(sink, makeFinding(surface, "marker", entry, marker.family, offset))) return;
    }
  }
  for (const secret of needles.secrets) {
    for (const offset of collectOffsets(rawHaystack, secret.raw)) {
      if (!pushFinding(sink, makeFinding(surface, "known_secret", entry, secret.label, offset, "raw"))) return;
    }
    for (const offset of collectOffsets(loweredHaystack, secret.hexLower)) {
      if (!pushFinding(sink, makeFinding(surface, "known_secret", entry, secret.label, offset, "hex"))) return;
    }
  }
  if (!checkMagic) return;
  for (const magic of VISIBILITY_FORBIDDEN_FILE_MAGICS) {
    const prefix = lowercaseAsciiBytes(magic.bytes);
    if (loweredHaystack.length >= prefix.length && loweredHaystack.subarray(0, prefix.length).equals(prefix)) {
      if (!pushFinding(sink, makeFinding(surface, "magic_bytes", entry, magic.label, 0))) return;
    }
  }
}

function validateScanInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return "Scan input is missing.";
  const candidate = input as Partial<VisibilityScanInput>;
  if (typeof candidate.storeRoot !== "string" || candidate.storeRoot.length === 0) {
    return "Store root path is missing.";
  }
  if (!(candidate.logBytes instanceof Uint8Array)) {
    return "Process log bytes are missing; a run without captured logs must be rescanned with its log.";
  }
  if (!Array.isArray(candidate.markers) || candidate.markers.length < VISIBILITY_MARKER_PREFIXES.length) {
    return "At least one marker instance from each frozen family is required.";
  }
  const normalizedMarkers: string[] = [];
  const coveredFamilies = new Set<VisibilityMarkerFamily>();
  for (const marker of candidate.markers) {
    if (typeof marker !== "string" || !ASCII_PATTERN.test(marker)) {
      return "Markers must be non-empty ASCII strings.";
    }
    const family = markerFamily(marker);
    const prefix = VISIBILITY_MARKER_PREFIXES.find((value) => marker.startsWith(value));
    if (family === undefined || prefix === undefined) {
      return "Markers must start with one of the frozen ADR-0016 marker prefixes.";
    }
    if (marker.length === prefix.length) return "Marker instances must include a non-empty suffix after the frozen prefix.";
    normalizedMarkers.push(marker.toLowerCase());
    coveredFamilies.add(family);
  }
  if (coveredFamilies.size !== VISIBILITY_MARKER_PREFIXES.length) {
    return "Markers must cover filename, content, and path families.";
  }
  if (new Set(normalizedMarkers).size !== normalizedMarkers.length) {
    return "Marker instances must be unique under ASCII case folding.";
  }
  for (let left = 0; left < normalizedMarkers.length; left += 1) {
    for (let right = 0; right < normalizedMarkers.length; right += 1) {
      if (left !== right && normalizedMarkers[right]?.includes(normalizedMarkers[left] ?? "")) {
        return "Marker instances must not be substrings of one another.";
      }
    }
  }
  if (!Array.isArray(candidate.knownSecrets) || candidate.knownSecrets.length === 0) {
    return "At least one known 32-byte secret is required.";
  }
  const secretLabels = new Set<string>();
  for (const secret of candidate.knownSecrets) {
    if (typeof secret.label !== "string" || !SAFE_SECRET_LABEL_PATTERN.test(secret.label)) {
      return "Known-secret labels must use the safe lowercase label vocabulary.";
    }
    if (secretLabels.has(secret.label)) return "Known-secret labels must be unique.";
    secretLabels.add(secret.label);
    if (typeof secret.hex !== "string" || !HEX_PATTERN.test(secret.hex) || secret.hex.length !== 64) {
      return "Each known secret must be exactly 32 bytes encoded as 64 hexadecimal characters.";
    }
  }
  if (
    candidate.control === undefined ||
    !(candidate.control.bytes instanceof Uint8Array) ||
    !Number.isInteger(candidate.control.plantedMarkers) ||
    candidate.control.plantedMarkers !== candidate.markers.length
  ) {
    return "Control artifact bytes are required and plantedMarkers must equal the configured marker count.";
  }
  return undefined;
}

function markerSelftestResults(
  bytes: Uint8Array,
  needles: ScanNeedles
): Array<{ marker_id: string; family: VisibilityMarkerFamily; occurrences: number }> {
  const haystack = lowercaseAsciiBytes(bytes);
  return needles.markers.map((marker) => ({
    marker_id: marker.markerId,
    family: marker.family,
    occurrences: collectOffsets(haystack, marker.lower).length
  }));
}

interface StoreStats {
  readonly entriesTotal: number;
  readonly byKind: { key: number; tmp: number; violation: number };
  totalBytes: number;
  readonly allowedMetadata: Array<{ name: string; size_bytes: number; mtime_ms: number }>;
}

/** ADR-0016 §3/§4: enumerate entries without following reparse points; read key/tmp regular files only. */
async function scanStoreEntries(
  storeRoot: string,
  needles: ScanNeedles,
  sink: FindingSink
): Promise<StoreStats | string> {
  let rootStats: Stats;
  try {
    rootStats = await lstat(storeRoot);
  } catch {
    return "Store root is unavailable.";
  }
  if (rootStats.isSymbolicLink()) return "Store root is a reparse point.";
  if (!rootStats.isDirectory()) return "Store root is not a directory.";

  let dirents: Dirent[];
  try {
    dirents = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return "Store entries could not be listed.";
  }
  dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const stats: StoreStats = {
    entriesTotal: dirents.length,
    byKind: { key: 0, tmp: 0, violation: 0 },
    totalBytes: 0,
    allowedMetadata: []
  };

  for (const dirent of dirents) {
    const name = dirent.name;
    const kind = classifyEntryName(name);
    if (kind === "violation") {
      stats.byKind.violation += 1;
      if (
        !pushFinding(sink, {
          surface: "store",
          kind: "filename_shape",
          pattern: "entry_name_outside_store_vocabulary",
          offset: 0
        })
      ) {
        return stats;
      }
      const encodedName = textEncoder.encode(name);
      collectContentFindings(encodedName, "store", undefined, needles, false, sink);
      const loweredName = lowercaseAsciiBytes(encodedName);
      for (const extension of VISIBILITY_FORBIDDEN_EXTENSIONS) {
        for (const at of collectOffsets(loweredName, lowercaseText(extension))) {
          if (
            !pushFinding(sink, {
              surface: "store",
              kind: "extension_token",
              pattern: extension,
              offset: at
            })
          ) {
            return stats;
          }
        }
      }
      continue;
    }

    let entryStats: Stats;
    try {
      entryStats = await lstat(join(storeRoot, name));
    } catch {
      return "Store entry state could not be inspected.";
    }
    if (!entryStats.isFile()) {
      stats.byKind.violation += 1;
      if (
        !pushFinding(sink, {
          surface: "store",
          kind: "filename_shape",
          entry: name,
          pattern: "entry_is_not_a_regular_file",
          offset: 0
        })
      ) {
        return stats;
      }
      continue;
    }

    stats.byKind[kind] += 1;
    stats.totalBytes += entryStats.size;
    stats.allowedMetadata.push({
      name,
      size_bytes: entryStats.size,
      mtime_ms: Math.round(entryStats.mtimeMs)
    });

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(storeRoot, name)));
    } catch {
      return "Store entry could not be read.";
    }
    collectContentFindings(bytes, "store", name, needles, true, sink);
    if (sink.truncated.value) return stats;
  }
  return stats;
}

/**
 * ADR-0016 storage visibility scan v1: whitelists the Directory ObjectStore vocabulary, scans
 * store bytes and process-log bytes for frozen markers, known secrets, extensions, and content
 * magics, and self-tests marker detection against a control artifact before any verdict.
 */
export async function scanStorageVisibilityV1(input: VisibilityScanInput): Promise<StorageVisibilityScanReportV1> {
  const candidate = (input ?? {}) as Partial<VisibilityScanInput>;
  const findings: VisibilityScanFinding[] = [];
  const sink: FindingSink = { findings, truncated: { value: false } };

  let scannerError = validateScanInput(input);
  const inputWasValid = scannerError === undefined;
  const selftestPlanted = Number.isInteger(candidate.control?.plantedMarkers)
    ? (candidate.control?.plantedMarkers ?? 0)
    : 0;
  let selftestFound = 0;
  let markerResults: Array<{ marker_id: string; family: VisibilityMarkerFamily; occurrences: number }> = [];
  let storeStats: StoreStats = {
    entriesTotal: 0,
    byKind: { key: 0, tmp: 0, violation: 0 },
    totalBytes: 0,
    allowedMetadata: []
  };

  if (scannerError === undefined) {
    const needles: ScanNeedles = {
      markers: input.markers.map((pattern, index) => ({
        markerId: `marker-${String(index + 1).padStart(3, "0")}`,
        family: markerFamily(pattern) as VisibilityMarkerFamily,
        lower: lowercaseText(pattern)
      })),
      secrets: input.knownSecrets.map((secret) => ({
        label: secret.label,
        raw: Buffer.from(secret.hex, "hex"),
        hexLower: lowercaseText(secret.hex)
      }))
    };
    markerResults = markerSelftestResults(input.control.bytes, needles);
    selftestFound = markerResults.reduce((total, result) => total + result.occurrences, 0);

    try {
      const result = await scanStoreEntries(input.storeRoot, needles, sink);
      if (typeof result === "string") {
        scannerError = result;
      } else {
        storeStats = result;
        collectContentFindings(input.logBytes, "log", undefined, needles, false, sink);
      }
    } finally {
      for (const secret of needles.secrets) {
        secret.raw.fill(0);
        secret.hexLower.fill(0);
      }
    }
  }

  const selftestPass =
    inputWasValid &&
    selftestFound === selftestPlanted &&
    markerResults.length === selftestPlanted &&
    markerResults.every((result) => result.occurrences === 1);
  const verdict =
    scannerError !== undefined || findings.length > 0 || !selftestPass ? ("fail" as const) : ("pass" as const);
  const forbiddenCounts = findings.reduce(
    (counts, finding) => {
      counts[finding.surface] += 1;
      return counts;
    },
    { store: 0, log: 0 }
  );
  const safeSecretLabels = Array.isArray(candidate.knownSecrets)
    ? candidate.knownSecrets
        .map((secret) => secret?.label)
        .filter((label): label is string => typeof label === "string" && SAFE_SECRET_LABEL_PATTERN.test(label))
    : [];
  const coveredFamilies = Array.isArray(candidate.markers)
    ? [...new Set(candidate.markers.map((marker) => (typeof marker === "string" ? markerFamily(marker) : undefined)))].filter(
        (family): family is VisibilityMarkerFamily => family !== undefined
      )
    : [];

  const report: StorageVisibilityScanReportV1 = {
    schema_version: VISIBILITY_SCAN_SCHEMA_VERSION,
    verdict,
    entries_total: storeStats.entriesTotal,
    entries_by_kind: storeStats.byKind,
    total_bytes: storeStats.totalBytes,
    allowed_metadata: storeStats.allowedMetadata,
    forbidden_findings: findings,
    findings_truncated: sink.truncated.value,
    forbidden_counts: forbiddenCounts,
    scanner_selftest: {
      control_markers_planted: selftestPlanted,
      control_markers_found: selftestFound,
      marker_results: markerResults,
      pass: selftestPass
    },
    inputs: {
      marker_count: Array.isArray(candidate.markers) ? candidate.markers.length : 0,
      marker_families_covered: coveredFamilies,
      known_secret_labels: safeSecretLabels,
      log_bytes_scanned: candidate.logBytes instanceof Uint8Array && scannerError === undefined ? candidate.logBytes.byteLength : 0
    }
  };
  if (scannerError !== undefined) {
    return { ...report, verdict, scanner_error: scannerError };
  }
  return report;
}
