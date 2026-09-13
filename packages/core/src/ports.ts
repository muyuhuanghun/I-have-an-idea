/** A byte sequence exchanged at a platform boundary. */
export type Bytes = Uint8Array;

/** A file observed by a VaultSource. Bytes are loaded only after core accepts its path. */
export interface VaultEntry {
  readonly relativePath: string;
  readonly readBytes: () => Promise<Bytes>;
}

/** Read-only access to a Vault. Platform adapters must not write to the source root. */
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

/** Opaque byte storage port reserved for later orchestration; Phase 3B codecs do not call it. */
export interface ObjectStore {
  readonly put: (key: string, value: Bytes) => Promise<void>;
  readonly get: (key: string) => Promise<Bytes | undefined>;
}

/**
 * ADR-0017 §3.1: mandatory snapshot run log. Exclusive creation happens in `open`; any
 * open/write/flush/close failure must fail the run with `LOG_WRITE_FAILED` before the
 * Recovery File is written. Implementations must keep the sink outside the Vault and the
 * ObjectStore; paths stay adapter-side and never enter the orchestration.
 */
export interface SnapshotLogSink {
  readonly open: () => Promise<void>;
  readonly writeLine: (line: string) => Promise<void>;
  readonly flushAndClose: () => Promise<void>;
}

/**
 * ADR-0017 §4.6: Recovery File target outside the Vault and ObjectStore. `verifyTargetAbsent`
 * is the preflight fast path; `writeExclusiveAndReadBack` is the authoritative exclusive-create
 * write with fsync, close, and byte-exact read-back. Any failure fails the run with
 * `RECOVERY_FILE_WRITE_FAILED`; implementations never overwrite an existing file.
 */
export interface RecoveryFileTarget {
  readonly verifyTargetAbsent: () => Promise<void>;
  readonly writeExclusiveAndReadBack: (bytes: Bytes) => Promise<void>;
}

/**
 * ADR-0018 §3.2: restore output boundary. The target must be a caller-created empty real
 * directory; `verifyEmptyTarget` is enforced before any write (INV-08). `relativePath` is a
 * canonical relative Vault path; adapters re-validate defensively (INV-06/ACC-19). Written
 * files are never read back and never fsynced — independent verification is the external
 * Python verifier's job.
 */
export interface RestoreTarget {
  readonly verifyEmptyTarget: () => Promise<void>;
  readonly writeRestoredFile: (relativePath: string, bytes: Bytes) => Promise<void>;
}

/** Result shape shared by candidate implementations during the smoke spike. */
export interface AeadResult {
  readonly ciphertext: Bytes;
  readonly tag: Bytes;
}

/**
 * Byte-level primitive surface selected by the Phase 1 smoke tests.
 *
 * The concrete candidate, suite selection, wire format, and protocol codecs remain
 * deliberately separate from the Phase 2 plaintext Manifest codec.
 */
export interface CryptoProvider {
  readonly randomBytes: (length: number) => Bytes;
  readonly sha256: (message: Bytes) => Promise<Bytes>;
  readonly hmacSha256: (key: Bytes, message: Bytes) => Promise<Bytes>;
  readonly verifyHmacSha256: (key: Bytes, message: Bytes, tag: Bytes) => Promise<boolean>;
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

/**
 * ADR-0026 §2.4 (P1-alpha state protocol): device signing boundary. The private key
 * never leaves the platform boundary; implementations must fail rather than substitute
 * a weak algorithm. Keys are ECDSA P-256 with SHA-256 digests; signatures are 64-byte
 * raw r||s values on the wire.
 */
export interface DeviceSignaturePort {
  readonly signHead: (signedBytes: Bytes) => Promise<Bytes>;
  readonly verifyHeadSignature: (signedBytes: Bytes, signature: Bytes, publicKeySpki: Bytes) => Promise<boolean>;
}

/**
 * ADR-0035 §3 (P1-beta team protocol): pairwise epoch-CEK wrapping boundary. ECDH
 * P-256 + HKDF-SHA-256 (salt = domain id, info = "ekd-group-epoch-cek-v1") +
 * AES-256-GCM; the AAD must bind domain id, epoch and member device id. Private
 * content-DH keys never leave the member device; only wrapped CEKs transit.
 */
export interface KeyAgreementPort {
  readonly generateContentDhPair: () => Promise<{ readonly private_pkcs8: Bytes; readonly spki: Bytes }>;
  readonly wrapCek: (input: {
    readonly domainId: Bytes;
    readonly epoch: number;
    readonly deviceId: string;
    readonly recipientSpki: Bytes;
    readonly cek: Bytes;
  }) => Promise<{ readonly ephemeral_spki: Bytes; readonly nonce: Bytes; readonly wrapped_cek: Bytes }>;
  readonly unwrapCek: (input: {
    readonly domainId: Bytes;
    readonly epoch: number;
    readonly deviceId: string;
    readonly own_private_pkcs8: Bytes;
    readonly ephemeral_spki: Bytes;
    readonly nonce: Bytes;
    readonly wrapped_cek: Bytes;
  }) => Promise<Bytes>;
}
