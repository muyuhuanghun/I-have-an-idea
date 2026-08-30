import { RecoveryFileCodecError } from "./errors.js";
import type { CryptoProvider, RandomSource } from "./ports.js";

const MAGIC = new Uint8Array([0x45, 0x4b, 0x44, 0x52]);
const RECOVERY_FORMAT_VERSION = 1;
const PROTOCOL_VERSION = 1;
const SUITE_ID = 1;
const DOMAIN_ID_LENGTH = 32;
const RECOVERY_ROOT_LENGTH = 32;
const SNAPSHOT_ID_LENGTH = 32;
const OBJECT_ID_LENGTH = 16;
const FINGERPRINT_LENGTH = 16;
const INTEGRITY_TAG_LENGTH = 32;
const HMAC_COVERED_LENGTH = 135;
const DOMAIN_ID_OFFSET = 6;
const SUITE_ID_OFFSET = 38;
const RECOVERY_ROOT_OFFSET = 39;
const SNAPSHOT_ID_OFFSET = 71;
const MANIFEST_OBJECT_ID_OFFSET = 103;
const FINGERPRINT_OFFSET = 119;
const INTEGRITY_TAG_OFFSET = 135;
const FINGERPRINT_LABEL = new TextEncoder().encode("ekd-v1/recovery-fingerprint");
const INTEGRITY_INFO = new TextEncoder().encode("ekd-v1/recovery-file-integrity");

export const RECOVERY_FILE_V1_LENGTH = 167;

export type RecoveryCryptoProvider = Pick<
  CryptoProvider,
  "hkdfSha256" | "hmacSha256" | "sha256" | "verifyHmacSha256"
>;

export interface RecoveryFileV1Material {
  readonly domainId: Uint8Array;
  readonly recoveryRoot: Uint8Array;
  readonly snapshotId: Uint8Array;
  readonly manifestObjectId: Uint8Array;
}

export interface RecoveryFileV1 extends RecoveryFileV1Material {
  readonly recoveryFormatVersion: 1;
  readonly protocolVersion: 1;
  readonly suiteId: 1;
  readonly nonSecretFingerprint: Uint8Array;
}

export interface RecoveryFileV1GenerationInput {
  readonly domainId: Uint8Array;
  readonly snapshotId: Uint8Array;
  readonly manifestObjectId: Uint8Array;
}

export interface RecoveryFileV1Dependencies {
  readonly cryptoProvider: RecoveryCryptoProvider;
  readonly randomSource: RandomSource;
}

function fail(code: ConstructorParameters<typeof RecoveryFileCodecError>[0], message: string): never {
  throw new RecoveryFileCodecError(code, message);
}

function requireLength(value: Uint8Array, expected: number, label: string): Uint8Array {
  if (value.byteLength !== expected) {
    fail("RECOVERY_FIELD_MISSING", `${label} must be exactly ${expected} bytes.`);
  }
  return value.slice();
}

