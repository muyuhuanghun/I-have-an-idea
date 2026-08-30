import { describe, expect, it } from "vitest";
import { WebCryptoAes256Provider } from "../../crypto/src/webcrypto.js";
import {
  createSnapshotV1,
  decodeRecoveryFileV1,
  deriveDomainDataRootV1,
  deriveManifestKeyV1,
  encodeManifestPlaintextV1,
  encodeObjectAadV1,
  encodeObjectEnvelopeV1,
  encodeObjectStoreKeyV1,
  restoreSnapshotV1,
  sealManifestObjectV1,
  type Bytes,
  type Clock,
  type CryptoProvider,
  type ManifestPlaintextV1,
  type ObjectStore,
  type RecoveryFileTarget,
  type RestoreResultV1,
  type RestoreTarget,
  type SnapshotCreateDependencies,
  type SnapshotCreateInputV1,
  type SnapshotLogSink,
  type VaultEntry,
  type VaultSource
} from "../src/index.js";

const provider = new WebCryptoAes256Provider();
const domainId = new Uint8Array(32).fill(0x11);
const RUNTIME_LIMITS_SHA = "cd".repeat(32);

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

class FakeVaultSource implements VaultSource {
  readonly #paths: string[];
  readonly #buffers: Map<string, Uint8Array>;

  constructor(files: Record<string, string>) {
    this.#paths = Object.keys(files).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    this.#buffers = new Map(Object.entries(files).map(([path, content]) => [path, utf8(content)]));
  }

  async *listFiles(): AsyncGenerator<VaultEntry> {
    for (const path of this.#paths) {
      yield { relativePath: path, readBytes: async () => this.#buffers.get(path) ?? utf8("") };
    }
  }
}

/** Read-only fake store: `put` must never be called during restore; `get` serves recorded puts. */
class FakeObjectStore implements ObjectStore {
  readonly puts: Array<{ readonly key: string; readonly bytes: Uint8Array }> = [];
  readonly objects = new Map<string, Uint8Array>();
  readonly gets: string[] = [];

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.puts.push({ key, bytes });
    this.objects.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.gets.push(key);
    return this.objects.get(key);
  }
}

class FakeLogSink implements SnapshotLogSink {
  readonly lines: string[] = [];
  async open(): Promise<void> {}
  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
  }
  async flushAndClose(): Promise<void> {}
}

class FakeSnapshotRecoveryTarget implements RecoveryFileTarget {
  written: Uint8Array | undefined;
  async verifyTargetAbsent(): Promise<void> {}
  async writeExclusiveAndReadBack(bytes: Uint8Array): Promise<void> {
    this.written = bytes.slice();
  }
}

class FakeRestoreTarget implements RestoreTarget {
  readonly files = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  readonly borrowedPlaintextBuffers: Bytes[] = [];
  failOnWrite: string | undefined;

  async verifyEmptyTarget(): Promise<void> {
    if (this.files.size > 0) {
      throw Object.assign(new Error("target not empty"), { code: "NON_EMPTY_TARGET" });
    }
  }

  async writeRestoredFile(relativePath: string, bytes: Bytes): Promise<void> {
    this.borrowedPlaintextBuffers.push(bytes);
    if (this.failOnWrite === relativePath) throw new Error("ENOSPC: simulated disk full");
    this.files.set(relativePath, bytes.slice());
    this.writes.push(relativePath);
  }
}

async function createSnapshotFixture(files: Record<string, string>): Promise<{
  store: FakeObjectStore;
  recoveryBytes: Bytes;
  manifestObjectKey: string;
}> {
  const store = new FakeObjectStore();
  const recoveryTarget = new FakeSnapshotRecoveryTarget();
  const input: SnapshotCreateInputV1 = {
    domainId,
    runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: RUNTIME_LIMITS_SHA }
  };
  const deps: SnapshotCreateDependencies = {
    vaultSource: new FakeVaultSource(files),
    objectStore: store,
    cryptoProvider: provider,
    randomSource: provider,
    clock: { nowMilliseconds: () => 0 } as Clock,
    logSink: new FakeLogSink(),
    recoveryFileTarget: recoveryTarget
  };
  const result = await createSnapshotV1(input, deps);
  if (result.status !== "complete") throw new Error("fixture snapshot creation failed");
  return {
    store,
    recoveryBytes: recoveryTarget.written ?? filled(0, 0),
    manifestObjectKey: result.manifestObjectKey ?? ""
  };
}

