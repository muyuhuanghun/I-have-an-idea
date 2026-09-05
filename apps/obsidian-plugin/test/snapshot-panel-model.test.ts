import { describe, expect, it } from "vitest";
import { SnapshotPanelModel } from "../src/snapshot-panel-model.js";
import { PLUGIN_VISIBILITY_EVIDENCE_SCOPE, type PluginSnapshotReportV1 } from "../src/p0-snapshot.js";

const report: PluginSnapshotReportV1 = {
  schema_version: "p0-plugin-snapshot-report-v1",
  run_id: "8bfa54ddaaa6889e02c8ec2c0a6c77d3",
  snapshot_id_hex: "d68a52586724ad4d87848becc583ed8a08574bb5c208de2370c0bd898cd53e90",
  domain_id_sha256: "30a09f0af3fd3f8e024d8842fee8fe1d6daf341684cf56c8d864fc586322fa8a",
  runtime_limits_sha256: "e1971ab746f6b08b06522463f907143036d99e41c470532482b5da8eafc44acd",
  file_count: 3,
  total_plaintext_bytes: 104,
  total_ciphertext_bytes: 661,
  visibility_summary: {
    object_count: 4,
    total_ciphertext_bytes: 661,
    object_keys_path_free: true,
    runtime_limits_sha256: "e1971ab746f6b08b06522463f907143036d99e41c470532482b5da8eafc44acd",
    evidence_scope: PLUGIN_VISIBILITY_EVIDENCE_SCOPE
  },
  snapshot_log_sha256: "23b7bc71933458f0903f5250f5445fa3e633fc9e9fe7eb87e4c4d2c504cef946",
  started_at: "2026-09-05T03:49:06.606Z",
  completed_at: "2026-09-05T03:49:06.664Z",
  verdict: "pass"
};

describe("SnapshotPanelModel (ADR-0023 view state)", () => {
  it("starts idle and maps the full progress sequence into derived lines", () => {
    const model = new SnapshotPanelModel();
    expect(model.render.phase).toBe("idle");
    expect(model.render.progressLines).toEqual([]);

    model.onProgress({ phase: "scanning", status: "active", scannedFiles: 1 });
    model.onProgress({ phase: "scanning", status: "complete", fileCount: 3, totalPlaintextBytes: 104 });
    model.onProgress({ phase: "encrypting", status: "active", fileOrdinal: 2, fileCount: 3, totalPlaintextBytes: 79 });
    model.onProgress({ phase: "encrypting", status: "complete", fileCount: 3 });
    model.onProgress({ phase: "recovery_ownership", status: "verifying" });
    model.onProgress({ phase: "recovery_ownership", status: "complete" });

    expect(model.render.phase).toBe("running");
    expect(model.render.progressLines).toEqual([
      "Scanning: 1 file(s)…",
      "Scan complete: 3 file(s), 104 plaintext byte(s).",
      "Encrypting: 2/3 — 79 plaintext byte(s) so far.",
      "Encrypted 3 file(s).",
      "Recovery File: verifying possession…",
      "Recovery File: possession verified (exclusive write + byte-exact read-back)."
    ]);
  });

  it("records a pass report with the visibility disclaimer scope and never regresses to running", () => {
    const model = new SnapshotPanelModel();
    model.onProgress({ phase: "encrypting", status: "active", fileOrdinal: 1, fileCount: 3, totalPlaintextBytes: 37 });
    model.onResult(report);

    expect(model.render.phase).toBe("complete");
    expect(model.render.report).toBe(report);
    expect(model.render.visibilityEvidenceScope).toBe("plugin-summary-not-formal-acc-32-or-33");
    expect(model.render.progressLines.at(-1)).toContain("Snapshot complete: 3 file(s)");

    model.onProgress({ phase: "scanning", status: "active", scannedFiles: 9 });
    expect(model.render.phase).toBe("complete");
  });

  it("records failures and reset returns to the idle state", () => {
    const model = new SnapshotPanelModel();
    model.onProgress({ phase: "scanning", status: "active", scannedFiles: 2 });
    model.onError(new Error("Obsidian desktop did not expose the Node module loader"));

    expect(model.render.phase).toBe("failed");
    expect(model.render.errorMessage).toBe("Obsidian desktop did not expose the Node module loader");
    expect(model.render.progressLines.at(-1)).toContain("Snapshot failed:");

    model.reset();
    expect(model.render.phase).toBe("idle");
    expect(model.render.progressLines).toEqual([]);
    expect(model.render.report).toBeUndefined();
    expect(model.render.errorMessage).toBeUndefined();
  });
});
