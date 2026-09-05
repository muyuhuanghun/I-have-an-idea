import {
  createSnapshotV1,
  type ObjectStore,
  type RecoveryFileTarget,
  type SnapshotCreateDependencies,
  type SnapshotCreateInputV1,
  type SnapshotCreateResultV1,
  type SnapshotLogSink,
  type VaultSource
} from "@ekd/core";
import { sha256Hex, utf8Bytes } from "@ekd/smoke";

export const PLUGIN_SNAPSHOT_REPORT_SCHEMA_VERSION = "p0-plugin-snapshot-report-v1" as const;
export const PLUGIN_VISIBILITY_EVIDENCE_SCOPE = "plugin-summary-not-formal-acc-32-or-33" as const;

export type PluginSnapshotProgress =
  | { readonly phase: "scanning"; readonly status: "active"; readonly scannedFiles: number }
  | {
      readonly phase: "scanning";
      readonly status: "complete";
      readonly fileCount: number;
      readonly totalPlaintextBytes: number;
    }
  | {
      readonly phase: "encrypting";
      readonly status: "active";
      readonly fileOrdinal: number;
      readonly fileCount: number;
      readonly totalPlaintextBytes: number;
    }
  | { readonly phase: "encrypting"; readonly status: "complete"; readonly fileCount: number }
  | { readonly phase: "recovery_ownership"; readonly status: "verifying" | "complete" };

export interface PluginVisibilitySummaryV1 {
  readonly object_count: number;
  readonly total_ciphertext_bytes: number;
  readonly object_keys_path_free: true;
  readonly runtime_limits_sha256: string;
  readonly evidence_scope: typeof PLUGIN_VISIBILITY_EVIDENCE_SCOPE;
}

export interface PluginSnapshotReportV1 {
  readonly schema_version: typeof PLUGIN_SNAPSHOT_REPORT_SCHEMA_VERSION;
  readonly run_id: string;
  readonly snapshot_id_hex: string;
  readonly domain_id_sha256: string;
  readonly runtime_limits_sha256: string;
  readonly file_count: number;
  readonly total_plaintext_bytes: number;
  readonly total_ciphertext_bytes: number;
  readonly visibility_summary: PluginVisibilitySummaryV1;
  readonly snapshot_log_sha256: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly verdict: "pass";
}

export interface PluginSnapshotExecutionDependencies extends SnapshotCreateDependencies {
  readonly readSnapshotLogBytes: () => Promise<Uint8Array>;
  readonly writeReportExclusive: (bytes: Uint8Array) => Promise<void>;
  readonly validateReport: (value: unknown) => { readonly valid: boolean; readonly errors: readonly unknown[] };
}

export interface PluginSnapshotExecutionResult {
  readonly snapshot: SnapshotCreateResultV1;
  readonly report?: PluginSnapshotReportV1;
}

function notifySafely(
  notify: ((progress: PluginSnapshotProgress) => void) | undefined,
  progress: PluginSnapshotProgress
): void {
  try {
    notify?.(progress);
  } catch {
    // UI progress is observational. A rendering failure must not change protocol behavior.
  }
}

class ProgressVaultSource implements VaultSource {
  readonly plaintextPaths: string[] = [];
  #pass = 0;

  constructor(
    readonly delegate: VaultSource,
    readonly notify: ((progress: PluginSnapshotProgress) => void) | undefined
  ) {}

  async *listFiles() {
    this.#pass += 1;
    const currentPass = this.#pass;
    let scannedFiles = 0;
    for await (const entry of this.delegate.listFiles()) {
      if (currentPass === 1) {
        this.plaintextPaths.push(entry.relativePath);
        scannedFiles += 1;
        notifySafely(this.notify, { phase: "scanning", status: "active", scannedFiles });
      }
      yield entry;
    }
  }
}

class CountingObjectStore implements ObjectStore {
  readonly keys: string[] = [];
  totalCiphertextBytes = 0;

  constructor(readonly delegate: ObjectStore) {}

  async put(key: string, value: Uint8Array): Promise<void> {
    const nextTotal = this.totalCiphertextBytes + value.byteLength;
    if (!Number.isSafeInteger(nextTotal)) throw new RangeError("Ciphertext byte total exceeds the safe JSON integer range.");
    await this.delegate.put(key, value);
    this.keys.push(key);
    this.totalCiphertextBytes = nextTotal;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.delegate.get(key);
  }
}

class ProgressSnapshotLogSink implements SnapshotLogSink {
  constructor(
    readonly delegate: SnapshotLogSink,
    readonly notify: ((progress: PluginSnapshotProgress) => void) | undefined
  ) {}

  async open(): Promise<void> {
    await this.delegate.open();
  }

