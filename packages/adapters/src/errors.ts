export type VaultAdapterErrorCode =
  | "ENTRY_PATH_ESCAPE"
  | "FILE_CHANGED_DURING_SCAN"
  | "REPARSE_POINT_FOUND"
  | "SOURCE_FILE_READ_FAILED";

export class VaultAdapterError extends Error {
  constructor(
    readonly code: VaultAdapterErrorCode,
    readonly relativePath: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "VaultAdapterError";
  }
}

/** ADR-0017 §3.1: stable codes for the snapshot log sink and Recovery File target adapters. */
export type SnapshotAdapterErrorCode =
  | "LOG_WRITE_FAILED"
  | "RECOVERY_FILE_WRITE_FAILED";

export class SnapshotAdapterError extends Error {
  constructor(
    readonly code: SnapshotAdapterErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SnapshotAdapterError";
  }
}

export type ObjectStoreAdapterErrorCode =
  | "OBJECT_ID_COLLISION"
  | "OBJECT_ID_INVALID"
  | "OBJECT_STORE_IO_FAILED"
  | "REPARSE_POINT_FOUND";

export class ObjectStoreAdapterError extends Error {
  constructor(
    readonly code: ObjectStoreAdapterErrorCode,
    readonly key: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ObjectStoreAdapterError";
  }
}

/** Stable error retained for adapters that are still outside the authorized phase. */
export class AdapterNotImplementedError extends Error {
  readonly code = "ADAPTER_NOT_IMPLEMENTED" as const;

  constructor(adapterName: string) {
    super(`${adapterName} is not enabled in the current phase.`);
    this.name = "AdapterNotImplementedError";
  }
}
