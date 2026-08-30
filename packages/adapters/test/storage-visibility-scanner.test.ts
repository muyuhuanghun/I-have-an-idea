import {
  encodeObjectStoreKeyV1,
  generateObjectIdV1,
  sealFileObjectV1,
  type RandomSource
} from "@ekd/core";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebCryptoAes256Provider } from "../../crypto/src/webcrypto.js";
import {
  DirectoryObjectStoreV1,
  isVisibilityReportOutputOutsideStoreV1,
  isVisibilityReportOutputResolvedOutsideStoreV1,
  scanStorageVisibilityV1
} from "../src/index.js";

const textEncoder = new TextEncoder();
const provider = new WebCryptoAes256Provider();
const randomSource: RandomSource = provider;

const MARKERS = ["FILENAME_MARK_alpha", "CONTENT_MARK_beta", "PATH_MARK_gamma"] as const;
const SECRETS = [
  { label: "recovery-root", hex: "aa".repeat(32) },
  { label: "manifest-key", hex: "bb".repeat(32) },
  { label: "object-wrap-key", hex: "33".repeat(32) }
] as const;
const CLEAN_LOG = "seed: 3 objects published\nseed: scan-ready\n";
const CLEAN_LOG_BYTES = textEncoder.encode(CLEAN_LOG);
const TMP_KEY = encodeObjectStoreKeyV1(Uint8Array.from({ length: 16 }, (_value, index) => index));

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

async function makeStoreRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "ekd-visibility-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function controlInput(): { bytes: Uint8Array; plantedMarkers: number } {
  return { bytes: textEncoder.encode(MARKERS.join(" ")), plantedMarkers: MARKERS.length };
}

function scanInput(storeRoot: string, overrides: Partial<Parameters<typeof scanStorageVisibilityV1>[0]> = {}) {
  return {
    storeRoot,
    logBytes: CLEAN_LOG_BYTES,
    markers: [...MARKERS],
    knownSecrets: SECRETS.map((secret) => ({ ...secret })),
    control: controlInput(),
    ...overrides
  };
}

/** Seeds one sealed object whose plaintext embeds the given text; returns the store key. */
async function seedObject(store: DirectoryObjectStoreV1, plaintext: string): Promise<string> {
  const objectId = generateObjectIdV1(randomSource);
  const key = encodeObjectStoreKeyV1(objectId);
  const sealed = await sealFileObjectV1(
    {
      domainId: filled(32, 0x11),
      objectId,
      snapshotId: filled(32, 0x22),
      objectWrapKey: filled(32, 0x33),
      plaintext: textEncoder.encode(plaintext)
    },
    { cryptoProvider: provider, randomSource }
  );
  await store.put(key, sealed.envelope);
  return key;
}

async function seedMarkerStore(storeRoot: string): Promise<void> {
  const store = new DirectoryObjectStoreV1(storeRoot);
  await seedObject(store, "note body with CONTENT_MARK_beta inside");
  await seedObject(store, "filename metadata FILENAME_MARK_alpha for audit");
  await seedObject(store, "source path PATH_MARK_gamma recorded");
}

