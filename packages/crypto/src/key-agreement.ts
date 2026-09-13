// ADR-0035 §3: pairwise epoch-CEK wrapping over WebCrypto — ECDH P-256 ephemeral
// agreement, HKDF-SHA-256 (salt = domain id, info = "ekd-group-epoch-cek-v1"),
// AES-256-GCM with the contract AAD (domain id || epoch u64BE || device id).
// Works in Node and browsers alike; private keys never leave this boundary's caller.
import { asArrayBuffer } from "./shared.js";
import { deviceIdBytes, type Bytes, type KeyAgreementPort } from "@ekd/core";

const HKDF_INFO = new TextEncoder().encode("ekd-group-epoch-cek-v1");

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (c?.subtle === undefined) {
    throw new Error("WebCrypto subtle is unavailable; the key agreement provider requires a WebCrypto runtime.");
  }
  return c.subtle;
}

async function importDhPublic(spki: Bytes): Promise<CryptoKey> {
  return subtle().importKey("spki", asArrayBuffer(spki), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function importDhPrivate(pkcs8: Bytes): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", asArrayBuffer(pkcs8), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

/** ECDH agreement bits → HKDF-SHA-256 → 256-bit AES-GCM wrapping key. */
async function wrappingKey(agreeFrom: CryptoKey, publicKeySpki: Bytes, domainId: Bytes): Promise<CryptoKey> {
  const shared = new Uint8Array(
    await subtle().deriveBits({ name: "ECDH", public: await importDhPublic(publicKeySpki) }, agreeFrom, 256)
  );
  const hkdfBase = await subtle().importKey("raw", asArrayBuffer(shared), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(domainId), info: asArrayBuffer(HKDF_INFO) },
    hkdfBase,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function aad(input: { domainId: Bytes; epoch: number; deviceId: string }): Uint8Array {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(input.epoch), false);
  const device = deviceIdBytes(input.deviceId);
  const out = new Uint8Array(input.domainId.byteLength + 8 + device.byteLength);
  out.set(input.domainId, 0);
  out.set(new Uint8Array(view.buffer), input.domainId.byteLength);
  out.set(device, input.domainId.byteLength + 8);
  return out;
}

export class WebCryptoKeyAgreementProvider implements KeyAgreementPort {
  async generateContentDhPair(): Promise<{ readonly private_pkcs8: Bytes; readonly spki: Bytes }> {
    const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
    const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
    return { private_pkcs8: pkcs8, spki };
  }

  async wrapCek(input: {
    domainId: Bytes;
    epoch: number;
    deviceId: string;
    recipientSpki: Bytes;
    cek: Bytes;
  }): Promise<{ readonly ephemeral_spki: Bytes; readonly nonce: Bytes; readonly wrapped_cek: Bytes }> {
    const ephemeral = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const wrapping = await wrappingKey(ephemeral.privateKey, input.recipientSpki, input.domainId);
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(
      await subtle().encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad(input), tagLength: 128 },
        wrapping,
        asArrayBuffer(input.cek)
      )
    );
    const ephemeral_spki = new Uint8Array(await subtle().exportKey("spki", ephemeral.publicKey));
    return { ephemeral_spki, nonce, wrapped_cek: wrapped };
  }

  async unwrapCek(input: {
    domainId: Bytes;
    epoch: number;
    deviceId: string;
    own_private_pkcs8: Bytes;
    ephemeral_spki: Bytes;
    nonce: Bytes;
    wrapped_cek: Bytes;
  }): Promise<Bytes> {
    const own = await importDhPrivate(input.own_private_pkcs8);
    const wrapping = await wrappingKey(own, input.ephemeral_spki, input.domainId);
    try {
      return new Uint8Array(
        await subtle().decrypt(
          { name: "AES-GCM", iv: input.nonce, additionalData: aad(input), tagLength: 128 },
          wrapping,
          asArrayBuffer(input.wrapped_cek)
        )
      );
    } catch (error) {
      throw new Error("Epoch CEK unwrap failed; wrapping does not match this device, epoch or domain.", { cause: error });
    }
  }
}
