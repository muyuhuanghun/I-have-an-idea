// ADR-0031 §13 (DP-027 plugin-host wiring): a thin host around the shared adapters
// web-console module. The server itself is unchanged and carries DP-027's WEB-ACC
// evidence; this wrapper only supplies the plugin's session-domain sources — the
// configured ObjectStore aggregate, an honest constant "not_checked" head (the plugin
// does not use the P1 state protocol), the last successful snapshot's in-memory
// report summary, and a task ring fed by plugin-triggered snapshot runs.
import {
  projectStorageStats,
  startWebConsoleServer,
  WebConsoleTaskRing,
  type RunningWebConsoleServer,
  type WebConsoleTaskEntry
} from "@ekd/adapters/web-console";

export interface PluginConsoleReportSummary {
  readonly schema_version: string;
  readonly verdict: string;
  readonly created_at: string;
  readonly object_count: number;
  readonly total_ciphertext_bytes: number;
}

export interface PluginConsoleHostOptions {
  readonly version: string;
  readonly build: () => Promise<string>;
  /** Absolute configured ObjectStore path, or undefined while settings are incomplete. */
  readonly objectStorePath: () => string | undefined;
  readonly log?: (line: string) => void;
}

export class PluginConsoleHost {
  readonly #options: PluginConsoleHostOptions;
  readonly #tasks = new WebConsoleTaskRing();
  #server: RunningWebConsoleServer | undefined;
  #report: PluginConsoleReportSummary | null = null;

  constructor(options: PluginConsoleHostOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#server !== undefined;
  }

  get url(): string | undefined {
    return this.#server === undefined ? undefined : `http://127.0.0.1:${this.#server.port}/`;
  }

  async start(): Promise<string> {
    if (this.#server !== undefined) return this.url as string;
    const build = await this.#options.build();
    const server = await startWebConsoleServer({
      service: { version: this.#options.version, build },
      headStatus: async () => ({
        present: false,
        sequence: null,
        created_at: null,
        verdict: "not_checked",
        checked_at: new Date().toISOString()
      }),
      storageStats: async () => {
        const storePath = this.#options.objectStorePath();
        if (storePath === undefined || storePath.length === 0) return undefined;
        return projectStorageStats(storePath);
      },
      reportSummary: async () => this.#report,
      tasks: this.#tasks,
      ...(this.#options.log === undefined ? {} : { log: this.#options.log })
    });
    this.#server = server;
    return `http://127.0.0.1:${server.port}/`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    await server?.close();
  }

  /** A completed plugin-triggered snapshot: feeds the ring and the report summary. */
  recordSnapshotSuccess(report: PluginConsoleReportSummary, startedAt: string, durationMs: number): void {
    this.#report = report;
    this.#tasks.record({
      kind: "snapshot",
      status: "complete",
      started_at: startedAt,
      completed_at: report.created_at,
      duration_ms: durationMs,
      object_count: report.object_count,
      total_ciphertext_bytes: report.total_ciphertext_bytes,
      error_code: null
    });
  }

  /** A pipeline failure (after the run started). Counters stay 0 by contract — they are not publication facts. */
  recordSnapshotFailure(errorCode: string, startedAt: string, completedAt: string, durationMs: number): void {
    const entry: WebConsoleTaskEntry = {
      kind: "snapshot",
      status: "failed",
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      object_count: 0,
      total_ciphertext_bytes: 0,
      error_code: errorCode
    };
    this.#tasks.record(entry);
  }
}
