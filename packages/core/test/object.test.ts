import { describe, expect, it } from "vitest";
import {
  OBJECT_AAD_V1_LENGTH,
  OBJECT_ENVELOPE_V1_HEADER_LENGTH,
  ObjectCodecError,
  decodeObjectAadV1,
  decodeObjectEnvelopeV1,
  decodeObjectStoreKeyV1,
  encodeObjectAadV1,
  encodeObjectEnvelopeV1,
  encodeObjectStoreKeyV1,
  generateObjectIdV1
} from "../src/index.js";

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function objectErrorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ObjectCodecError) return error.code;
    throw error;
  }
  throw new Error("Expected object codec operation to fail.");
}

describe("Object identifiers", () => {
  it("uses the canonical 22-character base64url form for 16 raw bytes", () => {
    const objectId = Uint8Array.from({ length: 16 }, (_value, index) => index);
    const text = encodeObjectStoreKeyV1(objectId);
    expect(text).toBe("AAECAwQFBgcICQoLDA0ODw");
    expect(decodeObjectStoreKeyV1(text)).toEqual(objectId);
    expect(decodeObjectStoreKeyV1(text, objectId)).toEqual(objectId);
  });

  it("rejects padding, wrong length, non-canonical tail bits, and wrong expected IDs", () => {
    expect(objectErrorCode(() => decodeObjectStoreKeyV1("AAECAwQFBgcICQoLDA0ODw==")))
      .toBe("OBJECT_ID_INVALID");
    expect(objectErrorCode(() => decodeObjectStoreKeyV1("AAECAwQFBgcICQoLDA0ODx")))
      .toBe("OBJECT_ID_INVALID");
    expect(objectErrorCode(() => decodeObjectStoreKeyV1(
      "AAECAwQFBgcICQoLDA0ODw",
      filled(16, 0xff)
    ))).toBe("OBJECT_AAD_MISMATCH");
  });

  it("generates exactly 16 non-zero bytes and fails closed on bad random sources", () => {
    expect(generateObjectIdV1({ randomBytes: () => filled(16, 7) })).toEqual(filled(16, 7));
    expect(objectErrorCode(() => generateObjectIdV1({ randomBytes: () => filled(15, 1) })))
      .toBe("RANDOM_SOURCE_SHORT_READ");
    expect(objectErrorCode(() => generateObjectIdV1({ randomBytes: () => filled(16, 0) })))
      .toBe("RANDOM_SOURCE_ALL_ZERO");
    expect(objectErrorCode(() => generateObjectIdV1({
      randomBytes: () => { throw new Error("failed"); }
    }))).toBe("RANDOM_SOURCE_FAILED");
  });
});

describe("Object AAD v1", () => {
  it("encodes the exact 101-byte layout and roundtrips every variable field", () => {
    const encoded = encodeObjectAadV1({
      objectType: "manifest",
      domainId: filled(32, 0x11),
      objectId: filled(16, 0x22),
      snapshotId: filled(32, 0x33),
      ciphertextLength: 0x0102_0304_0506_0708n
    });
    expect(encoded).toHaveLength(OBJECT_AAD_V1_LENGTH);
    expect(Array.from(encoded.slice(0, 9))).toEqual([0x45, 0x4b, 0x44, 0x41, 1, 1, 1, 1, 1]);
    expect(encoded.slice(9, 41)).toEqual(filled(32, 0x11));
    expect(encoded.slice(41, 57)).toEqual(filled(16, 0x22));
    expect(encoded.slice(57, 89)).toEqual(filled(32, 0x33));
    expect(Array.from(encoded.slice(89))).toEqual([
      0, 12,
      1, 2, 3, 4, 5, 6, 7, 8,
      0, 16
    ]);
    expect(decodeObjectAadV1(encoded)).toEqual({
      objectType: "manifest",
      domainId: filled(32, 0x11),
      objectId: filled(16, 0x22),
      snapshotId: filled(32, 0x33),
      ciphertextLength: 0x0102_0304_0506_0708n
    });
  });

  it("rejects wrong size, magic, version, type, suite, nonce length, and tag length", () => {
    const valid = encodeObjectAadV1({
      objectType: "file",
      domainId: filled(32, 1),
      objectId: filled(16, 2),
      snapshotId: filled(32, 3),
      ciphertextLength: 4n
    });
    expect(objectErrorCode(() => decodeObjectAadV1(valid.slice(0, -1)))).toBe("OBJECT_AAD_MISMATCH");
    for (const offset of [0, 4, 5, 6, 7, 8, 90, 100]) {
      const bytes = valid.slice();
      bytes[offset] = 2;
      expect(objectErrorCode(() => decodeObjectAadV1(bytes))).toBe("OBJECT_AAD_MISMATCH");
    }
  });
});

describe("Object Envelope v1", () => {
  it("encodes the exact 19-byte header and roundtrips nonce, ciphertext, and tag", () => {
    const envelope = {
      nonce: filled(12, 0x11),
      ciphertext: new Uint8Array([1, 2, 3]),
      tag: filled(16, 0x22)
    };
    const encoded = encodeObjectEnvelopeV1(envelope);
    expect(encoded).toHaveLength(OBJECT_ENVELOPE_V1_HEADER_LENGTH + 12 + 3 + 16);
    expect(Array.from(encoded.slice(0, 19))).toEqual([
      0x45, 0x4b, 0x44, 0x4f,
      1, 1, 1,
      0, 12,
      0, 0, 0, 0, 0, 0, 0, 3,
      0, 16
    ]);
    expect(decodeObjectEnvelopeV1(encoded)).toEqual(envelope);
  });

  it("rejects every truncation length and any trailing byte", () => {
    const encoded = encodeObjectEnvelopeV1({
      nonce: filled(12, 1),
      ciphertext: new Uint8Array([1, 2, 3]),
      tag: filled(16, 2)
    });
    for (let length = 0; length < encoded.byteLength; length += 1) {
      expect(objectErrorCode(() => decodeObjectEnvelopeV1(encoded.slice(0, length))))
        .toBe("OBJECT_TRUNCATED");
    }
    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(encoded);
    expect(objectErrorCode(() => decodeObjectEnvelopeV1(trailing))).toBe("OBJECT_TRAILING_BYTES");
  });

  it("rejects wrong magic, version, suite, nonce length, and tag length", () => {
    const valid = encodeObjectEnvelopeV1({
      nonce: filled(12, 1),
      ciphertext: new Uint8Array([1]),
      tag: filled(16, 2)
    });
    for (const offset of [0, 4, 5, 6, 8, 18]) {
      const bytes = valid.slice();
      bytes[offset] = 2;
      expect(objectErrorCode(() => decodeObjectEnvelopeV1(bytes))).toBe("OBJECT_AAD_MISMATCH");
    }
  });
});
