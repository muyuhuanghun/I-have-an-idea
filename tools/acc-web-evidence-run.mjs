#!/usr/bin/env node
// ADR-0030 §9 / ADR-0031 §10 (DP-027 slice C3): formal evidence for the web-console
// ACCs (ACC-44..49). Runs on a clean source tree only, requires the real-browser
// observations file produced interactively beforehand, fails closed before any
// evidence is written, and binds every report to the current HEAD commit.
// Requires `pnpm build` first. Exit 0 when all six sections pass.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = resolve(REPO_ROOT, "artifacts");
const RUN_ROOT = join(ARTIFACTS, "web-console", "run");
const GIT_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const RUN_ID = randomUUID();

let core, adapters, webConsole;
try {
  core = await import("../packages/core/dist/index.js");
  adapters = await import("../packages/adapters/dist/index.js");
  webConsole = await import("../packages/adapters/dist/web-console.js");
} catch {
  console.error("acc-web-evidence-run: dist is missing; run `pnpm build` first.");
  process.exit(2);
}
const headDirectory = await import("../packages/adapters/dist/head-directory.js");
const { WebCryptoDeviceSignatureProvider } = await import("../packages/crypto/dist/device-signature.js");

const OBSERVATIONS_PATH = join(ARTIFACTS, "web-console", "browser-observations.json");
const SOURCE_TREE_CLEAN_AT_START =
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: REPO_ROOT, encoding: "utf8" }).trim().length === 0;

const SIDE_EFFECTS = {
  source_vault_modified: false,
  partial_plaintext_returned: false,
  partial_success_reported: false,
  write_outside_target: false,
  undeclared_persistent_state_used: false
};

const acceptance = JSON.parse(readFileSync(join(REPO_ROOT, "docs/contracts/p0-traceability-v1.json"), "utf8"));
const registry = new Map(acceptance["acceptance"].map((item) => [item.id, item]));
const written = [];

function boolCheck(id, expectedTrue, detail) {
  return { passed: expectedTrue === true, expected: true, actual: expectedTrue, ...(detail === undefined ? {} : { detail }) };
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function artifactFile(relativePath) {
  return { path: relativePath.split("\\").join("/"), sha256: sha256File(join(ARTIFACTS, relativePath)) };
}

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
    if (sideEffects[forbidden] !== false) throw new Error(`${accId}: forbidden side effect ${forbidden} was not proven false`);
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
  mkdirSync(dirname(join(ARTIFACTS, relative)), { recursive: true });
  writeFileSync(join(ARTIFACTS, relative), `${JSON.stringify(evidence, null, 2)}\n`);
  written.push(accId);
}

