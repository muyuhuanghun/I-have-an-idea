import { readFile, writeFile, mkdir } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CryptoProvider } from "@ekd/core";
import { NobleAes256Provider, NOBLE_CANDIDATE } from "@ekd/crypto/noble";
import { WebCryptoAes256Provider, WEBCRYPTO_CANDIDATE } from "@ekd/crypto/webcrypto";
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
  "ekd-p0 — Phase 1 portability smoke harness",
  "",
  "Commands:",
  "  smoke --candidate webcrypto|noble [--output-dir PATH] [--allow-dirty-dev]",
  "  aggregate --root PATH --report PATH --report PATH --report PATH [--output PATH]",
  "",
  "Production Recovery, Manifest, and Object codecs are intentionally unavailable."
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

export async function run(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (args[0] === "smoke") return smoke(args.slice(1));
  if (args[0] === "aggregate") return aggregate(args.slice(1));
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
