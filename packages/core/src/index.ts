export { CORE_VERSION, createCore } from "./core.js";
export {
  ManifestCodecError,
  ObjectCodecError,
  RecoveryFileCodecError,
  RestoreError,
  SnapshotCreateError,
  VaultScanError
} from "./errors.js";
export { isRestoreErrorCode, isSnapshotCreateErrorCode } from "./errors.js";
export {
  deriveDomainDataRootV1,
  deriveManifestKeyV1,
  deriveObjectWrapKeyV1
} from "./keys.js";
export { decodeManifestPlaintextV1, encodeManifestPlaintextV1 } from "./manifest.js";
export { windowsCaseFoldV1, canonicalRelativePathBytes, decodeCanonicalRelativePath } from "./paths.js";
export {
  OBJECT_AAD_V1_LENGTH,
  OBJECT_ENVELOPE_V1_HEADER_LENGTH,
  decodeObjectAadV1,
  decodeObjectEnvelopeV1,
  decodeObjectStoreKeyV1,
  encodeObjectAadV1,
  encodeObjectEnvelopeV1,
  encodeObjectStoreKeyV1,
  generateObjectIdV1,
  openFileObjectV1,
  openManifestObjectV1,
  sealFileObjectV1,
  sealManifestObjectV1
} from "./object.js";
export {
  RECOVERY_FILE_V1_LENGTH,
  decodeRecoveryFileV1,
  encodeRecoveryFileV1,
  generateRecoveryFileV1
} from "./recovery.js";
export { scanVault } from "./scan.js";
export {
  HEAD_RECORD_WIRE_LENGTH,
  HEAD_SIGNED_BYTES_LENGTH,
  createHeadRecordV1,
  decodeHeadRecordWire,
  encodeHeadRecordWire,
  encodeHeadSignedBytes,
  verifyHeadRecordWire,
  HeadError,
  type HeadErrorCode,
  type HeadRecordInputV1,
  type HeadRecordV1,
  type HeadSigner,
  type HeadVerifier
} from "./head.js";
export { createSnapshotV1 } from "./snapshot.js";
export { restoreSnapshotV1 } from "./restore.js";
export type { Core } from "./core.js";
export type { DeviceSignaturePort } from "./ports.js";
export type {
  ManifestCodecErrorCode,
  ObjectCodecErrorCode,
  RecoveryFileCodecErrorCode,
  RestoreErrorCode,
  SnapshotCreateErrorCode,
  VaultScanErrorCode
} from "./errors.js";
export type { ManifestEntryV1, ManifestPlaintextV1 } from "./manifest.js";
export type { KeyDerivationProvider } from "./keys.js";
export type {
  ObjectAadV1,
  ObjectContextV1,
  ObjectCryptoProvider,
  ObjectEnvelopeV1,
  ObjectSealDependencies,
  ObjectTypeV1,
  OpenFileObjectV1Input,
  OpenManifestObjectV1Input,
  SealFileObjectV1Input,
  SealManifestObjectV1Input,
  SealedFileObjectV1
} from "./object.js";
export type {
  RecoveryCryptoProvider,
  RecoveryFileV1,
  RecoveryFileV1Dependencies,
  RecoveryFileV1GenerationInput,
  RecoveryFileV1Material
} from "./recovery.js";
export type {
  RestoreDependencies,
  RestoreInputV1,
  RestoreOutputInventoryEntryV1,
  RestoreOutputStateV1,
  RestorePhase,
  RestoreResultV1,
  RestoreStatus
} from "./restore.js";
export type {
  SnapshotCreateDependencies,
  SnapshotCreateInputV1,
  SnapshotCreatePhase,
  SnapshotCreateResultV1,
  SnapshotCreateStatus,
  SnapshotRuntimeLimitsV1
} from "./snapshot.js";
export type {
  AeadResult,
  Bytes,
  Clock,
  CorePorts,
  CryptoProvider,
  ObjectStore,
  RandomSource,
  RecoveryFileTarget,
  RestoreTarget,
  SnapshotLogSink,
  VaultEntry,
  VaultSource
} from "./ports.js";
export type { ContentClass, ScannedVaultFile, VaultScanResult } from "./scan.js";