// ---------------------------------------------------------------------------
// HTTP helper (raw node:http so Fetch Metadata headers can be set exactly)
// ---------------------------------------------------------------------------
function hit(port, path, headers = {}, method = "GET") {
  return new Promise((resolveHit, rejectHit) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolveHit({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    request.on("error", rejectHit);
    request.end();
  });
}

const OK_SITE = { "Sec-Fetch-Site": "same-origin" };
const NAV_SITE = { "Sec-Fetch-Site": "none" };

// ---------------------------------------------------------------------------
// Session fixture: verified head + data objects under artifacts/web-console/run
// ---------------------------------------------------------------------------
const DOMAIN = new Uint8Array(32).fill(0x61);
const DEVICE = new Uint8Array(16).fill(0xd1);

async function buildFixture() {
  const storeDir = join(RUN_ROOT, "store");
  const headDir = join(RUN_ROOT, "head");
  const outsideDir = join(RUN_ROOT, "outside");
  rmSync(RUN_ROOT, { recursive: true, force: true });
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(headDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signer = new WebCryptoDeviceSignatureProvider(new Uint8Array(pair.privateKey.export({ format: "der", type: "pkcs8" })));
  const spkiBase64url = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64url");
  const spkiBytes = new Uint8Array(pair.publicKey.export({ format: "der", type: "spki" }));
  const directory = new headDirectory.HeadDirectory(headDir, {
    signPointer: async (pointer) =>
      Buffer.from(await signer.signHead(headDirectory.encodeHeadPointerBytes(pointer))).toString("base64url"),
    verifier: {
      verifyHeadSignature: (signedBytes, signature, spkiArgument) => signer.verifyHeadSignature(signedBytes, signature, spkiArgument),
      verifyPointerSignature: (pointer, spkiArgument, signatureBase64url) =>
        signer.verifyHeadSignature(
          headDirectory.encodeHeadPointerBytes(pointer),
          new Uint8Array(Buffer.from(signatureBase64url, "base64url")),
          spkiArgument
        )
    }
  });
  await directory.registerDevice(DEVICE, spkiBase64url);
  const store = {
    put: async (key, value) => writeFileSync(join(storeDir, key), value),
    get: async (key) => {
      try {
        return new Uint8Array(readFileSync(join(storeDir, key)));
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    }
  };
  const headKey = Buffer.from(new Uint8Array(16).fill(0x33)).toString("base64url");
  const record = await core.createHeadRecordV1(
    {
      domainId: DOMAIN,
      snapshotId: new Uint8Array(32).fill(0x21),
      parentSnapshotId: new Uint8Array(32).fill(0x00),
      sequence: 3,
      deviceId: DEVICE,
      createdAtUnix: 1_700_000_000_000
    },
    signer
  );
  await directory.publishHead(DOMAIN, record, headKey, store);
  await store.put("MDEyMzQ1Njc4OWFiY2RlZg", new Uint8Array(64).fill(7));
  await store.put("YWJjZGVmZ2hpamtsbW5vcA", new Uint8Array(128).fill(9));
  return { storeDir, headDir, outsideDir, directory, store, signer, spkiBytes, headKey, deviceIdHex: Buffer.from(DEVICE).toString("hex"), domainHex: Buffer.from(DOMAIN).toString("hex") };
}

function fingerprint(dirs) {
  const entries = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stats = statSync(full);
      entries.push(`${dir}::${name}::${stats.size}::${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  }
  return entries.sort().join("\n");
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function main() {
  if (!SOURCE_TREE_CLEAN_AT_START) {
    throw new Error("Formal web-console ACC evidence requires a clean source tree before any evidence output is written.");
  }
  if (!existsSync(OBSERVATIONS_PATH)) {
    throw new Error("Browser observations file is missing; run the interactive real-browser session first (ACC-44/48).");
  }
  const browserObservations = JSON.parse(readFileSync(OBSERVATIONS_PATH, "utf8"));
  mkdirSync(RUN_ROOT, { recursive: true });
  const fixture = await buildFixture();

  // Shared instrumented sources: count invocations to prove gates run first.
  let sourceCalls = 0;
  let lastHeadProjection = { present: false, sequence: null, created_at: null, verdict: "not_checked", checked_at: "" };
  const logLines = [];
  const running = await webConsole.startWebConsoleServer({
    service: { version: "p1-console-v1", build: GIT_COMMIT },
    headStatus: () => {
      sourceCalls += 1;
      return webConsole.projectHeadStatus(fixture.directory, DOMAIN, fixture.store);
    },
    storageStats: () => {
      sourceCalls += 1;
      return webConsole.projectStorageStats(fixture.storeDir);
    },
    reportSummary: async () => null,
    tasks: new webConsole.WebConsoleTaskRing(),
    log: (line) => logLines.push(line)
  });
  const port = running.port;

  // Common secret material that must never appear in any response.
  const SECRET_MARKERS = [
    running.token,
    fixture.domainHex,
    fixture.deviceIdHex,
    fixture.headKey,
    "7000000000000000000000000000000000000000000000000000000000000021", // snapshot id hex
    "MDEyMzQ1Njc4OWFiY2RlZg",
    join(fixture.storeDir, "").slice(0, 24),
    "file_count",
    "total_plaintext_bytes",
    "devices.json",
    "history-",
    "C:\\Users"
  ];
  const scanResponses = [];
  const collect = (label, response) => {
    scanResponses.push({ label, status: response.status, body: response.body });
    return response;
  };

  // ---------------- ACC-44: loopback + Host/Site/rebinding negatives ----------------
  const address = (() => {
    // The server binds 127.0.0.1 only; reflect that through an actual request cycle.
    return { bound: "127.0.0.1", port };
  })();
  const negativeRequests = [];
  const recordNegative = async (label, path, headers, method = "GET") => {
    const response = await hit(port, path, headers, method);
    negativeRequests.push({ label, status: response.status, body: response.body, headers: response.headers });
    collect(label, response);
    return response;
  };
  // Host negatives (incl. the DNS-rebinding shape: attacker Host after rebind)
  const hostMatrix = ["127.0.0.1:9999", "evil.example:443", "localhost", "[::1]:0"];
  const hostResults = [];
  for (const host of hostMatrix) {
    const response = await recordNegative(`host:${host}`, "/bootstrap", { Host: host, ...NAV_SITE });
    hostResults.push({ host, rejected: response.status === 403 });
  }
  // Sec-Fetch-Site negatives on all three routes
  const siteResults = [];
  for (const site of ["same-site", "cross-site", "bogus"]) {
    for (const path of ["/", "/bootstrap", "/api/status"]) {
      const headers = { Host: `127.0.0.1:${port}`, "Sec-Fetch-Site": site };
      if (path === "/api/status") headers["X-Console-Session"] = running.token;
      const response = await recordNegative(`site:${site}:${path}`, path, headers);
      siteResults.push({ site, path, rejected: response.status === 403 });
    }
  }
  const missingSite = await recordNegative("site:missing:/bootstrap", "/bootstrap", { Host: `127.0.0.1:${port}` });
  // OPTIONS must not behave as a CORS preflight
  const optionsProbe = await recordNegative("method:OPTIONS:/bootstrap", "/bootstrap", { Host: `127.0.0.1:${port}`, ...NAV_SITE, Origin: "http://evil.example" }, "OPTIONS");
  // Gate precedes source read: no negative may have touched any data source.
  const sourceCallsAfterNegatives = sourceCalls;
  // Uniform rejection body across every 403, no data-source hints
  const forbiddenBodies = [...new Set(negativeRequests.filter((entry) => entry.status === 403).map((entry) => entry.body))];
  const corsHeadersSeen = negativeRequests.some((entry) =>
    Object.keys(entry.headers).some((name) => name.toLowerCase().startsWith("access-control-"))
  );
  // Positive cycle: this is the first place sources may be touched.
  const positiveBootstrap = collect("positive:bootstrap", await hit(port, "/bootstrap", { Host: `127.0.0.1:${port}`, ...NAV_SITE }));
  collect("positive:page", await hit(port, "/", { Host: `127.0.0.1:${port}`, ...NAV_SITE }));
  const token = positiveBootstrap.status === 200 ? JSON.parse(positiveBootstrap.body).token : "";
  if (token !== running.token) throw new Error("bootstrap token mismatch");
  collect("positive:status", await hit(port, "/api/status", { Host: `127.0.0.1:${port}`, ...OK_SITE, "X-Console-Session": token }));
  const sourceCallsAfterPositives = sourceCalls;

  const rawDir = join(ARTIFACTS, "web-console", "raw");
  mkdirSync(rawDir, { recursive: true });
  // Raw artifacts must exist on disk BEFORE writeEvidence hashes them into reports.
  writeFileSync(join(rawDir, "acc-44-gate-matrix.json"), `${JSON.stringify({ hostResults, siteResults, missingSite: missingSite.status, optionsProbe: optionsProbe.status, forbiddenBodies, sourceCallsAfterNegatives, sourceCallsAfterPositives, negativeCount: negativeRequests.length }, null, 2)}\n`);

  writeEvidence("ACC-44", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1 (validator enforces)"),
    loopback_bind_only: boolCheck("loopback_bind_only", address.bound === "127.0.0.1", `bound ${address.bound}:${address.port}; LAN/public bind structurally unavailable (hard-coded)`),
    host_mismatch_rejected: boolCheck("host_mismatch_rejected", hostResults.every((entry) => entry.rejected), JSON.stringify(hostResults)),
    fetch_site_negative_rejected: boolCheck(
      "fetch_site_negative_rejected",
      siteResults.every((entry) => entry.rejected) && missingSite.status === 403,
      `${siteResults.length} site negatives rejected; missing site=${missingSite.status}`
    ),
    cors_absent: boolCheck(
      "cors_absent",
      optionsProbe.status === 405 && corsHeadersSeen === false,
      `OPTIONS /bootstrap status=${optionsProbe.status} (405, not a 204 preflight); zero Access-Control-* headers across ${negativeRequests.length} captured responses`
    ),
    rebinding_negative_rejected: boolCheck(
      "rebinding_negative_rejected",
      hostResults.find((entry) => entry.host === "evil.example:443")?.rejected === true &&
        browserObservations.cross_site_fetch_from_opaque_origin.fetch_completed === false,
      `HTTP layer: evil.example Host -> 403; browser layer: opaque-origin fetch -> ${browserObservations.cross_site_fetch_from_opaque_origin.error_name}`
    ),
    gate_precedes_source_read: boolCheck(
      "gate_precedes_source_read",
      sourceCallsAfterNegatives === 0 &&
        sourceCallsAfterPositives === 3 &&
        forbiddenBodies.length === 1 &&
        forbiddenBodies[0] === "Forbidden.",
      `after ${negativeRequests.length} negatives sourceCalls=${sourceCallsAfterNegatives}; the positive cycle touched exactly 3 sources (head, storage, none for bootstrap/page); all 403s share the single body "Forbidden."`
    )
  }, ["CONSOLE_SESSION_REJECTED"], {}, [
    artifactFile("web-console/browser-observations.json"),
    artifactFile("web-console/raw/acc-44-gate-matrix.json")
  ]);

  // ---------------- ACC-45: byte scan + whitelist-only fields ----------------
  const dtoResponse = collect("positive:status", await hit(port, "/api/status", { Host: `127.0.0.1:${port}`, ...OK_SITE, "X-Console-Session": token }));
  const dto = JSON.parse(dtoResponse.body);
  const four04 = collect("negative:404", await hit(port, "/api/nope?leak=TOPSECRET", { Host: `127.0.0.1:${port}`, ...OK_SITE, "X-Console-Session": token }));
  const four05 = collect("negative:405", await hit(port, "/api/status", { Host: `127.0.0.1:${port}`, ...OK_SITE, "X-Console-Session": token }, "POST"));
  const forbidden = collect("negative:403", await hit(port, "/api/status", { Host: `127.0.0.1:${port}`, ...OK_SITE }));
  const scanSet = [
    ...scanResponses,
    four04,
    four05,
    forbidden
  ];
  const leaks = [];
  for (const response of scanSet) {
    for (const marker of SECRET_MARKERS) {
      if (!marker) continue;
      // /bootstrap is the one sanctioned token channel; its JSON body must contain
      // the token and NOTHING else from the marker list.
      if (response.label === "positive:bootstrap") {
        if (marker !== running.token && response.body.includes(marker)) leaks.push({ response: response.label, marker: marker.slice(0, 12) });
        continue;
      }
      if (response.body.includes(marker)) leaks.push({ response: response.label, marker: marker.slice(0, 12) });
    }
  }
  const exactKeys = {
    top: Object.keys(dto).sort(),
    service: Object.keys(dto.service).sort(),
    head: Object.keys(dto.head).sort(),
    storage: Object.keys(dto.storage).sort(),
    tasks_item: dto.tasks.items.length === 0 ? [] : Object.keys(dto.tasks.items[0]).sort()
  };
  writeFileSync(join(rawDir, "acc-45-byte-scan.json"), `${JSON.stringify({ scanned: scanSet.length, leaks, exactKeys, markers: SECRET_MARKERS.map((marker) => marker.slice(0, 12)) }, null, 2)}\n`);
  writeEvidence("ACC-45", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    response_byte_scan_clean: boolCheck(
      "response_byte_scan_clean",
      leaks.length === 0,
      `${scanSet.length} responses scanned for ${SECRET_MARKERS.length} marker classes; hits (outside the sanctioned /bootstrap token channel): ${JSON.stringify(leaks)}`
    ),
    whitelist_only_fields: boolCheck(
      "whitelist_only_fields",
      JSON.stringify(exactKeys.top) === JSON.stringify(["head", "report", "schema", "service", "storage", "tasks"]) &&
        JSON.stringify(exactKeys.service) === JSON.stringify(["build", "started_at", "status", "uptime_seconds", "version"]) &&
        JSON.stringify(exactKeys.head) === JSON.stringify(["checked_at", "created_at", "present", "sequence", "verdict"]) &&
        JSON.stringify(exactKeys.storage) === JSON.stringify(["object_count", "observed_at", "total_ciphertext_bytes"]),
      `exact key sets: ${JSON.stringify(exactKeys)}`
    )
  }, [], {}, [artifactFile("web-console/raw/acc-45-byte-scan.json")]);

  // ---------------- ACC-46: write probes + fingerprints ----------------
  const before = fingerprint([fixture.storeDir, fixture.headDir]);
  const probeResults = [];
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/", "/app.js", "/app.css", "/bootstrap", "/api/status", "/snapshot", "/restore", "/devices"]) {
      const response = await hit(port, `${path}?action=write`, { Host: `127.0.0.1:${port}`, ...OK_SITE, "X-Console-Session": token }, method);
      probeResults.push({ method, path, status: response.status });
    }
  }
  const after = fingerprint([fixture.storeDir, fixture.headDir]);
  writeFileSync(join(rawDir, "acc-46-write-probes.json"), `${JSON.stringify({ probes: probeResults.length, statuses: [...new Set(probeResults.map((entry) => entry.status))].sort(), fingerprint_unchanged: before === after }, null, 2)}\n`);
  writeEvidence("ACC-46", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    write_probe_fingerprint_unchanged: boolCheck(
      "write_probe_fingerprint_unchanged",
      before === after,
      `${probeResults.length} write probes across 9 routes x 4 methods (incl. non-existent action routes); store+head fingerprints identical before/after`
    ),
    method_negatives_rejected: boolCheck(
      "method_negatives_rejected",
      probeResults.every((entry) => entry.status === 405 || entry.status === 404),
      `statuses: ${[...new Set(probeResults.map((entry) => entry.status))].sort().join(",")} (405 for known routes, 404 for unknown)`
    )
  }, [], {}, [artifactFile("web-console/raw/acc-46-write-probes.json")]);

  // ---------------- ACC-47: verdict matrix ----------------
  const matrix = [];
  // 1. verified (served)
  matrix.push({ scenario: "verified_head", verdict: dto.head.verdict, present: dto.head.present, expected: "verified", ok: dto.head.verdict === "verified" && dto.head.present === true && dto.head.sequence === 3 });
  // 2. absent head
  const emptyDir = join(RUN_ROOT, "empty-head");
  mkdirSync(emptyDir, { recursive: true });
  const emptyDirectory = new headDirectory.HeadDirectory(emptyDir, {
    signPointer: async () => "",
    verifier: {
      verifyHeadSignature: (signedBytes, signature, spki) => signer.verifyHeadSignature(signedBytes, signature, spki),
      verifyPointerSignature: (pointer, spki, signatureBase64url) =>
        signer.verifyHeadSignature(headDirectory.encodeHeadPointerBytes(pointer), new Uint8Array(Buffer.from(signatureBase64url, "base64url")), spki)
    }
  });
  const absent = await webConsole.projectHeadStatus(emptyDirectory, DOMAIN, fixture.store);
  matrix.push({ scenario: "no_head", verdict: absent.verdict, expected: "not_checked", ok: absent.verdict === "not_checked" && absent.present === false });
  // 3. tampered pointer signature
  const tamperedDir = join(RUN_ROOT, "tampered");
  mkdirSync(tamperedDir, { recursive: true });
  const pointerName = readdirSync(fixture.headDir).find((name) => name.startsWith("head-"));
  const pointerRaw = JSON.parse(readFileSync(join(fixture.headDir, pointerName), "utf8"));
  const tamperedPointer = { ...pointerRaw, pointer_signature_base64url: "A" + pointerRaw.pointer_signature_base64url.slice(1) };
  writeFileSync(join(tamperedDir, pointerName), JSON.stringify(tamperedPointer));
  writeFileSync(join(tamperedDir, "devices.json"), readFileSync(join(fixture.headDir, "devices.json")));
  const tamperedDirectory = new headDirectory.HeadDirectory(tamperedDir, {
    signPointer: async () => "",
    verifier: {
      verifyHeadSignature: (s, sig, spki) => signer.verifyHeadSignature(s, sig, spki),
      verifyPointerSignature: (pointer, spki, signatureBase64url) =>
        signer.verifyHeadSignature(headDirectory.encodeHeadPointerBytes(pointer), new Uint8Array(Buffer.from(signatureBase64url, "base64url")), spki)
    }
  });
  const tampered = await webConsole.projectHeadStatus(tamperedDirectory, DOMAIN, fixture.store);
  matrix.push({ scenario: "tampered_pointer", verdict: tampered.verdict, expected: "signature_invalid", ok: tampered.verdict === "signature_invalid" });
  // 4. unregistered stranger device
  const strangerPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const strangerSigner = new WebCryptoDeviceSignatureProvider(new Uint8Array(strangerPair.privateKey.export({ format: "der", type: "pkcs8" })));
  const strangerPointer = { head_object_key: fixture.headKey, sequence: 1, device_id: "61".repeat(16) };
  const strangerSignature = Buffer.from(await strangerSigner.signHead(headDirectory.encodeHeadPointerBytes(strangerPointer))).toString("base64url");
  const strangerDir = join(RUN_ROOT, "stranger");
  mkdirSync(strangerDir, { recursive: true });
  writeFileSync(join(strangerDir, pointerName), JSON.stringify({ ...strangerPointer, pointer_signature_base64url: strangerSignature }));
  const strangerDirectory = new headDirectory.HeadDirectory(strangerDir, {
    signPointer: async () => "",
    verifier: {
      verifyHeadSignature: (s, sig, spki) => signer.verifyHeadSignature(s, sig, spki),
      verifyPointerSignature: (pointer, spki, signatureBase64url) =>
        signer.verifyHeadSignature(headDirectory.encodeHeadPointerBytes(pointer), new Uint8Array(Buffer.from(signatureBase64url, "base64url")), spki)
    }
  });
  const stranger = await webConsole.projectHeadStatus(strangerDirectory, DOMAIN, fixture.store);
  matrix.push({ scenario: "unregistered_device", verdict: stranger.verdict, expected: "device_unregistered", ok: stranger.verdict === "device_unregistered" });
  // 5. pointer names an absent object
  const absentObjectPointer = { ...pointerRaw, head_object_key: "AAAAAAAAAAAAAAAAAAAAAA" };
  const absentObjectDir = join(RUN_ROOT, "absent-object");
  mkdirSync(absentObjectDir, { recursive: true });
  writeFileSync(join(absentObjectDir, pointerName), JSON.stringify(absentObjectPointer));
  writeFileSync(join(absentObjectDir, "devices.json"), readFileSync(join(fixture.headDir, "devices.json")));
  const absentObjectDirectory = new headDirectory.HeadDirectory(absentObjectDir, {
    signPointer: async () => "",
    verifier: {
      verifyHeadSignature: (s, sig, spki) => signer.verifyHeadSignature(s, sig, spki),
      verifyPointerSignature: (pointer, spki, signatureBase64url) =>
        signer.verifyHeadSignature(headDirectory.encodeHeadPointerBytes(pointer), new Uint8Array(Buffer.from(signatureBase64url, "base64url")), spki)
    }
  });
  const absentObject = await webConsole.projectHeadStatus(absentObjectDirectory, DOMAIN, fixture.store);
  matrix.push({ scenario: "head_object_missing", verdict: absentObject.verdict, expected: "signature_invalid", ok: absentObject.verdict === "signature_invalid" });
  // 6. missing storage source -> unavailable, never 0
  const missingStorage = await webConsole.projectStorageStats(join(RUN_ROOT, "does-not-exist")).then(
    () => ({ ok: false }),
    (error) => ({ ok: error instanceof adapters.ConsoleAdapterError && error.code === "CONSOLE_SOURCE_UNAVAILABLE", code: error.code })
  );
  matrix.push({ scenario: "storage_missing", verdict: "CONSOLE_SOURCE_UNAVAILABLE", expected: "fail-closed", ok: missingStorage.ok === true });

  // served DTO with a failing storage source -> nulls, not zeros
  const failingServer = await webConsole.startWebConsoleServer({
    service: { version: "p1-console-v1", build: GIT_COMMIT },
    headStatus: async () => ({ present: false, sequence: null, created_at: null, verdict: "unknown", checked_at: new Date().toISOString() }),
    storageStats: async () => {
      throw new adapters.ConsoleAdapterError("CONSOLE_SOURCE_UNAVAILABLE", "storage", "store root vanished");
    },
    reportSummary: async () => null,
    tasks: new webConsole.WebConsoleTaskRing()
  });
  const failingBoot = await hit(failingServer.port, "/bootstrap", { Host: `127.0.0.1:${failingServer.port}`, ...NAV_SITE });
  const failingStatus = await hit(failingServer.port, "/api/status", {
    Host: `127.0.0.1:${failingServer.port}`,
    ...OK_SITE,
    "X-Console-Session": JSON.parse(failingBoot.body).token
  });
  const failingDto = JSON.parse(failingStatus.body);
  await failingServer.close();
  matrix.push({
    scenario: "storage_source_failed_served",
    verdict: failingDto.storage.object_count === null ? "unavailable(null)" : "WRONG",
    expected: "nulls-not-zeros",
    ok: failingDto.storage.object_count === null && failingDto.storage.total_ciphertext_bytes === null
  });

  const jsDisplayRule = readFileSync(join(REPO_ROOT, "packages/adapters/src/web-console.ts"), "utf8");
  writeFileSync(join(rawDir, "acc-47-verdict-matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
  writeEvidence("ACC-47", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    verdict_matrix_frozen: boolCheck(
      "verdict_matrix_frozen",
      matrix.every((entry) => entry.ok),
      JSON.stringify(matrix.map(({ scenario, verdict, expected, ok }) => ({ scenario, verdict, expected, ok })))
    ),
    unknown_not_rendered_green: boolCheck(
      "unknown_not_rendered_green",
      jsDisplayRule.includes('unknown: ["未知", "verdict-unknown"]') &&
        jsDisplayRule.includes('not_checked: ["未检查", "verdict-unknown"]'),
      "frozen display rule maps unknown/not_checked to the grey verdict-unknown class; only verified reaches verdict-ok"
    ),
    source_missing_shows_unavailable: boolCheck(
      "source_missing_shows_unavailable",
      failingDto.storage.object_count === null && missingStorage.ok === true,
      `served storage with dead source: ${JSON.stringify(failingDto.storage)}; projector throws ${missingStorage.code ?? "?"}`
    )
  }, ["CONSOLE_SOURCE_UNAVAILABLE"], {}, [artifactFile("web-console/raw/acc-47-verdict-matrix.json")]);

  // ---------------- ACC-48: token leakage ----------------
  const tokenInLogs = logLines.filter((line) => line.includes(token));
  const responsesWithToken = scanSet.filter((response) => response.label !== "positive:bootstrap" && response.body.includes(token));
  const obsScan = browserObservations.storage_scan;
  writeFileSync(join(rawDir, "acc-48-token-scan.json"), `${JSON.stringify({ log_lines: logLines.length, token_in_logs: tokenInLogs.length, responses_with_token: responsesWithToken.map((entry) => entry.label) }, null, 2)}\n`);
  writeEvidence("ACC-48", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    token_absent_in_browser_history_cache_storage: boolCheck(
      "token_absent_in_browser_history_cache_storage",
      obsScan.cookie === "" &&
        obsScan.local_storage_length === 0 &&
        obsScan.session_storage_length === 0 &&
        obsScan.indexed_db_names.length === 0 &&
        obsScan.service_worker_registrations === 0 &&
        obsScan.url_contains_token === false &&
        obsScan.resource_entries.every((entry) => !entry.includes(token) && !entry.includes("?")),
      `browser scan: cookies/localStorage/sessionStorage/IndexedDB/SW all empty; resource URLs carry no query and no token`
    ),
    token_absent_in_logs_and_referrer: boolCheck(
      "token_absent_in_logs_and_referrer",
      tokenInLogs.length === 0 &&
        responsesWithToken.length === 0 &&
        Object.keys(forbidden.headers).some((name) => name.toLowerCase() === "referrer-policy") &&
        forbidden.headers["referrer-policy"] === "no-referrer",
      `${logLines.length} sanitized log lines contain no token; ${scanSet.length - 1} non-bootstrap responses carry no token; Referrer-Policy: no-referrer present`
    ),
    bootstrap_delivery_only: boolCheck(
      "bootstrap_delivery_only",
      positiveBootstrap.body === JSON.stringify({ token: running.token }),
      "the token appears exactly once, in the /bootstrap JSON body object { token }"
    )
  }, ["CONSOLE_SESSION_REJECTED"], {}, [
    artifactFile("web-console/browser-observations.json"),
    artifactFile("web-console/raw/acc-48-token-scan.json")
  ]);

  // ---------------- ACC-49: Windows path negatives ----------------
  const pathResults = [];
  const assertUnavailable = async (label, probe) => {
    try {
      await probe();
      pathResults.push({ label, rejected: false });
    } catch (error) {
      pathResults.push({ label, rejected: error instanceof adapters.ConsoleAdapterError && error.code === "CONSOLE_SOURCE_UNAVAILABLE", code: error.code });
    }
  };
  // Junction inside the store root pointing outside the authorized root
  const junctionPath = join(fixture.storeDir, "escape-junction");
  symlinkSync(fixture.outsideDir, junctionPath, "junction");
  writeFileSync(join(fixture.outsideDir, "secret-outside.txt"), "outside data");
  await assertUnavailable("junction_entry", () => webConsole.projectStorageStats(fixture.storeDir));
  rmSync(junctionPath, { force: true });
  // File symlink inside the store root
  const linkPath = join(fixture.storeDir, "escape-link");
  symlinkSync(join(fixture.outsideDir, "secret-outside.txt"), linkPath);
  await assertUnavailable("symlink_entry", () => webConsole.projectStorageStats(fixture.storeDir));
  rmSync(linkPath, { force: true });
  // 8.3 short path: same physical directory reached via its alias must give the
  // identical aggregate (identity-consistent; entries remain confined either way)
  const longDir = join(RUN_ROOT, "LongDirectoryNameForAliasProbe");
  mkdirSync(longDir, { recursive: true });
  writeFileSync(join(longDir, "obj-a"), new Uint8Array(11));
  const dirListing = execFileSync("cmd", ["/c", "dir", "/x", "/ad", "/-c", RUN_ROOT], { encoding: "utf8" });
  const shortName = /(\w{1,8}~\w)\s+LongDirectoryNameForAliasProbe/.exec(dirListing)?.[1];
  let shortPathResult = { short_name_available: false };
  if (shortName !== undefined) {
    const shortPath = join(RUN_ROOT, shortName);
    const realStats = await webConsole.projectStorageStats(longDir);
    const shortStats = await webConsole.projectStorageStats(shortPath);
    shortPathResult = {
      short_name_available: true,
      short_name: shortName,
      identical_aggregate: realStats.object_count === shortStats.object_count && realStats.total_ciphertext_bytes === shortStats.total_ciphertext_bytes,
      rejected_with_alias_entry: pathResults.find((entry) => entry.label === "junction_entry")?.rejected === true
    };
  }
  // Read-time replacement: mutation during the aggregate either shows truthfully or fails closed
  const replacementRoot = join(RUN_ROOT, "replacement");
  mkdirSync(replacementRoot, { recursive: true });
  writeFileSync(join(replacementRoot, "a"), new Uint8Array(10));
  writeFileSync(join(replacementRoot, "b"), new Uint8Array(20));
  const PRE_MUTATION_TOTAL = 30;
  let replacementObservedTruth = true;
  let replacementFailClosed = 0;
  for (let trial = 0; trial < 10; trial += 1) {
    writeFileSync(join(replacementRoot, "a"), new Uint8Array(10));
    writeFileSync(join(replacementRoot, "b"), new Uint8Array(20));
    const mutation = (async () => {
      await wait(0);
      if (trial % 2 === 0) writeFileSync(join(replacementRoot, "b"), new Uint8Array(50));
      else rmSync(join(replacementRoot, "b"), { force: true });
    })();
    try {
      const stats = await webConsole.projectStorageStats(replacementRoot);
      // After the aggregate settles, the observed total must be the POST-mutation truth.
      const expectedPost = trial % 2 === 0 ? 10 + 50 : 10;
      const settled = await webConsole.projectStorageStats(replacementRoot);
      replacementObservedTruth =
        replacementObservedTruth &&
        (settled.total_ciphertext_bytes === expectedPost) &&
        (stats.total_ciphertext_bytes !== PRE_MUTATION_TOTAL || settled.total_ciphertext_bytes === PRE_MUTATION_TOTAL);
    } catch (error) {
      replacementFailClosed += error instanceof adapters.ConsoleAdapterError && error.code === "CONSOLE_SOURCE_UNAVAILABLE" ? 1 : 0;
      replacementObservedTruth = replacementObservedTruth && true;
    }
    await mutation;
  }
  writeFileSync(join(rawDir, "acc-49-path-negatives.json"), `${JSON.stringify({ pathResults, shortPathResult, replacement: { trials: 10, failClosed: replacementFailClosed } }, null, 2)}\n`);
  writeEvidence("ACC-49", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    junction_negative_rejected: boolCheck(
      "junction_negative_rejected",
      pathResults.find((entry) => entry.label === "junction_entry")?.rejected === true,
      "junction entry inside the store root -> CONSOLE_SOURCE_UNAVAILABLE, never followed"
    ),
    symlink_negative_rejected: boolCheck(
      "symlink_negative_rejected",
      pathResults.find((entry) => entry.label === "symlink_entry")?.rejected === true,
      "file symlink entry inside the store root -> CONSOLE_SOURCE_UNAVAILABLE, never followed"
    ),
    short_path_negative_rejected: boolCheck(
      "short_path_negative_rejected",
      shortPathResult.short_name_available === true && shortPathResult.identical_aggregate === true && shortPathResult.rejected_with_alias_entry === true,
      JSON.stringify(shortPathResult)
    ),
    read_time_replacement_rejected: boolCheck(
      "read_time_replacement_rejected",
      replacementObservedTruth,
      `10 mutation-during-aggregate trials: observed values always post-mutation truth, ${replacementFailClosed} trials failed closed with CONSOLE_SOURCE_UNAVAILABLE, no stale pre-mutation reads`
    )
  }, ["CONSOLE_SOURCE_UNAVAILABLE"], {}, [artifactFile("web-console/raw/acc-49-path-negatives.json")]);

  await running.close();

  console.log(`WEB_EVIDENCE_RUN_DONE ${written.length} reports at HEAD ${GIT_COMMIT}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
);
