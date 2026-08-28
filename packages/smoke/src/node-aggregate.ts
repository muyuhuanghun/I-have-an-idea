import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { base64UrlToBytes, bytesToHex, sha256Hex, utf8Bytes } from "./bytes.js";
import { SmokeAggregateError } from "./errors.js";
import { deriveAggregate } from "./runner.js";
import { loadSmokeSchemaValidator } from "./node-schema.js";
import { REQUIRED_VECTOR_COUNTS } from "./vectors.js";
import type {
  AggregateSourceInput,
  EnvironmentId,
  SmokeAggregate,
  SmokeReport,
  VectorResult
} from "./types.js";
import type { SmokeSchemaValidator } from "./schema.js";

export interface NodeAggregateOptions {
  readonly root_dir: string;
  readonly reports: readonly AggregateSourceInput[];
  readonly expected?: {
    readonly candidate?: string;
    readonly suite_id?: number;
    readonly git_commit?: string;
    readonly vector_manifest_sha256?: string;
    readonly vectors_sha256?: string;
    readonly lockfile_sha256?: string;
  };
  readonly schema_validator?: SmokeSchemaValidator;
}

type EnvironmentVerdict = "pass" | "fail" | "incomplete" | "invalid";

const ENVIRONMENTS: readonly EnvironmentId[] = ["windows-node-cli", "windows-obsidian", "android-obsidian"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function within(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getEnvironmentId(value: unknown): EnvironmentId | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = getString(value, "id");
  return ENVIRONMENTS.includes(id as EnvironmentId) ? id as EnvironmentId : undefined;
}

function shallowEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactCounts(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== Object.keys(REQUIRED_VECTOR_COUNTS).sort().join(",")) {
    return false;
  }
  return Object.entries(REQUIRED_VECTOR_COUNTS).every(([key, expected]) => value[key] === expected);
}

function vectorResultsValid(results: readonly VectorResult[]): boolean {
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const result of results) {
    if (ids.has(result.vector_id)) {
      return false;
    }
    ids.add(result.vector_id);
    if (result.required) {
      counts.set(result.category, (counts.get(result.category) ?? 0) + 1);
    }
  }
  for (const [key, expected] of Object.entries(REQUIRED_VECTOR_COUNTS)) {
    if ((counts.get(key.replaceAll("_", "-")) ?? 0) !== expected) {
      return false;
    }
  }
  return results.filter((result) => result.required).length === 14;
}

function reportCoreShapeValid(report: SmokeReport, expected: NodeAggregateOptions["expected"]): boolean {
  if (report.test_vectors.vector_count !== 14 || !exactCounts(report.required_vector_counts) || !vectorResultsValid(report.vector_results)) {
    return false;
  }
  if (report.environment.source_commit !== report.git_commit || report.environment.bundle_sha256 !== report.candidate.bundle_sha256) {
    return false;
  }
  const sourceTreeState = report.environment_manifest.items.find((item) => item.key === "source_tree_state")?.value;
  if (sourceTreeState !== "clean") {
    return false;
  }
  const itemsHash = sha256Hex(utf8Bytes(JSON.stringify(report.environment_manifest.items)));
  if (itemsHash !== report.environment_manifest.items_sha256) {
    return false;
  }
  if (expected?.candidate !== undefined && report.candidate.name !== expected.candidate) {
    return false;
  }
  if (expected?.suite_id !== undefined && report.algorithm_suite.suite_id !== expected.suite_id) {
    return false;
  }
  if (expected?.git_commit !== undefined && report.git_commit !== expected.git_commit) {
    return false;
  }
  if (expected?.vector_manifest_sha256 !== undefined && report.test_vectors.manifest_sha256 !== expected.vector_manifest_sha256) {
    return false;
  }
  if (expected?.vectors_sha256 !== undefined && report.test_vectors.vectors_sha256 !== expected.vectors_sha256) {
    return false;
  }
  if (expected?.lockfile_sha256 !== undefined && report.environment.lockfile_sha256 !== expected.lockfile_sha256) {
    return false;
  }
  const recomputed = deriveAggregate(report.vector_results, report.process);
  return shallowEqual(recomputed, report.aggregate);
}

