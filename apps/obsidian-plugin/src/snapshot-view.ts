// ADR-0023 §2: dockable P0 snapshot view. Presentation only — every state transition
// comes from SnapshotPanelModel (fed by the port-interception progress callback), and
// the trigger/open-report actions are callbacks wired by the plugin, never protocol logic.
// 文案经 strings.ts（中文本地化，2026-09-12）。
import { ItemView, Notice } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { SnapshotPanelRender } from "./snapshot-panel-model.js";
import { STRINGS } from "./strings.js";

export const VIEW_TYPE_EKD_P0_SNAPSHOT = "ekd-p0-snapshot-view";

export interface SnapshotViewCallbacks {
  readonly onTrigger: () => void;
  readonly onOpenReport: (reportPath: string) => void;
  readonly isRunning: () => boolean;
  /** ADR-0031 §13: present only while the read-only localhost console is enabled and running. */
  readonly consoleAvailable: () => boolean;
  readonly onOpenConsole: () => void;
}

export class P0SnapshotView extends ItemView {
  readonly #callbacks: SnapshotViewCallbacks;
  #render: SnapshotPanelRender | undefined;

  constructor(leaf: WorkspaceLeaf, callbacks: SnapshotViewCallbacks) {
    super(leaf);
    this.#callbacks = callbacks;
  }

  getViewType(): string {
    return VIEW_TYPE_EKD_P0_SNAPSHOT;
  }

  getDisplayText(): string {
    return STRINGS.view.title;
  }

  getIcon(): string {
    return "lock";
  }

  /** Called by the plugin whenever the panel model produces a new render snapshot. */
  updateFromModel(render: SnapshotPanelRender): void {
    this.#render = render;
    this.#renderContent();
  }

  protected async onOpen(): Promise<void> {
    this.#renderContent();
  }

  protected onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  #renderContent(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ekd-p0-snapshot-view");

    const header = container.createDiv({ cls: "ekd-p0-header" });
    header.createEl("h4", { text: STRINGS.view.header });
    header.createEl("p", { cls: "ekd-p0-muted", text: STRINGS.view.description });

    const runSection = container.createDiv({ cls: "ekd-p0-run" });
    const button = runSection.createEl("button", {
      cls: "mod-cta",
      text: this.#callbacks.isRunning() ? STRINGS.view.snapshotRunning : STRINGS.view.createSnapshot
    });
    button.disabled = this.#callbacks.isRunning();
    button.addEventListener("click", () => {
      if (!this.#callbacks.isRunning()) this.#callbacks.onTrigger();
    });
    if (this.#callbacks.consoleAvailable()) {
      const consoleButton = runSection.createEl("button", { text: STRINGS.view.openConsole });
      consoleButton.addEventListener("click", () => this.#callbacks.onOpenConsole());
      runSection.createEl("p", { cls: "ekd-p0-muted", text: STRINGS.view.consoleHint });
    }

    const progressSection = container.createDiv({ cls: "ekd-p0-progress" });
    progressSection.createEl("h5", { text: STRINGS.view.progress });
    if (this.#render === undefined || this.#render.progressLines.length === 0) {
      progressSection.createEl("p", { cls: "ekd-p0-muted", text: STRINGS.view.noRunYet });
    } else {
      const list = progressSection.createEl("ul");
      for (const line of this.#render.progressLines) list.createEl("li", { text: line });
    }

    const resultSection = container.createDiv({ cls: "ekd-p0-result" });
    resultSection.createEl("h5", { text: STRINGS.view.lastResult });
    const render = this.#render;
    if (render === undefined || render.phase === "idle") {
      resultSection.createEl("p", { cls: "ekd-p0-muted", text: STRINGS.view.idle });
      return;
    }
    if (render.phase === "failed" && render.errorMessage !== undefined) {
      resultSection.createEl("p", { cls: "ekd-p0-error", text: `${STRINGS.view.failedPrefix}${render.errorMessage}` });
      resultSection.createEl("p", {
        cls: "ekd-p0-muted",
        text: render.errorHint ?? STRINGS.view.failedHint
      });
    }
    if (render.report !== undefined) {
      const report = render.report;
      const card = resultSection.createDiv({ cls: "ekd-p0-summary" });
      const rows: Array<[string, string]> = [
        [STRINGS.view.table.runId, report.run_id],
        [STRINGS.view.table.snapshotId, `${report.snapshot_id_hex.slice(0, 16)}…`],
        [STRINGS.view.table.files, String(report.file_count)],
        [STRINGS.view.table.plaintextBytes, String(report.total_plaintext_bytes)],
        [STRINGS.view.table.ciphertextBytes, String(report.total_ciphertext_bytes)],
        [STRINGS.view.table.objects, String(report.visibility_summary.object_count)],
        [STRINGS.view.table.completedAt, report.completed_at]
      ];
      const table = card.createEl("table");
      for (const [label, value] of rows) {
        const row = table.createEl("tr");
        row.createEl("td", { text: label });
        row.createEl("td", { text: value });
      }
      card.createEl("p", {
        cls: "ekd-p0-muted",
        text: STRINGS.view.visibilityScopeNote(render.visibilityEvidenceScope)
      });
      const openButton = card.createEl("button", { text: STRINGS.view.openReport });
      openButton.addEventListener("click", () => {
        try {
          this.#callbacks.onOpenReport(this.#reportPathForView());
        } catch (error) {
          new Notice(STRINGS.view.openReportFailed(error instanceof Error ? error.message : String(error)));
        }
      });
    }
  }

  #reportPathForView(): string {
    // The plugin keeps the configured report path; the view surface only receives the
    // model, so the path is re-exposed through the header data attribute at update time.
    const path = this.contentEl.getAttr("data-ekd-report-path");
    if (typeof path !== "string" || path.length === 0) throw new Error("No report path recorded for this run.");
    return path;
  }

  /** The plugin records the configured report path alongside each render. */
  setReportPath(path: string): void {
    this.contentEl.setAttr("data-ekd-report-path", path);
  }
}
