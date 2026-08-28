import type { AeadResult, Bytes, CryptoProvider } from "@ekd/core";
import { CryptoProviderUnavailableError } from "./errors.js";

/**
 * Explicit guard used by the scaffold until a smoke-tested candidate is selected.
 * It prevents callers from accidentally treating the package skeleton as a
 * production crypto implementation.
 */
export class UnconfiguredCryptoProvider implements CryptoProvider {
  randomBytes(_length: number): Bytes {
    void _length;
    throw new CryptoProviderUnavailableError();
  }

  async aeadEncrypt(
    _key: Bytes,
    _nonce: Bytes,
    _plaintext: Bytes,
    _aad: Bytes
  ): Promise<AeadResult> {
    void _key;
    void _nonce;
    void _plaintext;
    void _aad;
    throw new CryptoProviderUnavailableError();
  }

  async aeadDecrypt(
    _key: Bytes,
    _nonce: Bytes,
    _ciphertext: Bytes,
    _tag: Bytes,
    _aad: Bytes
  ): Promise<Bytes> {
    void _key;
    void _nonce;
    void _ciphertext;
    void _tag;
    void _aad;
    throw new CryptoProviderUnavailableError();
  }

  async hkdfSha256(
    _ikm: Bytes,
    _salt: Bytes,
    _info: Bytes,
    _length: number
  ): Promise<Bytes> {
    void _ikm;
    void _salt;
    void _info;
    void _length;
    throw new CryptoProviderUnavailableError();
  }

  async wrapKey(_wrappingKey: Bytes, _keyToWrap: Bytes): Promise<Bytes> {
    void _wrappingKey;
    void _keyToWrap;
    throw new CryptoProviderUnavailableError();
  }

  async unwrapKey(_wrappingKey: Bytes, _wrappedKey: Bytes): Promise<Bytes> {
    void _wrappingKey;
    void _wrappedKey;
    throw new CryptoProviderUnavailableError();
  }
}
