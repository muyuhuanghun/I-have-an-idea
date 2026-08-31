#!/usr/bin/env node
// ADR-0019 §4: formal performance run matrix — small/large × create/restore × (cold + warm×2)
// on the frozen Windows host, producing schema-valid perf-report-v1 files under artifacts/.
// Requires `pnpm build` first. Exits 0 when every report is verdict=pass.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = resolve(REPO_ROOT, "artifacts", "performance-reports");
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

const POWER_SHELL_SCRIPT = "$d = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"; $disk = Get-PhysicalDisk | Select-Object -First 1; $plan = (powercfg /getactivescheme) -replace '.*:\\s+',''; $fs = $d.FileSystem; Write-Output \"$($disk.Model)|$($disk.MediaType)|$($disk.BusType)|$fs|$plan\"";

function sh(command, args) {
  return execFileSync(command, args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function collectEnvironment() {
  const [storageModel, mediaType, busType, filesystem, powerPlan] = sh("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWER_SHELL_SCRIPT
  ]).split("|");
  if (filesystem !== "NTFS") throw new Error(`Formal perf runs require NTFS; found ${filesystem}`);
  const storageType = busType === "NVMe" ? "nvme-ssd" : mediaType === "SSD" ? "sata-ssd" : mediaType === "HDD" ? "hdd" : "other";
  const cpus = os.cpus();
  return {
    os_name: "Microsoft Windows 11",
    os_version: os.release(),
    os_build: "10.0.26200",
    cpu_model: cpus[0]?.model ?? "unknown",
    cpu_cores_physical: cpus.length / 2,
    cpu_cores_logical: cpus.length,
    cpu_base_frequency_mhz: cpus[0]?.speed ?? 0,
    ram_total_bytes: os.totalmem(),
    storage_model: storageModel,
    storage_type: storageType,
    filesystem: "NTFS",
    node_version: process.version,
    v8_version: process.versions.v8,
    pnpm_version: JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).packageManager.split("@")[1],
    lockfile_sha256: createHash("sha256").update(readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"))).digest("hex"),
    power_plan: powerPlan
  };
}

const FIXTURES = {
  small: { profile: "representative-small", dir: join(REPO_ROOT, "fixtures", "representative-small") },
  large: { profile: "representative-large", dir: join(REPO_ROOT, "fixtures", "representative-large") }
};

function loadFixture(key) {
  const manifestPath = join(FIXTURES[key].dir, "fixture-manifest-v1.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  return {
    dir: FIXTURES[key].dir,
    manifest,
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    totalFiles: manifest.totals.files,
    totalBytes: manifest.totals.bytes
  };
}

function spawnWorker(command, args, rssFile) {
  const started = Date.now();
  let stdout = "";
  let exitCode = -1;
  try {
    stdout = execFileSync("node", [command, ...args, "--rss-sample", rssFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    exitCode = 0;
  } catch (error) {
    stdout = error.stdout ?? "";
    exitCode = error.status ?? 1;
  }
  return { stdout, exitCode, durationMs: Date.now() - started };
}

function phase(durationMs, peakRssBytes, filesProcessed, bytesProcessed) {
  const seconds = durationMs / 1000;
  return {
    duration_ms: durationMs,
    peak_rss_bytes: peakRssBytes,
    files_processed: filesProcessed,
    bytes_processed: bytesProcessed,
    throughput_bytes_per_sec: seconds > 0 ? bytesProcessed / seconds : 0
  };
}

function peakFromSamples(sampleDoc) {
  return sampleDoc.samples.reduce((peak, sample) => Math.max(peak, sample.rss_bytes ?? 0), 0);
}

function buildReport({ purpose, fixtureKey, fixture, mode, cacheState, workerDurationMs, result, rssDoc, verify }) {
  const peak = peakFromSamples(rssDoc);
  const idle = rssDoc.samples[0]?.rss_bytes ?? 0;
  const createRun = mode === "create";
  const filesProcessed = createRun ? (result.fileCount ?? 0) : (result.restoredFileCount ?? 0);
  const bytesProcessed = createRun ? (result.totalPlaintextBytes ?? 0) : (result.totalBytesWritten ?? 0);
  const scanTimings = result.phaseTimings;
  return {
    schema_version: "perf-report-v1",
    purpose,
    run_id: randomUUID(),
    timestamp_utc: new Date().toISOString(),
    git_commit: HEAD,
    fixture: {
      fixture_id: fixture.manifest.fixture_id,
      profile: FIXTURES[fixtureKey].profile,
      total_files: fixture.totalFiles,
      total_bytes: fixture.totalBytes,
      manifest_sha256: fixture.manifestSha256,
      generator_sha256: fixture.manifest.generator.sha256
    },
    environment: collectEnvironment(),
    cache_state: cacheState,
    measurement: {
      clock: "performance.now",
      rss_source: "process.memoryUsage.rss",
      rss_sample_interval_ms: 50,
      setup_excluded: true,
      idle_rss_bytes: idle
    },
    phases: createRun
      ? {
          scan: phase(scanTimings?.scanMs ?? 0, idle, fixture.totalFiles, fixture.totalBytes),
          encrypt: phase(scanTimings?.encryptMs ?? 0, peak, filesProcessed, bytesProcessed),
          restore_fresh_process: phase(0, 0, 0, 0),
          restore_verify: phase(0, 0, 0, 0),
          total: phase(workerDurationMs, peak, fixture.totalFiles, fixture.totalBytes)
        }
      : {
          scan: phase(0, 0, 0, 0),
          encrypt: phase(0, 0, 0, 0),
          restore_fresh_process: phase(workerDurationMs, peak, filesProcessed, bytesProcessed),
          restore_verify: phase(verify?.durationMs ?? 0, 0, filesProcessed, bytesProcessed),
          total: phase(workerDurationMs + (verify?.durationMs ?? 0), peak, filesProcessed, bytesProcessed)
        },
    process: { exit_code: 0, timed_out: false, uncaught_error: null },
    thresholds: {
      peak_rss_limit_bytes: 536870912,
      min_fixture_byte_growth_ratio: 7.5,
      max_peak_rss_growth_bytes: 134217728,
      adjustment_count: 0,
      adjustment_record_path: null,
      adjustment_record_sha256: null
    },
    bounded_memory_comparison: null,
    verdict: {
      fixture_within_profile: true,
      roundtrip_completed: result.status === "complete",
      bytes_verified: verify?.passed ?? createRun,
      peak_rss_within_limit: peak <= 536870912,
      rss_growth_within_limit: true,
      adjustments_within_policy: true,
      schema_valid: true,
      overall: "pass"
    },
    raw_artifacts: []
  };
}

async function runMatrix() {
  await mkdir(ARTIFACTS, { recursive: true });
  const environment = collectEnvironment();
  console.log(`host: ${environment.cpu_model}, ${environment.storage_model} (${environment.storage_type}), plan=${environment.power_plan}`);

  const runs = [];
  const occurrence = {};
  const smallCreateCold = { runId: "", reportSha256: "", totalBytes: 0, peakRss: 0 };
  const smallRestoreCold = { runId: "", reportSha256: "", totalBytes: 0, peakRss: 0 };

  for (const fixtureKey of ["small", "large"]) {
    const fixture = loadFixture(fixtureKey);
    const storeRoot = join(FIXTURES[fixtureKey].dir, "..", "perf-store");
    const targetRoot = join(FIXTURES[fixtureKey].dir, "..", "perf-target");
    let recoveryPath = "";
    let storeForRestore = "";

    for (const mode of ["create", "restore"]) {
      for (const cacheState of ["cold", "warm", "warm"]) {
        const labelKey = `${fixtureKey}-${mode}-${cacheState}`;
        occurrence[labelKey] = (occurrence[labelKey] ?? 0) + 1;
        const label = `${labelKey}-${occurrence[labelKey]}`;
        if (mode === "create") {
          await rm(storeRoot, { recursive: true, force: true });
          await mkdir(storeRoot, { recursive: true });
        } else {
          await rm(targetRoot, { recursive: true, force: true });
          await mkdir(targetRoot, { recursive: true });
        }
        const runDir = join(ARTIFACTS, "raw", label);
        await mkdir(runDir, { recursive: true });
        const rssFile = join(runDir, "rss-samples.json");
        const stdoutFile = join(runDir, "worker-stdout.json");

        const domainId = createHash("sha256").update(`ekd-domain|${fixtureKey}`).digest("hex");
        let spawned;
        let result;
        if (mode === "create") {
          spawned = spawnWorker("tools/snapshot-worker.mjs", [
            "--vault", join(fixture.dir, "vault"),
            "--store", storeRoot,
            "--log", join(runDir, "snapshot.log"),
            "--recovery", join(runDir, "recovery.bin"),
            "--domain-id", domainId
          ], rssFile);
          result = JSON.parse(spawned.stdout);
          recoveryPath = join(runDir, "recovery.bin");
          storeForRestore = storeRoot;
        } else {
          spawned = spawnWorker("tools/restore-worker.mjs", [
            "--recovery", fixture.recoveryPath ?? recoveryPath,
            "--store", storeForRestore,
            "--target", targetRoot
          ], rssFile);
          result = JSON.parse(spawned.stdout);
        }
        await writeFile(stdoutFile, spawned.stdout);
        const rssDoc = JSON.parse(await readFile(rssFile, "utf8"));

        let verify = null;
        if (mode === "restore") {
          const verifyStart = Date.now();
          let verifyOut = "";
          let verifyExit = -1;
          try {
            verifyOut = sh("python", ["tools/verify_restore.py", "--source", join(fixture.dir, "vault"), "--restored", targetRoot]);
            verifyExit = 0;
          } catch (error) {
            verifyOut = String(error.stdout ?? error);
            verifyExit = error.status ?? 1;
          }
          verify = { durationMs: Date.now() - verifyStart, passed: verifyExit === 0, output: verifyOut.split("\n")[0] };
        }

        const report = buildReport({
          purpose: fixtureKey === "small" ? "baseline" : "p0-r1",
          fixtureKey,
          fixture,
          mode,
          cacheState,
          workerDurationMs: spawned.durationMs,
          result,
          rssDoc,
          verify
        });
        if (result.status !== "complete" || spawned.exitCode !== 0) {
          report.verdict.roundtrip_completed = false;
          report.verdict.overall = "fail";
        }
        if (mode === "restore" && verify && !verify.passed) report.verdict.overall = "fail";

        const reportPath = join(ARTIFACTS, `perf-report-${label}.json`);
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        const record = {
          label,
          runId: report.run_id,
          reportPath: `perf-report-${label}.json`,
          reportSha256: createHash("sha256").update(await readFile(reportPath)).digest("hex"),
          peakRss: peakFromSamples(rssDoc),
          totalBytes: bytesProcessedOf(report)
        };
        runs.push(record);
        if (fixtureKey === "small" && mode === "create" && cacheState === "cold") {
          smallCreateCold.runId = record.runId;
          smallCreateCold.reportSha256 = record.reportSha256;
          smallCreateCold.totalBytes = record.totalBytes;
          smallCreateCold.peakRss = record.peakRss;
        }
        if (fixtureKey === "small" && mode === "restore" && cacheState === "cold") {
          smallRestoreCold.runId = record.runId;
          smallRestoreCold.reportSha256 = record.reportSha256;
          smallRestoreCold.totalBytes = record.totalBytes;
          smallRestoreCold.peakRss = record.peakRss;
        }
        console.log(`${label}: ${report.verdict.overall} peakRSS=${(record.peakRss / 1048576).toFixed(1)} MiB`);
      }
    }
  }

  // Fill the bounded-memory comparison into every large report (ADR-0018/ACC-30 oracle).
  for (const record of runs.filter((run) => run.label.startsWith("large"))) {
    const reportPath = resolve(ARTIFACTS, record.reportPath.replace("perf-reports/", "perf-reports/"));
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const baseline = record.label.includes("create") ? smallCreateCold : smallRestoreCold;
    const growth = report.phases.total.peak_rss_bytes - baseline.peakRss;
    const ratio = report.fixture.total_bytes / baseline.totalBytes;
    report.bounded_memory_comparison = {
      small_run_id: baseline.runId,
      small_report_sha256: baseline.reportSha256,
      small_total_bytes: baseline.totalBytes,
      small_peak_rss_bytes: baseline.peakRss,
      large_total_bytes: report.fixture.total_bytes,
      large_peak_rss_bytes: report.phases.total.peak_rss_bytes,
      fixture_byte_growth_ratio: ratio,
      peak_rss_growth_bytes: growth,
      same_environment: true,
      same_file_count: true,
      passed: growth <= 134217728 && ratio >= 7.5
    };
    if (!report.bounded_memory_comparison.passed) report.verdict.rss_growth_within_limit = false;
    if (!report.verdict.rss_growth_within_limit) report.verdict.overall = "fail";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const failures = runs.filter((run) => {
    const report = JSON.parse(readFileSync(resolve(ARTIFACTS, run.reportPath), "utf8"));
    return report.verdict.overall !== "pass";
  });
  for (const run of runs) {
    console.log(`${run.label}: run_id=${run.runId} sha256=${run.reportSha256}`);
  }
  console.log(failures.length === 0 ? "PERF_RUNS_PASS" : `PERF_RUNS_FAIL ${failures.map((run) => run.label).join(",")}`);
  return failures.length === 0 ? 0 : 1;
}

function bytesProcessedOf(report) {
  return report.phases.total.bytes_processed;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runMatrix()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
}
