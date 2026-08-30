import { isRestoreErrorCode, RestoreError, type RestoreErrorCode } from "./errors.js";
import { deriveDomainDataRootV1, deriveManifestKeyV1, deriveObjectWrapKeyV1 } from "./keys.js";
import { encodeObjectStoreKeyV1, openFileObjectV1, openManifestObjectV1 } from "./object.js";
import { windowsCaseFoldV1 } from "./paths.js";
import type { Bytes, CryptoProvider, ObjectStore, RestoreTarget } from "./ports.js";
import { decodeRecoveryFileV1 } from "./recovery.js";

export type RestoreStatus = "complete" | "failed";
export type RestorePhase = "validate_recovery" | "fetch_manifest" | "validate_target" | "write_files";
export type RestoreOutputStateV1 = "complete" | "possibly_partial";

export interface RestoreOutputInventoryEntryV1 {
  /** Zero-based index in the authenticated canonical Manifest entry list; never a raw path. */
  readonly manifestEntryIndex: number;
  readonly state: RestoreOutputStateV1;
}

export interface RestoreInputV1 {
  /** The 167-byte Recovery File; the orchestration performs no file I/O of its own. */
  readonly recoveryFileBytes: Bytes;
}

export interface RestoreDependencies {
  /** Read-only access to the ObjectStore; restore never calls `put` (ADR-0018 §3.1). */
  readonly objectStore: ObjectStore;
  readonly cryptoProvider: CryptoProvider;
  readonly restoreTarget: RestoreTarget;
}

export interface RestoreResultV1 {
  readonly status: RestoreStatus;
  readonly recoveryFileValid: boolean;
  readonly manifestEntryCount?: number;
  readonly restoredFileCount: number;
  readonly totalBytesWritten: number;
  /** Present on every failed run, including as an empty list when no target write was attempted. */
  readonly partialOutputInventory?: readonly RestoreOutputInventoryEntryV1[];
  readonly errorCode?: RestoreErrorCode;
  readonly failedPhase?: RestorePhase;
}

function structuralCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** ADR-0018 §4.3: Windows case-folding collisions cannot restore onto the P0 target. */
function requireNoCaseFoldCollision(entries: ReadonlyArray<{ readonly relativePath: string }>): void {
  const folded = new Map<string, string>();
  for (const entry of entries) {
    const key = windowsCaseFoldV1(entry.relativePath);
    const conflict = folded.get(key);
    if (conflict !== undefined) {
      throw new RestoreError(
        "CASE_COLLISION",
        "Manifest contains paths that collide under the frozen Windows case-folding rule; restore fails before any write."
      );
    }
    folded.set(key, entry.relativePath);
  }
}

function requireSafeByteTotal(total: number): number {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RestoreError("HONEST_CLAIM_VIOLATION", "Restored byte total exceeds the safe JSON integer range.");
  }
  return total;
}

/**
 * ADR-0018 §4: the single accepted restore order — strict Recovery File decode, Manifest
 * fetch and full validation (including case-fold collisions) before the target is even
 * inspected, then sequential decrypt-and-write in Manifest canonical order. Restore only
 * ever calls `ObjectStore.get`, performs no per-file fsync or read-back, and leaves honest
 * partial residue on failure with `restoredFileCount` reporting exactly what was written.
 */
