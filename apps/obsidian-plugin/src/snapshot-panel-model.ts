// ADR-0023 §2: presentation-only state for the P0 snapshot view. Pure TypeScript with
// no Obsidian imports so the state machine stays unit-testable; the ItemView renders
// exactly what `SnapshotPanelRender` describes and never derives protocol state.
// 文案经 strings.ts（中文本地化，2026-09-12）；错误提示 hint 由调用方按归一化错误码注入。
import {
  PLUGIN_VISIBILITY_EVIDENCE_SCOPE,
  type PluginSnapshotProgress,
  type PluginSnapshotReportV1
} from "./p0-snapshot.js";
import { STRINGS } from "./strings.js";

export interface SnapshotPanelRender {
  readonly phase: "idle" | "running" | "complete" | "failed";
  readonly progressLines: readonly string[];
  readonly report: PluginSnapshotReportV1 | undefined;
  readonly errorMessage: string | undefined;
  /** 交互友好：按归一化错误码给出的下一步操作提示（无匹配时为通用提示）。 */
  readonly errorHint: string | undefined;
  readonly visibilityEvidenceScope: typeof PLUGIN_VISIBILITY_EVIDENCE_SCOPE;
}

const MAX_PROGRESS_LINES = 50;

export class SnapshotPanelModel {
  readonly #lines: string[] = [];
  #phase: SnapshotPanelRender["phase"] = "idle";
  #report: PluginSnapshotReportV1 | undefined;
  #errorMessage: string | undefined;
  #errorHint: string | undefined;

  get render(): SnapshotPanelRender {
    return {
      phase: this.#phase,
      progressLines: [...this.#lines],
      report: this.#report,
      errorMessage: this.#errorMessage,
      errorHint: this.#errorHint,
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
    this.#append(STRINGS.panel.complete(
      report.file_count,
      report.total_plaintext_bytes,
      report.total_ciphertext_bytes,
      report.visibility_summary.object_count
    ));
  }

  onError(error: unknown, hint?: string): void {
    this.#phase = "failed";
    this.#errorMessage = error instanceof Error ? error.message : String(error);
    this.#errorHint = hint;
    this.#append(STRINGS.panel.failed(this.#errorMessage));
  }

  reset(): void {
    this.#lines.length = 0;
    this.#phase = "idle";
    this.#report = undefined;
    this.#errorMessage = undefined;
    this.#errorHint = undefined;
  }

  #append(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > MAX_PROGRESS_LINES) this.#lines.splice(0, this.#lines.length - MAX_PROGRESS_LINES);
  }

  #progressLine(progress: PluginSnapshotProgress): string | undefined {
    switch (progress.phase) {
      case "scanning":
        return progress.status === "active"
          ? STRINGS.panel.scanActive(progress.scannedFiles)
          : STRINGS.panel.scanDone(progress.fileCount, progress.totalPlaintextBytes);
      case "encrypting":
        return progress.status === "active"
          ? STRINGS.panel.encryptActive(progress.fileOrdinal, progress.fileCount, progress.totalPlaintextBytes)
          : STRINGS.panel.encryptDone(progress.fileCount);
      case "recovery_ownership":
        return progress.status === "verifying"
          ? STRINGS.panel.recoveryVerifying
          : STRINGS.panel.recoveryDone;
    }
  }
}
