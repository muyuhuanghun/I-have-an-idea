// ADR-0026 §2.2-2.5 (P1-alpha state protocol, directory side): the head directory is
// the ONLY mutable state of the protocol — signed per-domain pointer files, an explicit
// devices.json registry, and an append-only history journal for rollback detection.
// Everything else (head objects) lives in the immutable ObjectStore.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Bytes, HeadRecordV1, ObjectStore } from "@ekd/core";
import { encodeHeadRecordWire, verifyHeadRecordWire, HeadError } from "@ekd/core";

export interface RegisteredDeviceV1 {
  readonly device_id: string; // 32 hex characters (16 bytes)
  readonly public_key_spki_base64url: string;
  readonly registered_at: string; // ISO-8601
}

export interface DevicesRegistryV1 {
  readonly devices: readonly RegisteredDeviceV1[];
}

export interface HeadPointerV1 {
  readonly head_object_key: string;
  readonly sequence: number; // JSON-safe integer
  readonly device_id: string;
  readonly pointer_signature_base64url: string;
}

export interface HeadForkEvidenceV1 {
  readonly sequence: number;
  readonly incumbent_head_object_key: string;
  readonly challenger_head_object_key: string;
}

function headError(
  code: "HEAD_SIGNATURE_INVALID" | "HEAD_DEVICE_UNREGISTERED" | "HEAD_ROLLBACK_DETECTED" | "HEAD_FORK_DETECTED",
  message: string,
  cause?: unknown
): HeadError {
  return new HeadError(code, message, cause === undefined ? undefined : { cause });
}

/** ADR-0026 §2.2: pointer/journal file names hash the domain id so it never appears in listings. */
function domainHash(domainId: Bytes): string {
  return createHash("sha256").update(domainId).digest("hex");
}

function pointerFileName(domainId: Bytes): string {
  return `head-${domainHash(domainId).slice(0, 16)}.json`;
}

function hex(bytes: Bytes): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * ADR-0026 §2.2: canonical pointer bytes signed by the device key —
 * utf8(head_object_key) || sequence(u64 big-endian) || utf8(device_id).
 * Both the signing callback and the verification callback must use this exact encoding.
 */
export function encodeHeadPointerBytes(pointer: {
  readonly head_object_key: string;
  readonly sequence: number;
  readonly device_id: string;
}): Bytes {
  const out = new Uint8Array(Buffer.byteLength(pointer.head_object_key) + 8 + Buffer.byteLength(pointer.device_id));
  let offset = 0;
  out.set(Buffer.from(pointer.head_object_key, "utf8"), offset);
  offset += Buffer.byteLength(pointer.head_object_key);
  new DataView(out.buffer).setBigUint64(offset, BigInt(pointer.sequence), false);
  offset += 8;
  out.set(Buffer.from(pointer.device_id, "utf8"), offset);
  return out;
}

export interface HeadDirectoryOptions {
  /** Signed by the pointer signing boundary; covers head_object_key/sequence/device_id. */
  readonly signPointer: (pointer: { readonly head_object_key: string; readonly sequence: number; readonly device_id: string }) => Promise<string>;
  readonly verifier: {
    readonly verifyHeadSignature: (signedBytes: Bytes, signature: Bytes, publicKeySpki: Bytes) => Promise<boolean>;
    readonly verifyPointerSignature: (pointer: Omit<HeadPointerV1, "pointer_signature_base64url">, publicKeySpki: Bytes, signatureBase64url: string) => Promise<boolean>;
  };
}

/**
 * INV-17/INV-18 (ADR-0026 §2.6): head chains are verifiable and monotonic; sequence
 * rollback is rejected. The directory keeps an append-only history journal per domain
 * as the local freshness anchor.
 */
export class HeadDirectory {
  readonly #rootPath: string;
  readonly #options: HeadDirectoryOptions;

  constructor(rootPath: string, options: HeadDirectoryOptions) {
    this.#rootPath = resolve(rootPath);
    this.#options = options;
  }

  get rootPath(): string {
    return this.#rootPath;
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.#rootPath, { recursive: true });
  }

