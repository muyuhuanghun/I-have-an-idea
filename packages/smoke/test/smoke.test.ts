import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NobleAes256Provider } from "@ekd/crypto/noble";
import { WebCryptoAes256Provider } from "@ekd/crypto/webcrypto";
import {
  createSmokeReport,
  runSmokeVectors,
  sha256Hex,
  utf8Bytes,
  type CandidateMetadata,
  type EnvironmentManifest,
  type SmokeExecutionOptions
} from "../src/index.js";
import { loadCryptoVectors, loadSmokeSchemaValidator } from "../src/node.js";

type CandidateFactory = (randomBytes?: (length: number) => Uint8Array) =>
  WebCryptoAes256Provider | NobleAes256Provider;

const candidates: readonly [string, CandidateFactory][] = [
  ["webcrypto", (randomBytes) => new WebCryptoAes256Provider(randomBytes === undefined ? {} : { randomBytes })],
  ["noble", (randomBytes) => new NobleAes256Provider(randomBytes === undefined ? {} : { randomBytes })]
];

function faultOptions(factory: CandidateFactory): SmokeExecutionOptions["random_source_faults"] {
  return {
    short_read: factory((length) => new Uint8Array(length - 1)),
    failure: factory(() => { throw new Error("injected"); }),
    all_zero: factory((length) => new Uint8Array(length))
  };
}

function environmentManifest(state = "clean"): EnvironmentManifest {
  const items = [
    { key: "source_tree_state", value: state },
    { key: "test_scope", value: "phase1-smoke" },
    { key: "runtime", value: "vitest" },
    { key: "network", value: "unused" }
  ];
  return {
    recorded_at: "2026-08-28T00:00:00.000Z",
    items,
    items_sha256: sha256Hex(utf8Bytes(JSON.stringify(items)))
  };
}

describe.each(candidates)("%s smoke runner", (name, factory) => {
  it("passes exactly the fixed 14 required vectors", async () => {
    const vectorSet = await loadCryptoVectors({
      manifest_path: resolve(process.cwd(), "../../fixtures/crypto-vectors/manifest.json")
    });
    const provider = factory();
    const run = await runSmokeVectors(provider, {
      vector_set: vectorSet,
      random_source_faults: faultOptions(factory)
    });
    expect(run.vector_results.filter((result) => result.status !== "passed")).toEqual([]);
    expect(run.aggregate).toMatchObject({
      total: 14,
      required_total: 14,
      required_passed: 14,
      verdict: "pass"
    });
    expect(run.vector_results.every((result) => result.status === "passed")).toBe(true);

    const candidate: CandidateMetadata = {
      name,
      version: "test",
      package_integrity: "test-only",
      bundle_sha256: "1".repeat(64)
    };
    const report = createSmokeReport(run, vectorSet, {
      run_id: crypto.randomUUID(),
      timestamp_utc: "2026-08-28T00:00:00.000Z",
      git_commit: "2".repeat(40),
      candidate,
      environment: {
        id: "windows-node-cli",
        os_name: "Windows",
        os_version: "test",
        runtime_name: "Node.js",
        runtime_version: process.version,
        device_model: null,
        architecture: process.arch,
        lockfile_sha256: "3".repeat(64),
        source_commit: "2".repeat(40),
        bundle_sha256: candidate.bundle_sha256
      },
      environment_manifest: environmentManifest(),
      raw_artifacts: [{ path: "raw.json", sha256: "4".repeat(64) }],
      device_binding: null
    });
    const validator = loadSmokeSchemaValidator();
    expect(validator.validateSmokeReport(report).valid).toBe(true);
    expect(validator.validateSmokeReport({ ...report, unexpected: true }).valid).toBe(false);
  });

  it("fails the required random-source vector when candidate probes are absent", async () => {
    const vectorSet = await loadCryptoVectors({
      manifest_path: resolve(process.cwd(), "../../fixtures/crypto-vectors/manifest.json")
    });
    const run = await runSmokeVectors(factory(), { vector_set: vectorSet });
    expect(run.aggregate.verdict).toBe("fail");
    expect(run.vector_results.find((result) => result.vector_id === "random-source-errors")).toMatchObject({
      status: "error",
      actual_error_code: "RANDOM_SOURCE_PROBES_MISSING"
    });
  });
});
