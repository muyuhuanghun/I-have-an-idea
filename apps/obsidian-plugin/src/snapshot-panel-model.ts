// ADR-0023 §2: presentation-only state for the P0 snapshot view. Pure TypeScript with
// no Obsidian imports so the state machine stays unit-testable; the ItemView renders
// exactly what `SnapshotPanelRender` describes and never derives protocol state.
import {
  PLUGIN_VISIBILITY_EVIDENCE_SCOPE,
  type PluginSnapshotProgress,
  type PluginSnapshotReportV1
} from "./p0-snapshot.js";

export interface SnapshotPanelRender {
  readonly phase: "idle" | "running" | "complete" | "failed";
  readonly progressLines: readonly string[];
  readonly report: PluginSnapshotReportV1 | undefined;
  readonly errorMessage: string | undefined;
  readonly visibilityEvidenceScope: typeof PLUGIN_VISIBILITY_EVIDENCE_SCOPE;
}

const MAX_PROGRESS_LINES = 50;

export class SnapshotPanelModel {
  readonly #lines: string[] = [];
  #phase: SnapshotPanelRender["phase"] = "idle";
  #report: PluginSnapshotReportV1 | undefined;
  #errorMessage: string | undefined;

  get render(): SnapshotPanelRender {
    return {
      phase: this.#phase,
      progressLines: [...this.#lines],
      report: this.#report,
      errorMessage: this.#errorMessage,
      visibilityEvidenceScope: PLUGIN_VISIBILITY_EVIDENCE_SCOPE
    };
  }

  /** ADR-0021 §2.5 semantics unchanged: progress lines are derived purely from port events. */
  onProgress(progress: PluginSnapshotProgress): void {
    if (this.#phase === "complete" || this.#phase === "failed") return;
    this.#phase = "running";
    const line = this.#progressLine(progress);
    if (line !== undefined) this.#append(line);
  }

  onResult(report: PluginSnapshotReportV1): void {
    this.#phase = "complete";
    this.#report = report;
    this.#append(`Snapshot complete: ${report.file_count} file(s), ${report.total_plaintext_bytes} plaintext / ${report.total_ciphertext_bytes} ciphertext byte(s), ${report.visibility_summary.object_count} object(s).`);
  }

  onError(error: unknown): void {
    this.#phase = "failed";
    this.#errorMessage = error instanceof Error ? error.message : String(error);
    this.#append(`Snapshot failed: ${this.#errorMessage}`);
  }

  reset(): void {
    this.#lines.length = 0;
    this.#phase = "idle";
    this.#report = undefined;
    this.#errorMessage = undefined;
  }

  #append(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > MAX_PROGRESS_LINES) this.#lines.splice(0, this.#lines.length - MAX_PROGRESS_LINES);
  }

  #progressLine(progress: PluginSnapshotProgress): string | undefined {
    switch (progress.phase) {
      case "scanning":
        return progress.status === "active"
          ? `Scanning: ${progress.scannedFiles} file(s)…`
          : `Scan complete: ${progress.fileCount} file(s), ${progress.totalPlaintextBytes} plaintext byte(s).`;
      case "encrypting":
        return progress.status === "active"
          ? `Encrypting: ${progress.fileOrdinal}/${progress.fileCount} — ${progress.totalPlaintextBytes} plaintext byte(s) so far.`
          : `Encrypted ${progress.fileCount} file(s).`;
      case "recovery_ownership":
        return progress.status === "verifying"
          ? "Recovery File: verifying possession…"
          : "Recovery File: possession verified (exclusive write + byte-exact read-back).";
    }
  }
}