function requireNonZeroRecoveryRoot(value: Uint8Array): Uint8Array {
  const root = requireLength(value, RECOVERY_ROOT_LENGTH, "recoveryRoot");
  if (root.every((byte) => byte === 0)) {
    fail("RANDOM_SOURCE_ALL_ZERO", "recoveryRoot must not be all zero bytes.");
  }
  return root;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function fixedLengthEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function fingerprint(
  cryptoProvider: RecoveryCryptoProvider,
  domainId: Uint8Array
): Promise<Uint8Array> {
  const digest = await cryptoProvider.sha256(concatenate(FINGERPRINT_LABEL, domainId));
  if (digest.byteLength !== INTEGRITY_TAG_LENGTH) {
    fail("RECOVERY_INTEGRITY_FAILED", "SHA-256 provider returned an invalid digest length.");
  }
  return digest.slice(0, FINGERPRINT_LENGTH);
}

async function integrityKey(
  cryptoProvider: RecoveryCryptoProvider,
  recoveryRoot: Uint8Array,
  domainId: Uint8Array
): Promise<Uint8Array> {
  const key = await cryptoProvider.hkdfSha256(
    recoveryRoot,
    domainId,
    INTEGRITY_INFO,
    INTEGRITY_TAG_LENGTH
  );
  if (key.byteLength !== INTEGRITY_TAG_LENGTH) {
    key.fill(0);
    fail("RECOVERY_INTEGRITY_FAILED", "HKDF provider returned an invalid recovery integrity key length.");
  }
  return key;
}

function randomRecoveryRoot(randomSource: RandomSource): Uint8Array {
  let value: Uint8Array;
  try {
    value = randomSource.randomBytes(RECOVERY_ROOT_LENGTH);
  } catch (error) {
    if (error instanceof RecoveryFileCodecError) throw error;
    if (error !== null && typeof error === "object" && "code" in error) {
      const code = error.code;
      if (code === "RANDOM_SOURCE_ALL_ZERO" || code === "RANDOM_SOURCE_SHORT_READ") {
        return fail(code, "The recovery random source returned invalid bytes.");
      }
    }
    return fail("RANDOM_SOURCE_FAILED", "The recovery random source failed.");
  }
  if (value.byteLength !== RECOVERY_ROOT_LENGTH) {
    fail("RANDOM_SOURCE_SHORT_READ", `The recovery random source returned ${value.byteLength} bytes.`);
  }
  return requireNonZeroRecoveryRoot(value);
}

export async function encodeRecoveryFileV1(
  material: RecoveryFileV1Material,
  cryptoProvider: RecoveryCryptoProvider
): Promise<Uint8Array> {
  const domainId = requireLength(material.domainId, DOMAIN_ID_LENGTH, "domainId");
  const recoveryRoot = requireNonZeroRecoveryRoot(material.recoveryRoot);
  const snapshotId = requireLength(material.snapshotId, SNAPSHOT_ID_LENGTH, "snapshotId");
  const manifestObjectId = requireLength(material.manifestObjectId, OBJECT_ID_LENGTH, "manifestObjectId");
  const nonSecretFingerprint = await fingerprint(cryptoProvider, domainId);
  const output = new Uint8Array(RECOVERY_FILE_V1_LENGTH);
  output.set(MAGIC, 0);
  output[4] = RECOVERY_FORMAT_VERSION;
  output[5] = PROTOCOL_VERSION;
  output.set(domainId, DOMAIN_ID_OFFSET);
  output[SUITE_ID_OFFSET] = SUITE_ID;
  output.set(recoveryRoot, RECOVERY_ROOT_OFFSET);
  output.set(snapshotId, SNAPSHOT_ID_OFFSET);
  output.set(manifestObjectId, MANIFEST_OBJECT_ID_OFFSET);
  output.set(nonSecretFingerprint, FINGERPRINT_OFFSET);

  const key = await integrityKey(cryptoProvider, recoveryRoot, domainId);
  try {
    const tag = await cryptoProvider.hmacSha256(key, output.slice(0, HMAC_COVERED_LENGTH));
    if (tag.byteLength !== INTEGRITY_TAG_LENGTH) {
      fail("RECOVERY_INTEGRITY_FAILED", "HMAC provider returned an invalid tag length.");
    }
    output.set(tag, INTEGRITY_TAG_OFFSET);
    return output;
  } finally {
    key.fill(0);
  }
}

export async function generateRecoveryFileV1(
  input: RecoveryFileV1GenerationInput,
  dependencies: RecoveryFileV1Dependencies
): Promise<Uint8Array> {
  return encodeRecoveryFileV1(
    {
      domainId: input.domainId,
      recoveryRoot: randomRecoveryRoot(dependencies.randomSource),
      snapshotId: input.snapshotId,
      manifestObjectId: input.manifestObjectId
    },
    dependencies.cryptoProvider
  );
}

export async function decodeRecoveryFileV1(
  bytes: Uint8Array,
  cryptoProvider: RecoveryCryptoProvider
): Promise<RecoveryFileV1> {
  if (bytes.byteLength < RECOVERY_FILE_V1_LENGTH) {
    fail("RECOVERY_TRUNCATED", `Recovery File is ${bytes.byteLength} bytes; expected 167.`);
  }
  if (bytes.byteLength > RECOVERY_FILE_V1_LENGTH) {
    fail("RECOVERY_TRAILING_BYTES", "Recovery File contains trailing bytes.");
  }
  if (!fixedLengthEqual(bytes.slice(0, MAGIC.byteLength), MAGIC)) {
    fail("RECOVERY_MAGIC_MISMATCH", "Recovery File magic does not match EKDR.");
  }
  if (bytes[4] !== RECOVERY_FORMAT_VERSION || bytes[5] !== PROTOCOL_VERSION) {
    fail("RECOVERY_VERSION_UNSUPPORTED", "Recovery File or protocol version is unsupported.");
  }
  if (bytes[SUITE_ID_OFFSET] !== SUITE_ID) {
    fail("RECOVERY_SUITE_UNKNOWN", `Unsupported Recovery File suite ID: ${bytes[SUITE_ID_OFFSET] ?? -1}`);
  }

  const domainId = bytes.slice(DOMAIN_ID_OFFSET, DOMAIN_ID_OFFSET + DOMAIN_ID_LENGTH);
  const recoveryRoot = bytes.slice(RECOVERY_ROOT_OFFSET, RECOVERY_ROOT_OFFSET + RECOVERY_ROOT_LENGTH);
  const snapshotId = bytes.slice(SNAPSHOT_ID_OFFSET, SNAPSHOT_ID_OFFSET + SNAPSHOT_ID_LENGTH);
  const manifestObjectId = bytes.slice(
    MANIFEST_OBJECT_ID_OFFSET,
    MANIFEST_OBJECT_ID_OFFSET + OBJECT_ID_LENGTH
  );
  const nonSecretFingerprint = bytes.slice(
    FINGERPRINT_OFFSET,
    FINGERPRINT_OFFSET + FINGERPRINT_LENGTH
  );
  const integrityTag = bytes.slice(INTEGRITY_TAG_OFFSET);
  let returnRecoveryRoot = false;
  let key: Uint8Array | undefined;
  try {
    key = await integrityKey(cryptoProvider, recoveryRoot, domainId);
    const authentic = await cryptoProvider.verifyHmacSha256(
      key,
      bytes.slice(0, HMAC_COVERED_LENGTH),
      integrityTag
    );
    if (!authentic) fail("RECOVERY_INTEGRITY_FAILED", "Recovery File HMAC validation failed.");
    if (recoveryRoot.every((byte) => byte === 0)) {
      fail("RECOVERY_INTEGRITY_FAILED", "Recovery File contains an invalid all-zero recovery root.");
    }

    const expectedFingerprint = await fingerprint(cryptoProvider, domainId);
    if (!fixedLengthEqual(nonSecretFingerprint, expectedFingerprint)) {
      fail("RECOVERY_INTEGRITY_FAILED", "Recovery File fingerprint is not canonical for its domain ID.");
    }

    returnRecoveryRoot = true;
    return {
      recoveryFormatVersion: RECOVERY_FORMAT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      domainId,
      suiteId: SUITE_ID,
      recoveryRoot,
      snapshotId,
      manifestObjectId,
      nonSecretFingerprint
    };
  } finally {
    key?.fill(0);
    if (!returnRecoveryRoot) recoveryRoot.fill(0);
  }
}
