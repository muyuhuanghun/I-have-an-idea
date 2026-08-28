import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebCryptoAes256Provider, WEBCRYPTO_CANDIDATE } from "@ekd/crypto/webcrypto";
import {
  bytesToBase64Url,
  createSmokeReport,
  runSmokeVectors,
  sha256Hex,
  utf8Bytes,
  type DeviceBinding,
  type EnvironmentManifest,
  type SmokeReport
} from "../src/index.js";
import { aggregateSmokeReports, loadCryptoVectors } from "../src/node.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function manifest(items: { readonly key: string; readonly value: string }[]): EnvironmentManifest {
  return {
    recorded_at: "2026-08-28T00:00:00.000Z",
    items,
    items_sha256: sha256Hex(utf8Bytes(JSON.stringify(items)))
  };
}

async function androidBinding(runId: string, manifestSha: string, bundleSha: string): Promise<{
  readonly binding: DeviceBinding;
  readonly publicKey: string;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const payload = utf8Bytes(`${runId}\n${manifestSha}\n${bundleSha}`);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    payload
  ));
  return {
    publicKey: bytesToBase64Url(publicKey),
    binding: {
      signature_algorithm: "ECDSA-P256-SHA256",
      public_key_fingerprint: sha256Hex(publicKey),
      device_signature_base64url: bytesToBase64Url(signature),
      run_id: runId,
      vector_manifest_sha256: manifestSha,
      plugin_bundle_sha256: bundleSha,
      verified: true
    }
  };
}

it("requires a verified Android binding for cross_env_pass", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ekd-smoke-"));
  temporaryDirectories.push(root);
  const vectorSet = await loadCryptoVectors({
    manifest_path: resolve(process.cwd(), "../../fixtures/crypto-vectors/manifest.json")
  });
  const provider = new WebCryptoAes256Provider();
  const vectorRun = await runSmokeVectors(provider, {
    vector_set: vectorSet,
    random_source_faults: {
      short_read: new WebCryptoAes256Provider({ randomBytes: (length) => new Uint8Array(length - 1) }),
      failure: new WebCryptoAes256Provider({ randomBytes: () => { throw new Error("injected"); } }),
      all_zero: new WebCryptoAes256Provider({ randomBytes: (length) => new Uint8Array(length) })
    }
  });
  const gitCommit = "a".repeat(40);
  const lockfileSha = "b".repeat(64);
  const reportPaths: string[] = [];

  for (const [index, environmentId] of (["windows-node-cli", "windows-obsidian", "android-obsidian"] as const).entries()) {
    const bundleSha = String(index + 1).repeat(64);
    const runId = crypto.randomUUID();
    const rawPath = `raw-${environmentId}.json`;
    const rawBytes = utf8Bytes(JSON.stringify({ run_id: runId, environment_id: environmentId }));
    await writeFile(resolve(root, rawPath), rawBytes);
    const items = [
      { key: "source_tree_state", value: "clean" },
      { key: "test_scope", value: "phase1-smoke" },
      { key: "runtime", value: environmentId },
      { key: "network", value: "unused" }
    ];
    let binding: DeviceBinding | null = null;
    if (environmentId === "android-obsidian") {
      const android = await androidBinding(runId, vectorSet.manifestSha256, bundleSha);
      binding = android.binding;
      items.push({ key: "device_public_key_spki_base64url", value: android.publicKey });
    }
    const report = createSmokeReport(vectorRun, vectorSet, {
      run_id: runId,
      timestamp_utc: "2026-08-28T00:00:00.000Z",
      git_commit: gitCommit,
      candidate: {
        name: WEBCRYPTO_CANDIDATE.name,
        version: WEBCRYPTO_CANDIDATE.version,
        package_integrity: WEBCRYPTO_CANDIDATE.packageIntegrity,
        bundle_sha256: bundleSha
      },
      environment: {
        id: environmentId,
        os_name: environmentId === "android-obsidian" ? "Android" : "Windows",
        os_version: "test",
        runtime_name: environmentId === "windows-node-cli" ? "Node.js" : "Obsidian",
        runtime_version: "test",
        device_model: environmentId === "android-obsidian" ? "real-device-test-double" : null,
        architecture: "test",
        lockfile_sha256: lockfileSha,
        source_commit: gitCommit,
        bundle_sha256: bundleSha
      },
      environment_manifest: manifest(items),
      raw_artifacts: [{ path: rawPath, sha256: sha256Hex(rawBytes) }],
      device_binding: binding
    });
    const reportPath = `report-${environmentId}.json`;
    await writeFile(resolve(root, reportPath), `${JSON.stringify(report)}\n`, "utf8");
    reportPaths.push(reportPath);
  }

  const aggregate = await aggregateSmokeReports({
    root_dir: root,
    reports: reportPaths.map((path) => ({ path })),
    expected: {
      candidate: WEBCRYPTO_CANDIDATE.name,
      suite_id: 1,
      git_commit: gitCommit,
      vector_manifest_sha256: vectorSet.manifestSha256,
      vectors_sha256: vectorSet.vectorsSha256,
      lockfile_sha256: lockfileSha
    }
  });
  expect(aggregate.cross_env_verdict).toBe("cross_env_pass");

  const androidPath = resolve(root, reportPaths[2]!);
  const android = JSON.parse(await (await import("node:fs/promises")).readFile(androidPath, "utf8")) as SmokeReport;
  await writeFile(androidPath, `${JSON.stringify({ ...android, device_binding: null })}\n`, "utf8");
  const unboundAndroidAggregate = await aggregateSmokeReports({
    root_dir: root,
    reports: reportPaths.map((path) => ({ path }))
  });
  expect(unboundAndroidAggregate.cross_env_verdict).toBe("cross_env_invalid");
  await writeFile(androidPath, `${JSON.stringify(android)}\n`, "utf8");

  const windowsPath = resolve(root, reportPaths[0]!);
  const windows = JSON.parse(await (await import("node:fs/promises")).readFile(windowsPath, "utf8")) as SmokeReport;
  const dirtyItems = windows.environment_manifest.items.map((item) =>
    item.key === "source_tree_state" ? { ...item, value: "dirty" } : item
  );
  const dirty = {
    ...windows,
    environment_manifest: manifest(dirtyItems)
  };
  await writeFile(windowsPath, `${JSON.stringify(dirty)}\n`, "utf8");
  const dirtyAggregate = await aggregateSmokeReports({
    root_dir: root,
    reports: reportPaths.map((path) => ({ path }))
  });
  expect(dirtyAggregate.cross_env_verdict).toBe("cross_env_invalid");
});
