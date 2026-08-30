import { describe, expect, it } from "vitest";
import {
  RECOVERY_FILE_V1_LENGTH,
  RecoveryFileCodecError,
  decodeRecoveryFileV1,
  encodeRecoveryFileV1,
  generateRecoveryFileV1,
  type RecoveryCryptoProvider,
  type RecoveryFileV1Material
} from "../src/index.js";

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function cryptoProvider(): RecoveryCryptoProvider {
  const crypto = globalThis.crypto;
  const importHmacKey = async (key: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> =>
    crypto.subtle.importKey(
      "raw",
      asArrayBuffer(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      [usage]
    );
  return {
    sha256: async (message) => new Uint8Array(
      await crypto.subtle.digest("SHA-256", asArrayBuffer(message))
    ),
    hkdfSha256: async (ikm, salt, info, length) => {
      const key = await crypto.subtle.importKey("raw", asArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
      return new Uint8Array(await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(salt), info: asArrayBuffer(info) },
        key,
        length * 8
      ));
    },
    hmacSha256: async (key, message) => new Uint8Array(
      await crypto.subtle.sign("HMAC", await importHmacKey(key, "sign"), asArrayBuffer(message))
    ),
    verifyHmacSha256: async (key, message, tag) => tag.byteLength === 32 && crypto.subtle.verify(
      "HMAC",
      await importHmacKey(key, "verify"),
      asArrayBuffer(tag),
      asArrayBuffer(message)
    )
  };
}

function material(): RecoveryFileV1Material {
  return {
    domainId: filled(32, 0x11),
    recoveryRoot: filled(32, 0x44),
    snapshotId: filled(32, 0x22),
    manifestObjectId: filled(16, 0x33)
  };
}

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof RecoveryFileCodecError) return error.code;
    throw error;
  }
  throw new Error("Expected Recovery File operation to fail.");
}