describe("storage visibility scanner self-test", () => {
  it("passes the self-test only when the control artifact reproduces every planted marker", async () => {
    const storeRoot = await makeStoreRoot();
    const clean = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(clean.scanner_selftest).toEqual({
      control_markers_planted: 3,
      control_markers_found: 3,
      marker_results: [
        { marker_id: "marker-001", family: "filename", occurrences: 1 },
        { marker_id: "marker-002", family: "content", occurrences: 1 },
        { marker_id: "marker-003", family: "path", occurrences: 1 }
      ],
      pass: true
    });

    const blind = await scanStorageVisibilityV1(
      scanInput(storeRoot, { control: { bytes: textEncoder.encode("FILENAME_MARK_alpha only"), plantedMarkers: 3 } })
    );
    expect(blind.scanner_selftest).toEqual({
      control_markers_planted: 3,
      control_markers_found: 1,
      marker_results: [
        { marker_id: "marker-001", family: "filename", occurrences: 1 },
        { marker_id: "marker-002", family: "content", occurrences: 0 },
        { marker_id: "marker-003", family: "path", occurrences: 0 }
      ],
      pass: false
    });
    expect(blind.verdict).toBe("fail");
  });

  it("rejects total-count substitution and incomplete marker-family coverage", async () => {
    const storeRoot = await makeStoreRoot();
    const substituted = await scanStorageVisibilityV1(
      scanInput(storeRoot, {
        control: {
          bytes: textEncoder.encode("FILENAME_MARK_alpha FILENAME_MARK_alpha PATH_MARK_gamma"),
          plantedMarkers: 3
        }
      })
    );
    expect(substituted.scanner_selftest.control_markers_found).toBe(3);
    expect(substituted.scanner_selftest.marker_results.map((result) => result.occurrences)).toEqual([2, 0, 1]);
    expect(substituted.scanner_selftest.pass).toBe(false);
    expect(substituted.verdict).toBe("fail");

    const missingFamily = await scanStorageVisibilityV1(
      scanInput(storeRoot, {
        markers: ["FILENAME_MARK_alpha", "CONTENT_MARK_beta", "CONTENT_MARK_delta"],
        control: {
          bytes: textEncoder.encode("FILENAME_MARK_alpha CONTENT_MARK_beta CONTENT_MARK_delta"),
          plantedMarkers: 3
        }
      })
    );
    expect(missingFamily.verdict).toBe("fail");
    expect(missingFamily.scanner_error).toContain("filename, content, and path");
  });

  it("fails closed on markers outside the frozen prefixes and on zero planted markers", async () => {
    const storeRoot = await makeStoreRoot();
    const rogue = await scanStorageVisibilityV1(
      scanInput(storeRoot, {
        markers: ["SECRET_MARK_x", "CONTENT_MARK_beta", "PATH_MARK_gamma"],
        control: { bytes: textEncoder.encode("SECRET_MARK_x CONTENT_MARK_beta PATH_MARK_gamma"), plantedMarkers: 3 }
      })
    );
    expect(rogue.verdict).toBe("fail");
    expect(rogue.scanner_error).toContain("frozen ADR-0016 marker prefixes");

    const vacuous = await scanStorageVisibilityV1(
      scanInput(storeRoot, { control: { bytes: textEncoder.encode("irrelevant"), plantedMarkers: 0 } })
    );
    expect(vacuous.verdict).toBe("fail");
    expect(vacuous.scanner_error).toContain("plantedMarkers");
  });
});

