import { ManifestCodecError, ObjectCodecError } from "./errors.js";
import { decodeManifestPlaintextV1, encodeManifestPlaintextV1 } from "./manifest.js";
import type { ManifestPlaintextV1 } from "./manifest.js";
import type { CryptoProvider, RandomSource } from "./ports.js";

const ENVELOPE_MAGIC = new Uint8Array([0x45, 0x4b, 0x44, 0x4f]);
const AAD_MAGIC = new Uint8Array([0x45, 0x4b, 0x44, 0x41]);
const OBJECT_FORMAT_VERSION = 1;
const AAD_FORMAT_VERSION = 1;
const PROTOCOL_VERSION = 1;
const SUITE_ID = 1;
const DOMAIN_ID_LENGTH = 32;
const SNAPSHOT_ID_LENGTH = 32;
const OBJECT_ID_LENGTH = 16;
const OBJECT_STORE_KEY_LENGTH = 22;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const OBJECT_KEY_LENGTH = 32;
const WRAPPED_OBJECT_KEY_LENGTH = 40;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const OBJECT_ENVELOPE_V1_HEADER_LENGTH = 19;
export const OBJECT_AAD_V1_LENGTH = 101;

export type ObjectTypeV1 = "file" | "manifest";
export type ObjectCryptoProvider = Pick<
  CryptoProvider,
  "aeadDecrypt" | "aeadEncrypt" | "unwrapKey" | "wrapKey"
>;

export interface ObjectContextV1 {
  readonly domainId: Uint8Array;
  readonly objectId: Uint8Array;
  readonly snapshotId: Uint8Array;
}

export interface ObjectAadV1 extends ObjectContextV1 {
  readonly objectType: ObjectTypeV1;
  readonly ciphertextLength: bigint;
}

export interface ObjectEnvelopeV1 {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

export interface SealFileObjectV1Input extends ObjectContextV1 {
  readonly objectWrapKey: Uint8Array;
  readonly plaintext: Uint8Array;
}

export interface SealedFileObjectV1 {
  readonly envelope: Uint8Array;
  readonly plaintextSize: bigint;
  readonly wrappedObjectKey: Uint8Array;
}

export interface OpenFileObjectV1Input extends ObjectContextV1 {
  readonly envelope: Uint8Array;
  readonly expectedPlaintextSize: bigint;
  readonly objectWrapKey: Uint8Array;
  readonly wrappedObjectKey: Uint8Array;
}

export interface SealManifestObjectV1Input extends ObjectContextV1 {
  readonly manifest: ManifestPlaintextV1;
  readonly manifestKey: Uint8Array;
}

export interface OpenManifestObjectV1Input extends ObjectContextV1 {
  readonly envelope: Uint8Array;
  readonly manifestKey: Uint8Array;
}

export interface ObjectSealDependencies {
  readonly cryptoProvider: ObjectCryptoProvider;
  readonly randomSource: RandomSource;
}

function fail(code: ConstructorParameters<typeof ObjectCodecError>[0], message: string, cause?: unknown): never {
  throw new ObjectCodecError(code, message, cause === undefined ? undefined : { cause });
}

function requireLength(value: Uint8Array, expected: number, label: string): void {
  if (value.byteLength !== expected) {
    throw new RangeError(`${label} must be exactly ${expected} bytes.`);
  }
}

function requireU64(value: bigint, label: string): void {
  if (value < 0n || value > MAX_U64) {
    throw new RangeError(`${label} must fit an unsigned 64-bit integer.`);
  }
}

function fixedLengthEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function objectTypeByte(type: ObjectTypeV1): number {
  if (type === "file") return 0;
  if (type === "manifest") return 1;
  return fail("OBJECT_AAD_MISMATCH", "Object type must be file or manifest.");
}

function objectTypeFromByte(value: number): ObjectTypeV1 {
  if (value === 0) return "file";
  if (value === 1) return "manifest";
  return fail("OBJECT_AAD_MISMATCH", `Unknown object type: ${value}`);
}

function randomBytesExact(randomSource: RandomSource, length: number, label: string): Uint8Array {
  let value: Uint8Array;
  try {
    value = randomSource.randomBytes(length);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error) {
      const code = error.code;
      if (code === "RANDOM_SOURCE_ALL_ZERO" || code === "RANDOM_SOURCE_SHORT_READ") {
        return fail(code, `${label} random source returned invalid bytes.`, error);
      }
    }
    return fail("RANDOM_SOURCE_FAILED", `${label} random source failed.`, error);
  }
  if (value.byteLength !== length) {
    return fail(
      "RANDOM_SOURCE_SHORT_READ",
      `${label} random source returned ${value.byteLength} bytes; expected ${length}.`
    );
  }
  if (value.every((byte) => byte === 0)) {
    return fail("RANDOM_SOURCE_ALL_ZERO", `${label} random source returned only zero bytes.`);
  }
  return value;
}

