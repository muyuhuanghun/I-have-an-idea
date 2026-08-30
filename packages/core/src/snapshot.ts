import { isSnapshotCreateErrorCode, SnapshotCreateError, type SnapshotCreateErrorCode } from "./errors.js";
import { deriveDomainDataRootV1, deriveManifestKeyV1, deriveObjectWrapKeyV1 } from "./keys.js";
import { encodeManifestPlaintextV1, type ManifestEntryV1, type ManifestPlaintextV1 } from "./manifest.js";
import {
  encodeObjectStoreKeyV1,
  generateObjectIdV1,
  sealFileObjectV1,
  sealManifestObjectV1
} from "./object.js";
import type {
  Bytes,
  Clock,
  CryptoProvider,
  ObjectStore,
  RandomSource,
  RecoveryFileTarget,
  SnapshotLogSink,
  VaultSource
} from "./ports.js";
import { encodeRecoveryFileV1 } from "./recovery.js";
import { scanVault } from "./scan.js";

const RUN_ID_LENGTH = 16;
const IDENTIFIER_LENGTH = 32;
const PARENT_SNAPSHOT_ID_V1 = new Uint8Array(IDENTIFIER_LENGTH);

const ACCEPTED_RUNTIME_LIMITS_SCHEMA_VERSION = "p0-runtime-limits-v1";
const FILE_OBJECT_PUBLISH_TOTAL_ATTEMPTS = 8;
const MANIFEST_OBJECT_PUBLISH_TOTAL_ATTEMPTS = 8;

export type SnapshotCreateStatus = "complete" | "failed";

export type SnapshotCreatePhase =
  | "preflight"
  | "root_material"
  | "file_objects"
  | "manifest_object"
  | "log_seal"
  | "recovery_file";

export interface SnapshotRuntimeLimitsV1 {
  /** Must be the accepted `p0-runtime-limits-v1`; the frozen values themselves live in core. */
  readonly schemaVersion: string;
  /** SHA-256 of the accepted `p0-runtime-limits-v1.json` file bytes, recorded for evidence binding. */
  readonly sha256Hex: string;
}

export interface SnapshotCreateInputV1 {
  /** Exactly 32 non-secret bytes identifying the domain; provided explicitly by the caller. */
  readonly domainId: Bytes;
  readonly runtimeLimits: SnapshotRuntimeLimitsV1;
}

export interface SnapshotCreateDependencies {
  readonly vaultSource: VaultSource;
  readonly objectStore: ObjectStore;
  readonly cryptoProvider: CryptoProvider;
  readonly randomSource: RandomSource;
  readonly clock: Clock;
  readonly logSink: SnapshotLogSink;
  readonly recoveryFileTarget: RecoveryFileTarget;
}

export interface SnapshotCreateResultV1 {
  readonly status: SnapshotCreateStatus;
  readonly runId: string;
  readonly snapshotIdHex?: string;
  readonly manifestObjectKey?: string;
  readonly manifestObjectIdHex?: string;
  readonly fileCount?: number;
  readonly totalPlaintextBytes?: number;
  readonly errorCode?: SnapshotCreateErrorCode;
  readonly failedPhase?: SnapshotCreatePhase;
  readonly publishedObjectIdsHex: readonly string[];
  readonly orphanObjectCount: number;
  readonly recoveryFileCreated: boolean;
  readonly requiredLogClosed: boolean;
  readonly runtimeLimits: SnapshotRuntimeLimitsV1;
}

const HEX_ALPHABET = "0123456789abcdef";

function hex(bytes: Bytes): string {
  let result = "";
  for (const byte of bytes) result += HEX_ALPHABET.charAt(byte >> 4) + HEX_ALPHABET.charAt(byte & 0x0f);
  return result;
}

function structuralCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function requireNonZeroRandom(bytes: Bytes, label: string): Bytes {
  if (bytes.byteLength !== IDENTIFIER_LENGTH) {
    throw new SnapshotCreateError(
      "RANDOM_SOURCE_SHORT_READ",
      `${label} random source returned ${bytes.byteLength} bytes; expected ${IDENTIFIER_LENGTH}.`
    );
  }
  if (bytes.every((byte) => byte === 0)) {
    throw new SnapshotCreateError("RANDOM_SOURCE_ALL_ZERO", `${label} random source returned only zero bytes.`);
  }
  return bytes;
}

