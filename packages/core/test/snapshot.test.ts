import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebCryptoAes256Provider } from "../../crypto/src/webcrypto.js";
import {
  RECOVERY_FILE_V1_LENGTH,
  decodeObjectStoreKeyV1,
  decodeRecoveryFileV1,
  deriveDomainDataRootV1,
  deriveManifestKeyV1,
  deriveObjectWrapKeyV1,
  createSnapshotV1,
  encodeObjectStoreKeyV1,
  openFileObjectV1,
  openManifestObjectV1,
  type Clock,
  type CryptoProvider,
  type ObjectStore,
  type RandomSource,
  type RecoveryFileTarget,
  type SnapshotCreateDependencies,
  type SnapshotCreateInputV1,
  type SnapshotLogSink,
  type VaultEntry,
  type VaultSource
} from "../src/index.js";

const provider = new WebCryptoAes256Provider();
const domainId = new Uint8Array(32).fill(0x11);
const RUNTIME_LIMITS_SHA = "ab".repeat(32);

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function trackingRandomSource(): RandomSource & { readonly recorded: Uint8Array[] } {
  const recorded: Uint8Array[] = [];
  return {
    recorded,
    randomBytes(length: number): Uint8Array {
      const bytes = provider.randomBytes(length);
      recorded.push(bytes);
      return bytes;
    }
  };
}

function trackingCrypto(hkdfResults: Uint8Array[]): CryptoProvider {
  return {
    randomBytes: (length) => provider.randomBytes(length),
    sha256: (message) => provider.sha256(message),
    hmacSha256: (key, message) => provider.hmacSha256(key, message),
    verifyHmacSha256: (key, message, tag) => provider.verifyHmacSha256(key, message, tag),
    aeadEncrypt: (key, nonce, plaintext, aad) => provider.aeadEncrypt(key, nonce, plaintext, aad),
    aeadDecrypt: (key, nonce, ciphertext, tag, aad) => provider.aeadDecrypt(key, nonce, ciphertext, tag, aad),
    hkdfSha256: async (ikm, salt, info, length) => {
      const derived = await provider.hkdfSha256(ikm, salt, info, length);
      hkdfResults.push(derived);
      return derived;
    },
    wrapKey: (wrappingKey, keyToWrap) => provider.wrapKey(wrappingKey, keyToWrap),
    unwrapKey: (wrappingKey, wrappedKey) => provider.unwrapKey(wrappingKey, wrappedKey)
  };
}

interface VaultFileSpec {
  readonly content: string;
  /** Successive read results; read 1 belongs to the scan, later reads to the file phase. */
  readonly versions?: readonly string[];
}

/** ADR-0009-compatible sequential source; buffers stay retained so tests can assert zeroing. */
class FakeVaultSource implements VaultSource {
  readonly #paths: string[];
  readonly #buffers = new Map<string, Uint8Array>();
  readonly #readCounts = new Map<string, number>();
  readonly specs: Record<string, VaultFileSpec>;

  constructor(files: Record<string, VaultFileSpec>) {
    this.specs = files;
    this.#paths = Object.keys(files).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const [path, spec] of Object.entries(files)) {
      this.#buffers.set(path, utf8(spec.versions?.[0] ?? spec.content));
    }
  }

  bufferFor(path: string): Uint8Array {
    const buffer = this.#buffers.get(path);
    if (buffer === undefined) throw new Error(`No retained buffer for ${path}`);
    return buffer;
  }

  async *listFiles(): AsyncGenerator<VaultEntry> {
    for (const path of this.#paths) {
      yield {
        relativePath: path,
        readBytes: async () => {
          const spec = this.specs[path];
          const readIndex = (this.#readCounts.get(path) ?? 0) + 1;
          this.#readCounts.set(path, readIndex);
          if (spec.versions !== undefined) {
            return utf8(spec.versions[Math.min(readIndex - 1, spec.versions.length - 1)]);
          }
          return this.#buffers.get(path) ?? utf8("");
        }
      };
    }
  }
}

class FakeObjectStore implements ObjectStore {
  readonly puts: Array<{ readonly key: string; readonly bytes: Uint8Array }> = [];
  #calls = 0;
  readonly #handlers: Array<(key: string) => unknown>;

  constructor(handlers: Array<(key: string) => unknown> = []) {
    this.#handlers = handlers;
  }

  get callCount(): number {
    return this.#calls;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const handler = this.#handlers[this.#calls];
    this.#calls += 1;
    if (handler !== undefined) {
      const thrown = handler(key);
      if (thrown !== undefined) throw thrown;
    }
    this.puts.push({ key, bytes });
  }