  async registerDevice(deviceId: Bytes, publicKeySpkiBase64url: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(hex(deviceId))) throw headError("HEAD_DEVICE_UNREGISTERED", "device_id must be 16 bytes.");
    await this.ensureDirectory();
    const registry = await this.#readDevices();
    if (registry.devices.some((device) => device.device_id === hex(deviceId))) return;
    const updated: DevicesRegistryV1 = {
      devices: [
        ...registry.devices,
        { device_id: hex(deviceId), public_key_spki_base64url: publicKeySpkiBase64url, registered_at: new Date().toISOString() }
      ]
    };
    await writeFile(join(this.#rootPath, "devices.json"), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  }

  async registeredPublicKey(deviceId: Bytes | string): Promise<string | undefined> {
    const registry = await this.#readDevices();
    const id = typeof deviceId === "string" ? deviceId : hex(deviceId);
    return registry.devices.find((device) => device.device_id === id)?.public_key_spki_base64url;
  }

  /** INV-17: read the latest pointer, verify its signature and the head object it names. */
  async readLatestHead(domainId: Bytes, objectStore: ObjectStore): Promise<{ pointer: HeadPointerV1; record: HeadRecordV1 } | undefined> {
    const pointerPath = join(this.#rootPath, pointerFileName(domainId));
    let raw: string;
    try {
      raw = await readFile(pointerPath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw headError("HEAD_SIGNATURE_INVALID", "Head pointer file could not be read.", { cause: error });
    }
    const pointer = JSON.parse(raw) as HeadPointerV1;
    const spki = await this.registeredPublicKey(pointer.device_id);
    if (spki === undefined) throw headError("HEAD_DEVICE_UNREGISTERED", "The pointer was signed by an unregistered device.");
    const authentic = await this.#options.verifier.verifyPointerSignature(
      { head_object_key: pointer.head_object_key, sequence: pointer.sequence, device_id: pointer.device_id },
      decodeSpki(spki),
      pointer.pointer_signature_base64url
    );
    if (!authentic) throw headError("HEAD_SIGNATURE_INVALID", "Head pointer signature verification failed.");
    const wire = await objectStore.get(pointer.head_object_key);
    if (wire === undefined) throw headError("HEAD_SIGNATURE_INVALID", "Head pointer names an object that is absent from the ObjectStore.");
    const record = await verifyHeadRecordWire(wire, this.#options.verifier, decodeSpki(spki));
    if (Number(record.sequence) !== pointer.sequence) {
      throw headError("HEAD_SIGNATURE_INVALID", "Head pointer sequence does not match the signed head object.");
    }
    return { pointer, record };
  }

  /**
   * INV-17/INV-18: publish a head object and update the pointer — refusing sequence
   * rollback and same-sequence forks with evidence, and appending to the history
   * journal as the local freshness anchor.
   */
  async publishHead(domainId: Bytes, record: HeadRecordV1, headObjectKey: string, objectStore: ObjectStore): Promise<void> {
    const sequence = Number(record.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw headError("HEAD_SIGNATURE_INVALID", "Head sequence must be a safe non-negative integer.");
    await this.ensureDirectory();
    const spki = await this.registeredPublicKey(record.deviceId);
    if (spki === undefined) throw headError("HEAD_DEVICE_UNREGISTERED", "Unregistered devices cannot publish head records.");
    const spkiBytes = decodeSpki(spki);
    await verifyHeadRecordWire(encodeHeadRecordWire(record), this.#options.verifier, spkiBytes);
    if (hex(record.domainId) !== hex(domainId)) throw headError("HEAD_SIGNATURE_INVALID", "Head record domain does not match the publish target.");

    const pointerPath = join(this.#rootPath, pointerFileName(domainId));
    let incumbent: HeadPointerV1 | undefined;
    try {
      incumbent = JSON.parse(await readFile(pointerPath, "utf8")) as HeadPointerV1;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw headError("HEAD_SIGNATURE_INVALID", "Head pointer file could not be read.", { cause: error });
      }
    }
    if (incumbent !== undefined) {
      if (sequence < incumbent.sequence) {
        throw headError("HEAD_ROLLBACK_DETECTED", `Head sequence ${sequence} is behind the incumbent ${incumbent.sequence}.`);
      }
      if (sequence === incumbent.sequence && incumbent.head_object_key !== headObjectKey) {
        const evidence: HeadForkEvidenceV1 = {
          sequence,
          incumbent_head_object_key: incumbent.head_object_key,
          challenger_head_object_key: headObjectKey
        };
        throw headError("HEAD_FORK_DETECTED", JSON.stringify(evidence));
      }
      if (sequence === incumbent.sequence && incumbent.head_object_key === headObjectKey) return; // idempotent republish
    }

    await objectStore.put(headObjectKey, encodeHeadRecordWire(record));
    const pointer = {
      head_object_key: headObjectKey,
      sequence,
      device_id: hex(record.deviceId)
    };
    const signatureBase64url = await this.#options.signPointer(pointer);
    await mkdir(dirname(pointerPath), { recursive: true });
    await writeFile(pointerPath, `${JSON.stringify({ ...pointer, pointer_signature_base64url: signatureBase64url }, null, 2)}\n`, "utf8");
    const journalPath = join(this.#rootPath, `history-${domainHash(domainId).slice(0, 16)}.jsonl`);
    await writeFile(journalPath, `${JSON.stringify({ ...pointer, pointer_signature_base64url: signatureBase64url, recorded_at: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "a" });
  }

  /** INV-18: the maximum sequence this directory has ever accepted for the domain. */
  async localHighWaterMark(domainId: Bytes): Promise<number> {
    const pointer = await this.#readPointerIfExists(domainId);
    if (pointer !== undefined) return pointer.sequence;
    const journalPath = join(this.#rootPath, `history-${domainHash(domainId).slice(0, 16)}.jsonl`);
    try {
      const lines = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
      return lines.reduce((max, line) => Math.max(max, (JSON.parse(line) as { sequence: number }).sequence), -1);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return -1;
      throw headError("HEAD_SIGNATURE_INVALID", "Head history journal could not be read.", { cause: error });
    }
  }

  async #readPointerIfExists(domainId: Bytes): Promise<HeadPointerV1 | undefined> {
    try {
      return JSON.parse(await readFile(join(this.#rootPath, pointerFileName(domainId)), "utf8")) as HeadPointerV1;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw headError("HEAD_SIGNATURE_INVALID", "Head pointer file could not be read.", { cause: error });
    }
  }

  async #readDevices(): Promise<DevicesRegistryV1> {
    try {
      return JSON.parse(await readFile(join(this.#rootPath, "devices.json"), "utf8")) as DevicesRegistryV1;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { devices: [] };
      throw headError("HEAD_DEVICE_UNREGISTERED", "Device registry could not be read.", { cause: error });
    }
  }

  /** Diagnostic listing of registered pointer files (never exposes domain ids). */
  async listPointerFiles(): Promise<string[]> {
    try {
      return (await readdir(this.#rootPath)).filter((name) => name.startsWith("head-")).sort();
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  }
}

function decodeSpki(spkiBase64url: string): Bytes {
  return new Uint8Array(Buffer.from(spkiBase64url, "base64url"));
}
