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

  it("representative plans are deterministic, 10,000 files, and inside the frozen byte ranges", async () => {
    const generator = fileURLToPath(new URL("../../../tools/fixture-generator.mjs", import.meta.url));
    const script = `
      import { createHash } from "node:crypto";
      import { pathToFileURL } from "node:url";
      const { buildRepresentativePlan } = await import(pathToFileURL(process.env.GEN).href);
      for (const profile of ["representative-small", "representative-large"]) {
        const plan = buildRepresentativePlan(profile);
        const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
        console.log(profile + "|" + plan.totalBytes + "|" + plan.entries.length + "|" + digest);
      }
    `;
    const options = { env: { ...process.env, GEN: generator } };
    const first = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], options);
    const second = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], options);
    expect(first.stdout).toBe(second.stdout);

    const ranges: Record<string, [number, number]> = {
      "representative-small": [127506842, 140928614],
      "representative-large": [1020054733, 1127428915]
    };
    for (const line of first.stdout.trim().split("\n")) {
      const [profile, totalBytes, files, digest] = line.split("|");
      const [minBytes, maxBytes] = ranges[profile] ?? [0, 0];
      expect(Number(files)).toBe(10000);
      expect(Number(totalBytes)).toBeGreaterThanOrEqual(minBytes);
      expect(Number(totalBytes)).toBeLessThanOrEqual(maxBytes);
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("generates representative-small on disk inside the frozen range with a verifiable scan", { timeout: 60_000 }, async () => {
    const root = await temporaryRoot();
    const generator = fileURLToPath(new URL("../../../tools/fixture-generator.mjs", import.meta.url));
    const args = [generator, "--profile", "representative-small", "--git-commit", "0".repeat(40)];
    await execFileAsync(process.execPath, [...args, "--output", root], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    const manifest = JSON.parse(await readFile(join(root, "fixture-manifest-v1.json"), "utf8")) as {
      readonly totals: { readonly files: number; readonly bytes: number };
      readonly seed: string;
    };
    expect(manifest.totals.files).toBe(10000);
    expect(manifest.totals.bytes).toBeGreaterThanOrEqual(127_506_842);
    expect(manifest.totals.bytes).toBeLessThanOrEqual(140_928_614);
    expect(manifest.seed).toBe("ekd-representative-v1");

    const scan = await scanVault(new NodeVaultSource(join(root, "vault")));
    expect(scan.files).toHaveLength(10000);
    expect(scan.totalBytes).toBe(BigInt(manifest.totals.bytes));
  });
});
