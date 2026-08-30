import { describe, expect, it } from "vitest";
import {
  decodeObjectEnvelopeV1,
  deriveDomainDataRootV1,
  deriveManifestKeyV1,
  deriveObjectWrapKeyV1,
  openFileObjectV1,
  openManifestObjectV1,
  sealFileObjectV1,
  sealManifestObjectV1,
  type ManifestPlaintextV1,
  type ObjectCryptoProvider,
  type RandomSource
} from "../../core/src/index.js";
import { WebCryptoAes256Provider } from "../src/webcrypto.js";

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu)?.map((part) => Number.parseInt(part, 16)) ?? []);
}

class SequenceRandomSource implements RandomSource {
  readonly #values: Uint8Array[];

  constructor(...values: Uint8Array[]) {
    this.#values = values.map((value) => value.slice());
  }

  randomBytes(length: number): Uint8Array {
    const value = this.#values.shift();
    if (value === undefined) throw new Error("Unexpected random request.");
    if (value.byteLength !== length) {
      throw new Error(`Expected a ${value.byteLength}-byte request; got ${length}.`);
    }
    return value;
  }
}

async function rejectionCode(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    throw error;
  }
  throw new Error("Expected operation to fail.");
}

describe("Phase 3B key derivation", () => {
  it("matches independently calculated HKDF-SHA-256 outputs for all three frozen labels", async () => {
    const provider = new WebCryptoAes256Provider();
    const recoveryRoot = filled(32, 0x44);
    const domainId = filled(32, 0x11);
    const domainDataRoot = await deriveDomainDataRootV1(recoveryRoot, domainId, provider);
    expect(domainDataRoot).toEqual(bytes("54b14ccf84047403a5af50493ca5ef154d2a4f517b204a0f54c05d5952c1037d"));
    expect(await deriveManifestKeyV1(domainDataRoot, domainId, provider))
      .toEqual(bytes("b7c3dcdce1004490d9ed479275be106a36d266b291785ccd91cd82a59d7c71cd"));
    expect(await deriveObjectWrapKeyV1(domainDataRoot, domainId, provider))
      .toEqual(bytes("262242efb8f3e696fef5babb3eace650eec67b8b8f521102376793b939f34286"));
  });
});

