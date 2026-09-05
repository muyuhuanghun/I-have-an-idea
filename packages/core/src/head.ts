// ADR-0026 (P1-alpha-0 §2.1): Head Record v1 — the signed, immutable state anchor of
// the P1 state protocol. Canonical wire bytes are signed by the snapshotting device's
// ECDSA P-256 key; the record itself is stored as an immutable ObjectStore entry.
// This module never performs I/O and never touches P0 recovery semantics (INV-11).
import type { Bytes } from "./ports.js";

export const HEAD_RECORD_WIRE_VERSION = 1;
export const HEAD_DOMAIN_ID_LENGTH = 32;
export const HEAD_SNAPSHOT_ID_LENGTH = 32;
export const HEAD_DEVICE_ID_LENGTH = 16;
export const HEAD_SEQUENCE_LENGTH = 8;
export const HEAD_TIMESTAMP_LENGTH = 8;
export const HEAD_SIGNED_BYTES_LENGTH =
  HEAD_DOMAIN_ID_LENGTH +
  HEAD_SNAPSHOT_ID_LENGTH * 2 +
  HEAD_DEVICE_ID_LENGTH +
  HEAD_SEQUENCE_LENGTH +
  HEAD_TIMESTAMP_LENGTH;

/** Wire layout: version(1) || domain(32) || snapshot(32) || parent(32) || sequence(8BE) || device(16) || created_at(8BE) || signature(64). */
export const HEAD_RECORD_WIRE_LENGTH = 1 + HEAD_SIGNED_BYTES_LENGTH + 64;

export interface HeadRecordInputV1 {
  readonly domainId: Bytes;
  readonly snapshotId: Bytes;
  readonly parentSnapshotId: Bytes;
  /** Monotonic per-domain counter; values above 2^53 are rejected (JSON-safe callers). */
  readonly sequence: number | bigint;
  readonly deviceId: Bytes;
  readonly createdAtUnix: number | bigint;
}

export interface HeadRecordV1 extends HeadRecordInputV1 {
  readonly wireVersion: number;
  readonly signedBytes: Bytes;
  readonly signature: Bytes;
}

export type HeadErrorCode = "HEAD_SIGNATURE_INVALID" | "HEAD_DEVICE_UNREGISTERED" | "HEAD_ROLLBACK_DETECTED" | "HEAD_FORK_DETECTED";

export class HeadError extends Error {
  constructor(readonly code: HeadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeadError";
  }
}

export interface HeadSigner {
  /** Signs the canonical head bytes with the device's ECDSA P-256 key (DER signature). */
  readonly signHead: (signedBytes: Bytes) => Promise<Bytes>;
}

export interface HeadVerifier {
  /** Verifies a DER ECDSA P-256/SHA-256 signature over the canonical head bytes. */
  readonly verifyHeadSignature: (signedBytes: Bytes, signature: Bytes, publicKeySpki: Bytes) => Promise<boolean>;
}

function requireLength(value: Bytes, expected: number, label: string): void {
  if (value.byteLength !== expected) {
    throw new HeadError("HEAD_SIGNATURE_INVALID", `${label} must be exactly ${expected} bytes.`);
  }
}

function asUnsigned(value: number | bigint, label: string, max: bigint): bigint {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > max) throw new HeadError("HEAD_SIGNATURE_INVALID", `${label} out of range.`);
  return parsed;
}

export function encodeHeadSignedBytes(input: HeadRecordInputV1): Bytes {
  requireLength(input.domainId, HEAD_DOMAIN_ID_LENGTH, "domainId");
  requireLength(input.snapshotId, HEAD_SNAPSHOT_ID_LENGTH, "snapshotId");
  requireLength(input.parentSnapshotId, HEAD_SNAPSHOT_ID_LENGTH, "parentSnapshotId");
  requireLength(input.deviceId, HEAD_DEVICE_ID_LENGTH, "deviceId");
  const sequence = asUnsigned(input.sequence, "sequence", 0xffff_ffff_ffff_ffffn);
  const createdAt = asUnsigned(input.createdAtUnix, "createdAtUnix", 0xffff_ffff_ffff_ffffn);
  // ADR-0026 §2.1: the signed layout is exactly the frozen field list (no version byte —
  // the version lives in the outer wire record only).
  const out = new Uint8Array(HEAD_SIGNED_BYTES_LENGTH);
  out.set(input.domainId, 0);
  out.set(input.snapshotId, HEAD_DOMAIN_ID_LENGTH);
  out.set(input.parentSnapshotId, HEAD_DOMAIN_ID_LENGTH + HEAD_SNAPSHOT_ID_LENGTH);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(HEAD_DOMAIN_ID_LENGTH + HEAD_SNAPSHOT_ID_LENGTH * 2, sequence, false);
  out.set(input.deviceId, HEAD_DOMAIN_ID_LENGTH + HEAD_SNAPSHOT_ID_LENGTH * 2 + HEAD_SEQUENCE_LENGTH);
  view.setBigUint64(HEAD_DOMAIN_ID_LENGTH + HEAD_SNAPSHOT_ID_LENGTH * 2 + HEAD_SEQUENCE_LENGTH + HEAD_DEVICE_ID_LENGTH, createdAt, false);
  return out;
}

