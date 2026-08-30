import type { CryptoProvider } from "./ports.js";

const KEY_LENGTH = 32;
const DOMAIN_DATA_ROOT_INFO = new TextEncoder().encode("ekd-v1/domain-data-root");
const MANIFEST_KEY_INFO = new TextEncoder().encode("ekd-v1/manifest-key");
const OBJECT_WRAP_KEY_INFO = new TextEncoder().encode("ekd-v1/object-wrap-key");

export type KeyDerivationProvider = Pick<CryptoProvider, "hkdfSha256">;

function requireLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.byteLength !== expected) {
    throw new RangeError(`${label} must be exactly ${expected} bytes.`);
  }
}

async function deriveKey(
  provider: KeyDerivationProvider,
  ikm: Uint8Array,
  domainId: Uint8Array,
  info: Uint8Array,
  label: string
): Promise<Uint8Array> {
  requireLength(ikm, KEY_LENGTH, "IKM");
  requireLength(domainId, KEY_LENGTH, "domainId");
  const result = await provider.hkdfSha256(ikm, domainId, info, KEY_LENGTH);
  requireLength(result, KEY_LENGTH, label);
  return result;
}

export async function deriveDomainDataRootV1(
  recoveryRoot: Uint8Array,
  domainId: Uint8Array,
  provider: KeyDerivationProvider
): Promise<Uint8Array> {
  return deriveKey(provider, recoveryRoot, domainId, DOMAIN_DATA_ROOT_INFO, "domainDataRoot");
}

export async function deriveManifestKeyV1(
  domainDataRoot: Uint8Array,
  domainId: Uint8Array,
  provider: KeyDerivationProvider
): Promise<Uint8Array> {
  return deriveKey(provider, domainDataRoot, domainId, MANIFEST_KEY_INFO, "manifestKey");
}

export async function deriveObjectWrapKeyV1(
  domainDataRoot: Uint8Array,
  domainId: Uint8Array,
  provider: KeyDerivationProvider
): Promise<Uint8Array> {
  return deriveKey(provider, domainDataRoot, domainId, OBJECT_WRAP_KEY_INFO, "objectWrapKey");
}
