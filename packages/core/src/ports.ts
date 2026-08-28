/** A byte sequence exchanged at a platform boundary. */
export type Bytes = Uint8Array;

/** A file observed by a VaultSource. The path is relative to the source root. */
export interface VaultEntry {
  readonly relativePath: string;
  readonly bytes: Bytes;
}

/** Read-only access to a Vault. Scanning policy belongs to a later phase. */
export interface VaultSource {
  readonly listFiles: () => AsyncIterable<VaultEntry>;
}

/** CSPRNG boundary. Implementations must fail rather than substitute a weak source. */
export interface RandomSource {
  readonly randomBytes: (length: number) => Bytes;
}

/** Time boundary for reports and diagnostics, not retention or protocol state. */
export interface Clock {
  readonly nowMilliseconds: () => number;
}

/** Opaque byte storage. Snapshot, object, and envelope semantics are intentionally absent. */
export interface ObjectStore {
  readonly put: (key: string, value: Bytes) => Promise<void>;
  readonly get: (key: string) => Promise<Bytes | undefined>;
}

/** Result shape shared by candidate implementations during the smoke spike. */
export interface AeadResult {
  readonly ciphertext: Bytes;
  readonly tag: Bytes;
}

/**
 * Byte-level candidate primitive surface for Phase 1 smoke tests.
 *
 * The concrete candidate, suite selection, wire format, and protocol codecs remain
 * deliberately unconfigured until the deferred-parameter gate is closed.
 */
export interface CryptoProvider {
  readonly randomBytes: (length: number) => Bytes;
  readonly aeadEncrypt: (
    key: Bytes,
    nonce: Bytes,
    plaintext: Bytes,
    aad: Bytes
  ) => Promise<AeadResult>;
  readonly aeadDecrypt: (
    key: Bytes,
    nonce: Bytes,
    ciphertext: Bytes,
    tag: Bytes,
    aad: Bytes
  ) => Promise<Bytes>;
  readonly hkdfSha256: (
    ikm: Bytes,
    salt: Bytes,
    info: Bytes,
    length: number
  ) => Promise<Bytes>;
  readonly wrapKey: (wrappingKey: Bytes, keyToWrap: Bytes) => Promise<Bytes>;
  readonly unwrapKey: (wrappingKey: Bytes, wrappedKey: Bytes) => Promise<Bytes>;
}

/** All platform-specific behavior enters the application through these ports. */
export interface CorePorts {
  readonly vaultSource: VaultSource;
  readonly cryptoProvider: CryptoProvider;
  readonly objectStore: ObjectStore;
  readonly randomSource: RandomSource;
  readonly clock: Clock;
}
