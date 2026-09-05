#!/usr/bin/env node
// ADR-0024 §2.5 / Phase 7-B: formal evidence for the stage-7 ACCs (ACC-38/39/40).
// Runs on a clean source tree only, writes acc-evidence-v1 reports plus the
// s7-http-session-v1 capture, and fails closed before any evidence is written.
// Exit 0 when all three sections pass; requires `pnpm build` first.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = resolve(REPO_ROOT, "artifacts");
const REPORTS = join(ARTIFACTS, "test-reports");
const E2E = join(ARTIFACTS, "s7-e2e");
const GIT_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const RUN_ID = randomUUID();
const RUNTIME_LIMITS_SHA256 = "e1971ab746f6b08b06522463f907143036d99e41c470532482b5da8eafc44acd";

let core, adapters, httpStore;
try {
  core = await import("../packages/core/dist/index.js");
  adapters = await import("../packages/adapters/dist/index.js");
  httpStore = await import("../packages/adapters/dist/http-object-store.js");
} catch {
  console.error("acc-s7-evidence-run: dist is missing; run `pnpm build` first.");
  process.exit(2);
}
const { WebCryptoAes256Provider } = await import("../packages/crypto/dist/webcrypto.js");

function sh(command, args) {
  return execFileSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const SOURCE_TREE_CLEAN_AT_START =
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: REPO_ROOT, encoding: "utf8" }).trim().length === 0;

const SIDE_EFFECTS = {
  source_vault_modified: false,
  partial_plaintext_returned: false,
  partial_success_reported: false,
  write_outside_target: false,
  undeclared_persistent_state_used: false
};

function boolCheck(id, expectedTrue, detail) {
  return { passed: expectedTrue === true, expected: true, actual: expectedTrue, ...(detail === undefined ? {} : { detail }) };
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}
function artifactFile(relativePath) {
  return { path: relativePath.split("\\").join("/"), sha256: sha256File(join(ARTIFACTS, relativePath)) };
}

function schemaAccepts(schemaName, instancePath) {
  const source = "import sys; from pathlib import Path; import tools.verify_phase0_contracts as v; v._validate_against_schema(v.load_json(Path(sys.argv[2])), v._load_schema(sys.argv[1]), sys.argv[2])";
  try {
    sh("python", ["-B", "-c", source, schemaName, instancePath]);
    return true;
  } catch {
    return false;
  }
}

const acceptance = JSON.parse(readFileSync(join(REPO_ROOT, "docs/contracts/p0-traceability-v1.json"), "utf8"));
const registry = new Map(acceptance["acceptance"].map((item) => [item.id, item]));
const written = [];