export function generateObjectIdV1(randomSource: RandomSource): Uint8Array {
  return randomBytesExact(randomSource, OBJECT_ID_LENGTH, "object ID");
}

export function encodeObjectStoreKeyV1(objectId: Uint8Array): string {
  requireLength(objectId, OBJECT_ID_LENGTH, "objectId");
  let result = "";
  for (let offset = 0; offset < 15; offset += 3) {
    const first = objectId[offset] ?? 0;
    const second = objectId[offset + 1] ?? 0;
    const third = objectId[offset + 2] ?? 0;
    result += BASE64URL_ALPHABET.charAt(first >>> 2);
    result += BASE64URL_ALPHABET.charAt(((first & 0x03) << 4) | (second >>> 4));
    result += BASE64URL_ALPHABET.charAt(((second & 0x0f) << 2) | (third >>> 6));
    result += BASE64URL_ALPHABET.charAt(third & 0x3f);
  }
  const last = objectId[15] ?? 0;
  result += BASE64URL_ALPHABET.charAt(last >>> 2);
  result += BASE64URL_ALPHABET.charAt((last & 0x03) << 4);
  return result;
}

export function decodeObjectStoreKeyV1(text: string, expectedObjectId?: Uint8Array): Uint8Array {
  if (text.length !== OBJECT_STORE_KEY_LENGTH || !/^[A-Za-z0-9_-]{22}$/u.test(text)) {
    return fail("OBJECT_ID_INVALID", "ObjectStore key must be 22 canonical base64url characters.");
  }
  const output = new Uint8Array(OBJECT_ID_LENGTH);
  let outputOffset = 0;
  for (let offset = 0; offset < 20; offset += 4) {
    const a = BASE64URL_ALPHABET.indexOf(text[offset] ?? "");
    const b = BASE64URL_ALPHABET.indexOf(text[offset + 1] ?? "");
    const c = BASE64URL_ALPHABET.indexOf(text[offset + 2] ?? "");
    const d = BASE64URL_ALPHABET.indexOf(text[offset + 3] ?? "");
    output[outputOffset] = (a << 2) | (b >>> 4);
    output[outputOffset + 1] = ((b & 0x0f) << 4) | (c >>> 2);
    output[outputOffset + 2] = ((c & 0x03) << 6) | d;
    outputOffset += 3;
  }
  const a = BASE64URL_ALPHABET.indexOf(text[20] ?? "");
  const b = BASE64URL_ALPHABET.indexOf(text[21] ?? "");
  output[15] = (a << 2) | (b >>> 4);
  if (encodeObjectStoreKeyV1(output) !== text) {
    return fail("OBJECT_ID_INVALID", "ObjectStore key is not the canonical encoding of 16 bytes.");
  }
  if (expectedObjectId !== undefined) {
    requireLength(expectedObjectId, OBJECT_ID_LENGTH, "expectedObjectId");
    if (!fixedLengthEqual(output, expectedObjectId)) {
      return fail("OBJECT_AAD_MISMATCH", "ObjectStore key does not match the expected object ID.");
    }
  }
  return output;
}