function requireAcceptedRuntimeLimits(limits: SnapshotRuntimeLimitsV1): void {
  if (limits === undefined || typeof limits !== "object") {
    throw new SnapshotCreateError("HONEST_CLAIM_VIOLATION", "Snapshot runtime limits binding is missing.");
  }
  if (limits.schemaVersion !== ACCEPTED_RUNTIME_LIMITS_SCHEMA_VERSION) {
    throw new SnapshotCreateError(
      "HONEST_CLAIM_VIOLATION",
      "Snapshot runtime limits must bind the accepted p0-runtime-limits-v1 contract."
    );
  }
  if (typeof limits.sha256Hex !== "string" || !/^[0-9a-f]{64}$/u.test(limits.sha256Hex)) {
    throw new SnapshotCreateError(
      "HONEST_CLAIM_VIOLATION",
      "Snapshot runtime limits SHA-256 must be 64 lowercase hexadecimal characters."
    );
  }
}

function requireDomainId(domainId: Bytes): void {
  if (!(domainId instanceof Uint8Array) || domainId.byteLength !== IDENTIFIER_LENGTH) {
    throw new SnapshotCreateError("HONEST_CLAIM_VIOLATION", "Snapshot domainId must be exactly 32 bytes.");
  }
}

function requireSafeCount(value: bigint, label: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new SnapshotCreateError("HONEST_CLAIM_VIOLATION", `${label} exceeds the safe JSON integer range.`);
  }
  return converted;
}

/** ADR-0017 §7.1: canonical one-line JSON with a frozen field order; values are ASCII-safe by schema. */
function logLine(fields: Record<string, string | number>): string {
  return JSON.stringify(fields);
}

async function writeLogEvent(sink: SnapshotLogSink, fields: Record<string, string | number>): Promise<void> {
  try {
    await sink.writeLine(logLine(fields));
  } catch (error) {
    throw new SnapshotCreateError("LOG_WRITE_FAILED", "Snapshot log sink write failed.", { cause: error });
  }
}

function utcNow(clock: Clock): string {
  return new Date(clock.nowMilliseconds()).toISOString();
}

interface PublishedObject<A> {
  readonly objectId: Bytes;
  readonly key: string;
  readonly attempt: number;
  readonly artifact: A;
}

/**
 * ADR-0017 §4.3/§6: seal with a fresh ID/key/nonce, publish through the immutable ObjectStore,
 * and retry only on OBJECT_ID_COLLISION — each attempt regenerates every cryptographic input.
 * `OBJECT_STORE_IO_FAILED`, reparse points, random-source failures, and codec errors never
 * enter the collision loop.
 */
async function publishWithCollisionRetry<A>(
  attempts: number,
  randomSource: RandomSource,
  sealAndPut: (objectId: Bytes, key: string) => Promise<A>
): Promise<PublishedObject<A>> {
  let lastCollision: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const objectId = generateObjectIdV1(randomSource);
    const key = encodeObjectStoreKeyV1(objectId);
    try {
      const artifact = await sealAndPut(objectId, key);
      return { objectId, key, attempt, artifact };
    } catch (error) {
      if (structuralCode(error) === "OBJECT_ID_COLLISION") {
        lastCollision = error;
        continue;
      }
      throw error;
    }
  }
  throw lastCollision;
}

