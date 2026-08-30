import type { AeadResult, Bytes, CryptoProvider } from "@ekd/core";
import { CryptoPrimitiveError } from "./errors.js";
import {
  asArrayBuffer,
  assertByteLength,
  checkedRandomBytes,
  type RandomBytesFunction
} from "./shared.js";

export const WEBCRYPTO_CANDIDATE = Object.freeze({
  name: "webcrypto",
  version: "wrapper-0.1.0",
  packageIntegrity: "platform-webcrypto-bound-by-environment"
});

export interface WebCryptoProviderOptions {
  readonly crypto?: Crypto;
  readonly randomBytes?: RandomBytesFunction;
}

/** Browser/Node Web Crypto candidate for the Phase 1 AES suite smoke matrix. */
export class WebCryptoAes256Provider implements CryptoProvider {
  readonly #crypto: Crypto;
  readonly #randomBytes: RandomBytesFunction;

  constructor(options: WebCryptoProviderOptions = {}) {
    const crypto = options.crypto ?? globalThis.crypto;
    if (crypto?.subtle === undefined) {
      throw new CryptoPrimitiveError("CRYPTO_INPUT_INVALID", "Web Crypto SubtleCrypto is unavailable.");
    }
    this.#crypto = crypto;
    this.#randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  }

  randomBytes(length: number): Bytes {
    return checkedRandomBytes(this.#randomBytes, length);
  }

  async sha256(message: Bytes): Promise<Bytes> {
    return new Uint8Array(await this.#crypto.subtle.digest("SHA-256", asArrayBuffer(message)));
  }

  async hmacSha256(key: Bytes, message: Bytes): Promise<Bytes> {
    const cryptoKey = await this.#crypto.subtle.importKey(
      "raw",
      asArrayBuffer(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return new Uint8Array(await this.#crypto.subtle.sign("HMAC", cryptoKey, asArrayBuffer(message)));
  }

  async verifyHmacSha256(key: Bytes, message: Bytes, tag: Bytes): Promise<boolean> {
    if (tag.byteLength !== 32) return false;
    const cryptoKey = await this.#crypto.subtle.importKey(
      "raw",
      asArrayBuffer(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return this.#crypto.subtle.verify("HMAC", cryptoKey, asArrayBuffer(tag), asArrayBuffer(message));
  }

  async aeadEncrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes): Promise<AeadResult> {
    assertByteLength(key, 32, "AES-256-GCM key");
    assertByteLength(nonce, 12, "AES-GCM nonce");
    const cryptoKey = await this.#crypto.subtle.importKey(
      "raw",
      asArrayBuffer(key),
      "AES-GCM",
      false,
      ["encrypt"]
    );
    const sealed = new Uint8Array(await this.#crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad), tagLength: 128 },
      cryptoKey,
      asArrayBuffer(plaintext)
    ));
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
    try {
      const cryptoKey = await this.#crypto.subtle.importKey(
        "raw",
        asArrayBuffer(key),
        "AES-GCM",
        false,
        ["decrypt"]
      );
      const sealed = new Uint8Array(ciphertext.byteLength + tag.byteLength);
      sealed.set(ciphertext);
      sealed.set(tag, ciphertext.byteLength);
      return new Uint8Array(await this.#crypto.subtle.decrypt(
        { name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad), tagLength: 128 },
        cryptoKey,
        sealed
      ));
    } catch (error) {
      throw new CryptoPrimitiveError("OBJECT_AEAD_FAILED", "AES-GCM authentication failed.", { cause: error });
    }
  }

  async hkdfSha256(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new CryptoPrimitiveError("CRYPTO_INPUT_INVALID", "HKDF output length must be positive.");
    }
    const key = await this.#crypto.subtle.importKey("raw", asArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await this.#crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(salt), info: asArrayBuffer(info) },
      key,
      length * 8
    ));
  }

  async wrapKey(wrappingKey: Bytes, keyToWrap: Bytes): Promise<Bytes> {
    assertByteLength(wrappingKey, 32, "AES-256-KW key");
    if (![16, 24, 32].includes(keyToWrap.byteLength)) {
      throw new CryptoPrimitiveError("CRYPTO_INPUT_INVALID", "AES-KW key material must be 16, 24, or 32 bytes.");
    }
    const kek = await this.#crypto.subtle.importKey("raw", asArrayBuffer(wrappingKey), "AES-KW", false, ["wrapKey"]);
    const contentKey = await this.#crypto.subtle.importKey(
      "raw",
      asArrayBuffer(keyToWrap),
      { name: "AES-GCM", length: keyToWrap.byteLength * 8 },
      true,
      ["encrypt"]
    );
    return new Uint8Array(await this.#crypto.subtle.wrapKey("raw", contentKey, kek, "AES-KW"));
  }

  async unwrapKey(wrappingKey: Bytes, wrappedKey: Bytes): Promise<Bytes> {
    assertByteLength(wrappingKey, 32, "AES-256-KW key");
    const unwrappedLength = wrappedKey.byteLength - 8;
    if (![16, 24, 32].includes(unwrappedLength)) {
      throw new CryptoPrimitiveError("OBJECT_KEY_UNWRAP_FAILED", "AES-KW wrapped material has an invalid length.");
    }
    try {
      const kek = await this.#crypto.subtle.importKey("raw", asArrayBuffer(wrappingKey), "AES-KW", false, ["unwrapKey"]);
      const contentKey = await this.#crypto.subtle.unwrapKey(
        "raw",
        asArrayBuffer(wrappedKey),
        kek,
        "AES-KW",
        { name: "AES-GCM", length: unwrappedLength * 8 },
        true,
        ["encrypt"]
      );
      return new Uint8Array(await this.#crypto.subtle.exportKey("raw", contentKey));
    } catch (error) {
      throw new CryptoPrimitiveError("OBJECT_KEY_UNWRAP_FAILED", "AES-KW integrity check failed.", { cause: error });
    }
  }
}
