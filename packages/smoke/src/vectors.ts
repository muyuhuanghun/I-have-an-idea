import { SmokeContractError } from "./errors.js";
import type {
  AeadKatVector,
  AeadTamperVector,
  CryptoVectorManifest,
  CryptoVectorsFile,
  HkdfIsolationVector,
  HkdfKatVector,
  RandomRoundtripVector,
  RandomSourceErrorsVector,
  RequiredVector,
  RequiredVectorCounts,
  WrapBadMaterialVector,
  WrapKatVector
} from "./types.js";

export const REQUIRED_VECTOR_COUNTS: RequiredVectorCounts = Object.freeze({
  aead_kat: 3,
  aead_tamper_ciphertext: 1,
  aead_tamper_tag: 1,
  aead_tamper_nonce: 1,
  aead_tamper_aad: 1,
  hkdf_kat: 2,
  hkdf_info_isolation: 1,
  random_roundtrip: 1,
  random_source_errors: 1,
  wrap_kat: 1,
  wrap_bad_material: 1
});

const REQUIRED_CATEGORY_KEYS = Object.keys(REQUIRED_VECTOR_COUNTS);
const REQUIRED_CATEGORIES = new Set(REQUIRED_CATEGORY_KEYS.map((key) => key.replaceAll("_", "-")));
const HEX_FIELDS = [
  "key_hex",
  "nonce_hex",
  "aad_hex",
  "plaintext_hex",
  "ciphertext_hex",
  "tag_hex",
  "ikm_hex",
  "salt_hex",
  "info_hex",
  "okm_hex",
  "kek_hex",
  "key_material_hex",
  "wrapped_hex"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SmokeContractError(message);
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  contract(typeof value === "string", `Vector contract field ${key} must be a string.`);
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  contract(typeof value === "number" && Number.isInteger(value), `Vector contract field ${key} must be an integer.`);
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  contract(typeof value === "boolean", `Vector contract field ${key} must be a boolean.`);
  return value;
}

function arrayField(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  contract(Array.isArray(value), `Vector contract field ${key} must be an array.`);
  return value;
}

function hexField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  contract(value.length % 2 === 0 && /^[0-9a-f]*$/.test(value), `Vector field ${key} must be lowercase hexadecimal.`);
  return value;
}

function errorCodes(record: Record<string, unknown>): readonly string[] {
  const values = arrayField(record, "expected_error_codes");
  contract(values.every((value) => typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value)), "Vector error codes are invalid.");
  const result = values as string[];
  contract(new Set(result).size === result.length, "Vector error codes must be unique.");
  return result;
}

function mutationField(record: Record<string, unknown>): { readonly field: string; readonly byte_index: number; readonly xor: number } {
  const value = record.mutation;
  contract(isRecord(value), "Vector mutation must be an object.");
  const field = stringField(value, "field");
  const byteIndex = numberField(value, "byte_index");
  const xor = numberField(value, "xor");
  contract(byteIndex >= 0 && xor >= 0 && xor <= 255, "Vector mutation is out of range.");
  return { field, byte_index: byteIndex, xor };
}

function parseVector(value: unknown): RequiredVector {
  contract(isRecord(value), "Each crypto vector must be an object.");
  const vectorId = stringField(value, "vector_id");
  contract(/^[a-z0-9][a-z0-9-]*$/.test(vectorId), `Invalid vector id ${vectorId}.`);
  const category = stringField(value, "category");
  contract(REQUIRED_CATEGORIES.has(category), `Unexpected required vector category ${category}.`);
  contract(booleanField(value, "required"), `Vector ${vectorId} must be required.`);

  for (const key of HEX_FIELDS) {
    if (key in value) {
      hexField(value, key);
    }
  }

  switch (category) {
    case "aead-kat": {
      const sourceLocator = stringField(value, "source_locator");
      void sourceLocator;
      for (const key of ["key_hex", "nonce_hex", "aad_hex", "plaintext_hex", "ciphertext_hex", "tag_hex"] as const) {
        hexField(value, key);
      }
      return value as unknown as AeadKatVector;
    }
    case "aead-tamper-ciphertext":
    case "aead-tamper-tag":
    case "aead-tamper-nonce":
    case "aead-tamper-aad": {
      const baseVectorId = stringField(value, "base_vector_id");
      const mutation = mutationField(value);
      contract(["ciphertext", "tag", "nonce", "aad"].includes(mutation.field), `Invalid AEAD mutation on ${vectorId}.`);
      contract(mutation.byte_index >= 0, `Invalid AEAD mutation index on ${vectorId}.`);
      void baseVectorId;
      errorCodes(value);
      return value as unknown as AeadTamperVector;
    }
    case "hkdf-kat": {
      numberField(value, "length_bytes");
      for (const key of ["ikm_hex", "salt_hex", "info_hex", "okm_hex"] as const) {
        hexField(value, key);
      }
      contract(numberField(value, "length_bytes") === hexField(value, "okm_hex").length / 2, `HKDF length mismatch on ${vectorId}.`);
      return value as unknown as HkdfKatVector;
    }
    case "hkdf-info-isolation": {
      const outputs = arrayField(value, "outputs");
      numberField(value, "length_bytes");
      hexField(value, "ikm_hex");
      hexField(value, "salt_hex");
      contract(outputs.length === 4, `HKDF isolation vector ${vectorId} must contain four labels.`);
      for (const output of outputs) {
        contract(isRecord(output), `HKDF isolation output on ${vectorId} must be an object.`);
        stringField(output, "label_ascii");
        const okm = hexField(output, "okm_hex");
        contract(okm.length / 2 === numberField(value, "length_bytes"), `HKDF isolation output length mismatch on ${vectorId}.`);
      }
      return value as unknown as HkdfIsolationVector;
    }
    case "random-roundtrip":
      for (const key of ["key_length_bytes", "nonce_length_bytes", "plaintext_length_bytes", "aad_length_bytes"] as const) {
        contract(numberField(value, key) > 0, `Random vector ${vectorId} has invalid ${key}.`);
      }
      return value as unknown as RandomRoundtripVector;
    case "random-source-errors": {
      const subchecks = arrayField(value, "subchecks");
      contract(subchecks.length === 3 && subchecks.every((entry) => typeof entry === "string"), `Random source checks on ${vectorId} are invalid.`);
      const expected = errorCodes(value);
      contract(expected.length === 3, `Random source error codes on ${vectorId} must contain three entries.`);
      return value as unknown as RandomSourceErrorsVector;
    }
    case "wrap-kat": {
      for (const key of ["kek_hex", "key_material_hex", "wrapped_hex"] as const) {
        hexField(value, key);
      }
      return value as unknown as WrapKatVector;
    }
    case "wrap-bad-material": {
      const mutation = mutationField(value);
      contract(mutation.field === "wrapped", `Wrap mutation on ${vectorId} must target wrapped bytes.`);
      errorCodes(value);
      return value as unknown as WrapBadMaterialVector;
    }
    default:
      throw new SmokeContractError(`Unhandled required vector category ${category}.`);
  }
}

