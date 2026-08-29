import { ManifestCodecError } from "./errors.js";
import {
  bytesEqual,
  canonicalRelativePathBytes,
  compareBytes,
  decodeCanonicalRelativePath
} from "./paths.js";

const MAGIC = new Uint8Array([0x45, 0x4b, 0x44, 0x4d]);
const FORMAT_VERSION = 1;
const SUITE_ID = 1;
const CONTENT_POLICY_VERSION = 1;
const IDENTIFIER_LENGTH = 32;
const OBJECT_ID_LENGTH = 16;
const WRAPPED_KEY_LENGTH = 40;
const FIXED_HEADER_LENGTH = 107;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffff_ffff;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export interface ManifestEntryV1 {
  readonly relativePath: string;
  readonly objectId: Uint8Array;
  readonly plaintextSize: bigint;
  readonly wrappedObjectKey: Uint8Array;
}

export interface ManifestPlaintextV1 {
  readonly domainId: Uint8Array;
  readonly snapshotId: Uint8Array;
  readonly parentSnapshotId: Uint8Array;
  readonly contentPolicyVersion: 1;
  readonly suiteId: 1;
  readonly entries: readonly ManifestEntryV1[];
}

interface PreparedEntry extends ManifestEntryV1 {
  readonly pathBytes: Uint8Array;
}

function fail(code: ConstructorParameters<typeof ManifestCodecError>[0], message: string): never {
  throw new ManifestCodecError(code, message);
}

function requireLength(value: Uint8Array, expected: number, label: string): void {
  if (value.byteLength !== expected) fail("MANIFEST_FORMAT_INVALID", `${label} must be exactly ${expected} bytes.`);
}

function requireP0Header(manifest: ManifestPlaintextV1): void {
  requireLength(manifest.domainId, IDENTIFIER_LENGTH, "domainId");
  requireLength(manifest.snapshotId, IDENTIFIER_LENGTH, "snapshotId");
  requireLength(manifest.parentSnapshotId, IDENTIFIER_LENGTH, "parentSnapshotId");
  if (manifest.parentSnapshotId.some((byte) => byte !== 0)) {
    fail("MANIFEST_FORMAT_INVALID", "P0 parentSnapshotId must be all zero bytes.");
  }
  if (manifest.contentPolicyVersion !== CONTENT_POLICY_VERSION) {
    fail("MANIFEST_FORMAT_INVALID", `Unsupported content policy version: ${manifest.contentPolicyVersion}`);
  }
  if (manifest.suiteId !== SUITE_ID) fail("MANIFEST_SUITE_UNKNOWN", `Unsupported suite ID: ${manifest.suiteId}`);
  if (manifest.entries.length > MAX_U32) fail("MANIFEST_FORMAT_INVALID", "Manifest entry count exceeds u32.");
}

function objectIdKey(objectId: Uint8Array): string {
  let result = "";
  for (const byte of objectId) result += byte.toString(16).padStart(2, "0");
  return result;
}

function prepareEntries(entries: readonly ManifestEntryV1[]): PreparedEntry[] {
  const prepared = entries.map((entry) => {
    let pathBytes: Uint8Array;
    try {
      pathBytes = canonicalRelativePathBytes(entry.relativePath);
    } catch {
      return fail("ENTRY_PATH_ESCAPE", `Manifest path is not canonical: ${entry.relativePath}`);
    }
    if (pathBytes.byteLength > MAX_U32) fail("MANIFEST_FORMAT_INVALID", "Manifest path exceeds u32 length.");
    requireLength(entry.objectId, OBJECT_ID_LENGTH, "entry.objectId");
    requireLength(entry.wrappedObjectKey, WRAPPED_KEY_LENGTH, "entry.wrappedObjectKey");
    if (entry.plaintextSize < 0n || entry.plaintextSize > MAX_U64) {
      fail("MANIFEST_FORMAT_INVALID", "entry.plaintextSize is outside u64.");
    }
    return { ...entry, pathBytes };
  });

  prepared.sort((left, right) => compareBytes(left.pathBytes, right.pathBytes));
  const objectIds = new Set<string>();
  for (let index = 0; index < prepared.length; index += 1) {
    const current = prepared[index];
    if (current === undefined) fail("MANIFEST_FORMAT_INVALID", "Manifest entry preparation failed.");
    const previous = prepared[index - 1];
    if (previous !== undefined && compareBytes(previous.pathBytes, current.pathBytes) === 0) {
      fail("ENTRY_PATH_DUPLICATE", `Duplicate Manifest path: ${current.relativePath}`);
    }
    const key = objectIdKey(current.objectId);
    if (objectIds.has(key)) fail("DUPLICATE_OBJECT_REFERENCE", `Duplicate object ID at ${current.relativePath}.`);
    objectIds.add(key);
  }
  return prepared;
}