export async function restoreSnapshotV1(
  input: RestoreInputV1,
  deps: RestoreDependencies
): Promise<RestoreResultV1> {
  let recoveryFileValid = false;
  let manifestEntryCount: number | undefined;
  let restoredFileCount = 0;
  let totalBytesWritten = 0;
  let phase: RestorePhase = "validate_recovery";
  let recoveryRoot: Bytes | undefined;
  let domainDataRoot: Bytes | undefined;
  let manifestKey: Bytes | undefined;
  let objectWrapKey: Bytes | undefined;
  const partialOutputInventory: RestoreOutputInventoryEntryV1[] = [];

  const failedResult = (errorCode: RestoreErrorCode): RestoreResultV1 => {
    const base: RestoreResultV1 = {
      status: "failed",
      recoveryFileValid,
      restoredFileCount,
      totalBytesWritten,
      partialOutputInventory: partialOutputInventory.map((entry) => ({ ...entry }))
    };
    return manifestEntryCount === undefined
      ? { ...base, errorCode, failedPhase: phase }
      : { ...base, manifestEntryCount, errorCode, failedPhase: phase };
  };

  try {
    if (!(input.recoveryFileBytes instanceof Uint8Array)) {
      throw new RestoreError("HONEST_CLAIM_VIOLATION", "Recovery File bytes are missing.");
    }
    const recovery = await decodeRecoveryFileV1(input.recoveryFileBytes, deps.cryptoProvider);
    recoveryFileValid = true;
    recoveryRoot = recovery.recoveryRoot;

    // Keys are derived exclusively from the decoded Recovery File; the caller cannot inject
    // identity, and a wrong recovery root simply fails AEAD authentication downstream.
    phase = "fetch_manifest";
    domainDataRoot = await deriveDomainDataRootV1(recovery.recoveryRoot, recovery.domainId, deps.cryptoProvider);
    manifestKey = await deriveManifestKeyV1(domainDataRoot, recovery.domainId, deps.cryptoProvider);
    objectWrapKey = await deriveObjectWrapKeyV1(domainDataRoot, recovery.domainId, deps.cryptoProvider);

    const manifestObjectKey = encodeObjectStoreKeyV1(recovery.manifestObjectId);
    let manifestEnvelope: Bytes | undefined;
    try {
      manifestEnvelope = await deps.objectStore.get(manifestObjectKey);
    } catch (error) {
      throw new RestoreError("OBJECT_STORE_IO_FAILED", "Manifest object could not be read from the ObjectStore.", { cause: error });
    }
    if (manifestEnvelope === undefined) {
      throw new RestoreError("MISSING_OBJECT", "Recovery File points at a Manifest object that is absent from the ObjectStore.");
    }
    const manifest = await openManifestObjectV1(
      {
        domainId: recovery.domainId,
        objectId: recovery.manifestObjectId,
        snapshotId: recovery.snapshotId,
        envelope: manifestEnvelope,
        manifestKey
      },
      deps.cryptoProvider
    );
    manifestEntryCount = manifest.entries.length;

    // Full Manifest validation happens before the target is even inspected (ADR-0018 §4).
    requireNoCaseFoldCollision(manifest.entries);

    phase = "validate_target";
    await deps.restoreTarget.verifyEmptyTarget();

    phase = "write_files";
    for (const [manifestEntryIndex, entry] of manifest.entries.entries()) {
      const objectKey = encodeObjectStoreKeyV1(entry.objectId);
      let envelope: Bytes | undefined;
      try {
        envelope = await deps.objectStore.get(objectKey);
      } catch (error) {
        throw new RestoreError("OBJECT_STORE_IO_FAILED", "File object could not be read from the ObjectStore.", { cause: error });
      }
      if (envelope === undefined) {
        throw new RestoreError("MISSING_OBJECT", "A Manifest entry references an object that is absent from the ObjectStore.");
      }
      const plaintext = await openFileObjectV1(
        {
          domainId: recovery.domainId,
          objectId: entry.objectId,
          snapshotId: recovery.snapshotId,
          envelope,
          expectedPlaintextSize: entry.plaintextSize,
          objectWrapKey,
          wrappedObjectKey: entry.wrappedObjectKey
        },
        deps.cryptoProvider
      );
      try {
        try {
          await deps.restoreTarget.writeRestoredFile(entry.relativePath, plaintext);
        } catch (error) {
          partialOutputInventory.push({ manifestEntryIndex, state: "possibly_partial" });
          const code = structuralCode(error);
          if (code === "ENTRY_PATH_ESCAPE" || code === "REPARSE_POINT_FOUND" || code === "RESTORE_TARGET_WRITE_FAILED") {
            throw error;
          }
          throw new RestoreError(
            "RESTORE_TARGET_WRITE_FAILED",
            "Restore target write failed; the current entry may be partially present.",
            { cause: error }
          );
        }
      } finally {
        plaintext.fill(0);
      }
      partialOutputInventory.push({ manifestEntryIndex, state: "complete" });
      restoredFileCount += 1;
      totalBytesWritten = requireSafeByteTotal(totalBytesWritten + Number(entry.plaintextSize));
    }

    return {
      status: "complete",
      recoveryFileValid: true,
      manifestEntryCount,
      restoredFileCount,
      totalBytesWritten
    };
  } catch (error) {
    const code = structuralCode(error);
    const errorCode: RestoreErrorCode = isRestoreErrorCode(code ?? "")
      ? (code as RestoreErrorCode)
      : "HONEST_CLAIM_VIOLATION";
    return failedResult(errorCode);
  } finally {
    // ADR-0018 §3.1: best-effort in-place zeroing of the run's controllable key material.
    recoveryRoot?.fill(0);
    domainDataRoot?.fill(0);
    manifestKey?.fill(0);
    objectWrapKey?.fill(0);
  }
}