  async writeLine(line: string): Promise<void> {
    await this.delegate.writeLine(line);
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      value.event === "preflight_complete" &&
      typeof value.file_count === "number" &&
      typeof value.vault_plaintext_bytes === "number"
    ) {
      notifySafely(this.notify, {
        phase: "scanning",
        status: "complete",
        fileCount: value.file_count,
        totalPlaintextBytes: value.vault_plaintext_bytes
      });
    } else if (
      value.event === "file_published" &&
      typeof value.file_ordinal === "number" &&
      typeof value.file_count === "number" &&
      typeof value.plaintext_bytes_total === "number"
    ) {
      notifySafely(this.notify, {
        phase: "encrypting",
        status: "active",
        fileOrdinal: value.file_ordinal,
        fileCount: value.file_count,
        totalPlaintextBytes: value.plaintext_bytes_total
      });
    } else if (value.event === "snapshot_prepared" && typeof value.file_count === "number") {
      notifySafely(this.notify, {
        phase: "encrypting",
        status: "complete",
        fileCount: value.file_count
      });
    }
  }

  async flushAndClose(): Promise<void> {
    await this.delegate.flushAndClose();
  }
}

class ProgressRecoveryFileTarget implements RecoveryFileTarget {
  constructor(
    readonly delegate: RecoveryFileTarget,
    readonly notify: ((progress: PluginSnapshotProgress) => void) | undefined
  ) {}

  async verifyTargetAbsent(): Promise<void> {
    notifySafely(this.notify, { phase: "recovery_ownership", status: "verifying" });
    await this.delegate.verifyTargetAbsent();
  }

  async writeExclusiveAndReadBack(bytes: Uint8Array): Promise<void> {
    await this.delegate.writeExclusiveAndReadBack(bytes);
    notifySafely(this.notify, { phase: "recovery_ownership", status: "complete" });
  }
}

function requireCompleteSnapshot(
  result: SnapshotCreateResultV1
): asserts result is SnapshotCreateResultV1 & {
  readonly snapshotIdHex: string;
  readonly fileCount: number;
  readonly totalPlaintextBytes: number;
} {
  if (
    result.status !== "complete" ||
    result.snapshotIdHex === undefined ||
    result.fileCount === undefined ||
    result.totalPlaintextBytes === undefined
  ) {
    throw new Error("A complete snapshot result is required to create a plugin report.");
  }
}

function keysContainNoPlaintextPaths(keys: readonly string[], plaintextPaths: readonly string[]): boolean {
  return keys.every((key) =>
    /^[A-Za-z0-9_-]{22}$/u.test(key) &&
    plaintextPaths.every((path) => path.length > 0 && !key.includes(path))
  );
}

/**
 * ADR-0021 §2: derive progress and the visibility summary strictly by decorating
 * existing ports. Core and crypto stay unaware of UI/report concerns.
 */
export async function runPluginSnapshotV1(
  input: SnapshotCreateInputV1,
  dependencies: PluginSnapshotExecutionDependencies,
  notify?: (progress: PluginSnapshotProgress) => void
): Promise<PluginSnapshotExecutionResult> {
  const startedAt = new Date(dependencies.clock.nowMilliseconds()).toISOString();
  const vaultSource = new ProgressVaultSource(dependencies.vaultSource, notify);
  const objectStore = new CountingObjectStore(dependencies.objectStore);
  const result = await createSnapshotV1(input, {
    vaultSource,
    objectStore,
    cryptoProvider: dependencies.cryptoProvider,
    randomSource: dependencies.randomSource,
    clock: dependencies.clock,
    logSink: new ProgressSnapshotLogSink(dependencies.logSink, notify),
    recoveryFileTarget: new ProgressRecoveryFileTarget(dependencies.recoveryFileTarget, notify)
  });
  if (result.status !== "complete") return { snapshot: result };

  requireCompleteSnapshot(result);
  if (objectStore.keys.length !== result.publishedObjectIdsHex.length) {
    throw new Error("ObjectStore visibility counter does not match the completed snapshot result.");
  }
  if (!keysContainNoPlaintextPaths(objectStore.keys, vaultSource.plaintextPaths)) {
    throw new Error("ObjectStore key visibility assertion failed: a key is non-canonical or contains a plaintext path.");
  }
  const logBytes = await dependencies.readSnapshotLogBytes();
  const completedAt = new Date(dependencies.clock.nowMilliseconds()).toISOString();
  const report: PluginSnapshotReportV1 = {
    schema_version: PLUGIN_SNAPSHOT_REPORT_SCHEMA_VERSION,
    run_id: result.runId,
    snapshot_id_hex: result.snapshotIdHex,
    domain_id_sha256: sha256Hex(input.domainId),
    runtime_limits_sha256: input.runtimeLimits.sha256Hex,
    file_count: result.fileCount,
    total_plaintext_bytes: result.totalPlaintextBytes,
    total_ciphertext_bytes: objectStore.totalCiphertextBytes,
    visibility_summary: {
      object_count: objectStore.keys.length,
      total_ciphertext_bytes: objectStore.totalCiphertextBytes,
      object_keys_path_free: true,
      runtime_limits_sha256: input.runtimeLimits.sha256Hex,
      evidence_scope: PLUGIN_VISIBILITY_EVIDENCE_SCOPE
    },
    snapshot_log_sha256: sha256Hex(logBytes),
    started_at: startedAt,
    completed_at: completedAt,
    verdict: "pass"
  };
  const validation = dependencies.validateReport(report);
  if (!validation.valid) {
    throw new Error(`Generated plugin snapshot report failed schema validation (${validation.errors.length} errors).`);
  }
  await dependencies.writeReportExclusive(utf8Bytes(`${JSON.stringify(report, null, 2)}\n`));
  return { snapshot: result, report };
}