describe("Phase 3B file objects", () => {
  it("clears the exact object-key buffer returned by the random source", async () => {
    const provider = new WebCryptoAes256Provider();
    const domainId = filled(32, 0x11);
    const objectKey = filled(32, 0x55);
    const nonce = filled(12, 0x66);
    const randomValues = [objectKey, nonce];
    const randomSource: RandomSource = {
      randomBytes(length: number): Uint8Array {
        const value = randomValues.shift();
        if (value === undefined || value.byteLength !== length) {
          throw new Error("Unexpected random request.");
        }
        return value;
      }
    };
    const domainDataRoot = await deriveDomainDataRootV1(filled(32, 0x44), domainId, provider);
    const objectWrapKey = await deriveObjectWrapKeyV1(domainDataRoot, domainId, provider);

    await sealFileObjectV1(
      {
        domainId,
        snapshotId: filled(32, 0x22),
        objectId: filled(16, 0x33),
        objectWrapKey,
        plaintext: new Uint8Array([1])
      },
      { cryptoProvider: provider, randomSource }
    );

    expect(objectKey).toEqual(filled(32, 0));
    expect(nonce).toEqual(filled(12, 0x66));
  });

  it("wraps a fresh object key and roundtrips an empty file with the expected size and context", async () => {
    const provider = new WebCryptoAes256Provider();
    const domainId = filled(32, 0x11);
    const snapshotId = filled(32, 0x22);
    const objectId = filled(16, 0x33);
    const plaintext = new Uint8Array();
    const domainDataRoot = await deriveDomainDataRootV1(filled(32, 0x44), domainId, provider);
    const objectWrapKey = await deriveObjectWrapKeyV1(domainDataRoot, domainId, provider);
    const sealed = await sealFileObjectV1(
      { domainId, snapshotId, objectId, objectWrapKey, plaintext },
      {
        cryptoProvider: provider,
        randomSource: new SequenceRandomSource(filled(32, 0x55), filled(12, 0x66))
      }
    );

    expect(sealed.wrappedObjectKey).toHaveLength(40);
    expect(sealed.plaintextSize).toBe(BigInt(plaintext.byteLength));
    expect(decodeObjectEnvelopeV1(sealed.envelope).nonce).toEqual(filled(12, 0x66));
    expect(await openFileObjectV1(
      {
        domainId,
        snapshotId,
        objectId,
        objectWrapKey,
        envelope: sealed.envelope,
        wrappedObjectKey: sealed.wrappedObjectKey,
        expectedPlaintextSize: sealed.plaintextSize
      },
      provider
    )).toEqual(plaintext);

    expect(await rejectionCode(() => openFileObjectV1(
      {
        domainId,
        snapshotId,
        objectId,
        objectWrapKey,
        envelope: sealed.envelope,
        wrappedObjectKey: sealed.wrappedObjectKey,
        expectedPlaintextSize: sealed.plaintextSize + 1n
      },
      provider
    ))).toBe("ENTRY_SIZE_MISMATCH");
  });

  it("clears authenticated plaintext when the Manifest size claim is inconsistent", async () => {
    const provider = new WebCryptoAes256Provider();
    const domainId = filled(32, 0x11);
    const snapshotId = filled(32, 0x22);
    const objectId = filled(16, 0x33);
    const domainDataRoot = await deriveDomainDataRootV1(filled(32, 0x44), domainId, provider);
    const objectWrapKey = await deriveObjectWrapKeyV1(domainDataRoot, domainId, provider);
    const sealed = await sealFileObjectV1(
      { domainId, snapshotId, objectId, objectWrapKey, plaintext: new Uint8Array([1, 2, 3]) },
      {
        cryptoProvider: provider,
        randomSource: new SequenceRandomSource(filled(32, 0x55), filled(12, 0x66))
      }
    );
    let borrowedPlaintext: Uint8Array | undefined;
    const trackingProvider: ObjectCryptoProvider = {
      aeadEncrypt: provider.aeadEncrypt.bind(provider),
      aeadDecrypt: async (...args) => {
        borrowedPlaintext = await provider.aeadDecrypt(...args);
        return borrowedPlaintext;
      },
      wrapKey: provider.wrapKey.bind(provider),
      unwrapKey: provider.unwrapKey.bind(provider)
    };
    expect(await rejectionCode(() => openFileObjectV1(
      {
        domainId,
        snapshotId,
        objectId,
        objectWrapKey,
        envelope: sealed.envelope,
        wrappedObjectKey: sealed.wrappedObjectKey,
        expectedPlaintextSize: 4n
      },
      trackingProvider
    ))).toBe("ENTRY_SIZE_MISMATCH");
    expect(borrowedPlaintext).toEqual(new Uint8Array(3));
  });

  it("rejects ciphertext, tag, nonce, context, and wrapped-key tampering without plaintext", async () => {
    const provider = new WebCryptoAes256Provider();
    const domainId = filled(32, 1);
    const snapshotId = filled(32, 2);
    const objectId = filled(16, 3);
    const domainDataRoot = await deriveDomainDataRootV1(filled(32, 4), domainId, provider);
    const objectWrapKey = await deriveObjectWrapKeyV1(domainDataRoot, domainId, provider);
    const sealed = await sealFileObjectV1(
      { domainId, snapshotId, objectId, objectWrapKey, plaintext: new Uint8Array([1, 2, 3]) },
      {
        cryptoProvider: provider,
        randomSource: new SequenceRandomSource(filled(32, 5), filled(12, 6))
      }
    );
    const base = {
      domainId,
      snapshotId,
      objectId,
      objectWrapKey,
      wrappedObjectKey: sealed.wrappedObjectKey,
      expectedPlaintextSize: 3n
    };
    for (const offset of [19, 31, sealed.envelope.byteLength - 1]) {
      const envelope = sealed.envelope.slice();
      envelope[offset] ^= 1;
      expect(await rejectionCode(() => openFileObjectV1({ ...base, envelope }, provider)))
        .toBe("OBJECT_AEAD_FAILED");
    }
    expect(await rejectionCode(() => openFileObjectV1({
      ...base,
      objectId: filled(16, 9),
      envelope: sealed.envelope
    }, provider))).toBe("OBJECT_AEAD_FAILED");

    const wrappedObjectKey = sealed.wrappedObjectKey.slice();
    wrappedObjectKey[0] ^= 1;
    expect(await rejectionCode(() => openFileObjectV1({
      ...base,
      wrappedObjectKey,
      envelope: sealed.envelope
    }, provider))).toBe("OBJECT_AEAD_FAILED");
  });

  it("produces unlinkable bytes when the caller supplies fresh IDs and random material", async () => {
    const provider = new WebCryptoAes256Provider();
    const domainId = filled(32, 1);
    const snapshotId = filled(32, 2);
    const plaintext = new TextEncoder().encode("same plaintext");
    const domainDataRoot = await deriveDomainDataRootV1(filled(32, 3), domainId, provider);
    const objectWrapKey = await deriveObjectWrapKeyV1(domainDataRoot, domainId, provider);
    const first = await sealFileObjectV1(
      { domainId, snapshotId, objectId: filled(16, 4), objectWrapKey, plaintext },
      { cryptoProvider: provider, randomSource: new SequenceRandomSource(filled(32, 5), filled(12, 6)) }
    );
    const second = await sealFileObjectV1(
      { domainId, snapshotId, objectId: filled(16, 7), objectWrapKey, plaintext },
      { cryptoProvider: provider, randomSource: new SequenceRandomSource(filled(32, 8), filled(12, 9)) }
    );
    expect(second.envelope).not.toEqual(first.envelope);
    expect(second.wrappedObjectKey).not.toEqual(first.wrappedObjectKey);
  });
});

