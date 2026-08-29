import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { scanVault } from "../../core/src/index.js";
import { NodeVaultSource } from "../src/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ekd-phase2-fixture-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic tiny fixture", () => {
  it("generates the same manifest and bytes for the same seed and generator", async () => {
    const first = await temporaryRoot();
    const second = await temporaryRoot();
    const generator = fileURLToPath(new URL("../../../tools/fixture-generator.mjs", import.meta.url));
    const args = [generator, "--profile", "tiny", "--git-commit", "0".repeat(40)];
    await execFileAsync(process.execPath, [...args, "--output", first]);
    await execFileAsync(process.execPath, [...args, "--output", second]);
    const firstManifestText = await readFile(join(first, "fixture-manifest-v1.json"), "utf8");
    const secondManifestText = await readFile(join(second, "fixture-manifest-v1.json"), "utf8");
    expect(secondManifestText).toBe(firstManifestText);

    const manifest = JSON.parse(firstManifestText) as {
      readonly totals: { readonly files: number; readonly bytes: number };
      readonly entries_sha256: string;
      readonly entries: readonly { readonly relative_path: string }[];
    };
    expect(manifest.totals.files).toBe(20);
    expect(manifest.totals.bytes).toBeLessThanOrEqual(5_242_880);
    expect(manifest.entries_sha256).toMatch(/^[0-9a-f]{64}$/u);
    for (const entry of manifest.entries) {
      expect(await readFile(join(second, "vault", ...entry.relative_path.split("/"))))
        .toEqual(await readFile(join(first, "vault", ...entry.relative_path.split("/"))));
    }

    const scan = await scanVault(new NodeVaultSource(join(first, "vault")));
    expect(scan.files).toHaveLength(20);
    expect(scan.totalBytes).toBe(BigInt(manifest.totals.bytes));
  });
});
