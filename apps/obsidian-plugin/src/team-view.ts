// ADR-0039: dockable team view — presentation only; every action is a callback
// wired by the plugin, never protocol logic. 文案经 strings.ts（中文本地化）。
import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { TeamPanelRender } from "./team-panel-model.js";
import { STRINGS } from "./strings.js";

export const VIEW_TYPE_EKD_TEAM = "ekd-team-view";

export interface TeamViewCallbacks {
  readonly refresh: () => void;
  readonly submit: (title: string, content: string) => void;
  readonly approve: (proposalId: string) => void;
  readonly isBusy: () => boolean;
  readonly isReviewer: () => boolean;
}

export class TeamView extends ItemView {
  readonly #callbacks: TeamViewCallbacks;
  #render: TeamPanelRender | undefined;

  constructor(leaf: WorkspaceLeaf, callbacks: TeamViewCallbacks) {
    super(leaf);
    this.#callbacks = callbacks;
  }

  getViewType(): string {
    return VIEW_TYPE_EKD_TEAM;
  }

  getDisplayText(): string {
    return STRINGS.team.viewTitle;
  }

  getIcon(): string {
    return "users";
  }

  updateFromModel(render: TeamPanelRender): void {
    this.#render = render;
    this.#renderContent();
  }

  protected async onOpen(): Promise<void> {
    this.#callbacks.refresh();
    this.#renderContent();
  }

  protected onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  #renderContent(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ekd-team-view");
    const render = this.#render;

    if (render === undefined || render.phase === "unconfigured") {
      container.createEl("p", { cls: "ekd-p0-muted", text: STRINGS.team.unconfigured });
      return;
    }
    if (render.phase === "error" && render.errorMessage !== undefined) {
      container.createEl("p", { cls: "ekd-p0-error", text: `${STRINGS.team.errorPrefix}${render.errorMessage}` });
      return;
    }

    const header = container.createDiv({ cls: "ekd-p0-header" });
    header.createEl("h4", { text: STRINGS.team.viewTitle });
    const info = header.createEl("p", { cls: "ekd-p0-muted" });
    info.textContent = STRINGS.team.epochInfo(render.epoch ?? 0, render.memberCount ?? 0);

    if (render.isReviewer) {
      const submitSection = container.createDiv({ cls: "ekd-team-submit" });
      submitSection.createEl("h5", { text: STRINGS.team.submitTitle });
      const titleInput = submitSection.createEl("input", {
        type: "text",
        placeholder: STRINGS.team.titlePlaceholder,
        value: ""
      });
      titleInput.addClass("ekd-team-title-input");
      const contentInput = submitSection.createEl("textarea", { placeholder: STRINGS.team.contentPlaceholder });
      contentInput.addClass("ekd-team-content-input");
      const submitButton = submitSection.createEl("button", {
        cls: "mod-cta",
        text: render.busy ? STRINGS.team.submitting : STRINGS.team.submitButton
      });
      submitButton.disabled = render.busy;
      submitButton.addEventListener("click", () => {
        if (titleInput.value.trim().length === 0 || contentInput.value.trim().length === 0) {
          return;
        }
        this.#callbacks.submit(titleInput.value.trim(), contentInput.value.trim());
      });
    }

    const listSection = container.createDiv({ cls: "ekd-team-list" });
    listSection.createEl("h5", { text: STRINGS.team.listTitle });
    if (render.proposals.length === 0) {
      listSection.createEl("p", { cls: "ekd-p0-muted", text: STRINGS.team.noProposals });
    } else {
      for (const proposal of render.proposals) {
        const row = listSection.createDiv({ cls: "ekd-team-proposal" });
        const title = row.createEl("p", { text: proposal.title });
        title.addClass("ekd-team-proposal-title");
        const meta = row.createEl("p", { cls: "ekd-p0-muted" });
        meta.textContent = STRINGS.team.proposalMeta(proposal.createdAt, proposal.approvals);
        if (render.isReviewer && !proposal.accepted && !render.busy) {
          const approveButton = row.createEl("button", { text: STRINGS.team.approveButton });
          approveButton.addEventListener("click", () => this.#callbacks.approve(proposal.proposalId));
        }
        if (proposal.accepted) {
          row.createEl("p", { cls: "ekd-team-accepted", text: STRINGS.team.acceptedLabel });
        }
      }
    }

    const refreshButton = container.createEl("button", { text: STRINGS.team.refresh });
    refreshButton.addClass("ekd-team-refresh");
    refreshButton.addEventListener("click", () => this.#callbacks.refresh());
  }
}
