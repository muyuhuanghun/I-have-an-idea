export type VaultScanErrorCode =
  | "CASE_COLLISION"
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

/**
 * Stable codes the ADR-0017 snapshot orchestration can return. Every value is a frozen
 * registry code; unexpected internal errors converge to `HONEST_CLAIM_VIOLATION` at the
 * orchestration boundary instead of leaking raw OS or library errors.
 */
export type SnapshotCreateErrorCode =
  | "CASE_COLLISION"
  | "DUPLICATE_OBJECT_REFERENCE"
  | "ENTRY_PATH_DUPLICATE"
  | "ENTRY_PATH_ESCAPE"
  | "FILE_CHANGED_DURING_SCAN"
  | "HONEST_CLAIM_VIOLATION"
  | "LOG_WRITE_FAILED"
  | "MANIFEST_AEAD_FAILED"
  | "OBJECT_AEAD_FAILED"
  | "OBJECT_ID_COLLISION"
  | "OBJECT_STORE_IO_FAILED"
  | "RANDOM_SOURCE_ALL_ZERO"
  | "RANDOM_SOURCE_FAILED"
  | "RANDOM_SOURCE_SHORT_READ"
  | "RECOVERY_FILE_WRITE_FAILED"
  | "RECOVERY_INTEGRITY_FAILED"
  | "REPARSE_POINT_FOUND"
  | "SOURCE_FILE_READ_FAILED"
  | "UNSUPPORTED_FILES_FOUND";

const SNAPSHOT_CREATE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "CASE_COLLISION",
  "DUPLICATE_OBJECT_REFERENCE",
  "ENTRY_PATH_DUPLICATE",
  "ENTRY_PATH_ESCAPE",
  "FILE_CHANGED_DURING_SCAN",
  "HONEST_CLAIM_VIOLATION",
  "LOG_WRITE_FAILED",
  "MANIFEST_AEAD_FAILED",
  "OBJECT_AEAD_FAILED",
  "OBJECT_ID_COLLISION",
  "OBJECT_STORE_IO_FAILED",
  "RANDOM_SOURCE_ALL_ZERO",
  "RANDOM_SOURCE_FAILED",
  "RANDOM_SOURCE_SHORT_READ",
  "RECOVERY_FILE_WRITE_FAILED",
  "RECOVERY_INTEGRITY_FAILED",
  "REPARSE_POINT_FOUND",
  "SOURCE_FILE_READ_FAILED",
  "UNSUPPORTED_FILES_FOUND"
]);

export function isSnapshotCreateErrorCode(code: string): code is SnapshotCreateErrorCode {
  return SNAPSHOT_CREATE_ERROR_CODES.has(code);
}

export class SnapshotCreateError extends Error {
  constructor(
    readonly code: SnapshotCreateErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SnapshotCreateError";
  }
}

/**
 * Stable codes the ADR-0018 restore orchestration can return. Every value is a frozen
 * registry code; unexpected internal errors converge to `HONEST_CLAIM_VIOLATION` at the
 * orchestration boundary. `INCOMPLETE_RESTORE` is deliberately absent: ADR-0018 §6 freezes
 * that v1 reports the specific cause plus `restoredFileCount` instead.
 */
export type RestoreErrorCode =
  | "CASE_COLLISION"
  | "DUPLICATE_OBJECT_REFERENCE"
  | "ENTRY_PATH_DUPLICATE"
  | "ENTRY_PATH_ESCAPE"
  | "ENTRY_SIZE_MISMATCH"
  | "HONEST_CLAIM_VIOLATION"
  | "MANIFEST_AEAD_FAILED"
  | "MANIFEST_FORMAT_INVALID"
  | "MANIFEST_SUITE_UNKNOWN"
  | "MANIFEST_TRAILING_BYTES"
  | "MANIFEST_VERSION_UNSUPPORTED"
  | "MISSING_OBJECT"
  | "NON_EMPTY_TARGET"
  | "OBJECT_AAD_MISMATCH"
  | "OBJECT_AEAD_FAILED"
  | "OBJECT_STORE_IO_FAILED"
  | "OBJECT_TRAILING_BYTES"
  | "OBJECT_TRUNCATED"
  | "RECOVERY_FIELD_MISSING"
  | "RECOVERY_INTEGRITY_FAILED"
  | "RECOVERY_MAGIC_MISMATCH"
  | "RECOVERY_SUITE_UNKNOWN"
  | "RECOVERY_TRAILING_BYTES"
  | "RECOVERY_TRUNCATED"
  | "RECOVERY_VERSION_UNSUPPORTED"
  | "REPARSE_POINT_FOUND"
  | "RESTORE_TARGET_WRITE_FAILED";

const RESTORE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "CASE_COLLISION",
  "DUPLICATE_OBJECT_REFERENCE",
  "ENTRY_PATH_DUPLICATE",
  "ENTRY_PATH_ESCAPE",
  "ENTRY_SIZE_MISMATCH",
  "HONEST_CLAIM_VIOLATION",
  "MANIFEST_AEAD_FAILED",
  "MANIFEST_FORMAT_INVALID",
  "MANIFEST_SUITE_UNKNOWN",
  "MANIFEST_TRAILING_BYTES",
  "MANIFEST_VERSION_UNSUPPORTED",
  "MISSING_OBJECT",
  "NON_EMPTY_TARGET",
  "OBJECT_AAD_MISMATCH",
  "OBJECT_AEAD_FAILED",
  "OBJECT_STORE_IO_FAILED",
  "OBJECT_TRAILING_BYTES",
  "OBJECT_TRUNCATED",
  "RECOVERY_FIELD_MISSING",
  "RECOVERY_INTEGRITY_FAILED",
  "RECOVERY_MAGIC_MISMATCH",
  "RECOVERY_SUITE_UNKNOWN",
  "RECOVERY_TRAILING_BYTES",
  "RECOVERY_TRUNCATED",
  "RECOVERY_VERSION_UNSUPPORTED",
  "REPARSE_POINT_FOUND",
  "RESTORE_TARGET_WRITE_FAILED"
]);

export function isRestoreErrorCode(code: string): code is RestoreErrorCode {
  return RESTORE_ERROR_CODES.has(code);
}

export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RestoreError";
  }
}
