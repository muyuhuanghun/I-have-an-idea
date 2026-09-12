import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rmdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSnapshotV1, restoreSnapshotV1, type CryptoProvider } from "@ekd/core";
import {
  DirectoryObjectStoreV1,
  NodeRecoveryFileTarget,
  NodeRestoreTarget,
  NodeSnapshotLogSink,
  NodeVaultSource
} from "@ekd/adapters";
import { encodeHeadPointerBytes, HeadDirectory } from "@ekd/adapters/head-directory";
import {
  projectHeadStatus,
  projectStorageStats,
  startWebConsoleServer,
  WebConsoleTaskRing
} from "@ekd/adapters/web-console";
import { NobleAes256Provider, NOBLE_CANDIDATE } from "@ekd/crypto/noble";
import { WebCryptoAes256Provider, WEBCRYPTO_CANDIDATE } from "@ekd/crypto/webcrypto";
import { WebCryptoDeviceSignatureProvider } from "@ekd/crypto";
import {
  createSmokeReport,
  runSmokeVectors,
  sha256Hex,
  utf8Bytes,
  type CandidateMetadata,
  type EnvironmentManifest,
  type SmokeExecutionOptions
} from "@ekd/smoke";
import { aggregateSmokeReports, loadCryptoVectors, loadSmokeSchemaValidator } from "@ekd/smoke/node";

interface BuildMeta {
  readonly schema_version: "phase1-build-meta-v1";
  readonly source_commit: string;
  readonly source_tree_state: "clean" | "dirty";
  readonly lockfile_sha256: string;
  readonly vector_manifest_sha256: string;
  readonly vectors_sha256: string;
  readonly bundle_sha256: string;
}

type CandidateName = "webcrypto" | "noble";

const HELP = [
  "ekd-p0 — Phase 1 portability smoke harness + P0 CLI wiring (ADR-0021)",
  "",
  "Commands:",
  "  smoke --candidate webcrypto|noble [--output-dir PATH] [--allow-dirty-dev]",
  "  aggregate --root PATH --report PATH --report PATH --report PATH [--output PATH]",
  "",
  "P0 wiring:",
  "  snapshot --vault DIR --store DIR --log FILE --recovery FILE --domain-id 64HEX --runtime-limits FILE",
  "  restore --recovery FILE --store DIR --target DIR",
  "  __restore-worker --recovery FILE --store DIR --target DIR        (internal)",
  "",
  "P1 read-only console (DP-027, ADR-0030/0031):",
  "  console --store DIR --head-dir DIR --domain-id 64HEX",
  "",
  "P0 rules: every path is explicit; the Vault is never written; log/recovery/store",
  "stay outside the Vault and each other; the store root, log parent and recovery",
  "parent must pre-exist as real directories; restore refuses non-empty targets and",
  "runs in a fresh process. Runtime-limits hash is bound to the accepted contract bytes."
].join("\n");

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function repeatedOption(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
      values.push(value);
    }
  }
  return values;
}

function isBuildMeta(value: unknown): value is BuildMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  return meta.schema_version === "phase1-build-meta-v1" &&
    (meta.source_tree_state === "clean" || meta.source_tree_state === "dirty") &&
    [meta.source_commit, meta.lockfile_sha256, meta.vector_manifest_sha256, meta.vectors_sha256, meta.bundle_sha256]
      .every((field, index) => typeof field === "string" && new RegExp(index === 0 ? "^[0-9a-f]{40}$" : "^[0-9a-f]{64}$").test(field));
}

async function loadBuildMeta(): Promise<BuildMeta> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const bundlePath = resolve(moduleDirectory, "main.js");
  const parsed = JSON.parse(await readFile(resolve(moduleDirectory, "build-meta.json"), "utf8")) as unknown;
  if (!isBuildMeta(parsed)) throw new Error("Invalid Phase 1 build metadata.");
  const actualBundleSha = sha256Hex(new Uint8Array(await readFile(bundlePath)));
  if (actualBundleSha !== parsed.bundle_sha256) throw new Error("CLI bundle does not match build metadata.");
  return parsed;
}

