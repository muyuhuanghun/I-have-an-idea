import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRestoreTarget, run } from "../src/main.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

const DOMAIN_ID = "ab".repeat(32);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNTIME_LIMITS = resolve(REPO_ROOT, "docs", "contracts", "p0-runtime-limits-v1.json");

async function makeVault(): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "ekd-cli-vault-"));
  temporaryRoots.push(vaultRoot);
  await mkdir(join(vaultRoot, "notes"));
  await writeFile(join(vaultRoot, "alpha.md"), "alpha body\n", "utf8");
  await writeFile(join(vaultRoot, "notes", "beta.py"), "print('beta')\n", "utf8");
  return vaultRoot;
}

async function makeScaffold(): Promise<{ base: string; store: string; log: string; recovery: string }> {
  const base = await mkdtemp(join(tmpdir(), "ekd-cli-p0-"));
  temporaryRoots.push(base);
  const store = join(base, "store");
  await mkdir(store);
  return { base, store, log: join(base, "snapshot.log"), recovery: join(base, "recovery.bin") };
}

async function snapshot(vaultRoot: string, scaffold: { store: string; log: string; recovery: string }, overrides: Record<string, string> = {}): Promise<number> {
  return run([
    "snapshot",
    "--vault", vaultRoot,
    "--store", overrides.store ?? scaffold.store,
    "--log", scaffold.log,
    "--recovery", scaffold.recovery,
    "--domain-id", overrides.domainId ?? DOMAIN_ID,
    "--runtime-limits", overrides.runtimeLimits ?? RUNTIME_LIMITS
  ]);
}

describe("P0 CLI wiring (ADR-0021)", () => {
  it("snapshot creates store objects, log and Recovery File and exits zero", async () => {
    const vaultRoot = await makeVault();
    const scaffold = await makeScaffold();
    const exit = await snapshot(vaultRoot, scaffold);
    expect(exit).toBe(0);
    expect(existsSync(scaffold.log)).toBe(true);
    expect(existsSync(scaffold.recovery)).toBe(true);
    expect((await readdir(scaffold.store, { recursive: true })).length).toBeGreaterThan(0);
  });

  it("snapshot refuses a store inside the vault and non-hex domain ids", async () => {
    const vaultRoot = await makeVault();
    const scaffold = await makeScaffold();
    const nestedStore = join(vaultRoot, "nested-store");
    await mkdir(nestedStore);
    await expect(snapshot(vaultRoot, scaffold, { store: nestedStore })).rejects.toThrow(/must not contain each other/);
    await expect(snapshot(vaultRoot, scaffold, { domainId: "zz".repeat(32) })).rejects.toThrow(/64 lowercase hex/);
  });

  it("snapshot refuses runtime-limits bytes that do not match the accepted contract", async () => {
    const vaultRoot = await makeVault();
    const scaffold = await makeScaffold();
    const tampered = join(scaffold.base, "tampered-limits.json");
    await writeFile(tampered, `${JSON.stringify({ schema_version: "p0-runtime-limits-v1" })}\n`, "utf8");
    await expect(snapshot(vaultRoot, scaffold, { runtimeLimits: tampered })).rejects.toThrow(/does not match the accepted p0-runtime-limits-v1 contract/);
  });

  it("restore worker restores byte-identical content into the empty target", async () => {
    const vaultRoot = await makeVault();
    const scaffold = await makeScaffold();
    expect(await snapshot(vaultRoot, scaffold)).toBe(0);
    const target = join(scaffold.base, "target");
    await mkdir(target);
    const exit = await run(["__restore-worker", "--recovery", scaffold.recovery, "--store", scaffold.store, "--target", target]);
    expect(exit).toBe(0);
    expect(await readFile(join(target, "alpha.md"), "utf8")).toBe("alpha body\n");
    expect(await readFile(join(target, "notes", "beta.py"), "utf8")).toBe("print('beta')\n");
  });

  it("prepareRestoreTarget creates missing targets, accepts empty ones and refuses non-empty ones", async () => {
    const base = await mkdtemp(join(tmpdir(), "ekd-cli-target-"));
    temporaryRoots.push(base);
    const created = join(base, "created");
    expect(await prepareRestoreTarget(created)).toBe(true);
    const emptyExisting = join(base, "empty");
    await mkdir(emptyExisting);
    expect(await prepareRestoreTarget(emptyExisting)).toBe(false);
    const nonEmpty = join(base, "non-empty");
    await mkdir(nonEmpty);
    await writeFile(join(nonEmpty, "occupied.txt"), "occupied", "utf8");
    await expect(prepareRestoreTarget(nonEmpty)).rejects.toThrow(/not empty/);
  });
});
