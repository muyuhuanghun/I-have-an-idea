#!/usr/bin/env node
// ADR-0016 §8: thin CLI wrapper over the tested storage visibility scanner in @ekd/adapters.
// Run after `pnpm build`; exits 0 on verdict pass, 1 on fail, 2 on usage or scanner setup errors.
import { readFile, writeFile } from "node:fs/promises";

let isVisibilityReportOutputOutsideStoreV1;
let isVisibilityReportOutputResolvedOutsideStoreV1;
let scanStorageVisibilityV1;
try {
  ({
    isVisibilityReportOutputOutsideStoreV1,
    isVisibilityReportOutputResolvedOutsideStoreV1,
    scanStorageVisibilityV1
  } = await import("../packages/adapters/dist/index.js"));
} catch {
  console.error("storage-visibility-scan: @ekd/adapters dist is missing; run `pnpm build` first.");
  process.exit(2);
}

function usage() {
  console.error(
    [
      "Usage:",
      "  node tools/storage-visibility-scan.mjs --store-root <dir> --log-file <file>",
      "    --control-file <file> --planted-markers <n> --marker <s> [--marker <s> ...]",
      "    [--secret <label>=<hex> ...] [--output <file>]"
    ].join("\n")
  );
}

function parseArgs(argv) {
  const options = { markers: [], secrets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) return { error: `Missing value for ${name}.` };
    index += 1;
    if (name === "--store-root") options.storeRoot = value;
    else if (name === "--log-file") options.logFile = value;
    else if (name === "--control-file") options.controlFile = value;
    else if (name === "--planted-markers") options.plantedMarkers = Number(value);
    else if (name === "--marker") options.markers.push(value);
    else if (name === "--secret") {
      const separator = value.indexOf("=");
      if (separator <= 0) return { error: `--secret expects <label>=<hex>, got: ${value}` };
      options.secrets.push({ label: value.slice(0, separator), hex: value.slice(separator + 1) });
    } else if (name === "--output") options.output = value;
    else return { error: `Unknown option: ${name}` };
  }
  const required = ["storeRoot", "logFile", "controlFile", "plantedMarkers"];
  const missing = required.filter((key) => options[key] === undefined);
  if (missing.length > 0) return { error: `Missing required options: ${missing.join(", ")}` };
  if (!Number.isInteger(options.plantedMarkers) || options.plantedMarkers < 1) {
    return { error: "--planted-markers must be an integer of at least 1." };
  }
  if (options.markers.length === 0) return { error: "At least one --marker is required." };
  if (
    options.output !== undefined &&
    !isVisibilityReportOutputOutsideStoreV1(options.storeRoot, options.output)
  ) {
    return { error: "--output must be outside the ObjectStore root." };
  }
  return { options };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error !== undefined) {
  console.error(`storage-visibility-scan: ${parsed.error}`);
  usage();
  process.exit(2);
}
const options = parsed.options;

let report;
try {
  const [logBuffer, controlBuffer] = await Promise.all([readFile(options.logFile), readFile(options.controlFile)]);
  report = await scanStorageVisibilityV1({
    storeRoot: options.storeRoot,
    logBytes: new Uint8Array(logBuffer),
    markers: options.markers,
    knownSecrets: options.secrets,
    control: { bytes: new Uint8Array(controlBuffer), plantedMarkers: options.plantedMarkers }
  });
} catch {
  report = await scanStorageVisibilityV1({
    storeRoot: options.storeRoot,
    logBytes: undefined,
    markers: options.markers,
    knownSecrets: options.secrets,
    control: undefined
  });
}

const json = `${JSON.stringify(report, null, 2)}\n`;
if (options.output === undefined) {
  process.stdout.write(json);
} else {
  try {
    if (!(await isVisibilityReportOutputResolvedOutsideStoreV1(options.storeRoot, options.output))) {
      console.error("storage-visibility-scan: resolved report output must be outside the ObjectStore root.");
      process.exit(2);
    }
    await writeFile(options.output, json, { encoding: "utf8", flag: "wx" });
    console.log("storage-visibility-scan: report written");
  } catch {
    console.error("storage-visibility-scan: report output must be a new writable file outside the ObjectStore root.");
    process.exit(2);
  }
}
process.exit(report.verdict === "pass" ? 0 : 1);