function candidate(name: CandidateName): {
  readonly provider: CryptoProvider;
  readonly faults: NonNullable<SmokeExecutionOptions["random_source_faults"]>;
  readonly metadata: Omit<CandidateMetadata, "bundle_sha256">;
} {
  const create = (randomBytes?: (length: number) => Uint8Array): CryptoProvider => name === "webcrypto"
    ? new WebCryptoAes256Provider(randomBytes === undefined ? {} : { randomBytes })
    : new NobleAes256Provider(randomBytes === undefined ? {} : { randomBytes });
  const definition = name === "webcrypto" ? WEBCRYPTO_CANDIDATE : NOBLE_CANDIDATE;
  return {
    provider: create(),
    faults: {
      short_read: create((length) => new Uint8Array(length - 1)),
      failure: create(() => { throw new Error("injected random-source failure"); }),
      all_zero: create((length) => new Uint8Array(length))
    },
    metadata: {
      name: definition.name,
      version: definition.version,
      package_integrity: definition.packageIntegrity
    }
  };
}

function environmentManifest(meta: BuildMeta): EnvironmentManifest {
  const items = [
    { key: "source_tree_state", value: meta.source_tree_state },
    { key: "test_scope", value: "phase1-crypto-portability-smoke" },
    { key: "runtime", value: `Node.js ${process.version}` },
    { key: "network", value: "unused" }
  ];
  return {
    recorded_at: new Date().toISOString(),
    items,
    items_sha256: sha256Hex(utf8Bytes(JSON.stringify(items)))
  };
}

async function smoke(args: readonly string[]): Promise<number> {
  const selected = option(args, "--candidate");
  if (selected !== "webcrypto" && selected !== "noble") throw new Error("--candidate must be webcrypto or noble.");
  const meta = await loadBuildMeta();
  if (meta.source_tree_state !== "clean" && !args.includes("--allow-dirty-dev")) {
    throw new Error("Formal smoke requires a clean source tree. Use --allow-dirty-dev only for non-closing development evidence.");
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(moduleDirectory, "../../..");
  const outputRoot = resolve(option(args, "--output-dir") ?? resolve(repositoryRoot, "artifacts/phase1-smoke"));
  const vectorSet = await loadCryptoVectors({
    manifest_path: resolve(repositoryRoot, "fixtures/crypto-vectors/manifest.json")
  });
  if (vectorSet.manifestSha256 !== meta.vector_manifest_sha256 || vectorSet.vectorsSha256 !== meta.vectors_sha256) {
    throw new Error("Runtime vectors do not match the CLI build metadata.");
  }
  const selectedCandidate = candidate(selected);
  const runId = crypto.randomUUID();
  const vectorRun = await runSmokeVectors(selectedCandidate.provider, {
    vector_set: vectorSet,
    random_source_faults: selectedCandidate.faults
  });
  const rawRelative = `raw/windows-node-cli-${selected}-${runId}.json`;
  const reportRelative = `reports/windows-node-cli-${selected}-${runId}.json`;
  const rawBytes = utf8Bytes(`${JSON.stringify({
    schema_version: "phase1-smoke-raw-v1",
    run_id: runId,
    environment_id: "windows-node-cli",
    candidate: selectedCandidate.metadata,
    vector_results: vectorRun.vector_results,
    aggregate: vectorRun.aggregate
  }, null, 2)}\n`);
  await mkdir(resolve(outputRoot, "raw"), { recursive: true });
  await mkdir(resolve(outputRoot, "reports"), { recursive: true });
  await writeFile(resolve(outputRoot, rawRelative), rawBytes);
  const report = createSmokeReport(vectorRun, vectorSet, {
    run_id: runId,
    git_commit: meta.source_commit,
    candidate: { ...selectedCandidate.metadata, bundle_sha256: meta.bundle_sha256 },
    environment: {
      id: "windows-node-cli",
      os_name: platform(),
      os_version: release(),
      runtime_name: "Node.js",
      runtime_version: process.version,
      device_model: null,
      architecture: arch(),
      lockfile_sha256: meta.lockfile_sha256,
      source_commit: meta.source_commit,
      bundle_sha256: meta.bundle_sha256
    },
    environment_manifest: environmentManifest(meta),
    raw_artifacts: [{ path: rawRelative, sha256: sha256Hex(rawBytes) }],
    device_binding: null
  });
  const validation = loadSmokeSchemaValidator().validateSmokeReport(report);
  if (!validation.valid) throw new Error(`Generated report failed schema validation: ${validation.errors.join("; ")}`);
  await writeFile(resolve(outputRoot, reportRelative), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    mode: meta.source_tree_state === "clean" ? "formal" : "dev-only",
    verdict: report.aggregate.verdict,
    report: relative(process.cwd(), resolve(outputRoot, reportRelative))
  }));
  return report.aggregate.verdict === "pass" ? 0 : 1;
}