export async function createHeadRecordV1(input: HeadRecordInputV1, signer: HeadSigner, wireVersion = HEAD_RECORD_WIRE_VERSION): Promise<HeadRecordV1> {
  const signedBytes = encodeHeadSignedBytes(input);
  const signature = await signer.signHead(signedBytes);
  if (signature.byteLength !== 64) {
    throw new HeadError("HEAD_SIGNATURE_INVALID", `Device signature must be exactly 64 bytes; got ${signature.byteLength}.`);
  }
  return {
    wireVersion,
    domainId: input.domainId.slice(),
    snapshotId: input.snapshotId.slice(),
    parentSnapshotId: input.parentSnapshotId.slice(),
    sequence: input.sequence,
    deviceId: input.deviceId.slice(),
    createdAtUnix: input.createdAtUnix,
    signedBytes,
    signature: signature.slice()
  };
}

/** Full wire record: version(1) || signed bytes || signature(64). */
export function encodeHeadRecordWire(record: HeadRecordV1): Bytes {
  const out = new Uint8Array(HEAD_RECORD_WIRE_LENGTH);
  out[0] = record.wireVersion;
  out.set(record.signedBytes, 1);
  out.set(record.signature, 1 + HEAD_SIGNED_BYTES_LENGTH);
  return out;
}

export function decodeHeadRecordWire(wire: Bytes): HeadRecordV1 {
  if (wire.byteLength !== HEAD_RECORD_WIRE_LENGTH) {
    throw new HeadError("HEAD_SIGNATURE_INVALID", `Head record is ${wire.byteLength} bytes; expected ${HEAD_RECORD_WIRE_LENGTH}.`);
  }
  const wireVersion = wire[0] ?? 0;
  if (wireVersion !== HEAD_RECORD_WIRE_VERSION) {
    throw new HeadError("HEAD_SIGNATURE_INVALID", `Unsupported head record wire version ${wireVersion}.`);
  }
  const signedBytes = wire.slice(1, 1 + HEAD_SIGNED_BYTES_LENGTH);
  const signature = wire.slice(1 + HEAD_SIGNED_BYTES_LENGTH);
  const view = new DataView(signedBytes.buffer, signedBytes.byteOffset, signedBytes.byteLength);
  // signedBytes excludes the wire version byte: domain(0..31) snapshot(32..63)
  // parent(64..95) sequence(96..103) device(104..119) created_at(120..127).
  let offset = 0;
  const domainId = signedBytes.slice(offset, offset + HEAD_DOMAIN_ID_LENGTH);
  offset += HEAD_DOMAIN_ID_LENGTH;
  const snapshotId = signedBytes.slice(offset, offset + HEAD_SNAPSHOT_ID_LENGTH);
  offset += HEAD_SNAPSHOT_ID_LENGTH;
  const parentSnapshotId = signedBytes.slice(offset, offset + HEAD_SNAPSHOT_ID_LENGTH);
  offset += HEAD_SNAPSHOT_ID_LENGTH;
  const sequence = view.getBigUint64(offset, false);
  offset += HEAD_SEQUENCE_LENGTH;
  const deviceId = signedBytes.slice(offset, offset + HEAD_DEVICE_ID_LENGTH);
  offset += HEAD_DEVICE_ID_LENGTH;
  const createdAtUnix = view.getBigUint64(offset, false);
  return {
    wireVersion,
    domainId,
    snapshotId,
    parentSnapshotId,
    sequence,
    deviceId,
    createdAtUnix,
    signedBytes,
    signature
  };
}

/** INV-17: signature validity plus canonical reconstruction must both hold. */
export async function verifyHeadRecordWire(wire: Bytes, verifier: HeadVerifier, publicKeySpki: Bytes): Promise<HeadRecordV1> {
  const record = decodeHeadRecordWire(wire);
  const recomputed = encodeHeadSignedBytes(record);
  if (!recomputed.every((byte, index) => byte === (record.signedBytes[index] ?? 0))) {
    throw new HeadError("HEAD_SIGNATURE_INVALID", "Head record canonical bytes do not round-trip.");
  }
  const authentic = await verifier.verifyHeadSignature(record.signedBytes, record.signature, publicKeySpki);
  if (!authentic) throw new HeadError("HEAD_SIGNATURE_INVALID", "Head record signature verification failed.");
  return record;
}