describe("Recovery File v1", () => {
  it("generates the exact 167-byte layout and roundtrips only after HMAC validation", async () => {
    const provider = cryptoProvider();
    const source = material();
    const encoded = await generateRecoveryFileV1(
      {
        domainId: source.domainId,
        snapshotId: source.snapshotId,
        manifestObjectId: source.manifestObjectId
      },
      {
        cryptoProvider: provider,
        randomSource: { randomBytes: () => source.recoveryRoot }
      }
    );

    expect(encoded).toHaveLength(RECOVERY_FILE_V1_LENGTH);
    expect(Array.from(encoded.slice(0, 6))).toEqual([0x45, 0x4b, 0x44, 0x52, 1, 1]);
    expect(encoded.slice(6, 38)).toEqual(source.domainId);
    expect(encoded[38]).toBe(1);
    expect(encoded.slice(39, 71)).toEqual(source.recoveryRoot);
    expect(encoded.slice(71, 103)).toEqual(source.snapshotId);
    expect(encoded.slice(103, 119)).toEqual(source.manifestObjectId);
    expect(encoded.slice(135)).toHaveLength(32);

    const decoded = await decodeRecoveryFileV1(encoded, provider);
    expect(decoded.recoveryFormatVersion).toBe(1);
    expect(decoded.protocolVersion).toBe(1);
    expect(decoded.suiteId).toBe(1);
    expect(decoded.domainId).toEqual(source.domainId);
    expect(decoded.recoveryRoot).toEqual(source.recoveryRoot);
    expect(decoded.snapshotId).toEqual(source.snapshotId);
    expect(decoded.manifestObjectId).toEqual(source.manifestObjectId);
    expect(await encodeRecoveryFileV1(decoded, provider)).toEqual(encoded);
  });

  it("rejects every truncation offset and any trailing byte", async () => {
    const provider = cryptoProvider();
    const encoded = await encodeRecoveryFileV1(material(), provider);
    for (let length = 0; length < RECOVERY_FILE_V1_LENGTH; length += 1) {
      expect(await errorCode(() => decodeRecoveryFileV1(encoded.slice(0, length), provider)))
        .toBe("RECOVERY_TRUNCATED");
    }
    const trailing = new Uint8Array(RECOVERY_FILE_V1_LENGTH + 1);
    trailing.set(encoded);
    expect(await errorCode(() => decodeRecoveryFileV1(trailing, provider)))
      .toBe("RECOVERY_TRAILING_BYTES");
  });

  it("rejects bad magic, either version, and an unknown suite before parsing material", async () => {
    const provider = cryptoProvider();
    const encoded = await encodeRecoveryFileV1(material(), provider);
    const variants = [
      { offset: 0, code: "RECOVERY_MAGIC_MISMATCH" },
      { offset: 4, code: "RECOVERY_VERSION_UNSUPPORTED" },
      { offset: 5, code: "RECOVERY_VERSION_UNSUPPORTED" },
      { offset: 38, code: "RECOVERY_SUITE_UNKNOWN" }
    ] as const;
    for (const variant of variants) {
      const bytes = encoded.slice();
      bytes[variant.offset] = 2;
      expect(await errorCode(() => decodeRecoveryFileV1(bytes, provider))).toBe(variant.code);
    }
  });

  it("rejects bit flips in recovery material, locator fields, fingerprint, and HMAC", async () => {
    const provider = cryptoProvider();
    const encoded = await encodeRecoveryFileV1(material(), provider);
    for (const offset of [39, 71, 103, 119, 135]) {
      const bytes = encoded.slice();
      bytes[offset] ^= 1;
      expect(await errorCode(() => decodeRecoveryFileV1(bytes, provider)))
        .toBe("RECOVERY_INTEGRITY_FAILED");
    }
  });

  it("rejects a non-canonical fingerprint even when its HMAC is recomputed", async () => {
    const provider = cryptoProvider();
    const source = material();
    const encoded = await encodeRecoveryFileV1(source, provider);
    encoded[119] ^= 1;
    const key = await provider.hkdfSha256(
      source.recoveryRoot,
      source.domainId,
      new TextEncoder().encode("ekd-v1/recovery-file-integrity"),
      32
    );
    encoded.set(await provider.hmacSha256(key, encoded.slice(0, 135)), 135);
    expect(await errorCode(() => decodeRecoveryFileV1(encoded, provider)))
      .toBe("RECOVERY_INTEGRITY_FAILED");
  });

  it("fails closed on short, failed, and all-zero recovery random sources", async () => {
    const provider = cryptoProvider();
    const input = {
      domainId: filled(32, 1),
      snapshotId: filled(32, 2),
      manifestObjectId: filled(16, 3)
    };
    expect(await errorCode(() => generateRecoveryFileV1(input, {
      cryptoProvider: provider,
      randomSource: { randomBytes: (length) => new Uint8Array(length - 1) }
    }))).toBe("RANDOM_SOURCE_SHORT_READ");
    expect(await errorCode(() => generateRecoveryFileV1(input, {
      cryptoProvider: provider,
      randomSource: { randomBytes: (length) => new Uint8Array(length) }
    }))).toBe("RANDOM_SOURCE_ALL_ZERO");
    expect(await errorCode(() => generateRecoveryFileV1(input, {
      cryptoProvider: provider,
      randomSource: { randomBytes: () => { throw new Error("failed"); } }
    }))).toBe("RANDOM_SOURCE_FAILED");
  });

  it("rejects malformed caller-supplied field lengths before encoding", async () => {
    const provider = cryptoProvider();
    expect(await errorCode(() => encodeRecoveryFileV1({
      ...material(),
      manifestObjectId: filled(15, 1)
    }, provider))).toBe("RECOVERY_FIELD_MISSING");
  });

  it("clears the exact Recovery integrity-key buffer on encode, decode success, and decode failure", async () => {
    const provider = cryptoProvider();
    const borrowedKeys: Uint8Array[] = [];
    const trackingProvider: RecoveryCryptoProvider = {
      ...provider,
      hkdfSha256: async (...args) => {
        const key = await provider.hkdfSha256(...args);
        borrowedKeys.push(key);
        return key;
      }
    };

    const encoded = await encodeRecoveryFileV1(material(), trackingProvider);
    expect(borrowedKeys[0]).toEqual(filled(32, 0));

    await decodeRecoveryFileV1(encoded, trackingProvider);
    expect(borrowedKeys[1]).toEqual(filled(32, 0));

    const tampered = encoded.slice();
    tampered[135] ^= 1;
    expect(await errorCode(() => decodeRecoveryFileV1(tampered, trackingProvider)))
      .toBe("RECOVERY_INTEGRITY_FAILED");
    expect(borrowedKeys[2]).toEqual(filled(32, 0));
  });
});
