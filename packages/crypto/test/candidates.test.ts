import { describe, expect, it } from "vitest";
import { NobleAes256Provider } from "../src/noble.js";
import { WebCryptoAes256Provider } from "../src/webcrypto.js";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)?.map((part) => Number.parseInt(part, 16)) ?? []);
}

const providers = [
  ["webcrypto", () => new WebCryptoAes256Provider()],
  ["noble", () => new NobleAes256Provider()]
] as const;

describe.each(providers)("%s candidate", (_name, createProvider) => {
  it("matches the NIST AES-256-GCM empty-message vector", async () => {
    const provider = createProvider();
    const result = await provider.aeadEncrypt(
      bytes("b52c505a37d78eda5dd34f20c22540ea1b58963cf8e5bf8ffa85f9f2492505b4"),
      bytes("516c33929df5a3284ff463d7"),
      new Uint8Array(),
      new Uint8Array()
    );
    expect(result.ciphertext).toEqual(new Uint8Array());
    expect(result.tag).toEqual(bytes("bdc1ac884d332457a1d2664f168c76f0"));
  });

  it("matches RFC 5869 SHA-256 case 1", async () => {
    const provider = createProvider();
    const output = await provider.hkdfSha256(
      bytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
      bytes("000102030405060708090a0b0c"),
      bytes("f0f1f2f3f4f5f6f7f8f9"),
      42
    );
    expect(output).toEqual(bytes("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"));
  });

  it("matches the NIST AES-256-KW vector and rejects tampering", async () => {
    const provider = createProvider();
    const kek = bytes("f59782f1dceb0544a8da06b34969b9212b55ce6dcbdd0975a33f4b3f88b538da");
    const material = bytes("73d33060b5f9f2eb5785c0703ddfa704");
    const wrapped = await provider.wrapKey(kek, material);
    expect(wrapped).toEqual(bytes("2e63946ea3c090902fa1558375fdb2907742ac74e39403fc"));
    expect(await provider.unwrapKey(kek, wrapped)).toEqual(material);
    const tampered = wrapped.slice();
    tampered[0] ^= 1;
    await expect(provider.unwrapKey(kek, tampered)).rejects.toMatchObject({ code: "OBJECT_KEY_UNWRAP_FAILED" });
  });
});

it("fails closed on short, failed, and all-zero random sources", () => {
  expect(() => new WebCryptoAes256Provider({ randomBytes: (length) => new Uint8Array(length - 1) }).randomBytes(32))
    .toThrowError(expect.objectContaining({ code: "RANDOM_SOURCE_SHORT_READ" }));
  expect(() => new WebCryptoAes256Provider({ randomBytes: () => { throw new Error("boom"); } }).randomBytes(32))
    .toThrowError(expect.objectContaining({ code: "RANDOM_SOURCE_FAILED" }));
  expect(() => new WebCryptoAes256Provider({ randomBytes: (length) => new Uint8Array(length) }).randomBytes(32))
    .toThrowError(expect.objectContaining({ code: "RANDOM_SOURCE_ALL_ZERO" }));
});
