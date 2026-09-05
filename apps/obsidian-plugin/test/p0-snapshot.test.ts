import type {
  ObjectStore,
  RecoveryFileTarget,
  SnapshotLogSink,
  VaultSource
} from "@ekd/core";
import { VaultAdapterError } from "@ekd/adapters/errors";
import { DirectoryObjectStoreV1 } from "@ekd/adapters/node-object-store";
import { NodeRecoveryFileTarget, NodeSnapshotLogSink } from "@ekd/adapters/node-snapshot-io";
import { ObsidianVaultSource } from "@ekd/adapters/obsidian-vault";
import { WebCryptoAes256Provider } from "@ekd/crypto/webcrypto";
import { bytesToHex, createSmokeReportSchemaValidator, sha256Hex, utf8Bytes } from "@ekd/smoke";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeVaultPathValidator,
  requireNewReportTarget,
  requireSnapshotPathsDisjoint,
  writeReportExclusive
} from "../src/node-path-safety.js";
import {
  PLUGIN_VISIBILITY_EVIDENCE_SCOPE,
  runPluginSnapshotV1,
  type PluginSnapshotProgress
} from "../src/p0-snapshot.js";

const RUNTIME_LIMITS_SHA256 = "e1971ab746f6b08b06522463f907143036d99e41c470532482b5da8eafc44acd";
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ekd-phase5b-plugin-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

class MemoryVaultSource implements VaultSource {
  listFiles(): AsyncIterable<{ readonly relativePath: string; readonly readBytes: () => Promise<Uint8Array> }> {
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          relativePath: "notes/example.md",
          readBytes: async () => utf8Bytes("phase 5-b plugin snapshot\n")
        };
      }
    };
  }
}

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
    if (this.values.has(key)) throw Object.assign(new Error("collision"), { code: "OBJECT_ID_COLLISION" });
    this.values.set(key, value.slice());
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.values.get(key)?.slice();
  }
}

class MemoryLogSink implements SnapshotLogSink {
  readonly lines: string[] = [];
  opened = false;
  closed = false;

  async open(): Promise<void> {
    this.opened = true;
  }

  async writeLine(line: string): Promise<void> {
    if (!this.opened || this.closed) throw new Error("log unavailable");
    this.lines.push(line);
  }

  async flushAndClose(): Promise<void> {
    this.closed = true;
  }

  bytes(): Uint8Array {
    return utf8Bytes(`${this.lines.join("\n")}\n`);
  }
}

class MemoryRecoveryTarget implements RecoveryFileTarget {
  bytes: Uint8Array | undefined;

  async verifyTargetAbsent(): Promise<void> {
    if (this.bytes !== undefined) throw new Error("already exists");
  }

  async writeExclusiveAndReadBack(bytes: Uint8Array): Promise<void> {
    if (this.bytes !== undefined) throw new Error("already exists");
    this.bytes = bytes.slice();
  }
}

