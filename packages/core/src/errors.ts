export type VaultScanErrorCode =
  | "ENTRY_PATH_DUPLICATE"
  | "ENTRY_PATH_ESCAPE"
  | "UNSUPPORTED_FILES_FOUND";

export class VaultScanError extends Error {
  constructor(
    readonly code: VaultScanErrorCode,
    message: string,
    readonly paths: readonly string[] = []
  ) {
    super(message);
    this.name = "VaultScanError";
  }
}

export type ManifestCodecErrorCode =
  | "DUPLICATE_OBJECT_REFERENCE"
  | "ENTRY_PATH_DUPLICATE"
  | "ENTRY_PATH_ESCAPE"
  | "MANIFEST_FORMAT_INVALID"
  | "MANIFEST_SUITE_UNKNOWN"
  | "MANIFEST_TRAILING_BYTES"
  | "MANIFEST_VERSION_UNSUPPORTED";

export class ManifestCodecError extends Error {
  constructor(readonly code: ManifestCodecErrorCode, message: string) {
    super(message);
    this.name = "ManifestCodecError";
  }
}

export type RecoveryFileCodecErrorCode =
  | "RANDOM_SOURCE_ALL_ZERO"
  | "RANDOM_SOURCE_FAILED"
  | "RANDOM_SOURCE_SHORT_READ"
  | "RECOVERY_FIELD_MISSING"
  | "RECOVERY_INTEGRITY_FAILED"
  | "RECOVERY_MAGIC_MISMATCH"
  | "RECOVERY_SUITE_UNKNOWN"
  | "RECOVERY_TRAILING_BYTES"
  | "RECOVERY_TRUNCATED"
  | "RECOVERY_VERSION_UNSUPPORTED";

export class RecoveryFileCodecError extends Error {
  constructor(readonly code: RecoveryFileCodecErrorCode, message: string) {
    super(message);
    this.name = "RecoveryFileCodecError";
  }
}

export type ObjectCodecErrorCode =
  | "ENTRY_SIZE_MISMATCH"
  | "MANIFEST_AEAD_FAILED"
  | "OBJECT_AAD_MISMATCH"
  | "OBJECT_AEAD_FAILED"
  | "OBJECT_ID_INVALID"
  | "OBJECT_TRAILING_BYTES"
  | "OBJECT_TRUNCATED"
  | "RANDOM_SOURCE_ALL_ZERO"
  | "RANDOM_SOURCE_FAILED"
  | "RANDOM_SOURCE_SHORT_READ";

export class ObjectCodecError extends Error {
  constructor(
    readonly code: ObjectCodecErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ObjectCodecError";
  }
}
