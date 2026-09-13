// ADR-0039: presentation model for the team view — pure TypeScript, no Obsidian
// imports, unit-testable. The view renders exactly what this model produces.
export interface TeamPanelRender {
  readonly phase: "unconfigured" | "ready" | "error";
  readonly errorMessage: string | undefined;
  readonly epoch: number | undefined;
  readonly memberCount: number | undefined;
  readonly proposals: readonly TeamProposalLine[];
  readonly isReviewer: boolean;
  readonly busy: boolean;
}

export interface TeamProposalLine {
  readonly proposalId: string;
  readonly title: string;
  readonly authorDeviceId: string;
  readonly createdAt: string;
  readonly approvals: number;
  readonly accepted: boolean;
}

export class TeamPanelModel {
  #phase: TeamPanelRender["phase"] = "unconfigured";
  #errorMessage: string | undefined;
  #epoch: number | undefined;
  #memberCount: number | undefined;
  #proposals: TeamProposalLine[] = [];
  #isReviewer = false;
  #busy = false;

  get render(): TeamPanelRender {
    return {
      phase: this.#phase,
      errorMessage: this.#errorMessage,
      epoch: this.#epoch,
      memberCount: this.#memberCount,
      proposals: [...this.#proposals],
      isReviewer: this.#isReviewer,
      busy: this.#busy
    };
  }

  setUnconfigured(): void {
    this.#phase = "unconfigured";
    this.#errorMessage = undefined;
    this.#proposals = [];
  }

  setError(message: string): void {
    this.#phase = "error";
    this.#errorMessage = message;
    this.#busy = false;
  }

  setBusy(): void {
    this.#busy = true;
  }

  setReady(state: { epoch: number; memberCount: number; proposals: readonly TeamProposalLine[]; isReviewer: boolean }): void {
    this.#phase = "ready";
    this.#errorMessage = undefined;
    this.#busy = false;
    this.#epoch = state.epoch;
    this.#memberCount = state.memberCount;
    this.#proposals = [...state.proposals];
    this.#isReviewer = state.isReviewer;
  }
}