export function encodeObjectAadV1(input: ObjectAadV1): Uint8Array {
  requireLength(input.domainId, DOMAIN_ID_LENGTH, "domainId");
  requireLength(input.objectId, OBJECT_ID_LENGTH, "objectId");
  requireLength(input.snapshotId, SNAPSHOT_ID_LENGTH, "snapshotId");
  requireU64(input.ciphertextLength, "ciphertextLength");
  const output = new Uint8Array(OBJECT_AAD_V1_LENGTH);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  output.set(AAD_MAGIC, 0);
  output[4] = AAD_FORMAT_VERSION;
  output[5] = OBJECT_FORMAT_VERSION;
  output[6] = PROTOCOL_VERSION;
  output[7] = SUITE_ID;
  output[8] = objectTypeByte(input.objectType);
  output.set(input.domainId, 9);
  output.set(input.objectId, 41);
  output.set(input.snapshotId, 57);
  view.setUint16(89, NONCE_LENGTH, false);
  view.setBigUint64(91, input.ciphertextLength, false);
  view.setUint16(99, TAG_LENGTH, false);
  return output;
}

export function decodeObjectAadV1(bytes: Uint8Array): ObjectAadV1 {
  if (bytes.byteLength !== OBJECT_AAD_V1_LENGTH) {
    return fail("OBJECT_AAD_MISMATCH", "Object AAD must be exactly 101 bytes.");
  }
  if (!fixedLengthEqual(bytes.slice(0, 4), AAD_MAGIC)) {
    return fail("OBJECT_AAD_MISMATCH", "Object AAD magic does not match EKDA.");
  }
  if (bytes[4] !== AAD_FORMAT_VERSION || bytes[5] !== OBJECT_FORMAT_VERSION || bytes[6] !== PROTOCOL_VERSION) {
    return fail("OBJECT_AAD_MISMATCH", "Object AAD version is unsupported.");
  }
  if (bytes[7] !== SUITE_ID) return fail("OBJECT_AAD_MISMATCH", "Object AAD suite is unsupported.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(89, false) !== NONCE_LENGTH || view.getUint16(99, false) !== TAG_LENGTH) {
    return fail("OBJECT_AAD_MISMATCH", "Object AAD lengths do not match Suite 1.");
  }
  return {
    objectType: objectTypeFromByte(bytes[8] ?? -1),
    domainId: bytes.slice(9, 41),
    objectId: bytes.slice(41, 57),
    snapshotId: bytes.slice(57, 89),
    ciphertextLength: view.getBigUint64(91, false)
  };
}

export function encodeObjectEnvelopeV1(envelope: ObjectEnvelopeV1): Uint8Array {
  requireLength(envelope.nonce, NONCE_LENGTH, "nonce");
  requireLength(envelope.tag, TAG_LENGTH, "tag");
  const totalLength = OBJECT_ENVELOPE_V1_HEADER_LENGTH + NONCE_LENGTH + envelope.ciphertext.byteLength + TAG_LENGTH;
  if (!Number.isSafeInteger(totalLength)) throw new RangeError("Object Envelope exceeds the safe in-memory range.");
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  output.set(ENVELOPE_MAGIC, 0);
  output[4] = OBJECT_FORMAT_VERSION;
  output[5] = PROTOCOL_VERSION;
  output[6] = SUITE_ID;
  view.setUint16(7, NONCE_LENGTH, false);
  view.setBigUint64(9, BigInt(envelope.ciphertext.byteLength), false);
  view.setUint16(17, TAG_LENGTH, false);
  output.set(envelope.nonce, OBJECT_ENVELOPE_V1_HEADER_LENGTH);
  output.set(envelope.ciphertext, OBJECT_ENVELOPE_V1_HEADER_LENGTH + NONCE_LENGTH);
  output.set(envelope.tag, totalLength - TAG_LENGTH);
  return output;
}