describe("Phase 5-B plugin snapshot orchestration", () => {
  it("uses the shared core and derives progress, visibility, and a hash-bound report from decorated ports", async () => {
    const provider = new WebCryptoAes256Provider();
    const store = new MemoryObjectStore();
    const log = new MemoryLogSink();
    const recovery = new MemoryRecoveryTarget();
    const progress: PluginSnapshotProgress[] = [];
    let reportBytes: Uint8Array | undefined;
    let now = Date.parse("2026-09-04T00:00:00.000Z");
    const domainId = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

    const execution = await runPluginSnapshotV1({
      domainId,
      runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: RUNTIME_LIMITS_SHA256 }
    }, {
      vaultSource: new MemoryVaultSource(),
      objectStore: store,
      cryptoProvider: provider,
      randomSource: provider,
      clock: { nowMilliseconds: () => now++ },
      logSink: log,
      recoveryFileTarget: recovery,
      readSnapshotLogBytes: async () => log.bytes(),
      writeReportExclusive: async (bytes) => { reportBytes = bytes.slice(); },
      validateReport: () => ({ valid: true, errors: [] })
    }, (event) => { progress.push(event); });

    expect(execution.snapshot.status).toBe("complete");
    expect(execution.report).toMatchObject({
      schema_version: "p0-plugin-snapshot-report-v1",
      domain_id_sha256: sha256Hex(domainId),
      runtime_limits_sha256: RUNTIME_LIMITS_SHA256,
      file_count: 1,
      verdict: "pass",
      visibility_summary: {
        object_count: 2,
        object_keys_path_free: true,
        evidence_scope: PLUGIN_VISIBILITY_EVIDENCE_SCOPE
      },
      snapshot_log_sha256: sha256Hex(log.bytes())
    });
    expect(execution.report?.total_ciphertext_bytes).toBeGreaterThan(execution.report?.total_plaintext_bytes ?? 0);
    expect(execution.report?.visibility_summary.total_ciphertext_bytes).toBe(execution.report?.total_ciphertext_bytes);
    expect([...store.values.keys()].every((key) => /^[A-Za-z0-9_-]{22}$/u.test(key))).toBe(true);
    expect(progress).toContainEqual({ phase: "scanning", status: "active", scannedFiles: 1 });
    expect(progress).toContainEqual({ phase: "recovery_ownership", status: "complete" });
    expect(progress.some((event) => event.phase === "encrypting" && event.status === "active")).toBe(true);
    expect(recovery.bytes?.byteLength).toBe(167);
    expect(reportBytes).toBeDefined();
    expect(new TextDecoder().decode(reportBytes)).not.toContain(bytesToHex(domainId));
  });

  it("does not export a report when the shared snapshot result fails", async () => {
    const provider = new WebCryptoAes256Provider();
    const log = new MemoryLogSink();
    let reportWritten = false;
    const execution = await runPluginSnapshotV1({
      domainId: new Uint8Array(32).fill(1),
      runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: RUNTIME_LIMITS_SHA256 }
    }, {
      vaultSource: new MemoryVaultSource(),
      objectStore: new MemoryObjectStore(),
      cryptoProvider: provider,
      randomSource: provider,
      clock: { nowMilliseconds: () => Date.now() },
      logSink: log,
      recoveryFileTarget: {
        verifyTargetAbsent: async () => { throw new Error("occupied"); },
        writeExclusiveAndReadBack: async () => { throw new Error("must not run"); }
      },
      readSnapshotLogBytes: async () => log.bytes(),
      writeReportExclusive: async () => { reportWritten = true; },
      validateReport: () => ({ valid: true, errors: [] })
    });

    expect(execution.snapshot).toMatchObject({
      status: "failed",
      failedPhase: "preflight",
      errorCode: "RECOVERY_FILE_WRITE_FAILED"
    });
    expect(execution.report).toBeUndefined();
    expect(reportWritten).toBe(false);
  });

  it("rejects a schema-invalid report before writing it", async () => {
    const provider = new WebCryptoAes256Provider();
    const log = new MemoryLogSink();
    let reportWritten = false;

    await expect(runPluginSnapshotV1({
      domainId: new Uint8Array(32).fill(2),
      runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: RUNTIME_LIMITS_SHA256 }
    }, {
      vaultSource: new MemoryVaultSource(),
      objectStore: new MemoryObjectStore(),
      cryptoProvider: provider,
      randomSource: provider,
      clock: { nowMilliseconds: () => Date.now() },
      logSink: log,
      recoveryFileTarget: new MemoryRecoveryTarget(),
      readSnapshotLogBytes: async () => log.bytes(),
      writeReportExclusive: async () => { reportWritten = true; },
      validateReport: () => ({ valid: false, errors: ["injected schema failure"] })
    })).rejects.toThrow(/failed schema validation/);
    expect(reportWritten).toBe(false);
  });

  it("runs the Obsidian source and Node output adapters end to end without writing into the Vault", async () => {
    const root = await temporaryRoot();
    const vaultRoot = join(root, "vault");
    const storeRoot = join(root, "store");
    const outputRoot = join(root, "output");
    const logPath = join(outputRoot, "snapshot.jsonl");
    const recoveryPath = join(outputRoot, "recovery.ekdr");
    const reportPath = join(outputRoot, "plugin-report.json");
    await mkdir(vaultRoot);
    await mkdir(storeRoot);
    await mkdir(outputRoot);
    const vaultFilePath = join(vaultRoot, "note.md");
    await writeFile(vaultFilePath, "actual Obsidian adapter bytes\n");
    const initialStats = await lstat(vaultFilePath);
    const file = {
      path: "note.md",
      stat: {
        ctime: Math.trunc(initialStats.ctimeMs),
        mtime: Math.trunc(initialStats.mtimeMs),
        size: initialStats.size
      }
    };
    const nodeFs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const validatePath = createNodeVaultPathValidator(
      vaultRoot,
      nodeFs,
      nodePath,
      (code, relativePath, message, cause) => new VaultAdapterError(
        code,
        relativePath,
        message,
        cause === undefined ? undefined : { cause }
      )
    );
    const source = new ObsidianVaultSource({
      getFiles: () => [file],
      getAbstractFileByPath: (path) => path === file.path ? file : null,
      readBinary: async () => {
        const bytes = await readFile(vaultFilePath);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
    }, { validatePath });
    const schema = JSON.parse(await readFile(
      join(process.cwd(), "../../docs/schemas/p0-plugin-snapshot-report-v1.schema.json"),
      "utf8"
    )) as unknown;
    const validator = createSmokeReportSchemaValidator(schema);
    const provider = new WebCryptoAes256Provider();
    const execution = await runPluginSnapshotV1({
      domainId: new Uint8Array(32).fill(3),
      runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: RUNTIME_LIMITS_SHA256 }
    }, {
      vaultSource: source,
      objectStore: new DirectoryObjectStoreV1(storeRoot),
      cryptoProvider: provider,
      randomSource: provider,
      clock: { nowMilliseconds: () => Date.now() },
      logSink: new NodeSnapshotLogSink(logPath, { vaultRoot, objectStoreRoot: storeRoot }),
      recoveryFileTarget: new NodeRecoveryFileTarget(recoveryPath, { vaultRoot, objectStoreRoot: storeRoot }),
      readSnapshotLogBytes: async () => new Uint8Array(await readFile(logPath)),
      writeReportExclusive: async (bytes) => writeReportExclusive(reportPath, bytes, nodeFs),
      validateReport: (value) => validator.validateSmokeReport(value)
    });

    expect(execution.snapshot.status).toBe("complete");
    expect(validator.validateSmokeReport(JSON.parse(await readFile(reportPath, "utf8"))).valid).toBe(true);
    expect((await readdir(storeRoot)).length).toBe(2);
    expect(await readdir(vaultRoot)).toEqual(["note.md"]);
    expect(await readFile(vaultFilePath, "utf8")).toBe("actual Obsidian adapter bytes\n");
  });
});