function totalLength(entries: readonly PreparedEntry[]): number {
  let total = FIXED_HEADER_LENGTH;
  for (const entry of entries) {
    total += 4 + entry.pathBytes.byteLength + OBJECT_ID_LENGTH + 8 + 2 + WRAPPED_KEY_LENGTH;
    if (!Number.isSafeInteger(total)) fail("MANIFEST_FORMAT_INVALID", "Manifest byte length exceeds the safe in-memory range.");
  }
  return total;
}

export function encodeManifestPlaintextV1(manifest: ManifestPlaintextV1): Uint8Array {
  requireP0Header(manifest);
  const entries = prepareEntries(manifest.entries);
  const output = new Uint8Array(totalLength(entries));
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  let offset = 0;
  const writeBytes = (bytes: Uint8Array): void => {
    output.set(bytes, offset);
    offset += bytes.byteLength;
  };
  const writeU8 = (value: number): void => { view.setUint8(offset, value); offset += 1; };
  const writeU16 = (value: number): void => { view.setUint16(offset, value, false); offset += 2; };
  const writeU32 = (value: number): void => { view.setUint32(offset, value, false); offset += 4; };
  const writeU64 = (value: bigint): void => { view.setBigUint64(offset, value, false); offset += 8; };

  writeBytes(MAGIC);
  writeU8(FORMAT_VERSION);
  writeBytes(manifest.domainId);
  writeBytes(manifest.snapshotId);
  writeBytes(manifest.parentSnapshotId);
  writeU8(manifest.contentPolicyVersion);
  writeU8(manifest.suiteId);
  writeU32(entries.length);
  for (const entry of entries) {
    writeU32(entry.pathBytes.byteLength);
    writeBytes(entry.pathBytes);
    writeBytes(entry.objectId);
    writeU64(entry.plaintextSize);
    writeU16(entry.wrappedObjectKey.byteLength);
    writeBytes(entry.wrappedObjectKey);
  }
  if (offset !== output.byteLength) fail("MANIFEST_FORMAT_INVALID", "Manifest encoder length accounting failed.");
  return output;
}

class Reader {
  readonly #view: DataView;
  #offset = 0;

