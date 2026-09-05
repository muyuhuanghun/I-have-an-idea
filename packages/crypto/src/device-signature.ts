// ADR-0026 §2.4: ECDSA P-256/SHA-256 device signing over WebCrypto. Works in Node
// (globalThis.crypto) and browsers alike; the private key never leaves the boundary —
// only pre-imported PKCS8 material is used, and public keys are imported from SPKI.
import { asArrayBuffer } from "./shared.js";
import type { DeviceSignaturePort, Bytes } from "@ekd/core";

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (c?.subtle === undefined) {
    throw new Error("WebCrypto subtle is unavailable; the device signature provider requires a WebCrypto runtime.");
  }
  return c.subtle;
}

export class WebCryptoDeviceSignatureProvider implements DeviceSignaturePort {
  /** The private key is bound at construction (PKCS8) and never leaves this boundary. */
  constructor(private readonly privateKeyPkcs8: Bytes) {}

  #signingKey: Promise<CryptoKey> | undefined;

  async #signing(): Promise<CryptoKey> {
    this.#signingKey ??= subtle().importKey(
      "pkcs8",
      asArrayBuffer(this.privateKeyPkcs8),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    return this.#signingKey;
  }

  async signHead(signedBytes: Bytes): Promise<Bytes> {
    const key = await this.#signing();
    // WebCrypto ECDSA signatures are already raw r||s (64 bytes) on both sides.
    const raw = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, asArrayBuffer(signedBytes)));
    if (raw.byteLength !== 64) throw new Error(`Device signature must be exactly 64 bytes; got ${raw.byteLength}.`);
    return raw;
  }

  async verifyHeadSignature(signedBytes: Bytes, signature: Bytes, publicKeySpki: Bytes): Promise<boolean> {
    const key = await subtle().importKey(
      "spki",
      asArrayBuffer(publicKeySpki),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, asArrayBuffer(signature), asArrayBuffer(signedBytes));
  }
}