describe("Phase 5-B desktop path gates", () => {
  it("rejects a Junction alias that would place a plugin output inside the physical Vault", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault-long-name");
    const store = join(root, "store");
    const alias = join(root, "vault-alias");
    await mkdir(vault);
    await mkdir(store);
    await symlink(vault, alias, "junction");

    await expect(requireSnapshotPathsDisjoint([
      ["Source Vault", vault],
      ["ObjectStore", store],
      ["plugin snapshot report", join(alias, "report.json")]
    ], await import("node:fs/promises"), await import("node:path"))).rejects.toThrow(/must not contain each other/);
  });

  it("rejects a linked Vault path segment before Obsidian reads the target", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    const outside = join(root, "outside");
    await mkdir(vault);
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "outside");
    await symlink(outside, join(vault, "linked"), "junction");
    const validate = createNodeVaultPathValidator(
      vault,
      await import("node:fs/promises"),
      await import("node:path"),
      (code, relativePath, message) => Object.assign(new Error(message), { code, relativePath })
    );

    await expect(validate("linked/secret.md")).rejects.toMatchObject({
      code: "REPARSE_POINT_FOUND",
      relativePath: "linked/secret.md"
    });
  });

  it("detects a file identity or metadata change across desktop path validations", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    await mkdir(vault);
    await writeFile(join(vault, "changing.md"), "a");
    const validate = createNodeVaultPathValidator(
      vault,
      await import("node:fs/promises"),
      await import("node:path"),
      (code, relativePath, message) => Object.assign(new Error(message), { code, relativePath })
    );
    await validate("changing.md");
    await writeFile(join(vault, "changing.md"), "changed");

    await expect(validate("changing.md")).rejects.toMatchObject({
      code: "FILE_CHANGED_DURING_SCAN",
      relativePath: "changing.md"
    });
  });

  it("preflights and exclusively preserves the plugin report target", async () => {
    const root = await temporaryRoot();
    const reportPath = join(root, "snapshot-report.json");
    const nodeFs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    await requireNewReportTarget(reportPath, nodeFs, nodePath);
    await writeReportExclusive(reportPath, utf8Bytes("first\n"), nodeFs);

    await expect(requireNewReportTarget(reportPath, nodeFs, nodePath)).rejects.toThrow(/never overwritten/);
    await expect(writeReportExclusive(reportPath, utf8Bytes("second\n"), nodeFs)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(reportPath, "utf8")).toBe("first\n");
  });
});
