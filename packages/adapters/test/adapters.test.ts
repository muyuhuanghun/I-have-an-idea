import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterNotImplementedError,
  NodeVaultSource,
  ObsidianVaultSource,
  VaultAdapterError,
  readStableFile,
  writeRecoveryFileAndReadBack,
  type StableReadDependencies
} from "../src/index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ekd-phase2-adapter-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("Node Vault adapter", () => {
  it("reads regular files in stable UTF-8 path order and excludes .obsidian", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, ".obsidian"));
    await writeFile(join(root, ".obsidian", "workspace.json"), "host-only");
    await writeFile(join(root, "z.md"), "z");
    await writeFile(join(root, "a.md"), "a");
    const beforeA = await readFile(join(root, "a.md"));
    const entries = [];
    for await (const entry of new NodeVaultSource(root).listFiles()) entries.push(entry);

    expect(entries.map((entry) => entry.relativePath)).toEqual(["a.md", "z.md"]);
    expect(Array.from(await entries[0]?.readBytes() ?? [])).toEqual(Array.from(beforeA));
    expect(await readFile(join(root, "a.md"))).toEqual(beforeA);
  });

  it("detects a file stamp change after reading", async () => {
    const unchanged = { size: 3n, mtimeNs: 1n, ctimeNs: 1n, device: 1n, inode: 1n };
    let stampCalls = 0;
    const dependencies: StableReadDependencies = {
      stamp: async () => {
        stampCalls += 1;
        return stampCalls === 1 ? unchanged : { ...unchanged, mtimeNs: 2n };
      },
      read: async () => new Uint8Array([1, 2, 3])
    };
    await expect(readStableFile("C:/vault/changing.md", dependencies)).rejects.toMatchObject({
      code: "FILE_CHANGED_DURING_SCAN"
    });
  });

  it("rejects a directory link before reading its target", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "secret.md"), "must-not-be-read");
    await symlink(outside, join(root, "linked"), "junction");
    await expect((async () => {
      for await (const entry of new NodeVaultSource(root).listFiles()) void entry;
    })()).rejects.toMatchObject({ code: "REPARSE_POINT_FOUND", relativePath: "linked" });
  });
});

describe("adapter phase boundaries", () => {
  it("keeps the Obsidian product scanner binding disabled", async () => {
    const source = new ObsidianVaultSource({ getMarkdownFiles: () => [] });
    await expect((async () => {
      for await (const entry of source.listFiles()) void entry;
    })()).rejects.toBeInstanceOf(AdapterNotImplementedError);
  });

  it("exposes stable adapter errors", () => {
    expect(new VaultAdapterError("ENTRY_PATH_ESCAPE", "../x", "bad path").code).toBe("ENTRY_PATH_ESCAPE");
  });
});

describe("Node Recovery File adapter", () => {
  it("exclusively writes outside the Vault, closes the handle, and returns disk bytes", async () => {
    const vaultRoot = await temporaryRoot();
    const recoveryRoot = await temporaryRoot();
    const recoveryPath = join(recoveryRoot, "domain-recovery.ekdr");
    const bytes = new Uint8Array(167).fill(0x5a);

    expect(await writeRecoveryFileAndReadBack(vaultRoot, recoveryPath, bytes)).toEqual(bytes);
    expect(new Uint8Array(await readFile(recoveryPath))).toEqual(bytes);
  });

  it("rejects a path inside the Vault before creating a file", async () => {
    const vaultRoot = await temporaryRoot();
    const recoveryPath = join(vaultRoot, "must-not-exist.ekdr");
    await expect(writeRecoveryFileAndReadBack(
      vaultRoot,
      recoveryPath,
      new Uint8Array(167).fill(1)
    )).rejects.toBeInstanceOf(RangeError);
    await expect(readFile(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite an existing Recovery File", async () => {
    const vaultRoot = await temporaryRoot();
    const recoveryRoot = await temporaryRoot();
    const recoveryPath = join(recoveryRoot, "existing.ekdr");
    const existing = new Uint8Array([1, 2, 3]);
    await writeFile(recoveryPath, existing);

    await expect(writeRecoveryFileAndReadBack(
      vaultRoot,
      recoveryPath,
      new Uint8Array(167).fill(2)
    )).rejects.toMatchObject({ code: "EEXIST" });
    expect(new Uint8Array(await readFile(recoveryPath))).toEqual(existing);
  });
});
