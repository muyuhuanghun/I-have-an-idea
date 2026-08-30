export { CORE_VERSION, createCore } from "./core.js";
export { ManifestCodecError, RecoveryFileCodecError, VaultScanError } from "./errors.js";
export { decodeManifestPlaintextV1, encodeManifestPlaintextV1 } from "./manifest.js";
export {
  RECOVERY_FILE_V1_LENGTH,
  decodeRecoveryFileV1,
  encodeRecoveryFileV1,
  generateRecoveryFileV1
} from "./recovery.js";
export { scanVault } from "./scan.js";
export type { Core } from "./core.js";
export type {
  ManifestCodecErrorCode,
  RecoveryFileCodecErrorCode,
  VaultScanErrorCode
} from "./errors.js";
export type { ManifestEntryV1, ManifestPlaintextV1 } from "./manifest.js";
export type {
  RecoveryCryptoProvider,
  RecoveryFileV1,
  RecoveryFileV1Dependencies,
  RecoveryFileV1GenerationInput,
  RecoveryFileV1Material
} from "./recovery.js";
export type {
  AeadResult,
  Bytes,
  Clock,
  CorePorts,
  CryptoProvider,
  ObjectStore,
  RandomSource,
  VaultEntry,
  VaultSource
} from "./ports.js";
export type { ContentClass, ScannedVaultFile, VaultScanResult } from "./scan.js";