describe("storage visibility scanner store surface", () => {
  it("reports a seeded store with sealed marker-bearing plaintexts as pass", async () => {
    const storeRoot = await makeStoreRoot();
    await seedMarkerStore(storeRoot);

    const report = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(report.schema_version).toBe("storage-visibility-scan-v1");
    expect(report.verdict).toBe("pass");
    expect(report.entries_by_kind).toEqual({ key: 3, tmp: 0, violation: 0 });
    expect(report.total_bytes).toBeGreaterThan(0);
    expect(report.allowed_metadata).toHaveLength(3);
    expect(report.forbidden_findings).toEqual([]);
    expect(report.findings_truncated).toBe(false);
    expect(report.forbidden_counts).toEqual({ store: 0, log: 0 });
    expect(report.scanner_error).toBeUndefined();
    expect(report.inputs).toEqual({
      marker_count: 3,
      marker_families_covered: ["filename", "content", "path"],
      known_secret_labels: SECRETS.map((secret) => secret.label),
      log_bytes_scanned: CLEAN_LOG_BYTES.byteLength
    });
    const serialized = JSON.stringify(report);
    for (const marker of MARKERS) expect(serialized).not.toContain(marker);
  });

  it("detects plaintext content published under a valid key without echoing context", async () => {
    const storeRoot = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(storeRoot);
    await seedObject(store, "sealed body without markers");
    const leaked = encodeObjectStoreKeyV1(generateObjectIdV1(randomSource));
    await store.put(leaked, textEncoder.encode("ctx-alpha-7f3 CONTENT_MARK_beta ctx-tail-9k2"));

    const report = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(report.verdict).toBe("fail");
    expect(report.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "marker",
      entry: leaked,
      pattern: "content",
      offset: expect.any(Number)
    });
    expect(JSON.stringify(report)).not.toContain("ctx-alpha-7f3");
    expect(JSON.stringify(report)).not.toContain("ctx-tail-9k2");
    expect(JSON.stringify(report)).not.toContain("CONTENT_MARK_beta");
  });

  it("detects content-type magics at offset zero of a store entry", async () => {
    const storeRoot = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(storeRoot);
    const key = await seedObject(store, "harmless sealed body");
    await writeFile(join(storeRoot, `${TMP_KEY}.tmp`), textEncoder.encode("%PDF-1.4\nnot really"));

    const report = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(report.verdict).toBe("fail");
    expect(report.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "magic_bytes",
      entry: `${TMP_KEY}.tmp`,
      pattern: "pdf",
      offset: 0
    });
    expect(JSON.stringify(report)).not.toContain("FILENAME_MARK_alpha");
    expect(report.entries_by_kind).toEqual({ key: 1, tmp: 1, violation: 0 });
    expect(key.length).toBe(22);
  });

  it("flags entry names outside the store vocabulary and extension tokens", async () => {
    const storeRoot = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(storeRoot);
    await seedObject(store, "sealed body without markers");
    await writeFile(join(storeRoot, "notes.md"), "unused contents are not read");

    const report = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(report.verdict).toBe("fail");
    expect(report.entries_by_kind.violation).toBe(1);
    const shapes = report.forbidden_findings.filter((finding) => finding.kind === "filename_shape");
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ surface: "store", pattern: "entry_name_outside_store_vocabulary" });
    expect(report.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "extension_token",
      pattern: ".md",
      offset: 5
    });
    expect(JSON.stringify(report)).not.toContain("unused contents");
    expect(JSON.stringify(report)).not.toContain("notes.md");
  });

  it("detects markers planted in entry names and counts tmp entries both ways", async () => {
    const storeRoot = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(storeRoot);
    await seedObject(store, "sealed body without markers");
    await writeFile(join(storeRoot, `${TMP_KEY}.tmp`), textEncoder.encode("staged ciphertext bytes"));
    await writeFile(join(storeRoot, "FILENAME_MARK_alpha"), textEncoder.encode("leaky name"));

    const report = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(report.verdict).toBe("fail");
    expect(report.entries_by_kind).toEqual({ key: 1, tmp: 1, violation: 1 });
    expect(report.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "marker",
      pattern: "filename",
      offset: 0
    });
    expect(report.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "filename_shape",
      pattern: "entry_name_outside_store_vocabulary",
      offset: 0
    });
  });

  it("treats a marker-bearing tmp file and malformed tmp names as failures", async () => {
    const storeRoot = await makeStoreRoot();
    await writeFile(join(storeRoot, `${TMP_KEY}.tmp`), textEncoder.encode("clean staging"));
    const cleanTmp = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(cleanTmp.verdict).toBe("pass");
    expect(cleanTmp.entries_by_kind).toEqual({ key: 0, tmp: 1, violation: 0 });

    await writeFile(join(storeRoot, `${TMP_KEY}.tmp`), textEncoder.encode("staged PATH_MARK_gamma bytes"));
    await writeFile(join(storeRoot, `${TMP_KEY}.tmp.txt`), textEncoder.encode("malformed staging"));
    const leaky = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(leaky.verdict).toBe("fail");
    expect(leaky.entries_by_kind).toEqual({ key: 0, tmp: 1, violation: 1 });
    expect(leaky.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "marker",
      entry: `${TMP_KEY}.tmp`,
      pattern: "path",
      offset: expect.any(Number)
    });
  });

  it("flags directories inside the store without descending into them", async () => {
    const storeRoot = await makeStoreRoot();
    await mkdir(join(storeRoot, "nested"));
    const report = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(report.verdict).toBe("fail");
    expect(report.entries_by_kind.violation).toBe(1);
    expect(report.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "filename_shape",
      pattern: "entry_name_outside_store_vocabulary",
      offset: 0
    });
  });

  it("detects known secret bytes inside store files", async () => {
    const storeRoot = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(storeRoot);
    await seedObject(store, "sealed body");
    const leaked = encodeObjectStoreKeyV1(generateObjectIdV1(randomSource));
    await writeFile(join(storeRoot, leaked), textEncoder.encode(`wrap material ${"bb".repeat(32)} end`));

    const report = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(report.verdict).toBe("fail");
    expect(report.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "known_secret",
      entry: leaked,
      pattern: "manifest-key",
      encoding: "hex",
      offset: expect.any(Number)
    });
  });

  it("detects raw secret bytes without writing the secret value into the report", async () => {
    const storeRoot = await makeStoreRoot();
    const leaked = encodeObjectStoreKeyV1(generateObjectIdV1(randomSource));
    await writeFile(join(storeRoot, leaked), Buffer.from(SECRETS[0].hex, "hex"));

    const report = await scanStorageVisibilityV1(scanInput(storeRoot));
    expect(report.verdict).toBe("fail");
    expect(report.forbidden_findings).toContainEqual({
      surface: "store",
      kind: "known_secret",
      entry: leaked,
      pattern: "recovery-root",
      encoding: "raw",
      offset: 0
    });
    expect(JSON.stringify(report)).not.toContain(SECRETS[0].hex);
  });
});