function derToP1363(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) {
    return signature;
  }
  let offset = 0;
  if (signature[offset++] !== 0x30) {
    throw new TypeError("ECDSA signature is not DER encoded.");
  }
  const sequenceLength = derLength(signature, offset);
  offset = sequenceLength.offset;
  if (sequenceLength.length !== signature.length - offset) {
    throw new TypeError("ECDSA DER sequence has trailing bytes.");
  }
  const r = derInteger(signature, offset);
  offset = r.offset;
  const s = derInteger(signature, offset);
  if (s.offset !== signature.length) {
    throw new TypeError("ECDSA DER signature has trailing bytes.");
  }
  const result = new Uint8Array(64);
  copyInteger(r.value, result, 0);
  copyInteger(s.value, result, 32);
  return result;
}

function derLength(bytes: Uint8Array, offset: number): { readonly length: number; readonly offset: number } {
  const first = bytes[offset];
  if (first === undefined) {
    throw new TypeError("Truncated DER length.");
  }
  if (first < 0x80) {
    return { length: first, offset: offset + 1 };
  }
  const octets = first & 0x7f;
  if (octets === 0 || octets > 2 || offset + 1 + octets > bytes.length) {
    throw new TypeError("Invalid DER length.");
  }
  let length = 0;
  for (let index = 0; index < octets; index += 1) {
    length = length * 256 + bytes[offset + 1 + index]!;
  }
  return { length, offset: offset + 1 + octets };
}

function derInteger(bytes: Uint8Array, offset: number): { readonly value: Uint8Array; readonly offset: number } {
  if (bytes[offset++] !== 0x02) {
    throw new TypeError("ECDSA DER integer is missing.");
  }
  const length = derLength(bytes, offset);
  const end = length.offset + length.length;
  if (end > bytes.length || length.length === 0) {
    throw new TypeError("Truncated ECDSA DER integer.");
  }
  return { value: bytes.slice(length.offset, end), offset: end };
}

function copyInteger(value: Uint8Array, output: Uint8Array, offset: number): void {
  let start = 0;
  while (start < value.length - 32 && value[start] === 0) {
    start += 1;
  }
  if (value.length - start > 32) {
    throw new TypeError("ECDSA integer is larger than P-256.");
  }
  output.set(value.slice(start), offset + 32 - (value.length - start));
}

async function verifyDeviceBinding(report: SmokeReport): Promise<boolean> {
  if (report.environment.id !== "android-obsidian" || report.device_binding === null) {
    return false;
  }
  const binding = report.device_binding;
  if (!binding.verified || binding.signature_algorithm !== "ECDSA-P256-SHA256" || binding.run_id !== report.run_id || binding.vector_manifest_sha256 !== report.test_vectors.manifest_sha256 || binding.plugin_bundle_sha256 !== report.environment.bundle_sha256) {
    return false;
  }
  const publicKeyValue = report.environment_manifest.items.find((item) => item.key === "device_public_key_spki_base64url")?.value;
  if (publicKeyValue === undefined) {
    return false;
  }
  try {
    const publicKey = base64UrlToBytes(publicKeyValue);
    if (bytesToHex(publicKey).length === 0 || sha256Hex(publicKey) !== binding.public_key_fingerprint) {
      return false;
    }
    const signature = derToP1363(base64UrlToBytes(binding.device_signature_base64url));
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
      return false;
    }
    const key = await subtle.importKey("spki", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const payload = utf8Bytes(`${binding.run_id}\n${binding.vector_manifest_sha256}\n${binding.plugin_bundle_sha256}`);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, payload);
  } catch {
    return false;
  }
}

interface LoadedSource {
  readonly input: AggregateSourceInput;
  readonly path: string;
  readonly sha256: string;
  readonly report: unknown;
  readonly schemaValid: boolean;
  readonly environmentId: EnvironmentId | undefined;
}

async function loadSource(root: string, input: AggregateSourceInput, validator: SmokeSchemaValidator): Promise<LoadedSource> {
  const target = resolve(root, input.path);
  if (!within(root, target)) {
    throw new SmokeAggregateError(`Source report path escapes root_dir: ${input.path}`);
  }
  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = await realpath(root);
    targetReal = await realpath(target);
  } catch {
    throw new SmokeAggregateError(`Source report path does not resolve inside root_dir: ${input.path}`);
  }
  if (!within(rootReal, targetReal)) {
    throw new SmokeAggregateError(`Source report symlink escapes root_dir: ${input.path}`);
  }
  const bytes = new Uint8Array(await readFile(targetReal));
  const sha256 = sha256Hex(bytes);
  if (input.sha256 !== undefined && input.sha256 !== sha256) {
    throw new SmokeAggregateError(`Source report hash mismatch: ${input.path}`);
  }
  let report: unknown;
  try {
    report = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    report = null;
  }
  const validation = validator.validateSmokeReport(report);
  return { input, path: input.path, sha256, report, schemaValid: validation.valid, environmentId: input.environment_id ?? getEnvironmentId(isRecord(report) ? report.environment : undefined) };
}

