export { AdapterNotImplementedError, ObjectStoreAdapterError, VaultAdapterError } from "./errors.js";
export { DirectoryObjectStoreV1 } from "./node-object-store.js";
export {
  VISIBILITY_FORBIDDEN_EXTENSIONS,
  VISIBILITY_FORBIDDEN_FILE_MAGICS,
  VISIBILITY_MARKER_PREFIXES,
  VISIBILITY_SCAN_SCHEMA_VERSION,
  isVisibilityReportOutputOutsideStoreV1,
  isVisibilityReportOutputResolvedOutsideStoreV1,
  scanStorageVisibilityV1
} from "./storage-visibility-scanner.js";
export type {
  StorageVisibilityScanReportV1,
  VisibilityMarkerFamily,
  VisibilityScanControl,
  VisibilityScanFinding,
  VisibilityScanFindingKind,
  VisibilityScanInput,
  VisibilityScanKnownSecret,
  VisibilityScanSurface
} from "./storage-visibility-scanner.js";
export { writeRecoveryFileAndReadBack } from "./node-recovery-file.js";
export { NodeVaultSource, readStableFile } from "./node-vault.js";
export type { ObjectStoreAdapterErrorCode, VaultAdapterErrorCode } from "./errors.js";
export type { StableReadDependencies } from "./node-vault.js";
export { ObsidianVaultSource } from "./obsidian-vault.js";
export type { ObsidianVaultLike } from "./obsidian-vault.js";
