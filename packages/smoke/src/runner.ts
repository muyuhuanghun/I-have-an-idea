import type { AeadResult, Bytes, CryptoProvider, RandomSource } from "@ekd/core";
import { allZero, bytesEqual, concatBytes, hexToBytes, sha256Hex, utf8Bytes } from "./bytes.js";
import { REQUIRED_VECTOR_COUNTS } from "./vectors.js";
import { SmokeContractError } from "./errors.js";
import type {
  AeadKatVector,
  AeadTamperVector,
  AggregateCounts,
  AlgorithmSuiteMetadata,
  HkdfIsolationVector,
  HkdfKatVector,
  LoadedVectorSet,
  ProcessInfo,
  RandomRoundtripVector,
  RandomSourceErrorsVector,
  RequiredVector,
  SmokeExecutionOptions,
  SmokeReport,
  SmokeReportContext,
  VectorResult,
  VectorRun,
  WrapBadMaterialVector,
  WrapKatVector
} from "./types.js";

class RandomSourceCheckError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RandomSourceCheckError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (isRecord(error) && typeof error.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)) {
    return error.code;
  }
  return fallback;
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array.`);
  }
  return value;
}

function mutate(value: Uint8Array, index: number, xor: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index >= value.length) {
    throw new RangeError("Vector mutation index is outside the byte sequence.");
  }
  const result = value.slice();
  result[index] = result[index]! ^ xor;
  return result;
}

function randomBytes(source: RandomSource, length: number, rejectAllZero: boolean): Uint8Array {
  let value: Bytes;
  try {
    value = source.randomBytes(length);
  } catch (error) {
    const code = safeErrorCode(error, "RANDOM_SOURCE_FAILED");
    throw new RandomSourceCheckError(code === "RANDOM_SOURCE_SHORT_READ" || code === "RANDOM_SOURCE_ALL_ZERO" ? code : "RANDOM_SOURCE_FAILED");
  }
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RandomSourceCheckError("RANDOM_SOURCE_SHORT_READ");
  }
  if (rejectAllZero && allZero(value)) {
    throw new RandomSourceCheckError("RANDOM_SOURCE_ALL_ZERO");
  }
  return value.slice();
}

function expectedHash(value: Uint8Array): string {
  return sha256Hex(value);
}

function resultBase(vector: RequiredVector, started: number): Omit<VectorResult, "status" | "expected_sha256" | "actual_sha256" | "actual_error_code"> {
  return {
    vector_id: vector.vector_id,
    category: vector.category,
    required: vector.required,
    expected_error_codes: "expected_error_codes" in vector ? vector.expected_error_codes : [],
    duration_ms: Math.max(0, now() - started),
    peak_rss_bytes: 0
  };
}

function completeResult(
  vector: RequiredVector,
  started: number,
  status: VectorResult["status"],
  expectedSha256: string | null,
  actualSha256: string | null,
  actualErrorCode: string | null
): VectorResult {
  return {
    ...resultBase(vector, started),
    status,
    expected_sha256: expectedSha256,
    actual_sha256: actualSha256,
    actual_error_code: actualErrorCode,
    duration_ms: Math.max(0, now() - started),
    peak_rss_bytes: 0
  };
}

function isExpectedError(error: unknown, expectedCodes: readonly string[], fallback: string): string | null {
  const code = safeErrorCode(error, fallback);
  return expectedCodes.includes(code) ? code : null;
}

async function runAeadKat(provider: CryptoProvider, vector: AeadKatVector, started: number): Promise<VectorResult> {
  const expectedCiphertext = hexToBytes(vector.ciphertext_hex);
  const expectedTag = hexToBytes(vector.tag_hex);
  const expected = expectedHash(concatBytes(expectedCiphertext, expectedTag));
  try {
    const encrypted: AeadResult = await provider.aeadEncrypt(
      hexToBytes(vector.key_hex),
      hexToBytes(vector.nonce_hex),
      hexToBytes(vector.plaintext_hex),
      hexToBytes(vector.aad_hex)
    );
    const actualCiphertext = bytes(encrypted.ciphertext, "AEAD ciphertext");
    const actualTag = bytes(encrypted.tag, "AEAD tag");
    const actual = expectedHash(concatBytes(actualCiphertext, actualTag));
    return completeResult(vector, started, bytesEqual(actualCiphertext, expectedCiphertext) && bytesEqual(actualTag, expectedTag) ? "passed" : "failed", expected, actual, null);
  } catch (error) {
    return completeResult(vector, started, "error", expected, null, safeErrorCode(error, "OBJECT_AEAD_FAILED"));
  }
}

async function runAeadTamper(provider: CryptoProvider, vector: AeadTamperVector, vectorSet: LoadedVectorSet, started: number): Promise<VectorResult> {
  const base = vectorSet.vectors.find((candidate) => candidate.vector_id === vector.base_vector_id);
  if (base === undefined || base.category !== "aead-kat") {
    return completeResult(vector, started, "error", null, null, "SMOKE_VECTOR_ERROR");
  }
  const key = hexToBytes(base.key_hex);
  const nonce = hexToBytes(base.nonce_hex);
  const aad = hexToBytes(base.aad_hex);
  const ciphertext = hexToBytes(base.ciphertext_hex);
  const tag = hexToBytes(base.tag_hex);
  const mutation = vector.mutation;
  const input = {
    nonce: mutation.field === "nonce" ? mutate(nonce, mutation.byte_index, mutation.xor) : nonce,
    ciphertext: mutation.field === "ciphertext" ? mutate(ciphertext, mutation.byte_index, mutation.xor) : ciphertext,
    tag: mutation.field === "tag" ? mutate(tag, mutation.byte_index, mutation.xor) : tag,
    aad: mutation.field === "aad" ? mutate(aad, mutation.byte_index, mutation.xor) : aad
  };
  try {
    const plaintext = await provider.aeadDecrypt(key, input.nonce, input.ciphertext, input.tag, input.aad);
    if (plaintext instanceof Uint8Array) {
      return completeResult(vector, started, "failed", null, expectedHash(plaintext), null);
    }
    return completeResult(vector, started, "failed", null, null, "OBJECT_AEAD_FAILED");
  } catch (error) {
    const actualCode = isExpectedError(error, vector.expected_error_codes, "OBJECT_AEAD_FAILED");
    return completeResult(vector, started, actualCode === null ? "failed" : "passed", null, null, actualCode ?? safeErrorCode(error, "OBJECT_AEAD_FAILED"));
  }
}

async function runHkdfKat(provider: CryptoProvider, vector: HkdfKatVector, started: number): Promise<VectorResult> {
  const expectedBytes = hexToBytes(vector.okm_hex);
  const expected = expectedHash(expectedBytes);
  try {
    const output = bytes(await provider.hkdfSha256(hexToBytes(vector.ikm_hex), hexToBytes(vector.salt_hex), hexToBytes(vector.info_hex), vector.length_bytes), "HKDF output");
    const actual = expectedHash(output);
    return completeResult(vector, started, bytesEqual(output, expectedBytes) ? "passed" : "failed", expected, actual, null);
  } catch (error) {
    return completeResult(vector, started, "error", expected, null, safeErrorCode(error, "HKDF_FAILED"));
  }
}

async function runHkdfIsolation(provider: CryptoProvider, vector: HkdfIsolationVector, started: number): Promise<VectorResult> {
  const ikm = hexToBytes(vector.ikm_hex);
  const salt = hexToBytes(vector.salt_hex);
  const expectedOutputs = vector.outputs.map((output) => hexToBytes(output.okm_hex));
  const expected = expectedHash(concatBytes(...expectedOutputs));
  try {
    const actualOutputs: Uint8Array[] = [];
    for (const output of vector.outputs) {
      actualOutputs.push(bytes(await provider.hkdfSha256(ikm, salt, utf8Bytes(output.label_ascii), vector.length_bytes), "HKDF isolation output"));
    }
    const distinct = new Set(actualOutputs.map((output) => expectedHash(output))).size === actualOutputs.length;
    const exact = actualOutputs.every((output, index) => bytesEqual(output, expectedOutputs[index]!));
    return completeResult(vector, started, distinct && exact ? "passed" : "failed", expected, expectedHash(concatBytes(...actualOutputs)), null);
  } catch (error) {
    return completeResult(vector, started, "error", expected, null, safeErrorCode(error, "HKDF_FAILED"));
  }
}

async function runRandomRoundtrip(provider: CryptoProvider, vector: RandomRoundtripVector, options: SmokeExecutionOptions, started: number): Promise<VectorResult> {
  const source = options.random_source ?? provider;
  try {
    const key = randomBytes(source, vector.key_length_bytes, true);
    const nonce = randomBytes(source, vector.nonce_length_bytes, true);
    const plaintext = randomBytes(source, vector.plaintext_length_bytes, false);
    const aad = randomBytes(source, vector.aad_length_bytes, false);
    const encrypted = await provider.aeadEncrypt(key, nonce, plaintext, aad);
    const ciphertext = bytes(encrypted.ciphertext, "Random AEAD ciphertext");
    const tag = bytes(encrypted.tag, "Random AEAD tag");
    const decrypted = bytes(await provider.aeadDecrypt(key, nonce, ciphertext, tag, aad), "Random AEAD plaintext");
    return completeResult(vector, started, bytesEqual(decrypted, plaintext) ? "passed" : "failed", expectedHash(plaintext), expectedHash(decrypted), null);
  } catch (error) {
    return completeResult(vector, started, "error", null, null, safeErrorCode(error, "RANDOM_SOURCE_FAILED"));
  }
}

async function runRandomSourceErrors(vector: RandomSourceErrorsVector, options: SmokeExecutionOptions, started: number): Promise<VectorResult> {
  const length = 16;
  const probes = options.random_source_faults;
  if (probes === undefined) {
    return completeResult(vector, started, "error", null, null, "RANDOM_SOURCE_PROBES_MISSING");
  }
  const checks = [
    { source: probes.short_read, expected: "RANDOM_SOURCE_SHORT_READ" },
    { source: probes.failure, expected: "RANDOM_SOURCE_FAILED" },
    { source: probes.all_zero, expected: "RANDOM_SOURCE_ALL_ZERO" }
  ] as const;
  let passed = true;
  let actualErrorCode: string | null = null;
  for (const check of checks) {
    try {
      randomBytes(check.source, length, true);
      passed = false;
      actualErrorCode ??= "RANDOM_SOURCE_NOT_REJECTED";
    } catch (error) {
      const code = safeErrorCode(error, "RANDOM_SOURCE_FAILED");
      if (code !== check.expected) {
        passed = false;
        actualErrorCode ??= code;
      }
    }
  }
  return completeResult(vector, started, passed ? "passed" : "failed", null, null, actualErrorCode);
}

async function runWrapKat(provider: CryptoProvider, vector: WrapKatVector, started: number): Promise<VectorResult> {
  const kek = hexToBytes(vector.kek_hex);
  const material = hexToBytes(vector.key_material_hex);
  const expectedWrapped = hexToBytes(vector.wrapped_hex);
  const expected = expectedHash(expectedWrapped);
  try {
    const wrapped = bytes(await provider.wrapKey(kek, material), "Wrapped key");
    const unwrapped = bytes(await provider.unwrapKey(kek, wrapped), "Unwrapped key");
    const actual = expectedHash(wrapped);
    const passed = bytesEqual(wrapped, expectedWrapped) && bytesEqual(unwrapped, material);
    return completeResult(vector, started, passed ? "passed" : "failed", expected, actual, null);
  } catch (error) {
    return completeResult(vector, started, "error", expected, null, safeErrorCode(error, "OBJECT_KEY_WRAP_FAILED"));
  }
}

async function runWrapBadMaterial(provider: CryptoProvider, vector: WrapBadMaterialVector, vectorSet: LoadedVectorSet, started: number): Promise<VectorResult> {
  const base = vectorSet.vectors.find((candidate) => candidate.vector_id === vector.base_vector_id);
  if (base === undefined || base.category !== "wrap-kat") {
    return completeResult(vector, started, "error", null, null, "SMOKE_VECTOR_ERROR");
  }
  try {
    const mutatedWrapped = mutate(hexToBytes(base.wrapped_hex), vector.mutation.byte_index, vector.mutation.xor);
    const output = await provider.unwrapKey(hexToBytes(base.kek_hex), mutatedWrapped);
    return completeResult(vector, started, "failed", null, output instanceof Uint8Array ? expectedHash(output) : null, null);
  } catch (error) {
    const actualCode = isExpectedError(error, vector.expected_error_codes, "OBJECT_KEY_UNWRAP_FAILED");
    return completeResult(vector, started, actualCode === null ? "failed" : "passed", null, null, actualCode ?? safeErrorCode(error, "OBJECT_KEY_UNWRAP_FAILED"));
  }
}

async function runVector(provider: CryptoProvider, vector: RequiredVector, vectorSet: LoadedVectorSet, options: SmokeExecutionOptions): Promise<VectorResult> {
  const started = now();
  try {
    switch (vector.category) {
      case "aead-kat": return await runAeadKat(provider, vector, started);
      case "aead-tamper-ciphertext":
      case "aead-tamper-tag":
      case "aead-tamper-nonce":
      case "aead-tamper-aad": return await runAeadTamper(provider, vector, vectorSet, started);
      case "hkdf-kat": return await runHkdfKat(provider, vector, started);
      case "hkdf-info-isolation": return await runHkdfIsolation(provider, vector, started);
      case "random-roundtrip": return await runRandomRoundtrip(provider, vector, options, started);
      case "random-source-errors": return await runRandomSourceErrors(vector, options, started);
      case "wrap-kat": return await runWrapKat(provider, vector, started);
      case "wrap-bad-material": return await runWrapBadMaterial(provider, vector, vectorSet, started);
      default: return completeResult(vector, started, "skipped", null, null, null);
    }
  } catch (error) {
    return completeResult(vector, started, "error", null, null, safeErrorCode(error, "SMOKE_VECTOR_ERROR"));
  }
}

export function deriveAggregate(vectorResults: readonly VectorResult[], processInfo: ProcessInfo = { exit_code: 0, timed_out: false, uncaught_error: null }): AggregateCounts {
  const total = vectorResults.length;
  const requiredTotal = vectorResults.filter((result) => result.required).length;
  const passed = vectorResults.filter((result) => result.status === "passed").length;
  const failed = vectorResults.filter((result) => result.status === "failed").length;
  const error = vectorResults.filter((result) => result.status === "error").length;
  const skipped = vectorResults.filter((result) => result.status === "skipped").length;
  const requiredPassed = vectorResults.filter((result) => result.required && result.status === "passed").length;
  const processFailed = processInfo.exit_code !== 0 || processInfo.timed_out || processInfo.uncaught_error !== null;
  const requiredFailed = vectorResults.some((result) => result.required && (result.status === "failed" || result.status === "error"));
  const requiredIncomplete = vectorResults.some((result) => result.required && result.status === "skipped");
  const verdict = processFailed || requiredFailed ? "fail" : requiredIncomplete ? "incomplete" : "pass";
  return { total, required_total: requiredTotal as 14, passed, failed, error, skipped, required_passed: requiredPassed, verdict };
}

export async function runSmokeVectors(provider: CryptoProvider, options: SmokeExecutionOptions = {}): Promise<VectorRun> {
  const vectorSet = options.vector_set;
  if (vectorSet === undefined) {
    throw new SmokeContractError("Browser smoke runner requires a hash-checked vector_set.");
  }
  const vectorResults: VectorResult[] = [];
  for (const vector of vectorSet.vectors) {
    vectorResults.push(await runVector(provider, vector, vectorSet, options));
  }
  return { vector_results: vectorResults, aggregate: deriveAggregate(vectorResults) };
}

function suiteMetadata(vectorSet: LoadedVectorSet): AlgorithmSuiteMetadata {
  return {
    name: vectorSet.vectorsFile.suite.name,
    suite_id: vectorSet.vectorsFile.suite.suite_id,
    key_length_bytes: vectorSet.vectorsFile.suite.key_length_bytes,
    nonce_length_bytes: vectorSet.vectorsFile.suite.nonce_length_bytes,
    tag_length_bytes: vectorSet.vectorsFile.suite.tag_length_bytes,
    aad_contract: vectorSet.vectorsFile.suite.aad_contract
  };
}

/** Construct a report from an already executed vector run; aggregate fields are always derived. */
export function createSmokeReport(vectorRun: VectorRun, vectorSet: LoadedVectorSet, context: SmokeReportContext): SmokeReport {
  const processInfo = context.process ?? { exit_code: 0, timed_out: false, uncaught_error: null };
  return {
    schema_version: "smoke-report-v1",
    run_id: context.run_id,
    timestamp_utc: context.timestamp_utc ?? new Date().toISOString(),
    git_commit: context.git_commit,
    candidate: context.candidate,
    algorithm_suite: context.algorithm_suite ?? suiteMetadata(vectorSet),
    environment: context.environment,
    test_vectors: {
      manifest_path: vectorSet.manifestPathForReport,
      manifest_sha256: vectorSet.manifestSha256,
      vector_count: vectorSet.vectors.length,
      vectors_sha256: vectorSet.vectorsSha256
    },
    required_vector_counts: REQUIRED_VECTOR_COUNTS,
    vector_results: vectorRun.vector_results,
    process: processInfo,
    aggregate: deriveAggregate(vectorRun.vector_results, processInfo),
    environment_manifest: context.environment_manifest,
    raw_artifacts: context.raw_artifacts,
    device_binding: context.device_binding ?? null
  };
}

/** Execute the fixed vectors and construct the report; aggregate fields are always derived. */
export async function runSmoke(provider: CryptoProvider, context: SmokeReportContext, options: SmokeExecutionOptions = {}): Promise<SmokeReport> {
  const vectorSet = options.vector_set;
  if (vectorSet === undefined) {
    throw new SmokeContractError("Browser smoke runner requires a hash-checked vector_set.");
  }
  const vectorRun = await runSmokeVectors(provider, { ...options, vector_set: vectorSet });
  return createSmokeReport(vectorRun, vectorSet, context);
}

export const runCryptoSmoke = runSmoke;
export const executeSmokeVectors = runSmokeVectors;