describe("storage visibility scanner log surface", () => {
  it("detects known secrets in logs without echoing the secret value", async () => {
    const storeRoot = await makeStoreRoot();
    const leakedLog = `recoveryRoot=${"AA".repeat(32)}\n${CLEAN_LOG}`;
    const report = await scanStorageVisibilityV1(scanInput(storeRoot, { logBytes: textEncoder.encode(leakedLog) }));
    expect(report.verdict).toBe("fail");
    expect(report.forbidden_findings).toEqual([
      { surface: "log", kind: "known_secret", pattern: "recovery-root", encoding: "hex", offset: 13 }
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("aa".repeat(32));
    expect(serialized).not.toContain("AA".repeat(32));
  });

  it("detects markers in logs and reports byte offsets", async () => {
    const storeRoot = await makeStoreRoot();
    const leakedLog = `seed: resolved path PATH_MARK_gamma for staging\n${CLEAN_LOG}`;
    const report = await scanStorageVisibilityV1(scanInput(storeRoot, { logBytes: textEncoder.encode(leakedLog) }));
    expect(report.verdict).toBe("fail");
    expect(report.forbidden_findings).toEqual([
      {
        surface: "log",
        kind: "marker",
        pattern: "path",
        offset: Buffer.byteLength("seed: resolved path ", "utf8")
      }
    ]);
  });
});

describe("storage visibility scanner fail-closed behavior", () => {
  it("rejects report output paths inside the ObjectStore root", async () => {
    const storeRoot = await makeStoreRoot();
    expect(isVisibilityReportOutputOutsideStoreV1(storeRoot, join(storeRoot, "report.json"))).toBe(false);
    expect(isVisibilityReportOutputOutsideStoreV1(storeRoot, storeRoot)).toBe(false);
    expect(isVisibilityReportOutputOutsideStoreV1(storeRoot, join(storeRoot, "..", "report.json"))).toBe(true);
  });

  it("rejects a report output parent that resolves through a reparse point into the store", async () => {
    const storeRoot = await makeStoreRoot();
    const aliasRoot = await makeStoreRoot();
    const alias = join(aliasRoot, "store-alias");
    try {
      await symlink(storeRoot, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    expect(await isVisibilityReportOutputResolvedOutsideStoreV1(storeRoot, join(alias, "report.json"))).toBe(false);
  });

  it("fails closed when the store root is missing or not a directory", async () => {
    const missing = await scanStorageVisibilityV1(scanInput(join(await makeStoreRoot(), "does-not-exist")));
    expect(missing.verdict).toBe("fail");
    expect(missing.scanner_error).toBe("Store root is unavailable.");
    expect(missing.entries_total).toBe(0);

    const filePath = join(await makeStoreRoot(), "plain-file");
    await writeFile(filePath, "not a directory");
    const notDirectory = await scanStorageVisibilityV1(scanInput(filePath));
    expect(notDirectory.verdict).toBe("fail");
    expect(notDirectory.scanner_error).toBe("Store root is not a directory.");
  });

  it("fails closed without throwing when log bytes or the control artifact are missing", async () => {
    const storeRoot = await makeStoreRoot();
    const input = scanInput(storeRoot);
    const broken = { ...input, logBytes: undefined } as unknown as Parameters<typeof scanStorageVisibilityV1>[0];
    const report = await scanStorageVisibilityV1(broken);
    expect(report.verdict).toBe("fail");
    expect(report.scanner_error).toContain("log");

    const missingControl = { ...input, control: undefined } as unknown as Parameters<typeof scanStorageVisibilityV1>[0];
    const controlReport = await scanStorageVisibilityV1(missingControl);
    expect(controlReport.verdict).toBe("fail");
    expect(controlReport.scanner_error).toContain("Control artifact");
  });

  it("rejects unsafe or duplicate known-secret labels without echoing them", async () => {
    const storeRoot = await makeStoreRoot();
    const unsafeLabel = "CONTENT_MARK_label-leak";
    const unsafe = await scanStorageVisibilityV1(
      scanInput(storeRoot, { knownSecrets: [{ label: unsafeLabel, hex: "aa".repeat(32) }] })
    );
    expect(unsafe.verdict).toBe("fail");
    expect(unsafe.scanner_error).toContain("safe lowercase label vocabulary");
    expect(JSON.stringify(unsafe)).not.toContain(unsafeLabel);

    const duplicate = await scanStorageVisibilityV1(
      scanInput(storeRoot, {
        knownSecrets: [
          { label: "recovery-root", hex: "aa".repeat(32) },
          { label: "recovery-root", hex: "bb".repeat(32) }
        ]
      })
    );
    expect(duplicate.verdict).toBe("fail");
    expect(duplicate.scanner_error).toContain("unique");
  });
});