async function aggregate(args: readonly string[]): Promise<number> {
  const root = resolve(option(args, "--root") ?? ".");
  const reports = repeatedOption(args, "--report");
  if (reports.length !== 3) throw new Error("aggregate requires exactly three --report values.");
  const result = await aggregateSmokeReports({ root_dir: root, reports: reports.map((path) => ({ path })) });
  const output = resolve(root, option(args, "--output") ?? "smoke-aggregate.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ verdict: result.cross_env_verdict, output: relative(process.cwd(), output) }));
  return result.cross_env_verdict === "cross_env_pass" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// P0 wiring (ADR-0021). Adapter/core semantics (Vault zero-write, exclusive
// log/recovery creation, immutable store objects, empty restore target) stay in
// the shared packages; the CLI parses explicit arguments, binds the accepted
// runtime-limits contract bytes, enforces path disjointness and the restore
// target policy, and keeps restore in a fresh process.
// ---------------------------------------------------------------------------

/** SHA-256 of `docs/contracts/p0-runtime-limits-v1.json`; cross-checked against the real file by `tools/verify_phase0_contracts.py`. */
const ACCEPTED_RUNTIME_LIMITS_SHA256 = "e1971ab746f6b08b06522463f907143036d99e41c470532482b5da8eafc44acd";

function requireHex64(value: string | undefined, flag: string): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${flag} must be 64 lowercase hex characters.`);
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/../gu);
  if (pairs === null) throw new Error("Invalid hex string.");
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function isInsidePath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function requireDisjoint(labelA: string, pathA: string, labelB: string, pathB: string): void {
  if (isInsidePath(pathA, pathB) || isInsidePath(pathB, pathA)) {
    throw new Error(`${labelA} and ${labelB} must not contain each other.`);
  }
}

/**
 * Resolve the filesystem identity used for containment checks. Output files and a new
 * restore target do not exist yet, so their identity is the real path of the existing
 * parent plus the final basename. On Windows this also expands 8.3 short names and
 * resolves ancestor Junctions, which a lexical `path.relative` comparison cannot see.
 */
async function physicalPathIdentity(pathValue: string): Promise<string> {
  try {
    return await realpath(pathValue);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
  }
  const parentIdentity = await realpath(dirname(pathValue));
  return resolve(parentIdentity, basename(pathValue));
}

async function requirePhysicalDisjoint(
  labelA: string,
  pathA: string,
  labelB: string,
  pathB: string
): Promise<void> {
  let identityA: string;
  let identityB: string;
  try {
    [identityA, identityB] = await Promise.all([
      physicalPathIdentity(pathA),
      physicalPathIdentity(pathB)
    ]);
  } catch (error) {
    throw new Error(
      `${labelA}/${labelB} filesystem identity could not be resolved: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  requireDisjoint(labelA, identityA, labelB, identityB);
}

interface SnapshotCliOptions {
  readonly vault: string;
  readonly store: string;
  readonly log: string;
  readonly recovery: string;
  readonly domainIdHex: string;
  readonly runtimeLimits: string;
}

function snapshotOptions(args: readonly string[]): SnapshotCliOptions {
  const vault = option(args, "--vault");
  const store = option(args, "--store");
  const log = option(args, "--log");
  const recovery = option(args, "--recovery");
  const runtimeLimits = option(args, "--runtime-limits");
  const missing = [
    ["--vault", vault], ["--store", store], ["--log", log], ["--recovery", recovery], ["--runtime-limits", runtimeLimits]
  ].filter((entry) => entry[1] === undefined).map((entry) => entry[0]);
  if (missing.length > 0) throw new Error(`snapshot requires ${missing.join(", ")}.`);
  return {
    vault: resolve(vault as string),
    store: resolve(store as string),
    log: resolve(log as string),
    recovery: resolve(recovery as string),
    domainIdHex: requireHex64(option(args, "--domain-id"), "--domain-id"),
    runtimeLimits: resolve(runtimeLimits as string)
  };
}

async function snapshotCommand(args: readonly string[]): Promise<number> {
  const options = snapshotOptions(args);
  requireDisjoint("--vault", options.vault, "--store", options.store);
  requireDisjoint("--vault", options.vault, "--log", options.log);
  requireDisjoint("--vault", options.vault, "--recovery", options.recovery);
  requireDisjoint("--store", options.store, "--log", options.log);
  requireDisjoint("--store", options.store, "--recovery", options.recovery);
  await Promise.all([
    requirePhysicalDisjoint("--vault", options.vault, "--store", options.store),
    requirePhysicalDisjoint("--vault", options.vault, "--log", options.log),
    requirePhysicalDisjoint("--vault", options.vault, "--recovery", options.recovery),
    requirePhysicalDisjoint("--store", options.store, "--log", options.log),
    requirePhysicalDisjoint("--store", options.store, "--recovery", options.recovery)
  ]);

  const limitsBytes = await readFile(options.runtimeLimits);
  const limitsSha256 = sha256Hex(limitsBytes);
  if (limitsSha256 !== ACCEPTED_RUNTIME_LIMITS_SHA256) {
    throw new Error(`--runtime-limits sha256 ${limitsSha256} does not match the accepted p0-runtime-limits-v1 contract.`);
  }
  const limitsJson = JSON.parse(limitsBytes.toString("utf8")) as { schema_version?: unknown };
  if (limitsJson.schema_version !== "p0-runtime-limits-v1") {
    throw new Error("--runtime-limits file is not p0-runtime-limits-v1.");
  }

  const provider = new WebCryptoAes256Provider();
  const result = await createSnapshotV1(
    {
      domainId: hexToBytes(options.domainIdHex),
      runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: limitsSha256 }
    },
    {
      vaultSource: new NodeVaultSource(options.vault),
      objectStore: new DirectoryObjectStoreV1(options.store),
      cryptoProvider: provider,
      randomSource: provider,
      clock: { nowMilliseconds: () => Date.now() },
      logSink: new NodeSnapshotLogSink(options.log, { vaultRoot: options.vault, objectStoreRoot: options.store }),
      recoveryFileTarget: new NodeRecoveryFileTarget(options.recovery, { vaultRoot: options.vault, objectStoreRoot: options.store })
    }
  );
  console.log(JSON.stringify(result, null, 2));
  return result.status === "complete" ? 0 : 1;
}

