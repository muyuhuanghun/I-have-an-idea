import { describe, expect, it } from "vitest";
import {
  VaultScanError,
  scanVault,
  type VaultEntry,
  type VaultSource
} from "../src/index.js";

function source(entries: readonly VaultEntry[]): VaultSource {
  return {
    listFiles: async function* () {
      for (const entry of entries) yield entry;
    }
  };
}

function file(relativePath: string, bytes: Uint8Array, onRead?: () => void): VaultEntry {
  return {
    relativePath,
    readBytes: async () => {
      onRead?.();
      return bytes;
    }
  };
}

describe("read-only Vault scanner", () => {
  it("classifies supported files, excludes .obsidian, and returns canonical path order", async () => {
    const result = await scanVault(source([
      file("中文/笔记.md", new Uint8Array([1, 2])),
      file(".obsidian/workspace.json", new Uint8Array([9, 9, 9])),
      file("code/main.py", new Uint8Array([3])),
      file("attachments/pixel.png", new Uint8Array([4, 5, 6]))
    ]));

    expect(result.files).toEqual([
      { relativePath: "attachments/pixel.png", plaintextSize: 3n, contentClass: "image" },
      { relativePath: "code/main.py", plaintextSize: 1n, contentClass: "python" },
      { relativePath: "中文/笔记.md", plaintextSize: 2n, contentClass: "markdown" }
    ]);
    expect(result.totalBytes).toBe(6n);
  });

  it("reports every unsupported path and returns no partial result", async () => {
    let unsupportedReads = 0;
    await expect(scanVault(source([
      file("ok.md", new Uint8Array([1])),
      file("tools/run.exe", new Uint8Array([2]), () => { unsupportedReads += 1; }),
      file("data.json", new Uint8Array([3]), () => { unsupportedReads += 1; })
    ]))).rejects.toMatchObject({
      code: "UNSUPPORTED_FILES_FOUND",
      paths: ["data.json", "tools/run.exe"]
    });
    expect(unsupportedReads).toBe(0);
  });

  it("rejects escape-shaped and duplicate paths", async () => {
    await expect(scanVault(source([
      file("../outside.md", new Uint8Array())
    ]))).rejects.toMatchObject({ code: "ENTRY_PATH_ESCAPE" });

    await expect(scanVault(source([
      file("same.md", new Uint8Array()),
      file("same.md", new Uint8Array())
    ]))).rejects.toMatchObject({
      name: VaultScanError.name,
      code: "ENTRY_PATH_DUPLICATE"
    });

    for (const escapedConfigurationPath of [
      ".obsidian/../escape.md",
      ".obsidian//bad.md"
    ]) {
      await expect(scanVault(source([
        file(escapedConfigurationPath, new Uint8Array())
      ]))).rejects.toMatchObject({ code: "ENTRY_PATH_ESCAPE" });
    }
  });

  it("matches Windows one-code-point case folding without multi-character expansion", async () => {
    await expect(scanVault(source([
      file("A.md", new Uint8Array()),
      file("a.md", new Uint8Array())
    ]))).rejects.toMatchObject({ code: "CASE_COLLISION" });

    await expect(scanVault(source([
      file("Å.md", new Uint8Array()),
      file("å.md", new Uint8Array())
    ]))).rejects.toMatchObject({ code: "CASE_COLLISION" });

    const result = await scanVault(source([
      file("k.md", new Uint8Array([1])),
      file("K.md", new Uint8Array([2])),
      file("ss.md", new Uint8Array([3])),
      file("ß.md", new Uint8Array([4]))
    ]));
    expect(result.files).toHaveLength(4);
  });
});