export function parseCryptoVectorManifest(value: unknown): CryptoVectorManifest {
  contract(isRecord(value), "Crypto vector manifest must be an object.");
  contract(value.schema_version === "ekd-crypto-vector-manifest-v1", "Crypto vector manifest schema_version is invalid.");
  const vectorCount = numberField(value, "vector_count");
  contract(vectorCount === 14, "Crypto vector manifest must declare exactly 14 vectors.");
  numberField(value, "suite_id");
  stringField(value, "status");
  stringField(value, "suite_name");
  contract(value.aad_contract === "ekd-object-aad-v1-101-bytes", "Crypto vector manifest AAD contract is invalid.");
  stringField(value, "vectors_path");
  const vectorsSha = stringField(value, "vectors_sha256");
  contract(/^[0-9a-f]{64}$/.test(vectorsSha), "Crypto vector manifest vectors_sha256 is invalid.");
  const counts = value.required_vector_counts;
  contract(isRecord(counts), "Crypto vector manifest required_vector_counts is missing.");
  contract(Object.keys(counts).sort().join(",") === REQUIRED_CATEGORY_KEYS.sort().join(","), "Crypto vector category keys are invalid.");
  for (const key of REQUIRED_CATEGORY_KEYS) {
    contract(counts[key] === REQUIRED_VECTOR_COUNTS[key as keyof RequiredVectorCounts], `Crypto vector count for ${key} is invalid.`);
  }
  const sources = arrayField(value, "sources");
  contract(sources.every(isRecord), "Crypto vector manifest sources are invalid.");
  return value as unknown as CryptoVectorManifest;
}

export function parseCryptoVectorsFile(value: unknown): CryptoVectorsFile {
  contract(isRecord(value), "Crypto vectors file must be an object.");
  contract(value.schema_version === "ekd-crypto-vectors-v1", "Crypto vectors schema_version is invalid.");
  const suite = value.suite;
  contract(isRecord(suite), "Crypto vectors suite is missing.");
  for (const key of ["name", "aad_contract"] as const) {
    stringField(suite, key);
  }
  for (const key of ["suite_id", "key_length_bytes", "nonce_length_bytes", "tag_length_bytes", "wrap_key_length_bytes"] as const) {
    numberField(suite, key);
  }
  contract(suite.aad_contract === "ekd-object-aad-v1-101-bytes", "Crypto vectors suite AAD contract is invalid.");
  const values = arrayField(value, "vectors");
  contract(values.length === 14, "Crypto vectors file must contain exactly 14 vectors.");
  const vectors = values.map(parseVector);
  return { schema_version: "ekd-crypto-vectors-v1", suite: suite as unknown as CryptoVectorsFile["suite"], vectors };
}

export function validateRequiredVectorCounts(vectors: readonly RequiredVector[]): void {
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  for (const vector of vectors) {
    contract(!ids.has(vector.vector_id), `Duplicate crypto vector id ${vector.vector_id}.`);
    ids.add(vector.vector_id);
    counts.set(vector.category, (counts.get(vector.category) ?? 0) + 1);
  }
  for (const [categoryKey, expected] of Object.entries(REQUIRED_VECTOR_COUNTS)) {
    const actual = counts.get(categoryKey.replaceAll("_", "-")) ?? 0;
    contract(actual === expected, `Crypto vector category ${categoryKey} has ${actual}; expected ${expected}.`);
  }
}