  constructor(readonly bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number { return this.#offset; }
  get remaining(): number { return this.bytes.byteLength - this.#offset; }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      fail("MANIFEST_FORMAT_INVALID", "Manifest is truncated or contains an invalid length.");
    }
    const value = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  readU8(): number {
    if (this.remaining < 1) fail("MANIFEST_FORMAT_INVALID", "Manifest is truncated.");
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  readU16(): number {
    if (this.remaining < 2) fail("MANIFEST_FORMAT_INVALID", "Manifest is truncated.");
    const value = this.#view.getUint16(this.#offset, false);
    this.#offset += 2;
    return value;
  }

  readU32(): number {
    if (this.remaining < 4) fail("MANIFEST_FORMAT_INVALID", "Manifest is truncated.");
    const value = this.#view.getUint32(this.#offset, false);
    this.#offset += 4;
    return value;
  }

  readU64(): bigint {
    if (this.remaining < 8) fail("MANIFEST_FORMAT_INVALID", "Manifest is truncated.");
    const value = this.#view.getBigUint64(this.#offset, false);
    this.#offset += 8;
    return value;
  }
}

export function decodeManifestPlaintextV1(bytes: Uint8Array): ManifestPlaintextV1 {
  const reader = new Reader(bytes);
  if (!bytesEqual(reader.readBytes(MAGIC.byteLength), MAGIC)) {
    fail("MANIFEST_FORMAT_INVALID", "Manifest magic does not match EKDM.");
  }
  const version = reader.readU8();
  if (version !== FORMAT_VERSION) fail("MANIFEST_VERSION_UNSUPPORTED", `Unsupported Manifest format version: ${version}`);
  const domainId = reader.readBytes(IDENTIFIER_LENGTH);
  const snapshotId = reader.readBytes(IDENTIFIER_LENGTH);
  const parentSnapshotId = reader.readBytes(IDENTIFIER_LENGTH);
  if (parentSnapshotId.some((byte) => byte !== 0)) {
    fail("MANIFEST_FORMAT_INVALID", "P0 parentSnapshotId must be all zero bytes.");
  }
  const contentPolicyVersion = reader.readU8();
  if (contentPolicyVersion !== CONTENT_POLICY_VERSION) {
    fail("MANIFEST_FORMAT_INVALID", `Unsupported content policy version: ${contentPolicyVersion}`);
  }
  const suiteId = reader.readU8();
  if (suiteId !== SUITE_ID) fail("MANIFEST_SUITE_UNKNOWN", `Unsupported suite ID: ${suiteId}`);
  const entryCount = reader.readU32();
  const minimumEntryLength = 4 + 1 + OBJECT_ID_LENGTH + 8 + 2 + WRAPPED_KEY_LENGTH;
  if (entryCount > Math.floor(reader.remaining / minimumEntryLength)) {
    fail("MANIFEST_FORMAT_INVALID", "Manifest entry count exceeds the remaining byte length.");
  }

  const entries: ManifestEntryV1[] = [];
  const objectIds = new Set<string>();
  let previousPathBytes: Uint8Array | undefined;
  for (let index = 0; index < entryCount; index += 1) {
    const pathLength = reader.readU32();
    const pathBytes = reader.readBytes(pathLength);
    let relativePath: string;
    try {
      relativePath = decodeCanonicalRelativePath(pathBytes);
    } catch {
      return fail("ENTRY_PATH_ESCAPE", "Manifest path is not canonical strict UTF-8.");
    }
    if (previousPathBytes !== undefined) {
      const order = compareBytes(previousPathBytes, pathBytes);
      if (order === 0) fail("ENTRY_PATH_DUPLICATE", `Duplicate Manifest path: ${relativePath}`);
      if (order > 0) fail("MANIFEST_FORMAT_INVALID", "Manifest entries are not in canonical byte order.");
    }
    previousPathBytes = pathBytes;

    const objectId = reader.readBytes(OBJECT_ID_LENGTH);
    const key = objectIdKey(objectId);
    if (objectIds.has(key)) fail("DUPLICATE_OBJECT_REFERENCE", `Duplicate object ID at ${relativePath}.`);
    objectIds.add(key);
    const plaintextSize = reader.readU64();
    const wrappedKeyLength = reader.readU16();
    if (wrappedKeyLength !== WRAPPED_KEY_LENGTH || wrappedKeyLength > MAX_U16) {
      fail("MANIFEST_FORMAT_INVALID", `Suite 1 wrapped key must be ${WRAPPED_KEY_LENGTH} bytes.`);
    }
    const wrappedObjectKey = reader.readBytes(wrappedKeyLength);
    entries.push(Object.freeze({ relativePath, objectId, plaintextSize, wrappedObjectKey }));
  }

  if (reader.offset !== bytes.byteLength) fail("MANIFEST_TRAILING_BYTES", "Manifest contains trailing bytes.");
  return Object.freeze({
    domainId,
    snapshotId,
    parentSnapshotId,
    contentPolicyVersion: CONTENT_POLICY_VERSION,
    suiteId: SUITE_ID,
    entries: Object.freeze(entries)
  });
}
