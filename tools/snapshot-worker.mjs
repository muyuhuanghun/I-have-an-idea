#!/usr/bin/env node
// ADR-0018 §5.1: snapshot worker — process A of the fresh-process flow. Run after
// `pnpm build`; exits 0 on complete, 1 on failed, 2 on usage/setup errors.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let createSnapshotV1;
let DirectoryObjectStoreV1;
let NodeRecoveryFileTarget;
let NodeSnapshotLogSink;
let NodeVaultSource;
try {
  ({ createSnapshotV1 } = await import("../packages/core/dist/index.js"));
  ({
    DirectoryObjectStoreV1,
    NodeRecoveryFileTarget,
    NodeSnapshotLogSink,
    NodeVaultSource
  } = await import("../packages/adapters/dist/index.js"));
} catch {
  console.error("snapshot-worker: dist is missing; run `pnpm build` first.");
  process.exit(2);
}

const { WebCryptoAes256Provider } = await import("../packages/crypto/dist/webcrypto.js");

function usage() {
  console.error("Usage: node tools/snapshot-worker.mjs --vault <dir> --store <dir> --log <file> --recovery <file> --domain-id <64hex>");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) return { error: `Missing value for ${name}.` };
    index += 1;
    if (["--vault", "--store", "--log", "--recovery", "--domain-id"].includes(name)) {
      options[name.slice(2)] = value;
    } else {
      return { error: `Unknown option: ${name}` };
    }
  }
  const missing = ["vault", "store", "log", "recovery", "domain-id"].filter((key) => options[key] === undefined);
  if (missing.length > 0) return { error: `Missing required options: ${missing.join(", ")}` };
  if (!/^[0-9a-f]{64}$/.test(options["domain-id"])) return { error: "--domain-id must be 64 lowercase hex characters." };
  return { options };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error !== undefined) {
  console.error(`snapshot-worker: ${parsed.error}`);
  usage();
  process.exit(2);
}
const options = parsed.options;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// ADR-0017 §3.1: the runtime-limits binding is the SHA-256 of the accepted contract file.
const limitsBytes = await readFile(resolve(repoRoot, "docs/contracts/p0-runtime-limits-v1.json"));
const runtimeLimitsSha256 = createHash("sha256").update(limitsBytes).digest("hex");

const domainId = new Uint8Array(options["domain-id"].match(/../gu).map((pair) => Number.parseInt(pair, 16)));
const provider = new WebCryptoAes256Provider();
const result = await createSnapshotV1(
  { domainId, runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: runtimeLimitsSha256 } },
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

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === "complete" ? 0 : 1);
