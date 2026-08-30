import { NodeRestoreTarget } from "../src/index.js";
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

/** Returns false when the platform refuses to create the link (e.g. unprivileged Windows symlinks). */
async function createReparseLink(linkPath: string, targetPath: string): Promise<boolean> {
  try {
    await symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

describe("NodeRestoreTarget", () => {
  it("accepts a caller-created empty directory and rejects any non-empty target", async () => {
    const empty = await makeRoot("ekd-restore-");
    await new NodeRestoreTarget(empty).verifyEmptyTarget();

    const withFile = await makeRoot("ekd-restore-");
    await writeFile(join(withFile, "dummy.txt"), "pre-existing");
    await expect(new NodeRestoreTarget(withFile).verifyEmptyTarget()).rejects.toMatchObject({
      code: "NON_EMPTY_TARGET"
    });
    await expect(readFile(join(withFile, "dummy.txt"), "utf8")).resolves.toBe("pre-existing");

    const withDir = await makeRoot("ekd-restore-");
    await mkdir(join(withDir, "nested"));
    await expect(new NodeRestoreTarget(withDir).verifyEmptyTarget()).rejects.toMatchObject({
      code: "NON_EMPTY_TARGET"
    });
  });

  it("rejects a missing target, a file target, and a reparse-point target", async () => {
    const outside = await makeRoot("ekd-restore-out-");
    await expect(new NodeRestoreTarget(join(outside, "missing")).verifyEmptyTarget()).rejects.toMatchObject({
      code: "NON_EMPTY_TARGET"
    });

    const filePath = join(outside, "plain-file");
    await writeFile(filePath, "not a directory");
    await expect(new NodeRestoreTarget(filePath).verifyEmptyTarget()).rejects.toMatchObject({
      code: "NON_EMPTY_TARGET"
    });

    const realDir = await makeRoot("ekd-restore-real-");
    if (await createReparseLink(join(outside, "alias"), realDir)) {
      await expect(new NodeRestoreTarget(join(outside, "alias")).verifyEmptyTarget()).rejects.toMatchObject({
        code: "REPARSE_POINT_FOUND"
      });
    }

    const attributedReparse = await makeRoot("ekd-restore-reparse-");
    await expect(new NodeRestoreTarget(attributedReparse, {
      reparsePointProbe: async () => true
    }).verifyEmptyTarget()).rejects.toMatchObject({ code: "REPARSE_POINT_FOUND" });

    const uninspectable = await makeRoot("ekd-restore-uninspectable-");
    await expect(new NodeRestoreTarget(uninspectable, {
      reparsePointProbe: async () => { throw new Error("probe failed"); }
    }).verifyEmptyTarget()).rejects.toMatchObject({ code: "REPARSE_POINT_FOUND" });
  });

  it("creates parent directories and writes restored bytes exactly", async () => {
    const targetRoot = await makeRoot("ekd-restore-");
    const target = new NodeRestoreTarget(targetRoot);
    const bytes = new Uint8Array(64).map((_value, index) => index % 251);
    await target.writeRestoredFile("notes/nested/a.md", bytes);
    const stored = await readFile(join(targetRoot, "notes", "nested", "a.md"));
    expect([...stored]).toEqual([...bytes]);
  });

  it("rejects non-canonical restored paths defensively (INV-06/ACC-19)", async () => {
    const targetRoot = await makeRoot("ekd-restore-");
    const target = new NodeRestoreTarget(targetRoot);
    await expect(target.writeRestoredFile("../escape.md", utf8Bytes("x"))).rejects.toMatchObject({
      code: "ENTRY_PATH_ESCAPE"
    });
    await expect(target.writeRestoredFile("a\\b.md", utf8Bytes("x"))).rejects.toMatchObject({
      code: "ENTRY_PATH_ESCAPE"
    });
    await expect(target.writeRestoredFile("/absolute.md", utf8Bytes("x"))).rejects.toMatchObject({
      code: "ENTRY_PATH_ESCAPE"
    });
    await expect(readFile(join(targetRoot, "escape.md")).catch(() => "absent")).resolves.toBe("absent");
  });

  it("normalizes target filesystem failures to RESTORE_TARGET_WRITE_FAILED", async () => {
    const targetRoot = await makeRoot("ekd-restore-");
    await writeFile(join(targetRoot, "blocked-parent"), "not a directory");
    await expect(
      new NodeRestoreTarget(targetRoot).writeRestoredFile("blocked-parent/a.md", utf8Bytes("x"))
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_WRITE_FAILED" });
  });
});

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
