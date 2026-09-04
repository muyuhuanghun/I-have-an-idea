import { VAULT_SOURCE_READ_CHUNK_BYTES, NodeRecoveryFileTarget, NodeSnapshotLogSink, readStableFile } from "../src/index.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(rootPath);
  return rootPath;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Returns false when the platform refuses to create the link (e.g. unprivileged Windows symlinks). */
async function createReparseLink(linkPath: string, targetPath: string): Promise<boolean> {
  try {
    await symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

describe("NodeSnapshotLogSink", () => {
  it("creates exclusively, appends canonical lines, and flushes to disk", async () => {
    const outside = await makeRoot("ekd-log-out-");
    const logPath = join(outside, "run.log");
    const sink = new NodeSnapshotLogSink(logPath);
    await sink.open();
    await sink.writeLine('{"event":"preflight_complete"}');
    await sink.writeLine('{"event":"snapshot_prepared"}');
    await sink.flushAndClose();

    const contents = await readFile(logPath, "utf8");
    expect(contents).toBe('{"event":"preflight_complete"}\n{"event":"snapshot_prepared"}\n');
  });

  it("refuses a second open and refuses to overwrite an existing log file", async () => {
    const outside = await makeRoot("ekd-log-out-");
    const logPath = join(outside, "run.log");
    const sink = new NodeSnapshotLogSink(logPath);
    await sink.open();
    await expect(sink.open()).rejects.toMatchObject({ code: "LOG_WRITE_FAILED" });
    await sink.flushAndClose();

    const second = new NodeSnapshotLogSink(logPath);
    await expect(second.open()).rejects.toMatchObject({ code: "LOG_WRITE_FAILED" });
    expect(await readFile(logPath, "utf8")).not.toContain("second");
  });

  it("refuses targets inside the Vault root or the ObjectStore root", async () => {
    const vaultRoot = await makeRoot("ekd-vault-");
    const storeRoot = await makeRoot("ekd-store-");
    const insideVault = new NodeSnapshotLogSink(join(vaultRoot, "run.log"), { vaultRoot, objectStoreRoot: storeRoot });
    await expect(insideVault.open()).rejects.toMatchObject({ code: "LOG_WRITE_FAILED" });
    const insideStore = new NodeSnapshotLogSink(join(storeRoot, "run.log"), { vaultRoot, objectStoreRoot: storeRoot });
    await expect(insideStore.open()).rejects.toMatchObject({ code: "LOG_WRITE_FAILED" });
    await expect(readFile(join(vaultRoot, "run.log"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(storeRoot, "run.log"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a missing or symlinked parent directory", async () => {
    const outside = await makeRoot("ekd-log-out-");
    const missing = new NodeSnapshotLogSink(join(outside, "does-not-exist", "run.log"));
    await expect(missing.open()).rejects.toMatchObject({ code: "LOG_WRITE_FAILED" });

    const aliasDir = await makeRoot("ekd-alias-");
    const realDir = await makeRoot("ekd-real-");
    if (await createReparseLink(join(aliasDir, "alias"), realDir)) {
      const sink = new NodeSnapshotLogSink(join(aliasDir, "alias", "run.log"));
      await expect(sink.open()).rejects.toMatchObject({ code: "LOG_WRITE_FAILED" });
    }
  });
});

describe("NodeRecoveryFileTarget", () => {
  it("verifies absence, writes exclusively, and reads back byte-exactly", async () => {
    const outside = await makeRoot("ekd-rec-out-");
    const recoveryPath = join(outside, "recovery.bin");
    const target = new NodeRecoveryFileTarget(recoveryPath);
    await target.verifyTargetAbsent();
    const bytes = new Uint8Array(167).map((_value, index) => index % 251);
    await target.writeExclusiveAndReadBack(bytes);
    const stored = await readFile(recoveryPath);
    expect(stored.byteLength).toBe(167);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex")
    );
  });

  it("fails when the target already exists and never overwrites it", async () => {
    const outside = await makeRoot("ekd-rec-out-");
    const recoveryPath = join(outside, "recovery.bin");
    await writeFile(recoveryPath, utf8Bytes("precious prior content"));

    const target = new NodeRecoveryFileTarget(recoveryPath);
    await expect(target.verifyTargetAbsent()).rejects.toMatchObject({ code: "RECOVERY_FILE_WRITE_FAILED" });
    await expect(target.writeExclusiveAndReadBack(utf8Bytes("new snapshot bytes"))).rejects.toMatchObject({
      code: "RECOVERY_FILE_WRITE_FAILED"
    });
    expect(await readFile(recoveryPath, "utf8")).toBe("precious prior content");
  });

  it("fails for targets inside the Vault root or the ObjectStore root", async () => {
    const vaultRoot = await makeRoot("ekd-vault-");
    const storeRoot = await makeRoot("ekd-store-");
    const insideVault = new NodeRecoveryFileTarget(join(vaultRoot, "recovery.bin"), { vaultRoot, objectStoreRoot: storeRoot });
    await expect(insideVault.verifyTargetAbsent()).rejects.toMatchObject({ code: "RECOVERY_FILE_WRITE_FAILED" });
    const insideStore = new NodeRecoveryFileTarget(join(storeRoot, "recovery.bin"), { vaultRoot, objectStoreRoot: storeRoot });
    await expect(insideStore.verifyTargetAbsent()).rejects.toMatchObject({ code: "RECOVERY_FILE_WRITE_FAILED" });
    await expect(readFile(join(vaultRoot, "recovery.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails preflight when an ancestor filesystem alias resolves the target inside the Vault", async () => {
    const vaultRoot = await makeRoot("ekd-vault-");
    const storeRoot = await makeRoot("ekd-store-");
    const aliasRoot = await makeRoot("ekd-alias-");
    await writeFile(join(vaultRoot, "keep.md"), "unchanged\n", "utf8");
    const outputDirectory = join(vaultRoot, "output");
    await mkdir(outputDirectory);
    const aliasPath = join(aliasRoot, "vault-alias");
    if (!(await createReparseLink(aliasPath, vaultRoot))) return;

    const recoveryPath = join(aliasPath, "output", "recovery.bin");
    const target = new NodeRecoveryFileTarget(recoveryPath, { vaultRoot, objectStoreRoot: storeRoot });
    await expect(target.verifyTargetAbsent()).rejects.toMatchObject({
      code: "RECOVERY_FILE_WRITE_FAILED",
      message: "Snapshot target must stay outside both the Vault root and the ObjectStore root."
    });
    await expect(readFile(join(outputDirectory, "recovery.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(vaultRoot, "keep.md"), "utf8")).toBe("unchanged\n");
  });
});

describe("NodeVaultSource stable chunked reads", () => {
  it("round-trips a multi-chunk file byte-exactly through the stable read path", async () => {
    const vaultRoot = await makeRoot("ekd-vault-");
    const filePath = join(vaultRoot, "big.md");
    const original = new Uint8Array(VAULT_SOURCE_READ_CHUNK_BYTES + Math.floor(VAULT_SOURCE_READ_CHUNK_BYTES / 2) + 7);
    for (let index = 0; index < original.byteLength; index += 1) original[index] = index % 251;
    await writeFile(filePath, original);

    const bytes = await readStableFile(filePath);
    expect(bytes.byteLength).toBe(original.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      createHash("sha256").update(original).digest("hex")
    );
  });

  it("converges read failures other than stability changes to SOURCE_FILE_READ_FAILED", async () => {
    await expect(
      readStableFile(join(await makeRoot("ekd-vault-"), "any.md"), {
        stamp: async () => ({ size: 8n, mtimeNs: 1n, ctimeNs: 1n, device: 1n, inode: 1n }),
        read: async () => {
          throw new Error("EACCES: permission denied");
        }
      })
    ).rejects.toMatchObject({ code: "SOURCE_FILE_READ_FAILED" });
  });

  it("keeps converging observed stability changes to FILE_CHANGED_DURING_SCAN", async () => {
    const vaultRoot = await makeRoot("ekd-vault-");
    const filePath = join(vaultRoot, "shifting.md");
    await writeFile(filePath, "before\n");
    const firstRead = readStableFile(filePath);
    await writeFile(filePath, "changed with a different length\n");
    await expect(firstRead).rejects.toMatchObject({ code: "FILE_CHANGED_DURING_SCAN" });
  });

  it("binds the adapter chunk constant to the accepted runtime-limits contract file", async () => {
    const contract = JSON.parse(
      await readFile(join(process.cwd(), "../../docs/contracts/p0-runtime-limits-v1.json"), "utf8")
    ) as { limits: { vault_read_chunk_bytes: number } };
    expect(VAULT_SOURCE_READ_CHUNK_BYTES).toBe(contract.limits.vault_read_chunk_bytes);
  });
});
