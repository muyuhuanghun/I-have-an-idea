export { CORE_VERSION, createCore } from "./core.js";
export { ManifestCodecError, VaultScanError } from "./errors.js";
export { decodeManifestPlaintextV1, encodeManifestPlaintextV1 } from "./manifest.js";
export { scanVault } from "./scan.js";
export type { Core } from "./core.js";
export type { ManifestCodecErrorCode, VaultScanErrorCode } from "./errors.js";
export type { ManifestEntryV1, ManifestPlaintextV1 } from "./manifest.js";
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