  async get(): Promise<Uint8Array | undefined> {
    throw new Error("Snapshot creation must never call ObjectStore.get.");
  }
}

class FakeLogSink implements SnapshotLogSink {
  readonly lines: string[] = [];
  closed = false;
  failOn: "open" | "write" | "close" | undefined;

  async open(): Promise<void> {
    if (this.failOn === "open") throw new Error("open refused");
  }

  async writeLine(line: string): Promise<void> {
    if (this.failOn === "write") throw new Error("write refused");
    this.lines.push(line);
  }

  async flushAndClose(): Promise<void> {
    if (this.failOn === "close") throw new Error("close refused");
    this.closed = true;
  }
}

class FakeRecoveryFileTarget implements RecoveryFileTarget {
  verifyCalls = 0;
  written: Uint8Array | undefined;
  failVerify = false;
  failWrite = false;
  failReadBack = false;

  async verifyTargetAbsent(): Promise<void> {
    this.verifyCalls += 1;
    if (this.failVerify) throw new Error("target already exists");
  }

  async writeExclusiveAndReadBack(bytes: Uint8Array): Promise<void> {
    if (this.failWrite) throw new Error("write refused");
    this.written = bytes.slice();
    if (this.failReadBack) throw new Error("read-back mismatch");
  }
}

interface Fixture {
  readonly vault: FakeVaultSource;
  readonly store: FakeObjectStore;
  readonly log: FakeLogSink;
  readonly recovery: FakeRecoveryFileTarget;
  readonly deps: SnapshotCreateDependencies;
}

function createFixture(files: Record<string, VaultFileSpec>, putHandlers: Array<(key: string) => unknown> = []): Fixture {
  const vault = new FakeVaultSource(files);
  const store = new FakeObjectStore(putHandlers);
  const log = new FakeLogSink();
  const recovery = new FakeRecoveryFileTarget();
  const clock: Clock = { nowMilliseconds: () => 0 };
  return {
    vault,
    store,
    log,
    recovery,
    deps: {
      vaultSource: vault,
      objectStore: store,
      cryptoProvider: provider,
      randomSource: provider,
      clock,
      logSink: log,
      recoveryFileTarget: recovery
    }
  };
}

function createInput(overrides: Partial<SnapshotCreateInputV1> = {}): SnapshotCreateInputV1 {
  return {
    domainId,
    runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: RUNTIME_LIMITS_SHA },
    ...overrides
  };
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const collision = { code: "OBJECT_ID_COLLISION" };
const BASIC_FILES: Record<string, VaultFileSpec> = {
  "a.md": { content: "# alpha\n\nnote body for alpha.\n" },
  "b/c.md": { content: "gamma body.\n" },
  "b/d.md": { content: "delta body.\n" }
};

function logEvents(log: FakeLogSink): Array<Record<string, string | number>> {
  return log.lines.map((line) => JSON.parse(line) as Record<string, string | number>);
}