interface RestoreCliOptions {
  readonly recovery: string;
  readonly store: string;
  readonly target: string;
}

function restoreOptions(args: readonly string[]): RestoreCliOptions {
  const recovery = option(args, "--recovery");
  const store = option(args, "--store");
  const target = option(args, "--target");
  const missing = [["--recovery", recovery], ["--store", store], ["--target", target]]
    .filter((entry) => entry[1] === undefined).map((entry) => entry[0]);
  if (missing.length > 0) throw new Error(`restore requires ${missing.join(", ")}.`);
  return { recovery: resolve(recovery as string), store: resolve(store as string), target: resolve(target as string) };
}

/** ADR-0021 §2.8: refuse non-empty existing targets; create the empty directory on the caller's behalf. Returns whether the CLI created it. */
export async function prepareRestoreTarget(target: string): Promise<boolean> {
  try {
    await mkdir(target);
    return true;
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) {
      throw new Error(`--target could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("--target exists and is not a real directory.");
  if ((await readdir(target)).length > 0) throw new Error("--target exists and is not empty; refusing to restore into it.");
  return false;
}

/** Leave no trace when the CLI created the target and the failed run never wrote into it. */
async function removeEmptyCreatedTarget(target: string, created: boolean): Promise<void> {
  if (!created) return;
  try {
    if ((await readdir(target)).length === 0) await rmdir(target);
  } catch {
    // Best-effort cleanup; the restore failure is still reported as-is.
  }
}

async function restoreWorkerCommand(args: readonly string[]): Promise<number> {
  const options = restoreOptions(args);
  const recoveryFileBytes = await readFile(options.recovery);
  const provider = new WebCryptoAes256Provider();
  const result = await restoreSnapshotV1(
    { recoveryFileBytes },
    {
      objectStore: new DirectoryObjectStoreV1(options.store),
      cryptoProvider: provider,
      restoreTarget: new NodeRestoreTarget(options.target)
    }
  );
  console.log(JSON.stringify(result, null, 2));
  return result.status === "complete" ? 0 : 1;
}

async function restoreCommand(args: readonly string[]): Promise<number> {
  const options = restoreOptions(args);
  requireDisjoint("--store", options.store, "--target", options.target);
  await requirePhysicalDisjoint("--store", options.store, "--target", options.target);
  const created = await prepareRestoreTarget(options.target);
  const child = spawnSync(
    process.execPath,
    [resolve(process.argv[1] ?? "."), "__restore-worker", "--recovery", options.recovery, "--store", options.store, "--target", options.target],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (child.error !== undefined || child.stdout === null || !child.stdout.trim().startsWith("{")) {
    await removeEmptyCreatedTarget(options.target, created);
    process.stderr.write(child.stderr ?? `${child.error === undefined ? "restore worker produced no output" : String(child.error)}\n`);
    return 2;
  }
  const result = JSON.parse(child.stdout) as { status?: string };
  if (result.status !== "complete") await removeEmptyCreatedTarget(options.target, created);
  process.stdout.write(child.stdout);
  if (child.stderr !== null && child.stderr.length > 0) process.stderr.write(child.stderr);
  return child.status === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// P1 read-only console (DP-027, ADR-0030 §7.0 / ADR-0031 §1.4): the server and
// DTO live in the adapters web-console subentry; the CLI only parses explicit
// arguments, enforces the ADR-0021 path discipline and wires the session-domain
// sources. The process runs no tasks, so its task ring stays empty by design.
// ---------------------------------------------------------------------------

interface ConsoleCliOptions {
  readonly store: string;
  readonly headDir: string;
  readonly domainIdHex: string;
}

function consoleOptions(args: readonly string[]): ConsoleCliOptions {
  const store = option(args, "--store");
  const headDir = option(args, "--head-dir");
  const missing = [["--store", store], ["--head-dir", headDir]]
    .filter((entry) => entry[1] === undefined)
    .map((entry) => entry[0]);
  if (missing.length > 0) throw new Error(`console requires ${missing.join(", ")}.`);
  return {
    store: resolve(store as string),
    headDir: resolve(headDir as string),
    domainIdHex: requireHex64(option(args, "--domain-id"), "--domain-id")
  };
}

async function consoleCommand(args: readonly string[]): Promise<number> {
  const options = consoleOptions(args);
  requireDisjoint("--store", options.store, "--head-dir", options.headDir);
  await requirePhysicalDisjoint("--store", options.store, "--head-dir", options.headDir);

  const meta = await loadBuildMeta();
  const objectStore = new DirectoryObjectStoreV1(options.store);
  // Verify-only host: the PKCS8 slot is never used because the console never signs
  // (signPointer below refuses), and verification imports public keys from SPKI.
  const signer = new WebCryptoDeviceSignatureProvider(new Uint8Array(0));
  const directory = new HeadDirectory(options.headDir, {
    signPointer: async () => {
      throw new Error("The console is read-only and cannot sign head pointers.");
    },
    verifier: {
      verifyHeadSignature: (signedBytes, signature, spkiBytes) => signer.verifyHeadSignature(signedBytes, signature, spkiBytes),
      verifyPointerSignature: (pointer, spkiBytes, signatureBase64url) =>
        signer.verifyHeadSignature(
          encodeHeadPointerBytes(pointer),
          new Uint8Array(Buffer.from(signatureBase64url, "base64url")),
          spkiBytes
        )
    }
  });
  const domainId = hexToBytes(options.domainIdHex);
  const tasks = new WebConsoleTaskRing();
  const running = await startWebConsoleServer({
    service: { version: "p1-console-v1", build: meta.source_commit },
    headStatus: () => projectHeadStatus(directory, domainId, objectStore),
    storageStats: () => projectStorageStats(objectStore.rootPath),
    reportSummary: async () => null,
    tasks,
    log: (line) => process.stderr.write(`[console] ${line}\n`)
  });
  // The token is never printed or persisted; the page obtains it via the
  // same-origin bootstrap fetch (ADR-0030 §3.4).
  console.log(JSON.stringify({
    url: `http://127.0.0.1:${running.port}/`,
    build: meta.source_commit,
    started_at: new Date().toISOString(),
    note: "只读状态页；会话凭据不落盘、不打印。"
  }));
  await new Promise<void>((resolveStopped) => {
    const stop = (): void => {
      void running.close().then(
        () => resolveStopped(),
        () => resolveStopped()
      );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

export async function run(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (args[0] === "smoke") return smoke(args.slice(1));
  if (args[0] === "aggregate") return aggregate(args.slice(1));
  if (args[0] === "snapshot") return snapshotCommand(args.slice(1));
  if (args[0] === "restore") return restoreCommand(args.slice(1));
  if (args[0] === "__restore-worker") return restoreWorkerCommand(args.slice(1));
  if (args[0] === "console") return consoleCommand(args.slice(1));
  throw new Error(`Unknown command: ${args[0]}`);
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  );
}