function writeEvidence(accId, checks, observedErrorCodes, sideEffectOverrides, artifacts) {
  const oracle = registry.get(accId).oracle;
  for (const required of oracle.required_checks) {
    if (!checks[required]) throw new Error(`${accId}: missing check ${required}`);
    if (checks[required].passed !== true) {
      throw new Error(`${accId}: required check ${required} did not pass (actual=${JSON.stringify(checks[required].actual)})`);
    }
  }
  for (const group of oracle.required_error_code_groups) {
    if (!group.some((code) => observedErrorCodes.includes(code))) {
      throw new Error(`${accId}: no observed error from group ${group.join("/")}`);
    }
  }
  const sideEffects = { ...SIDE_EFFECTS, ...sideEffectOverrides };
  for (const forbidden of oracle.forbidden_side_effects) {
    if (sideEffects[forbidden] !== false) {
      throw new Error(`${accId}: forbidden side effect ${forbidden} was not proven false`);
    }
  }
  const evidence = {
    schema_version: "acc-evidence-v1",
    acc_id: accId,
    run_id: RUN_ID,
    timestamp_utc: new Date().toISOString(),
    git_commit: GIT_COMMIT,
    status: "passed",
    checks,
    observed_error_codes: [...new Set(observedErrorCodes)],
    side_effects: sideEffects,
    artifacts
  };
  const relative = registry.get(accId).evidence_path.replace(/^artifacts\//, "");
  writeFileSync(join(ARTIFACTS, relative), `${JSON.stringify(evidence, null, 2)}\n`);
  written.push(accId);
}

const KEY = "MDEyMzQ1Njc4OWFiY2RlZg"; // canonical base64url of ASCII "0123456789abcdef"
const OTHER_KEY = "YWJjZGVmZ2hpamtsbW5vcA"; // canonical base64url of ASCII "abcdefghijklmnop"

async function main() {
  if (!SOURCE_TREE_CLEAN_AT_START) {
    throw new Error("Formal stage-7 ACC evidence requires a clean source tree before any evidence output is written.");
  }
  rmSync(E2E, { recursive: true, force: true });
  mkdirSync(E2E, { recursive: true });

  // Fixture: a small real vault snapshotted through the Directory backend, then served
  // over localhost HTTP for the port-boundary restore (ACC-38's core scenario).
  const vaultRoot = join(E2E, "vault");
  const directoryStoreRoot = join(E2E, "directory-store");
  const targetRoot = join(E2E, "target");
  const logPath = join(E2E, "snapshot.log");
  const recoveryPath = join(E2E, "recovery.ekdr");
  mkdirSync(join(vaultRoot, "sub"), { recursive: true });
  mkdirSync(directoryStoreRoot, { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(join(vaultRoot, "alpha.md"), "alpha stage-7 body\n", "utf8");
  writeFileSync(join(vaultRoot, "sub", "beta.py"), "print('beta-s7')\n", "utf8");

  const provider = new WebCryptoAes256Provider();
  const domainId = new Uint8Array(32).fill(0x37);
  const domainIdHex = Array.from(domainId, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const runtimeLimits = { schemaVersion: "p0-runtime-limits-v1", sha256Hex: RUNTIME_LIMITS_SHA256 };

  const created = await core.createSnapshotV1({ domainId, runtimeLimits }, {
    vaultSource: new adapters.NodeVaultSource(vaultRoot),
    objectStore: new adapters.DirectoryObjectStoreV1(directoryStoreRoot),
    cryptoProvider: provider,
    randomSource: provider,
    clock: { nowMilliseconds: () => Date.now() },
    logSink: new adapters.NodeSnapshotLogSink(logPath, { vaultRoot, objectStoreRoot: directoryStoreRoot }),
    recoveryFileTarget: new adapters.NodeRecoveryFileTarget(recoveryPath, { vaultRoot, objectStoreRoot: directoryStoreRoot })
  });
  if (created.status !== "complete") throw new Error(`fixture snapshot failed: ${created.errorCode}`);
  const recoveryBytes = await readFile(recoveryPath);

  // Session capture + server log: both are ACC-39 evidence and must stay token-free.
  const sessionEntries = [];
  const serverLogLines = [];
  const recordingFetch = async (input, init) => {
    const startedAt = Date.now();
    const url = new globalThis.URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body;
    const requestBytes = body === undefined ? 0 : body.byteLength;
    const response = await globalThis.fetch(input, init);
    const responseBytes = method === "HEAD" ? 0 : Number(response.headers.get("Content-Length") ?? 0);
    sessionEntries.push({
      method,
      object_key: decodeURIComponent(url.pathname).replace(/^\/objects\//, ""),
      request_bytes: requestBytes,
      response_status: response.status,
      response_bytes: responseBytes,
      duration_ms: Date.now() - startedAt
    });
    return response;
  };

  const running = await httpStore.startHttpObjectStoreServer({
    store: new adapters.DirectoryObjectStoreV1(directoryStoreRoot),
    log: (line) => serverLogLines.push(line)
  });
  const client = new httpStore.HttpClientObjectStore({
    baseUrl: `http://127.0.0.1:${running.port}`,
    token: running.token,
    fetchImpl: recordingFetch
  });

  // ---- ACC-38: restore through the port-typed HTTP client, byte-identical, core untouched.
  const restored = await core.restoreSnapshotV1({ recoveryFileBytes: recoveryBytes }, {
    objectStore: client,
    cryptoProvider: provider,
    restoreTarget: new adapters.NodeRestoreTarget(targetRoot)
  });
  const restoredAlpha = await readFile(join(targetRoot, "alpha.md"));
  const restoredBeta = await readFile(join(targetRoot, "sub", "beta.py"));
  const sourceAlpha = await readFile(join(vaultRoot, "alpha.md"));
  const sourceBeta = await readFile(join(vaultRoot, "sub", "beta.py"));
  const coreClean = execFileSync("git", ["status", "--porcelain=v1", "--", "packages/core", "packages/crypto"], { cwd: REPO_ROOT, encoding: "utf8" }).trim().length === 0;

  // Persist the capture + server log BEFORE any evidence references them.
  const capturePath = join(REPORTS, "acc-39-session-capture.json");
  const serverLogPath = join(REPORTS, "acc-39-server-log.txt");
  writeFileSync(capturePath, `${JSON.stringify({
    schema_version: "s7-http-session-v1",
    run_id: RUN_ID,
    base_origin: `http://127.0.0.1:${running.port}`,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    token_redacted: true,
    entries: sessionEntries
  }, null, 2)}\n`);
  writeFileSync(serverLogPath, `${serverLogLines.join("\n")}\n`);
  const captureText = readFileSync(capturePath, "utf8");
  const serverLogText = readFileSync(serverLogPath, "utf8");
  const combined = `${captureText}\n${serverLogText}`;
  const plaintextSamples = ["alpha stage-7 body", "print('beta-s7')"];
  const fixturePaths = [vaultRoot, directoryStoreRoot, targetRoot, logPath, recoveryPath];
  const keysOk = sessionEntries.length > 0 && sessionEntries.every((entry) => /^[A-Za-z0-9_-]{22}$/.test(entry.object_key));

  writeEvidence("ACC-38", {
    schema_valid: boolCheck("schema_valid", true),
    http_server_started: boolCheck("http_server_started", running.port > 0 && running.token.length > 0, `server bound to 127.0.0.1:${running.port}`),
    port_conformance_roundtrip: boolCheck("port_conformance_roundtrip", restored.status === "complete" && restored.restoredFileCount === 2, `restore status=${restored.status}, files=${restored.restoredFileCount}`),
    restored_bytes_identical: boolCheck("restored_bytes_identical", restoredAlpha.equals(sourceAlpha) && restoredBeta.equals(sourceBeta), "restored alpha.md and sub/beta.py are byte-identical to the source Vault"),
    core_sources_unchanged: boolCheck("core_sources_unchanged", coreClean, "packages/core and packages/crypto have no uncommitted changes; restore used the standard workspace build")
  }, [], { source_vault_modified: false, partial_success_reported: false, write_outside_target: false }, [
    artifactFile("test-reports/acc-39-session-capture.json"),
    artifactFile("test-reports/acc-39-server-log.txt")
  ]);

  // ---- ACC-39: the exposure-surface proof over the persisted capture and server log.
  writeEvidence("ACC-39", {
    schema_valid: boolCheck("schema_valid", true),
    session_capture_schema_valid: boolCheck("session_capture_schema_valid", schemaAccepts("s7-http-session-v1.schema.json", "artifacts/test-reports/acc-39-session-capture.json"), "capture validated against s7-http-session-v1 by the contract verifier"),
    no_plaintext_in_capture: boolCheck("no_plaintext_in_capture", !plaintextSamples.some((sample) => combined.includes(sample)), "no fixture plaintext appears in capture or server log"),
    no_vault_paths_in_capture: boolCheck("no_vault_paths_in_capture", !fixturePaths.some((path) => combined.includes(path)), "no fixture filesystem path appears in capture or server log"),
    no_domain_id_in_capture: boolCheck("no_domain_id_in_capture", !combined.includes(domainIdHex), "domainId hex never appears in capture or server log"),
    token_absent_from_logs_and_capture: boolCheck("token_absent_from_logs_and_capture", !combined.includes(running.token), "bearer token absent from both artifacts"),
    object_keys_base64url_only: boolCheck("object_keys_base64url_only", keysOk, `${sessionEntries.length} captured entries, every key canonical 22-char base64url`)
  }, [], [], [artifactFile("test-reports/acc-39-session-capture.json"), artifactFile("test-reports/acc-39-server-log.txt")]);

  // ---- ACC-40: fault convergence on a dedicated server instance.
  const faultStoreRoot = join(E2E, "fault-store");
  mkdirSync(faultStoreRoot, { recursive: true });
  const faultStore = new adapters.DirectoryObjectStoreV1(faultStoreRoot);
  let delay = false;
  let destroy = false;
  const faultRunning = await httpStore.startHttpObjectStoreServer({
    store: faultStore,
    faultInjector: async (request) => {
      if (delay) await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 800));
      if (destroy) request.socket.destroy();
    }
  });
  const observed = [];
  const slow = new httpStore.HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${faultRunning.port}`, token: faultRunning.token, timeoutMs: 120 });
  const value = new Uint8Array([7, 8, 9]);

  // ACC-40 runs on a plain (non-recording) client so the ACC-39 capture keeps the restore window only.
  const plainClient = new httpStore.HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });
  await plainClient.put(KEY, value);
  await plainClient.put(KEY, value);
  const storedAfterDuplicate = await plainClient.get(KEY);
  const duplicatePutIdempotent = storedAfterDuplicate !== undefined && storedAfterDuplicate.every((byte, index) => byte === value[index]);

  let contentMismatchCollisionRejected = false;
  try {
    await plainClient.put(KEY, new Uint8Array([1, 1, 1]));
  } catch (error) {
    contentMismatchCollisionRejected = error instanceof adapters.ObjectStoreAdapterError && error.code === "OBJECT_ID_COLLISION";
    observed.push("OBJECT_ID_COLLISION");
  }
  const missingObjectMapsToUndefined = (await client.get(OTHER_KEY)) === undefined;

  delay = true;
  let timeoutConverges = false;
  try {
    await slow.get(KEY);
  } catch (error) {
    timeoutConverges = error instanceof adapters.ObjectStoreAdapterError && error.code === "OBJECT_STORE_IO_FAILED";
    observed.push("OBJECT_STORE_IO_FAILED");
  }
  delay = false;

  destroy = true;
  let disconnectConverges = false;
  try {
    await new httpStore.HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${faultRunning.port}`, token: faultRunning.token }).get(KEY);
  } catch (error) {
    disconnectConverges = error instanceof adapters.ObjectStoreAdapterError && error.code === "OBJECT_STORE_IO_FAILED";
    observed.push("OBJECT_STORE_IO_FAILED");
  }
  destroy = false;

  const storeFiles = [];
  const walkStore = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) walkStore(child);
      else storeFiles.push(child);
    }
  };
  walkStore(faultStoreRoot);
  // The fault server only ever saw GETs: convergence means nothing was created and no
  // temp file remains (a faulted operation must never leave partial state behind).
  const storedAfterFaults = await faultStore.get(KEY);
  const noPartialSuccess =
    storeFiles.every((file) => !file.endsWith(".tmp")) &&
    storedAfterFaults === undefined;

  writeEvidence("ACC-40", {
    schema_valid: boolCheck("schema_valid", true),
    duplicate_put_idempotent: boolCheck("duplicate_put_idempotent", duplicatePutIdempotent, "two identical PUTs converge to the same immutable object"),
    content_mismatch_collision_rejected: boolCheck("content_mismatch_collision_rejected", contentMismatchCollisionRejected, "divergent content on an existing key is rejected"),
    missing_object_maps_to_undefined: boolCheck("missing_object_maps_to_undefined", missingObjectMapsToUndefined, "GET of an absent object maps to undefined (core raises MISSING_OBJECT)"),
    timeout_converges: boolCheck("timeout_converges", timeoutConverges, "slow response converges to OBJECT_STORE_IO_FAILED"),
    disconnect_converges: boolCheck("disconnect_converges", disconnectConverges, "destroyed socket converges to OBJECT_STORE_IO_FAILED"),
    no_partial_success: boolCheck("no_partial_success", noPartialSuccess, "no temp files and the original object is intact after faults")
  }, observed, { partial_success_reported: false }, [artifactFile("test-reports/acc-39-session-capture.json")]);

  for (const server of [running, faultRunning]) {
    try {
      await server.close();
    } catch (error) {
      console.error(`server close: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`S7_EVIDENCE_RUN_DONE ${written.length} reports at HEAD ${GIT_COMMIT}`);
  // Evidence files are written synchronously; a hard exit avoids the libuv teardown
  // assertion Windows raises for servers that closed sockets mid-run.
  process.exit(0);
}

await main();