/** ADR-0017 §4: the single accepted snapshot-creation order; any deviation fails closed. */
export async function createSnapshotV1(
  input: SnapshotCreateInputV1,
  deps: SnapshotCreateDependencies
): Promise<SnapshotCreateResultV1> {
  const runtimeLimits: SnapshotRuntimeLimitsV1 = {
    schemaVersion: input.runtimeLimits?.schemaVersion ?? "",
    sha256Hex: input.runtimeLimits?.sha256Hex ?? ""
  };
  const publishedObjectIdsHex: string[] = [];
  let recoveryFileCreated = false;
  let logOpen = false;
  let logClosed = false;
  let phase: SnapshotCreatePhase = "preflight";
  let runId = "";
  let recoveryRoot: Bytes | undefined;
  let domainDataRoot: Bytes | undefined;
  let manifestKey: Bytes | undefined;
  let objectWrapKey: Bytes | undefined;

  const failedResult = (errorCode: SnapshotCreateErrorCode): SnapshotCreateResultV1 => ({
    status: "failed",
    runId,
    errorCode,
    failedPhase: phase,
    publishedObjectIdsHex: [...publishedObjectIdsHex],
    orphanObjectCount: publishedObjectIdsHex.length,
    recoveryFileCreated,
    requiredLogClosed: logClosed,
    runtimeLimits
  });

  try {
    requireDomainId(input.domainId);
    requireAcceptedRuntimeLimits(input.runtimeLimits);
    runId = hex(deps.randomSource.randomBytes(RUN_ID_LENGTH));

    // Phase 0: preflight — no ObjectStore writes may happen before this completes.
    // ADR-0017 §4.1 orders target verification before the log sink is opened, so a bad
    // Recovery File target leaves no log file behind at all.
    try {
      await deps.recoveryFileTarget.verifyTargetAbsent();
    } catch (error) {
      throw new SnapshotCreateError("RECOVERY_FILE_WRITE_FAILED", "Recovery File target failed preflight.", { cause: error });
    }
    try {
      await deps.logSink.open();
    } catch (error) {
      throw new SnapshotCreateError("LOG_WRITE_FAILED", "Snapshot log sink could not be opened.", { cause: error });
    }
    logOpen = true;
    const scan = await scanVault(deps.vaultSource);
    const scannedByPath = new Map(scan.files.map((file) => [file.relativePath, file]));
    const vaultPlaintextBytes = requireSafeCount(scan.totalBytes, "Vault plaintext byte total");
    await writeLogEvent(deps.logSink, {
      schema_version: "snapshot-log-v1",
      event: "preflight_complete",
      run_id: runId,
      time_utc: utcNow(deps.clock),
      phase: "preflight",
      file_count: scan.files.length,
      vault_plaintext_bytes: vaultPlaintextBytes,
      runtime_limits_sha256: input.runtimeLimits.sha256Hex
    });

    // Phase 1: root material. ADR-0017 §4.2: one recovery root for the whole run; the existing
    // generateRecoveryFileV1 generates its own root and must not be called here.
    phase = "root_material";
    recoveryRoot = requireNonZeroRandom(deps.randomSource.randomBytes(IDENTIFIER_LENGTH), "recovery root");
    const snapshotId = requireNonZeroRandom(deps.randomSource.randomBytes(IDENTIFIER_LENGTH), "snapshot ID");
    const derivedDomainDataRoot = await deriveDomainDataRootV1(recoveryRoot, input.domainId, deps.cryptoProvider);
    const derivedManifestKey = await deriveManifestKeyV1(derivedDomainDataRoot, input.domainId, deps.cryptoProvider);
    const derivedObjectWrapKey = await deriveObjectWrapKeyV1(derivedDomainDataRoot, input.domainId, deps.cryptoProvider);
    domainDataRoot = derivedDomainDataRoot;
    manifestKey = derivedManifestKey;
    objectWrapKey = derivedObjectWrapKey;

    // Phase 2: sequential file objects — concurrency 1, no prefetch, one in-flight plaintext.
    phase = "file_objects";
    const entries: ManifestEntryV1[] = [];
    let totalPlaintextBytes = 0;
    let ordinal = 0;
    for await (const entry of deps.vaultSource.listFiles()) {
      const scanned = scannedByPath.get(entry.relativePath);
      if (scanned === undefined) {
        throw new SnapshotCreateError(
          "FILE_CHANGED_DURING_SCAN",
          "Vault file appeared after the scan completed; the run must fail closed."
        );
      }
      const plaintext = await entry.readBytes();
      try {
        if (BigInt(plaintext.byteLength) !== scanned.plaintextSize) {
          throw new SnapshotCreateError(
            "FILE_CHANGED_DURING_SCAN",
            "Vault file size changed after the scan completed; the run must fail closed."
          );
        }
        const published = await publishWithCollisionRetry(
          FILE_OBJECT_PUBLISH_TOTAL_ATTEMPTS,
          deps.randomSource,
          async (objectId, key) => {
            const sealed = await sealFileObjectV1(
              { domainId: input.domainId, objectId, snapshotId, objectWrapKey: derivedObjectWrapKey, plaintext },
              { cryptoProvider: deps.cryptoProvider, randomSource: deps.randomSource }
            );
            await deps.objectStore.put(key, sealed.envelope);
            return sealed.wrappedObjectKey;
          }
        );
        entries.push({
          relativePath: entry.relativePath,
          objectId: published.objectId,
          plaintextSize: BigInt(plaintext.byteLength),
          wrappedObjectKey: published.artifact
        });
        publishedObjectIdsHex.push(hex(published.objectId));
        ordinal += 1;
        totalPlaintextBytes += plaintext.byteLength;
        await writeLogEvent(deps.logSink, {
          schema_version: "snapshot-log-v1",
          event: "file_published",
          run_id: runId,
          time_utc: utcNow(deps.clock),
          phase: "file_objects",
          file_ordinal: ordinal,
          file_count: scan.files.length,
          plaintext_bytes_total: totalPlaintextBytes,
          object_key: published.key,
          object_id_hex: hex(published.objectId),
          collision_attempt: published.attempt
        });
      } finally {
        plaintext.fill(0);
      }
    }
    if (ordinal !== scan.files.length) {
      throw new SnapshotCreateError(
        "FILE_CHANGED_DURING_SCAN",
        "Vault file disappeared after the scan completed; the run must fail closed."
      );
    }

    // Phase 3: Manifest object — same collision rule; the P0 parent snapshot ID stays all-zero.
    phase = "manifest_object";
    const manifest: ManifestPlaintextV1 = {
      domainId: input.domainId,
      snapshotId,
      parentSnapshotId: PARENT_SNAPSHOT_ID_V1,
      contentPolicyVersion: 1,
      suiteId: 1,
      entries
    };
    // Fail fast on encoder-level contract violations before any Manifest publish attempt.
    encodeManifestPlaintextV1(manifest);
    const manifestPublished = await publishWithCollisionRetry(
      MANIFEST_OBJECT_PUBLISH_TOTAL_ATTEMPTS,
      deps.randomSource,
      async (objectId, key) => {
        const envelope = await sealManifestObjectV1(
          { domainId: input.domainId, objectId, snapshotId, manifest, manifestKey: derivedManifestKey },
          { cryptoProvider: deps.cryptoProvider, randomSource: deps.randomSource }
        );
        await deps.objectStore.put(key, envelope);
        return envelope;
      }
    );
    publishedObjectIdsHex.push(hex(manifestPublished.objectId));
    await writeLogEvent(deps.logSink, {
      schema_version: "snapshot-log-v1",
      event: "manifest_published",
      run_id: runId,
      time_utc: utcNow(deps.clock),
      phase: "manifest_object",
      object_key: manifestPublished.key,
      object_id_hex: hex(manifestPublished.objectId),
      collision_attempt: manifestPublished.attempt
    });

    // Phase 4: seal the mandatory log. ADR-0017 §4.5: after this point no further must-succeed
    // log or report I/O exists; completion is proven by the Recovery File read-back, the
    // function returning, and exit 0 — never by an extra log event.
    phase = "log_seal";
    await writeLogEvent(deps.logSink, {
      schema_version: "snapshot-log-v1",
      event: "snapshot_prepared",
      run_id: runId,
      time_utc: utcNow(deps.clock),
      phase: "log_seal",
      file_count: scan.files.length,
      plaintext_bytes_total: totalPlaintextBytes,
      snapshot_id_hex: hex(snapshotId),
      manifest_object_id_hex: hex(manifestPublished.objectId),
      published_object_count: publishedObjectIdsHex.length,
      runtime_limits_sha256: input.runtimeLimits.sha256Hex
    });
    try {
      await deps.logSink.flushAndClose();
    } catch (error) {
      throw new SnapshotCreateError("LOG_WRITE_FAILED", "Snapshot log sink could not be flushed and closed.", { cause: error });
    }
    logClosed = true;

    // Phase 5: Recovery File last, encoded from the same recovery root used for every key.
    phase = "recovery_file";
    const recoveryBytes = await encodeRecoveryFileV1(
      { domainId: input.domainId, recoveryRoot, snapshotId, manifestObjectId: manifestPublished.objectId },
      deps.cryptoProvider
    );
    try {
      await deps.recoveryFileTarget.writeExclusiveAndReadBack(recoveryBytes);
    } catch (error) {
      throw new SnapshotCreateError("RECOVERY_FILE_WRITE_FAILED", "Recovery File write or read-back failed.", { cause: error });
    }
    recoveryFileCreated = true;

    return {
      status: "complete",
      runId,
      snapshotIdHex: hex(snapshotId),
      manifestObjectKey: manifestPublished.key,
      manifestObjectIdHex: hex(manifestPublished.objectId),
      fileCount: scan.files.length,
      totalPlaintextBytes,
      publishedObjectIdsHex: [...publishedObjectIdsHex],
      orphanObjectCount: 0,
      recoveryFileCreated: true,
      requiredLogClosed: logClosed,
      runtimeLimits
    };
  } catch (error) {
    const code = structuralCode(error);
    const errorCode: SnapshotCreateErrorCode = isSnapshotCreateErrorCode(code ?? "")
      ? (code as SnapshotCreateErrorCode)
      : "HONEST_CLAIM_VIOLATION";
    if (logOpen && !logClosed) {
      // Best-effort failure event; a broken log sink must not mask the original error.
      try {
        await deps.logSink.writeLine(logLine({
          schema_version: "snapshot-log-v1",
          event: "snapshot_failed",
          run_id: runId,
          time_utc: utcNow(deps.clock),
          phase,
          error_code: errorCode,
          published_object_count: publishedObjectIdsHex.length,
          orphan_object_count: publishedObjectIdsHex.length
        }));
        await deps.logSink.flushAndClose();
        logClosed = true;
      } catch {
        // Leave the sink unclosed; requiredLogClosed=false records it honestly.
      }
    }
    return failedResult(errorCode);
  } finally {
    // ADR-0017 §3.2/§4.2: best-effort in-place zeroing of the run's controllable secrets.
    recoveryRoot?.fill(0);
    domainDataRoot?.fill(0);
    manifestKey?.fill(0);
    objectWrapKey?.fill(0);
  }
}