describe("Phase 3B Manifest objects", () => {
  it("seals the canonical Manifest and returns a validated plaintext structure", async () => {
    const provider = new WebCryptoAes256Provider();
    const domainId = filled(32, 0x11);
    const snapshotId = filled(32, 0x22);
    const objectId = filled(16, 0x33);
    const domainDataRoot = await deriveDomainDataRootV1(filled(32, 0x44), domainId, provider);
    const manifestKey = await deriveManifestKeyV1(domainDataRoot, domainId, provider);
    const manifest: ManifestPlaintextV1 = {
      domainId,
      snapshotId,
      parentSnapshotId: filled(32, 0),
      contentPolicyVersion: 1,
      suiteId: 1,
      entries: [{
        relativePath: "note.md",
        objectId: filled(16, 0x55),
        plaintextSize: 4n,
        wrappedObjectKey: filled(40, 0x66)
      }]
    };
    let borrowedSealPlaintext: Uint8Array | undefined;
    let borrowedOpenPlaintext: Uint8Array | undefined;
    const trackingProvider: ObjectCryptoProvider = {
      aeadEncrypt: async (...args) => {
        borrowedSealPlaintext = args[2];
        return provider.aeadEncrypt(...args);
      },
      aeadDecrypt: async (...args) => {
        borrowedOpenPlaintext = await provider.aeadDecrypt(...args);
        return borrowedOpenPlaintext;
      },
      wrapKey: provider.wrapKey.bind(provider),
      unwrapKey: provider.unwrapKey.bind(provider)
    };
    const envelope = await sealManifestObjectV1(
      { domainId, snapshotId, objectId, manifestKey, manifest },
      { cryptoProvider: trackingProvider, randomSource: new SequenceRandomSource(filled(12, 0x77)) }
    );
    expect(borrowedSealPlaintext?.every((byte) => byte === 0)).toBe(true);
    const opened = await openManifestObjectV1(
      { domainId, snapshotId, objectId, manifestKey, envelope },
      trackingProvider
    );
    expect(opened.entries.map((entry) => entry.relativePath)).toEqual(["note.md"]);
    expect(borrowedOpenPlaintext?.every((byte) => byte === 0)).toBe(true);

    const tampered = envelope.slice();
    tampered[tampered.byteLength - 1] ^= 1;
    expect(await rejectionCode(() => openManifestObjectV1(
      { domainId, snapshotId, objectId, manifestKey, envelope: tampered },
      provider
    ))).toBe("MANIFEST_AEAD_FAILED");
    expect(await rejectionCode(() => openManifestObjectV1(
      { domainId, snapshotId: filled(32, 9), objectId, manifestKey, envelope },
      provider
    ))).toBe("MANIFEST_AEAD_FAILED");

    const malformedPlaintext = new Uint8Array([1, 2, 3]);
    const malformedProvider: ObjectCryptoProvider = {
      ...trackingProvider,
      aeadDecrypt: async () => malformedPlaintext
    };
    expect(await rejectionCode(() => openManifestObjectV1(
      { domainId, snapshotId, objectId, manifestKey, envelope },
      malformedProvider
    ))).toBe("MANIFEST_FORMAT_INVALID");
    expect(malformedPlaintext).toEqual(new Uint8Array(3));
  });

  it("rejects a Manifest whose plaintext identity disagrees with its AAD context", async () => {
    const provider = new WebCryptoAes256Provider();
    const domainId = filled(32, 1);
    const snapshotId = filled(32, 2);
    const domainDataRoot = await deriveDomainDataRootV1(filled(32, 3), domainId, provider);
    const manifestKey = await deriveManifestKeyV1(domainDataRoot, domainId, provider);
    const manifest: ManifestPlaintextV1 = {
      domainId,
      snapshotId: filled(32, 9),
      parentSnapshotId: filled(32, 0),
      contentPolicyVersion: 1,
      suiteId: 1,
      entries: []
    };
    expect(await rejectionCode(() => sealManifestObjectV1(
      { domainId, snapshotId, objectId: filled(16, 4), manifestKey, manifest },
      { cryptoProvider: provider, randomSource: new SequenceRandomSource(filled(12, 5)) }
    ))).toBe("MANIFEST_FORMAT_INVALID");
  });
});
