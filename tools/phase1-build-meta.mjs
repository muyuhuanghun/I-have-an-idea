import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readPhase1SourceMeta() {
  const lockfile = await readFile(resolve(repositoryRoot, "pnpm-lock.yaml"));
  const vectorManifestBytes = await readFile(resolve(repositoryRoot, "fixtures/crypto-vectors/manifest.json"));
  const vectorsBytes = await readFile(resolve(repositoryRoot, "fixtures/crypto-vectors/vectors.json"));
  const vectorManifest = JSON.parse(vectorManifestBytes.toString("utf8"));
  const vectorsSha256 = sha256(vectorsBytes);
  if (vectorManifest.vectors_sha256 !== vectorsSha256) {
    throw new Error("fixtures/crypto-vectors/vectors.json does not match manifest.json.");
  }
  const dirty = git("status", "--porcelain=v1", "--untracked-files=all").length > 0;
  return {
    repositoryRoot,
    gitCommit: git("rev-parse", "HEAD"),
    sourceTreeState: dirty ? "dirty" : "clean",
    lockfileSha256: sha256(lockfile),
    vectorManifestSha256: sha256(vectorManifestBytes),
    vectorsSha256,
    vectorManifestJson: vectorManifestBytes.toString("utf8"),
    vectorsJson: vectorsBytes.toString("utf8")
  };
}

export async function writeBundleMeta({ bundlePath, outputPath, appKind }) {
  const source = await readPhase1SourceMeta();
  const bundle = await readFile(bundlePath);
  const meta = {
    schema_version: "phase1-build-meta-v1",
    app_kind: appKind,
    source_commit: source.gitCommit,
    source_tree_state: source.sourceTreeState,
    lockfile_sha256: source.lockfileSha256,
    vector_manifest_sha256: source.vectorManifestSha256,
    vectors_sha256: source.vectorsSha256,
    bundle_sha256: sha256(bundle),
    bundle_size_bytes: bundle.byteLength,
    built_at_utc: new Date().toISOString()
  };
  await writeFile(outputPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

export { repositoryRoot };
