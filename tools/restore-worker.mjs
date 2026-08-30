#!/usr/bin/env node
// ADR-0018 §5.1: restore worker — process B of the fresh-process flow. It receives only the
// Recovery File path, the ObjectStore root, and the target root; run after `pnpm build`.
// Exits 0 on complete, 1 on failed, 2 on usage/setup errors.
import { readFileSync, writeFileSync } from "node:fs";

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
  console.error("Usage: node tools/restore-worker.mjs --recovery <file> --store <dir> --target <dir> [--rss-sample <file>]");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) return { error: `Missing value for ${name}.` };
    index += 1;
    if (["--recovery", "--store", "--target", "--rss-sample"].includes(name)) {
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

// ADR-0019 §4: self-sampled RSS at 50 ms; the sample file is written synchronously on exit.
const rssSamples = [];
let flushRss = () => {};
if (options["rss-sample"] !== undefined) {
  rssSamples.push({ epoch_ms: Date.now(), rss_bytes: process.memoryUsage().rss });
  const timer = globalThis.setInterval(() => {
    rssSamples.push({ epoch_ms: Date.now(), rss_bytes: process.memoryUsage().rss });
  }, 50);
  flushRss = () => {
    globalThis.clearInterval(timer);
    rssSamples.push({ epoch_ms: Date.now(), rss_bytes: process.memoryUsage().rss });
    writeFileSync(options["rss-sample"], `${JSON.stringify({ interval_ms: 50, samples: rssSamples })}\n`);
  };
}

const recoveryFileBytes = new Uint8Array(readFileSync(options.recovery));
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
flushRss();
process.exit(result.status === "complete" ? 0 : 1);
