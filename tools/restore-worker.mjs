#!/usr/bin/env node
// ADR-0018 §5.1: restore worker — process B of the fresh-process flow. It receives only the
// Recovery File path, the ObjectStore root, and the target root; run after `pnpm build`.
// Exits 0 on complete, 1 on failed, 2 on usage/setup errors.
import { readFile } from "node:fs/promises";

let DirectoryObjectStoreV1;
let NodeRestoreTarget;
let restoreSnapshotV1;
try {
  ({ restoreSnapshotV1 } = await import("../packages/core/dist/index.js"));
  ({ DirectoryObjectStoreV1, NodeRestoreTarget } = await import("../packages/adapters/dist/index.js"));
} catch {
  console.error("restore-worker: dist is missing; run `pnpm build` first.");
  process.exit(2);
}

const { WebCryptoAes256Provider } = await import("../packages/crypto/dist/webcrypto.js");

function usage() {
  console.error("Usage: node tools/restore-worker.mjs --recovery <file> --store <dir> --target <dir>");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) return { error: `Missing value for ${name}.` };
    index += 1;
    if (["--recovery", "--store", "--target"].includes(name)) {
      options[name.slice(2)] = value;
    } else {
      return { error: `Unknown option: ${name}` };
    }
  }
  const missing = ["recovery", "store", "target"].filter((key) => options[key] === undefined);
  if (missing.length > 0) return { error: `Missing required options: ${missing.join(", ")}` };
  return { options };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error !== undefined) {
  console.error(`restore-worker: ${parsed.error}`);
  usage();
  process.exit(2);
}
const options = parsed.options;

const recoveryFileBytes = new Uint8Array(await readFile(options.recovery));
const provider = new WebCryptoAes256Provider();
const result = await restoreSnapshotV1(
  { recoveryFileBytes },
  {
    objectStore: new DirectoryObjectStoreV1(options.store),
    cryptoProvider: provider,
    restoreTarget: new NodeRestoreTarget(options.target)
  }
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === "complete" ? 0 : 1);
