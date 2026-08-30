import type { AeadResult, Bytes, CryptoProvider } from "@ekd/core";
import { aeskw, gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CryptoPrimitiveError } from "./errors.js";
import {
  assertByteLength,
  checkedRandomBytes,
  type RandomBytesFunction
} from "./shared.js";

export const NOBLE_CANDIDATE = Object.freeze({
  name: "noble-ciphers-hashes",
  version: "2.3.0+2.3.0",
  packageIntegrity: "@noble/ciphers@2.3.0=sha512-Clu/xdfgVTf9o7ngLOURaxePwR0j8sjclKEtVij10/jGulwFsPWCvvRgG/XjUVf8Nei+jLG6uwyXzUTGY1DQrw==;@noble/hashes@2.3.0=sha512-oN+QwyX7VSHotibwubG3kpzbwKrfnyR6OOO+3Nk/53ADL7FmgHHz4TgrbaYKvvOw09u6QTx0oiH1cNCIOuN0CQ=="
});

export interface NobleProviderOptions {
  readonly randomBytes?: RandomBytesFunction;
  readonly crypto?: Crypto;
}

/** Pure JavaScript Noble candidate for the same Phase 1 AES suite matrix. */
export class NobleAes256Provider implements CryptoProvider {
  readonly #randomBytes: RandomBytesFunction;

  constructor(options: NobleProviderOptions = {}) {
    const crypto = options.crypto ?? globalThis.crypto;
    this.#randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  }

  randomBytes(length: number): Bytes {
    return checkedRandomBytes(this.#randomBytes, length);
  }

  async sha256(message: Bytes): Promise<Bytes> {
    return sha256(message);
  }

  async hmacSha256(key: Bytes, message: Bytes): Promise<Bytes> {
    return hmac(sha256, key, message);
  }

  async verifyHmacSha256(key: Bytes, message: Bytes, tag: Bytes): Promise<boolean> {
    if (tag.byteLength !== 32) return false;
    const expected = hmac(sha256, key, message);
    let difference = 0;
    for (let index = 0; index < expected.byteLength; index += 1) {
      difference |= (expected[index] ?? 0) ^ (tag[index] ?? 0);
    }
    return difference === 0;
  }

  async aeadEncrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes): Promise<AeadResult> {
    assertByteLength(key, 32, "AES-256-GCM key");
    assertByteLength(nonce, 12, "AES-GCM nonce");
    const sealed = gcm(key, nonce, aad).encrypt(plaintext);
    const tagOffset = sealed.byteLength - 16;
    return { ciphertext: sealed.slice(0, tagOffset), tag: sealed.slice(tagOffset) };
  }

  async aeadDecrypt(
    key: Bytes,
    nonce: Bytes,
    ciphertext: Bytes,
    tag: Bytes,
    aad: Bytes
  ): Promise<Bytes> {
    assertByteLength(key, 32, "AES-256-GCM key");
    assertByteLength(nonce, 12, "AES-GCM nonce");
    assertByteLength(tag, 16, "AES-GCM tag");
    const sealed = new Uint8Array(ciphertext.byteLength + tag.byteLength);
    sealed.set(ciphertext);
    sealed.set(tag, ciphertext.byteLength);
    try {
      return gcm(key, nonce, aad).decrypt(sealed);
    } catch (error) {
      throw new CryptoPrimitiveError("OBJECT_AEAD_FAILED", "AES-GCM authentication failed.", { cause: error });
    }
  }

  async hkdfSha256(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new CryptoPrimitiveError("CRYPTO_INPUT_INVALID", "HKDF output length must be positive.");
    }
    return hkdf(sha256, ikm, salt, info, length);
  }

  async wrapKey(wrappingKey: Bytes, keyToWrap: Bytes): Promise<Bytes> {
    assertByteLength(wrappingKey, 32, "AES-256-KW key");
    if (![16, 24, 32].includes(keyToWrap.byteLength)) {
      throw new CryptoPrimitiveError("CRYPTO_INPUT_INVALID", "AES-KW key material must be 16, 24, or 32 bytes.");
    }
    return aeskw(wrappingKey).encrypt(keyToWrap);
  }

  async unwrapKey(wrappingKey: Bytes, wrappedKey: Bytes): Promise<Bytes> {
    assertByteLength(wrappingKey, 32, "AES-256-KW key");
    try {
      return aeskw(wrappingKey).decrypt(wrappedKey);
    } catch (error) {
      throw new CryptoPrimitiveError("OBJECT_KEY_UNWRAP_FAILED", "AES-KW integrity check failed.", { cause: error });
    }
  }
}