export function decodeObjectEnvelopeV1(bytes: Uint8Array): ObjectEnvelopeV1 {
  if (bytes.byteLength < OBJECT_ENVELOPE_V1_HEADER_LENGTH) {
    return fail("OBJECT_TRUNCATED", "Object Envelope is shorter than its 19-byte header.");
  }
  if (!fixedLengthEqual(bytes.slice(0, 4), ENVELOPE_MAGIC)) {
    return fail("OBJECT_AAD_MISMATCH", "Object Envelope magic does not match EKDO.");
  }
  if (bytes[4] !== OBJECT_FORMAT_VERSION || bytes[5] !== PROTOCOL_VERSION || bytes[6] !== SUITE_ID) {
    return fail("OBJECT_AAD_MISMATCH", "Object Envelope version or suite is unsupported.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nonceLength = view.getUint16(7, false);
  const ciphertextLength = view.getBigUint64(9, false);
  const tagLength = view.getUint16(17, false);
  if (nonceLength !== NONCE_LENGTH || tagLength !== TAG_LENGTH) {
    return fail("OBJECT_AAD_MISMATCH", "Object Envelope lengths do not match Suite 1.");
  }
  const expectedLength = BigInt(OBJECT_ENVELOPE_V1_HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH) + ciphertextLength;
  const actualLength = BigInt(bytes.byteLength);
  if (actualLength < expectedLength) return fail("OBJECT_TRUNCATED", "Object Envelope is truncated.");
  if (actualLength > expectedLength) return fail("OBJECT_TRAILING_BYTES", "Object Envelope contains trailing bytes.");
  const ciphertextLengthNumber = Number(ciphertextLength);
  const nonceOffset = OBJECT_ENVELOPE_V1_HEADER_LENGTH;
  const ciphertextOffset = nonceOffset + NONCE_LENGTH;
  const tagOffset = ciphertextOffset + ciphertextLengthNumber;
  return {
    nonce: bytes.slice(nonceOffset, ciphertextOffset),
    ciphertext: bytes.slice(ciphertextOffset, tagOffset),
    tag: bytes.slice(tagOffset)
  };
}

function requireContext(context: ObjectContextV1): void {
  requireLength(context.domainId, DOMAIN_ID_LENGTH, "domainId");
  requireLength(context.objectId, OBJECT_ID_LENGTH, "objectId");
  requireLength(context.snapshotId, SNAPSHOT_ID_LENGTH, "snapshotId");
}

function aadFor(
  context: ObjectContextV1,
  objectType: ObjectTypeV1,
  ciphertextLength: number
): Uint8Array {
  requireContext(context);
  return encodeObjectAadV1({
    ...context,
    objectType,
    ciphertextLength: BigInt(ciphertextLength)
  });
}

async function encryptEnvelope(
  plaintext: Uint8Array,
  key: Uint8Array,
  context: ObjectContextV1,
  objectType: ObjectTypeV1,
  dependencies: ObjectSealDependencies
): Promise<Uint8Array> {
  const nonce = randomBytesExact(dependencies.randomSource, NONCE_LENGTH, `${objectType} nonce`);
  const aad = aadFor(context, objectType, plaintext.byteLength);
  const result = await dependencies.cryptoProvider.aeadEncrypt(key, nonce, plaintext, aad);
  if (result.ciphertext.byteLength !== plaintext.byteLength) {
    throw new RangeError("Suite 1 ciphertext length must equal plaintext length.");
  }
  requireLength(result.tag, TAG_LENGTH, "AEAD tag");
  return encodeObjectEnvelopeV1({ nonce, ciphertext: result.ciphertext, tag: result.tag });
}

async function decryptEnvelope(
  envelopeBytes: Uint8Array,
  key: Uint8Array,
  context: ObjectContextV1,
  objectType: ObjectTypeV1,
  provider: ObjectCryptoProvider
): Promise<Uint8Array> {
  requireContext(context);
  const envelope = decodeObjectEnvelopeV1(envelopeBytes);
  const aad = aadFor(context, objectType, envelope.ciphertext.byteLength);
  try {
    return await provider.aeadDecrypt(
      key,
      envelope.nonce,
      envelope.ciphertext,
      envelope.tag,
      aad
    );
  } catch (error) {
    return fail(
      objectType === "manifest" ? "MANIFEST_AEAD_FAILED" : "OBJECT_AEAD_FAILED",
      `${objectType} object authentication failed.`,
      error
    );
  }
}

export async function sealFileObjectV1(
  input: SealFileObjectV1Input,
  dependencies: ObjectSealDependencies
): Promise<SealedFileObjectV1> {
  requireContext(input);
  requireLength(input.objectWrapKey, OBJECT_KEY_LENGTH, "objectWrapKey");
  const objectKey = randomBytesExact(dependencies.randomSource, OBJECT_KEY_LENGTH, "file object key");
  try {
    const wrappedObjectKey = await dependencies.cryptoProvider.wrapKey(input.objectWrapKey, objectKey);
    requireLength(wrappedObjectKey, WRAPPED_OBJECT_KEY_LENGTH, "wrappedObjectKey");
    const envelope = await encryptEnvelope(input.plaintext, objectKey, input, "file", dependencies);
    return {
      envelope,
      plaintextSize: BigInt(input.plaintext.byteLength),
      wrappedObjectKey
    };
  } finally {
    objectKey.fill(0);
  }
}

export async function openFileObjectV1(
  input: OpenFileObjectV1Input,
  cryptoProvider: ObjectCryptoProvider
): Promise<Uint8Array> {
  requireContext(input);
  requireLength(input.objectWrapKey, OBJECT_KEY_LENGTH, "objectWrapKey");
  requireLength(input.wrappedObjectKey, WRAPPED_OBJECT_KEY_LENGTH, "wrappedObjectKey");
  requireU64(input.expectedPlaintextSize, "expectedPlaintextSize");
  let objectKey: Uint8Array | undefined;
  try {
    try {
      objectKey = await cryptoProvider.unwrapKey(input.objectWrapKey, input.wrappedObjectKey);
    } catch (error) {
      return fail("OBJECT_AEAD_FAILED", "File object key unwrap failed.", error);
    }
    requireLength(objectKey, OBJECT_KEY_LENGTH, "objectKey");
    const plaintext = await decryptEnvelope(input.envelope, objectKey, input, "file", cryptoProvider);
    if (BigInt(plaintext.byteLength) !== input.expectedPlaintextSize) {
      plaintext.fill(0);
      return fail("ENTRY_SIZE_MISMATCH", "Decrypted file size does not match its authenticated Manifest entry.");
    }
    return plaintext;
  } finally {
    objectKey?.fill(0);
  }
}

function requireManifestContext(manifest: ManifestPlaintextV1, context: ObjectContextV1): void {
  if (!fixedLengthEqual(manifest.domainId, context.domainId) ||
      !fixedLengthEqual(manifest.snapshotId, context.snapshotId) ||
      manifest.suiteId !== SUITE_ID) {
    throw new ManifestCodecError(
      "MANIFEST_FORMAT_INVALID",
      "Manifest plaintext identity does not match the authenticated object context."
    );
  }
}

export async function sealManifestObjectV1(
  input: SealManifestObjectV1Input,
  dependencies: ObjectSealDependencies
): Promise<Uint8Array> {
  requireContext(input);
  requireLength(input.manifestKey, OBJECT_KEY_LENGTH, "manifestKey");
  requireManifestContext(input.manifest, input);
  const plaintext = encodeManifestPlaintextV1(input.manifest);
  try {
    return await encryptEnvelope(plaintext, input.manifestKey, input, "manifest", dependencies);
  } finally {
    plaintext.fill(0);
  }
}

export async function openManifestObjectV1(
  input: OpenManifestObjectV1Input,
  cryptoProvider: ObjectCryptoProvider
): Promise<ManifestPlaintextV1> {
  requireContext(input);
  requireLength(input.manifestKey, OBJECT_KEY_LENGTH, "manifestKey");
  const plaintext = await decryptEnvelope(input.envelope, input.manifestKey, input, "manifest", cryptoProvider);
  try {
    const manifest = decodeManifestPlaintextV1(plaintext);
    requireManifestContext(manifest, input);
    return manifest;
  } finally {
    plaintext.fill(0);
  }
}