describe("Phase 4-A snapshot orchestration", () => {
  it("completes a three-file vault and re-derives the manifest from the Recovery File root", async () => {
    const fixture = createFixture(BASIC_FILES);
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("complete");
    expect(result.fileCount).toBe(3);
    expect(result.totalPlaintextBytes).toBe(54);
    expect(result.publishedObjectIdsHex).toHaveLength(4);
    expect(result.orphanObjectCount).toBe(0);
    expect(result.recoveryFileCreated).toBe(true);
    expect(result.requiredLogClosed).toBe(true);
    expect(result.runtimeLimits).toEqual({ schemaVersion: "p0-runtime-limits-v1", sha256Hex: RUNTIME_LIMITS_SHA });
    expect(fixture.store.puts).toHaveLength(4);
    expect(new Set(fixture.store.puts.map((put) => put.key)).size).toBe(4);

    expect(fixture.recovery.written?.byteLength).toBe(RECOVERY_FILE_V1_LENGTH);
    const recovery = await decodeRecoveryFileV1(fixture.recovery.written ?? filled(0, 0), provider);
    expect(recovery.domainId).toEqual(domainId);
    expect(recovery.snapshotId.byteLength).toBe(32);
    expect(recovery.manifestObjectId).toEqual(decodeObjectStoreKeyV1(result.manifestObjectKey ?? ""));
    expect(result.snapshotIdHex).toBe(toHex(recovery.snapshotId));

    const domainDataRoot = await deriveDomainDataRootV1(recovery.recoveryRoot, domainId, provider);
    const manifestKey = await deriveManifestKeyV1(domainDataRoot, domainId, provider);
    const manifestObjectBytes =
      fixture.store.puts.find((put) => put.key === result.manifestObjectKey)?.bytes ?? filled(0, 0);
    const manifest = await openManifestObjectV1(
      {
        domainId,
        objectId: decodeObjectStoreKeyV1(result.manifestObjectKey ?? ""),
        snapshotId: recovery.snapshotId,
        envelope: manifestObjectBytes,
        manifestKey
      },
      provider
    );
    expect(manifest.entries.map((entry) => entry.relativePath)).toEqual(["a.md", "b/c.md", "b/d.md"]);
    expect(manifest.entries.map((entry) => Number(entry.plaintextSize))).toEqual([30, 12, 12]);
    expect(manifest.parentSnapshotId.every((byte) => byte === 0)).toBe(true);

    const wrapKey = await deriveObjectWrapKeyV1(domainDataRoot, domainId, provider);
    const firstEntry = manifest.entries[0];
    const firstObjectKey = encodeObjectStoreKeyV1(firstEntry?.objectId ?? new Uint8Array(16));
    const firstObjectBytes = fixture.store.puts.find((put) => put.key === firstObjectKey)?.bytes ?? filled(0, 0);
    const plaintext = await openFileObjectV1(
      {
        domainId,
        objectId: decodeObjectStoreKeyV1(firstObjectKey),
        snapshotId: recovery.snapshotId,
        envelope: firstObjectBytes,
        expectedPlaintextSize: firstEntry?.plaintextSize ?? 0n,
        objectWrapKey: wrapKey,
        wrappedObjectKey: firstEntry?.wrappedObjectKey ?? filled(0, 0)
      },
      provider
    );
    expect(new TextDecoder().decode(plaintext)).toBe(BASIC_FILES["a.md"]?.content);

    const events = logEvents(fixture.log);
    expect(events.map((event) => event.event)).toEqual([
      "preflight_complete",
      "file_published",
      "file_published",
      "file_published",
      "manifest_published",
      "snapshot_prepared"
    ]);
    expect(events[1]?.file_ordinal).toBe(1);
    expect(events[3]?.file_ordinal).toBe(3);
    expect(events.every((event) => event.collision_attempt === undefined || event.collision_attempt === 1)).toBe(true);
    expect(fixture.log.closed).toBe(true);
  });

  it("fails preflight with UNSUPPORTED_FILES_FOUND and writes zero objects", async () => {
    const fixture = createFixture({ ...BASIC_FILES, "note.txt": { content: "unsupported\n" } });
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("UNSUPPORTED_FILES_FOUND");
    expect(result.failedPhase).toBe("preflight");
    expect(result.orphanObjectCount).toBe(0);
    expect(fixture.store.puts).toHaveLength(0);
    expect(fixture.recovery.written).toBeUndefined();
    expect(fixture.log.closed).toBe(true);
    const failedEvent = logEvents(fixture.log).find((event) => event.event === "snapshot_failed");
    expect(failedEvent?.error_code).toBe("UNSUPPORTED_FILES_FOUND");
  });

  it("fails preflight with CASE_COLLISION for paths differing only by case", async () => {
    const fixture = createFixture({ "a.md": { content: "one\n" }, "A.md": { content: "two\n" } });
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("CASE_COLLISION");
    expect(result.failedPhase).toBe("preflight");
    expect(fixture.store.puts).toHaveLength(0);
  });

  it("fails with FILE_CHANGED_DURING_SCAN when a file changes size after the scan", async () => {
    const files: Record<string, VaultFileSpec> = {
      "a.md": { content: "stable one\n" },
      "b.md": { content: "stable two\n" },
      "c.md": { content: "stable three\n", versions: ["stable three\n", "mutated and longer\n"] }
    };
    const fixture = createFixture(files);
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("FILE_CHANGED_DURING_SCAN");
    expect(result.failedPhase).toBe("file_objects");
    expect(result.publishedObjectIdsHex).toHaveLength(2);
    expect(result.orphanObjectCount).toBe(2);
    expect(fixture.store.puts).toHaveLength(2);
    expect(fixture.recovery.written).toBeUndefined();
    expect(fixture.recovery.verifyCalls).toBe(1);
    expect(fixture.log.closed).toBe(true);
  });

  it("retries file-object collisions and succeeds on the eighth total attempt", async () => {
    const handlers: Array<(key: string) => unknown> = [];
    for (let index = 0; index < 7; index += 1) handlers.push(() => collision);
    const fixture = createFixture({ "a.md": { content: "body\n" }, "b.md": { content: "body2\n" } }, handlers);
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("complete");
    expect(fixture.store.puts).toHaveLength(3);
    expect(new Set(fixture.store.puts.map((put) => put.key)).size).toBe(3);
    const firstFileEvent = logEvents(fixture.log).find((event) => event.event === "file_published");
    expect(firstFileEvent?.collision_attempt).toBe(8);
    expect(firstFileEvent?.object_key).toBe(fixture.store.puts[0]?.key);
  });

  it("fails the whole run after eight file-object collisions", async () => {
    const handlers: Array<(key: string) => unknown> = [];
    for (let index = 0; index < 8; index += 1) handlers.push(() => collision);
    const fixture = createFixture({ "a.md": { content: "body\n" } }, handlers);
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("OBJECT_ID_COLLISION");
    expect(result.failedPhase).toBe("file_objects");
    expect(result.orphanObjectCount).toBe(0);
    expect(fixture.store.puts).toHaveLength(0);
    expect(fixture.recovery.written).toBeUndefined();
  });

  it("retries Manifest collisions but never retries non-collision store errors", async () => {
    const retryFixture = createFixture(BASIC_FILES, [undefined, undefined, undefined, () => collision]);
    const retried = await createSnapshotV1(createInput(), retryFixture.deps);
    expect(retried.status).toBe("complete");
    const manifestEvent = logEvents(retryFixture.log).find((event) => event.event === "manifest_published");
    expect(manifestEvent?.collision_attempt).toBe(2);

    const failingFixture = createFixture(BASIC_FILES, [
      undefined,
      undefined,
      undefined,
      () => ({ code: "OBJECT_STORE_IO_FAILED" })
    ]);
    const failed = await createSnapshotV1(createInput(), failingFixture.deps);
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("OBJECT_STORE_IO_FAILED");
    expect(failed.failedPhase).toBe("manifest_object");
    expect(failingFixture.store.callCount).toBe(4);
    expect(failingFixture.recovery.written).toBeUndefined();
  });

  it("fails with LOG_WRITE_FAILED before any object when the log sink cannot open", async () => {
    const fixture = createFixture(BASIC_FILES);
    fixture.log.failOn = "open";
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("LOG_WRITE_FAILED");
    expect(result.failedPhase).toBe("preflight");
    expect(result.requiredLogClosed).toBe(false);
    expect(fixture.store.puts).toHaveLength(0);
    expect(fixture.recovery.verifyCalls).toBe(1);
  });

  it("fails with LOG_WRITE_FAILED at seal time and never writes the Recovery File", async () => {
    const fixture = createFixture(BASIC_FILES);
    fixture.log.failOn = "close";
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("LOG_WRITE_FAILED");
    expect(result.failedPhase).toBe("log_seal");
    expect(fixture.store.puts).toHaveLength(4);
    expect(result.orphanObjectCount).toBe(4);
    expect(fixture.recovery.written).toBeUndefined();
    expect(result.requiredLogClosed).toBe(false);
  });

  it("fails with RECOVERY_FILE_WRITE_FAILED when the target exists or write or read-back fails", async () => {
    const verifyFixture = createFixture(BASIC_FILES);
    verifyFixture.recovery.failVerify = true;
    const verifyResult = await createSnapshotV1(createInput(), verifyFixture.deps);
    expect(verifyResult.status).toBe("failed");
    expect(verifyResult.errorCode).toBe("RECOVERY_FILE_WRITE_FAILED");
    expect(verifyResult.failedPhase).toBe("preflight");
    expect(verifyFixture.store.puts).toHaveLength(0);
    // ADR-0017 §4.1: the Recovery File target is verified before the log opens, so no log
    // file and no failure event exist for this failure.
    expect(verifyFixture.recovery.verifyCalls).toBe(1);
    expect(verifyFixture.log.lines).toHaveLength(0);
    expect(verifyFixture.log.closed).toBe(false);

    const writeFixture = createFixture(BASIC_FILES);
    writeFixture.recovery.failWrite = true;
    const writeResult = await createSnapshotV1(createInput(), writeFixture.deps);
    expect(writeResult.status).toBe("failed");
    expect(writeResult.errorCode).toBe("RECOVERY_FILE_WRITE_FAILED");
    expect(writeResult.failedPhase).toBe("recovery_file");
    expect(writeResult.publishedObjectIdsHex).toHaveLength(4);
    expect(writeResult.orphanObjectCount).toBe(4);
    expect(writeResult.recoveryFileCreated).toBe(false);
    expect(writeResult.requiredLogClosed).toBe(true);

    const mismatchFixture = createFixture(BASIC_FILES);
    mismatchFixture.recovery.failReadBack = true;
    const mismatchResult = await createSnapshotV1(createInput(), mismatchFixture.deps);
    expect(mismatchResult.status).toBe("failed");
    expect(mismatchResult.errorCode).toBe("RECOVERY_FILE_WRITE_FAILED");
    expect(mismatchResult.failedPhase).toBe("recovery_file");
  });

  it("fails closed on runtime-limits binding mismatch before touching any dependency", async () => {
    const badVersion = createFixture(BASIC_FILES);
    const versionResult = await createSnapshotV1(
      createInput({ runtimeLimits: { schemaVersion: "p0-runtime-limits-v2", sha256Hex: RUNTIME_LIMITS_SHA } }),
      badVersion.deps
    );
    expect(versionResult.status).toBe("failed");
    expect(versionResult.errorCode).toBe("HONEST_CLAIM_VIOLATION");
    expect(versionResult.failedPhase).toBe("preflight");
    expect(badVersion.store.puts).toHaveLength(0);
    expect(badVersion.recovery.verifyCalls).toBe(0);

    const badHash = createFixture(BASIC_FILES);
    const hashResult = await createSnapshotV1(
      createInput({ runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: "zz".repeat(32) } }),
      badHash.deps
    );
    expect(hashResult.status).toBe("failed");
    expect(hashResult.errorCode).toBe("HONEST_CLAIM_VIOLATION");
    expect(badHash.recovery.verifyCalls).toBe(0);
  });

  it("converges unexpected internal errors to HONEST_CLAIM_VIOLATION", async () => {
    const fixture = createFixture(BASIC_FILES, [() => new Error("unexpected internal failure")]);
    const result = await createSnapshotV1(createInput(), fixture.deps);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("HONEST_CLAIM_VIOLATION");
    expect(result.failedPhase).toBe("file_objects");
    expect(fixture.recovery.written).toBeUndefined();
  });

  it("keeps run secrets zeroed and records no paths, filenames, markers, or contents", async () => {
    const random = trackingRandomSource();
    const hkdfResults: Uint8Array[] = [];
    const vault = new FakeVaultSource({ "secret file name.md": { content: "secret CONTENT_MARK_beta body\n" } });
    const store = new FakeObjectStore();
    const log = new FakeLogSink();
    const recovery = new FakeRecoveryFileTarget();
    const result = await createSnapshotV1(createInput(), {
      vaultSource: vault,
      objectStore: store,
      cryptoProvider: trackingCrypto(hkdfResults),
      randomSource: random,
      clock: { nowMilliseconds: () => 0 },
      logSink: log,
      recoveryFileTarget: recovery
    });
    expect(result.status).toBe("complete");

    // The first 32-byte random allocation is the recovery root; it must be zeroed in place.
    const rootBuffer = random.recorded.find((bytes) => bytes.byteLength === 32);
    expect(rootBuffer?.every((byte) => byte === 0)).toBe(true);
    // The three run-owned derived keys must be zeroed in place. A fourth HKDF call inside
    // encodeRecoveryFileV1 derives the recovery integrity key, which is outside the
    // orchestration's zeroing contract.
    expect(hkdfResults.length).toBeGreaterThanOrEqual(4);
    for (const derived of hkdfResults.slice(0, 3)) expect(derived.every((byte) => byte === 0)).toBe(true);
    // The plaintext buffer is zeroed after its object is published.
    expect(vault.bufferFor("secret file name.md").every((byte) => byte === 0)).toBe(true);

    const serializedResult = JSON.stringify(result);
    const serializedLog = log.lines.join("\n");
    for (const forbidden of ["secret file name", "CONTENT_MARK_beta", "secret body", ".md"]) {
      expect(serializedResult).not.toContain(forbidden);
      expect(serializedLog).not.toContain(forbidden);
    }
  });

  it("rejects a domainId that is not exactly 32 bytes", async () => {
    const fixture = createFixture(BASIC_FILES);
    const result = await createSnapshotV1(createInput({ domainId: filled(16, 1) }), fixture.deps);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("HONEST_CLAIM_VIOLATION");
    expect(result.failedPhase).toBe("preflight");
    expect(fixture.store.puts).toHaveLength(0);
  });

  it("binds the recorded runtime-limits hash to the real accepted contract file", async () => {
    const contractBytes = await readFile(join(process.cwd(), "../../docs/contracts/p0-runtime-limits-v1.json"));
    const digest = createHash("sha256").update(contractBytes).digest("hex");
    const fixture = createFixture(BASIC_FILES);
    const result = await createSnapshotV1(
      createInput({ runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: digest } }),
      fixture.deps
    );
    expect(result.status).toBe("complete");
    expect(result.runtimeLimits.sha256Hex).toBe(digest);
  });
});
