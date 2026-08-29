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