async function restoreFrom(fixture: { store: FakeObjectStore; recoveryBytes: Bytes }, target: RestoreTarget): Promise<RestoreResultV1> {
  return restoreSnapshotV1(
    { recoveryFileBytes: fixture.recoveryBytes },
    { objectStore: fixture.store, cryptoProvider: provider, restoreTarget: target }
  );
}

function findBytes(haystack: Bytes, needle: Bytes): number {
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

async function installRawManifest(
  fixture: { store: FakeObjectStore; recoveryBytes: Bytes },
  mutate: (plaintext: Bytes) => Bytes
): Promise<void> {
  const recovery = await decodeRecoveryFileV1(fixture.recoveryBytes, provider);
  const domainDataRoot = await deriveDomainDataRootV1(recovery.recoveryRoot, recovery.domainId, provider);
  const manifestKey = await deriveManifestKeyV1(domainDataRoot, recovery.domainId, provider);
  try {
    const manifest: ManifestPlaintextV1 = {
      domainId: recovery.domainId,
      snapshotId: recovery.snapshotId,
      parentSnapshotId: filled(32, 0),
      contentPolicyVersion: 1,
      suiteId: 1,
      entries: [
        { relativePath: "a.md", objectId: filled(16, 1), plaintextSize: 1n, wrappedObjectKey: filled(40, 7) }
      ]
    };
    const plaintext = mutate(encodeManifestPlaintextV1(manifest));
    const nonce = filled(12, 0x5a);
    const aad = encodeObjectAadV1({
      objectType: "manifest",
      domainId: recovery.domainId,
      objectId: recovery.manifestObjectId,
      snapshotId: recovery.snapshotId,
      ciphertextLength: BigInt(plaintext.byteLength)
    });
    const encrypted = await provider.aeadEncrypt(manifestKey, nonce, plaintext, aad);
    const envelope = encodeObjectEnvelopeV1({ nonce, ciphertext: encrypted.ciphertext, tag: encrypted.tag });
    fixture.store.objects.set(encodeObjectStoreKeyV1(recovery.manifestObjectId), envelope);
    plaintext.fill(0);
  } finally {
    recovery.recoveryRoot.fill(0);
    domainDataRoot.fill(0);
    manifestKey.fill(0);
  }
}

describe("Phase 4-B restore orchestration", () => {
  it("restores a snapshot completely with matching paths, bytes, and counts", async () => {
    const fixture = await createSnapshotFixture({
      "a.md": "# alpha\n\nnote body for alpha.\n",
      "b/c.md": "gamma body.\n",
      "b/d.md": "delta body.\n"
    });
    const target = new FakeRestoreTarget();
    const putsBeforeRestore = fixture.store.puts.length;
    const result = await restoreFrom(fixture, target);

    expect(result.status).toBe("complete");
    expect(result.recoveryFileValid).toBe(true);
    expect(result.manifestEntryCount).toBe(3);
    expect(result.restoredFileCount).toBe(3);
    expect(result.totalBytesWritten).toBe(54);
    expect(result.errorCode).toBeUndefined();
    expect(result.partialOutputInventory).toBeUndefined();
    expect([...target.files.keys()].sort()).toEqual(["a.md", "b/c.md", "b/d.md"]);
    expect(new TextDecoder().decode(target.files.get("a.md") ?? filled(0, 0))).toBe("# alpha\n\nnote body for alpha.\n");
    // Restore never writes to the ObjectStore (ACC-22 counterpart): the put count is
    // unchanged from the fixture creation run.
    expect(fixture.store.puts).toHaveLength(putsBeforeRestore);
  });

  it("rejects a non-empty target before any write and preserves the pre-existing file", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    const target = new FakeRestoreTarget();
    target.files.set("dummy.txt", utf8("pre-existing\n"));
    const result = await restoreFrom(fixture, target);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("NON_EMPTY_TARGET");
    expect(result.failedPhase).toBe("validate_target");
    expect(result.restoredFileCount).toBe(0);
    expect(result.partialOutputInventory).toEqual([]);
    expect(target.writes).toHaveLength(0);
    expect(new TextDecoder().decode(target.files.get("dummy.txt") ?? filled(0, 0))).toBe("pre-existing\n");
  });

  it("rejects a corrupted Recovery File with RECOVERY_INTEGRITY_FAILED and zero writes", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    const corrupted = fixture.recoveryBytes.slice();
    corrupted[166] = (corrupted[166] ?? 0) ^ 0xff;
    const target = new FakeRestoreTarget();
    const result = await restoreSnapshotV1(
      { recoveryFileBytes: corrupted },
      { objectStore: fixture.store, cryptoProvider: provider, restoreTarget: target }
    );

    expect(result.status).toBe("failed");
    expect(result.recoveryFileValid).toBe(false);
    expect(result.errorCode).toBe("RECOVERY_INTEGRITY_FAILED");
    expect(result.failedPhase).toBe("validate_recovery");
    expect(target.writes).toHaveLength(0);
  });

  it("rejects unsupported recovery versions and trailing bytes", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    const badVersion = fixture.recoveryBytes.slice();
    badVersion[5] = 9;
    const versionResult = await restoreSnapshotV1(
      { recoveryFileBytes: badVersion },
      { objectStore: fixture.store, cryptoProvider: provider, restoreTarget: new FakeRestoreTarget() }
    );
    expect(versionResult.errorCode).toBe("RECOVERY_VERSION_UNSUPPORTED");

    const trailing = new Uint8Array(fixture.recoveryBytes.length + 1);
    trailing.set(fixture.recoveryBytes);
    const trailingResult = await restoreSnapshotV1(
      { recoveryFileBytes: trailing },
      { objectStore: fixture.store, cryptoProvider: provider, restoreTarget: new FakeRestoreTarget() }
    );
    expect(trailingResult.errorCode).toBe("RECOVERY_TRAILING_BYTES");
  });

  it("fails with MISSING_OBJECT when the Manifest object is absent", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    fixture.store.objects.clear();
    const result = await restoreFrom(fixture, new FakeRestoreTarget());

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("MISSING_OBJECT");
    expect(result.failedPhase).toBe("fetch_manifest");
    expect(result.restoredFileCount).toBe(0);
  });

  it("reports MISSING_OBJECT mid-write with an honest partial count", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n", "b.md": "beta\n" });
    // Remove a FILE object key, never the Manifest object key.
    const fileKeys = [...fixture.store.objects.keys()].filter((key) => key !== fixture.manifestObjectKey);
    fixture.store.objects.delete(fileKeys[fileKeys.length - 1] ?? "");
    const target = new FakeRestoreTarget();
    const result = await restoreFrom(fixture, target);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("MISSING_OBJECT");
    expect(result.failedPhase).toBe("write_files");
    expect(result.manifestEntryCount).toBe(2);
    expect(result.restoredFileCount).toBe(1);
    expect(result.partialOutputInventory).toEqual([{ manifestEntryIndex: 0, state: "complete" }]);
    expect([...target.files.keys()]).toEqual(["a.md"]);
  });

  it("fails with OBJECT_AEAD_FAILED for tampered objects and reports partial progress", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n", "b.md": "beta\n" });
    // Tamper a FILE object explicitly; tampering the Manifest object would fail earlier
    // in the fetch_manifest phase with MANIFEST_AEAD_FAILED.
    const fileKeys = [...fixture.store.objects.keys()].filter((key) => key !== fixture.manifestObjectKey);
    const tamperedKey = fileKeys[0] ?? "";
    const bytes = fixture.store.objects.get(tamperedKey);
    if (bytes !== undefined) bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    const target = new FakeRestoreTarget();
    const result = await restoreFrom(fixture, target);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("OBJECT_AEAD_FAILED");
    expect(result.failedPhase).toBe("write_files");
    expect(result.restoredFileCount).toBeLessThan(2);
  });

  it("preserves frozen structural object-envelope error codes at the restore boundary", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    const fileKey = [...fixture.store.objects.keys()].find((key) => key !== fixture.manifestObjectKey) ?? "";
    const envelope = fixture.store.objects.get(fileKey);
    if (envelope === undefined) throw new Error("file object fixture is missing");
    envelope[0] = (envelope[0] ?? 0) ^ 0xff;

    const result = await restoreFrom(fixture, new FakeRestoreTarget());
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("OBJECT_AAD_MISMATCH");
    expect(result.failedPhase).toBe("write_files");
  });

  it("preserves OBJECT_TRUNCATED and OBJECT_TRAILING_BYTES through orchestration", async () => {
    for (const expected of ["OBJECT_TRUNCATED", "OBJECT_TRAILING_BYTES"] as const) {
      const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
      const fileKey = [...fixture.store.objects.keys()].find((key) => key !== fixture.manifestObjectKey) ?? "";
      const envelope = fixture.store.objects.get(fileKey);
      if (envelope === undefined) throw new Error("file object fixture is missing");
      if (expected === "OBJECT_TRUNCATED") {
        fixture.store.objects.set(fileKey, envelope.slice(0, envelope.byteLength - 1));
      } else {
        const trailing = new Uint8Array(envelope.byteLength + 1);
        trailing.set(envelope);
        fixture.store.objects.set(fileKey, trailing);
      }
      const result = await restoreFrom(fixture, new FakeRestoreTarget());
      expect(result.errorCode).toBe(expected);
    }
  });

  it("rejects manifests with case-fold collisions before any write", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    // The snapshot-side scan rejects case-colliding vaults, so the manifest is sealed
    // directly from a crafted plaintext through the frozen codecs.
    const recovery = await decodeRecoveryFileV1(fixture.recoveryBytes, provider);
    const domainDataRoot = await deriveDomainDataRootV1(recovery.recoveryRoot, recovery.domainId, provider);
    const manifestKey = await deriveManifestKeyV1(domainDataRoot, recovery.domainId, provider);
    const collidingManifest = {
      domainId: recovery.domainId,
      snapshotId: recovery.snapshotId,
      parentSnapshotId: filled(32, 0),
      contentPolicyVersion: 1 as const,
      suiteId: 1 as const,
      entries: [
        { relativePath: "Å.md", objectId: filled(16, 1), plaintextSize: 1n, wrappedObjectKey: filled(40, 7) },
        { relativePath: "å.md", objectId: filled(16, 2), plaintextSize: 1n, wrappedObjectKey: filled(40, 8) }
      ]
    };
    const envelope = await sealManifestObjectV1(
      {
        domainId: recovery.domainId,
        objectId: recovery.manifestObjectId,
        snapshotId: recovery.snapshotId,
        manifest: collidingManifest,
        manifestKey
      },
      { cryptoProvider: provider, randomSource: provider }
    );
    fixture.store.objects.set(encodeObjectStoreKeyV1(recovery.manifestObjectId), envelope);

    const target = new FakeRestoreTarget();
    const result = await restoreFrom(fixture, target);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("CASE_COLLISION");
    // Manifest validation is folded into the fetch_manifest phase (ADR-0018 §3.3); it still
    // runs entirely before the target is inspected, hence zero writes.
    expect(result.failedPhase).toBe("fetch_manifest");
    expect(target.writes).toHaveLength(0);
    expect(result.restoredFileCount).toBe(0);
  });

  it("rejects an authenticated synthetic ../ Manifest before target writes", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    await installRawManifest(fixture, (encoded) => {
      const mutated = encoded.slice();
      const pathOffset = findBytes(mutated, utf8("a.md"));
      if (pathOffset < 0) throw new Error("Manifest path bytes were not found");
      mutated.set(utf8("../x"), pathOffset);
      return mutated;
    });
    const target = new FakeRestoreTarget();
    const result = await restoreFrom(fixture, target);
    expect(result.errorCode).toBe("ENTRY_PATH_ESCAPE");
    expect(result.failedPhase).toBe("fetch_manifest");
    expect(result.partialOutputInventory).toEqual([]);
    expect(target.writes).toEqual([]);
  });

  it("preserves Manifest suite and trailing-byte errors through orchestration", async () => {
    const suiteFixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    await installRawManifest(suiteFixture, (encoded) => {
      const mutated = encoded.slice();
      mutated[102] = 2;
      return mutated;
    });
    expect((await restoreFrom(suiteFixture, new FakeRestoreTarget())).errorCode).toBe("MANIFEST_SUITE_UNKNOWN");

    const trailingFixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    await installRawManifest(trailingFixture, (encoded) => {
      const trailing = new Uint8Array(encoded.byteLength + 1);
      trailing.set(encoded);
      return trailing;
    });
    expect((await restoreFrom(trailingFixture, new FakeRestoreTarget())).errorCode).toBe("MANIFEST_TRAILING_BYTES");
  });

  it("reports target write failures with a path-free honest partial-output inventory", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n", "b.md": "beta\n", "c.md": "gamma\n" });
    const target = new FakeRestoreTarget();
    target.failOnWrite = "b.md";
    const result = await restoreFrom(fixture, target);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("RESTORE_TARGET_WRITE_FAILED");
    expect(result.failedPhase).toBe("write_files");
    expect(result.restoredFileCount).toBe(1);
    expect(result.partialOutputInventory).toEqual([
      { manifestEntryIndex: 0, state: "complete" },
      { manifestEntryIndex: 1, state: "possibly_partial" }
    ]);
    expect([...target.files.keys()]).toEqual(["a.md"]);
    expect(JSON.stringify(result)).not.toContain("a.md");
    expect(JSON.stringify(result)).not.toContain("b.md");
    expect(target.borrowedPlaintextBuffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  it("keeps decrypted output intact and ciphertext buffers untouched after completion", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha secret body\n" });
    const objectKey = [...fixture.store.objects.keys()][0] ?? "";
    const envelope = fixture.store.objects.get(objectKey);
    const envelopeCopy = envelope?.slice();
    const target = new FakeRestoreTarget();
    const result = await restoreFrom(fixture, target);
    expect(result.status).toBe("complete");

    expect(envelope).toEqual(envelopeCopy);
    expect(new TextDecoder().decode(target.files.get("a.md") ?? filled(0, 0))).toBe("alpha secret body\n");
    expect(target.borrowedPlaintextBuffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  it("clears each successfully derived restore key when a later derivation fails", async () => {
    const fixture = await createSnapshotFixture({ "a.md": "alpha\n" });
    let hkdfCalls = 0;
    const observedRestoreKeys: Bytes[] = [];
    const failingProvider: CryptoProvider = {
      randomBytes: provider.randomBytes.bind(provider),
      sha256: provider.sha256.bind(provider),
      hmacSha256: provider.hmacSha256.bind(provider),
      verifyHmacSha256: provider.verifyHmacSha256.bind(provider),
      aeadEncrypt: provider.aeadEncrypt.bind(provider),
      aeadDecrypt: provider.aeadDecrypt.bind(provider),
      hkdfSha256: async (...args) => {
        hkdfCalls += 1;
        if (hkdfCalls === 4) throw new Error("simulated object-wrap derivation failure");
        const key = await provider.hkdfSha256(...args);
        if (hkdfCalls >= 2) observedRestoreKeys.push(key);
        return key;
      },
      wrapKey: provider.wrapKey.bind(provider),
      unwrapKey: provider.unwrapKey.bind(provider)
    };
    const result = await restoreSnapshotV1(
      { recoveryFileBytes: fixture.recoveryBytes },
      { objectStore: fixture.store, cryptoProvider: failingProvider, restoreTarget: new FakeRestoreTarget() }
    );
    expect(result.status).toBe("failed");
    expect(result.failedPhase).toBe("fetch_manifest");
    expect(observedRestoreKeys).toHaveLength(2);
    expect(observedRestoreKeys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });
});
