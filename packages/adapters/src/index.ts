export { AdapterNotImplementedError, ObjectStoreAdapterError, SnapshotAdapterError, VaultAdapterError } from "./errors.js";
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
export { NodeRecoveryFileTarget, NodeSnapshotLogSink } from "./node-snapshot-io.js";
export { NodeRestoreTarget, type NodeRestoreTargetOptions, type ReparsePointProbe } from "./node-restore-io.js";
export { NodeVaultSource, readStableFile, VAULT_SOURCE_READ_CHUNK_BYTES } from "./node-vault.js";
export type {
  ObjectStoreAdapterErrorCode,
  SnapshotAdapterErrorCode,
  VaultAdapterErrorCode
} from "./errors.js";
export type { StableReadDependencies } from "./node-vault.js";
export { ObsidianVaultSource } from "./obsidian-vault.js";
export type {
  ObsidianFileLike,
  ObsidianFileStatLike,
  ObsidianVaultLike,
  ObsidianVaultSourceOptions
} from "./obsidian-vault.js";