async function rawArtifactsValid(root: string, report: SmokeReport): Promise<boolean> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return false;
  }
  for (const artifact of report.raw_artifacts) {
    const target = resolve(root, artifact.path);
    if (!within(root, target)) {
      return false;
    }
    try {
      const targetReal = await realpath(target);
      if (!within(rootReal, targetReal)) {
        return false;
      }
      const bytes = new Uint8Array(await readFile(targetReal));
      if (sha256Hex(bytes) !== artifact.sha256) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function initialVerdicts(): Record<EnvironmentId, EnvironmentVerdict> {
  return { "windows-node-cli": "invalid", "windows-obsidian": "invalid", "android-obsidian": "invalid" };
}

/** Read, validate, bind, and reduce exactly three source reports without writing artifacts. */
export async function aggregateSmokeReports(options: NodeAggregateOptions): Promise<SmokeAggregate> {
  if (options.reports.length !== 3) {
    throw new SmokeAggregateError("Exactly three source reports are required.");
  }
  const validator = options.schema_validator ?? loadSmokeSchemaValidator();
  const root = resolve(options.root_dir);
  const loaded = await Promise.all(options.reports.map((input) => loadSource(root, input, validator)));
  const environmentVerdicts = initialVerdicts();
  const seen = new Set<EnvironmentId>();
  const validReports: { readonly id: EnvironmentId; readonly report: SmokeReport }[] = [];
  for (const source of loaded) {
    const id = source.environmentId;
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (!source.schemaValid || !isRecord(source.report)) {
      continue;
    }
    const report = source.report as unknown as SmokeReport;
    if (!reportCoreShapeValid(report, options.expected)) {
      continue;
    }
    if (!(await rawArtifactsValid(root, report))) {
      continue;
    }
    if (id === "android-obsidian" && !(await verifyDeviceBinding(report))) {
      continue;
    }
    environmentVerdicts[id] = report.aggregate.verdict;
    validReports.push({ id, report });
  }

  let bindingValid = seen.size === 3 && ENVIRONMENTS.every((id) => seen.has(id)) && validReports.length === 3;
  if (bindingValid) {
    const first = validReports[0]!.report;
    bindingValid = validReports.every(({ report }) =>
      report.candidate.name === first.candidate.name &&
      report.candidate.version === first.candidate.version &&
      report.candidate.package_integrity === first.candidate.package_integrity &&
      shallowEqual(report.algorithm_suite, first.algorithm_suite) &&
      report.git_commit === first.git_commit &&
      report.environment.lockfile_sha256 === first.environment.lockfile_sha256 &&
      report.test_vectors.manifest_sha256 === first.test_vectors.manifest_sha256 &&
      report.test_vectors.vectors_sha256 === first.test_vectors.vectors_sha256 &&
      report.test_vectors.vector_count === first.test_vectors.vector_count
    );
  }

  let crossEnvVerdict: SmokeAggregate["cross_env_verdict"];
  if (!bindingValid || Object.values(environmentVerdicts).includes("invalid")) {
    crossEnvVerdict = "cross_env_invalid";
  } else if (Object.values(environmentVerdicts).includes("fail")) {
    crossEnvVerdict = "cross_env_fail";
  } else if (Object.values(environmentVerdicts).includes("incomplete")) {
    crossEnvVerdict = "cross_env_incomplete";
  } else {
    crossEnvVerdict = "cross_env_pass";
  }

  const firstReport = validReports[0]?.report;
  const aggregate: SmokeAggregate = {
    schema_version: "smoke-aggregate-v1",
    candidate: firstReport?.candidate.name ?? options.expected?.candidate ?? "invalid",
    suite_id: firstReport?.algorithm_suite.suite_id ?? options.expected?.suite_id ?? 0,
    source_reports: loaded.map((source) => ({
      environment_id: source.environmentId ?? "windows-node-cli",
      path: source.path,
      sha256: source.sha256,
      schema_valid: source.schemaValid
    })),
    environment_verdicts: environmentVerdicts,
    cross_env_verdict: crossEnvVerdict
  };
  const validation = validator.validateSmokeAggregate(aggregate);
  if (!validation.valid) {
    throw new SmokeAggregateError("Derived smoke aggregate does not satisfy smoke-aggregate-v1.");
  }
  return aggregate;
}
