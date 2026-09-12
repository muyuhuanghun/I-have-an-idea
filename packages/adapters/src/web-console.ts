// ADR-0030/ADR-0031 (DP-027): the read-only localhost web console. The server binds
// IPv4 127.0.0.1 on an ephemeral port, hands a per-process capability token to the
// page via a same-origin bootstrap fetch (never URL/HTML/storage/logs), and projects
// a fixed whitelist DTO built from host-provided read-only sources. Every response
// carries the frozen security header set; every request passes Host + Fetch Metadata
// checks before any data source is touched. There is no write surface of any kind.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Bytes, ObjectStore } from "@ekd/core";
import { HeadError } from "@ekd/core";
import { ConsoleAdapterError } from "./errors.js";
import type { HeadDirectory } from "./head-directory.js";

// ---------------------------------------------------------------------------
// DTO contracts (ADR-0031 §4: the whitelist is closed; nothing outside it may
// reach the page, and absent sources must stay visibly unknown/unavailable)
// ---------------------------------------------------------------------------

export type ConsoleHeadVerdict =
  | "verified"
  | "not_checked"
  | "signature_invalid"
  | "device_unregistered"
  | "rollback_detected"
  | "fork_detected"
  | "unreadable"
  | "unknown";

export interface WebConsoleTaskEntry {
  readonly kind: "snapshot" | "restore";
  readonly status: "complete" | "failed";
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly object_count: number;
  readonly total_ciphertext_bytes: number;
  readonly error_code: string | null;
}

export interface WebConsoleStatusDto {
  readonly schema: "p1-web-console-status-v1";
  readonly service: {
    readonly status: "ok" | "degraded";
    readonly version: string;
    readonly build: string;
    readonly started_at: string;
    readonly uptime_seconds: number;
  };
  /** `present` is true only for a head that PASSED verification (ADR-0030 §6.2). */
  readonly head: {
    readonly present: boolean;
    readonly sequence: number | null;
    readonly created_at: string | null;
    readonly verdict: ConsoleHeadVerdict;
    readonly checked_at: string;
  };
  /** null counts mean the source is unavailable — never 0 (ADR-0031 §4). */
  readonly storage: {
    readonly object_count: number | null;
    readonly total_ciphertext_bytes: number | null;
    readonly observed_at: string;
  };
  readonly tasks: { readonly items: readonly WebConsoleTaskEntry[] };
  readonly report: {
    readonly schema_version: string;
    readonly verdict: string;
    readonly created_at: string;
    readonly object_count: number;
    readonly total_ciphertext_bytes: number;
  } | null;
}

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

// ---------------------------------------------------------------------------
// Read-only projections (ADR-0030 §2.2.4/§7.0: head status may only come from
// the existing verification primitives composed read-only — never from parsing
// pointer/head/devices files at the UI layer)
// ---------------------------------------------------------------------------

/**
 * Compose the existing read primitives into the head projection. `readLatestHead`
 * already covers pointer/head signatures, device registration and pointer/record
 * sequence agreement; its normalized error codes ARE the verdicts. Read-side
 * journal-aware rollback detection is not provided by the current primitives and
 * is therefore NOT faked here (ADR-0030 §6: unprovable states must stay honest).
 */
export async function projectHeadStatus(
  directory: HeadDirectory,
  domainId: Bytes,
  objectStore: ObjectStore,
  nowMilliseconds: () => number = Date.now
): Promise<WebConsoleStatusDto["head"]> {
  const checkedAt = iso(nowMilliseconds());
  try {
    const latest = await directory.readLatestHead(domainId, objectStore);
    if (latest === undefined) {
      return { present: false, sequence: null, created_at: null, verdict: "not_checked", checked_at: checkedAt };
    }
    return {
      present: true,
      sequence: latest.pointer.sequence,
      created_at: iso(Number(latest.record.createdAtUnix)),
      verdict: "verified",
      checked_at: checkedAt
    };
  } catch (error) {
    const code = error instanceof HeadError ? error.code : undefined;
    const verdict: ConsoleHeadVerdict =
      code === "HEAD_SIGNATURE_INVALID" ? "signature_invalid"
      : code === "HEAD_DEVICE_UNREGISTERED" ? "device_unregistered"
      : code === "HEAD_ROLLBACK_DETECTED" ? "rollback_detected"
      : code === "HEAD_FORK_DETECTED" ? "fork_detected"
      : "unknown";
    return { present: false, sequence: null, created_at: null, verdict, checked_at: checkedAt };
  }
}

/**
 * Ciphertext-side aggregate over the flat ObjectStore directory. Read-only, lstat
 * only: any reparse point or unexpected entry type fails the whole source closed
 * (ADR-0030 §7) instead of skipping or following it.
 */
export async function projectStorageStats(storeRoot: string): Promise<{
  object_count: number;
  total_ciphertext_bytes: number;
}> {
  const unavailable = (message: string, cause?: unknown): ConsoleAdapterError =>
    new ConsoleAdapterError("CONSOLE_SOURCE_UNAVAILABLE", "storage", message, cause === undefined ? undefined : { cause });
  let rootStats;
  try {
    rootStats = await lstat(storeRoot);
  } catch (error) {
    throw unavailable("Storage root is unavailable.", error);
  }
  if (rootStats.isSymbolicLink()) throw unavailable("Storage root must be a real directory, not a reparse point.");
  if (!rootStats.isDirectory()) throw unavailable("Storage root is not a directory.");
  const entries = await readdir(storeRoot, { withFileTypes: true }).catch((error: unknown) => {
    throw unavailable("Storage root could not be listed.", error);
  });
  let objectCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw unavailable("Storage contains a reparse point; refusing to aggregate.");
    if (!entry.isFile()) throw unavailable("Storage contains an unexpected non-file entry; refusing to aggregate.");
    const stats = await lstat(join(storeRoot, entry.name)).catch((error: unknown) => {
      throw unavailable("Storage entry could not be inspected.", error);
    });
    objectCount += 1;
    totalBytes += Number(stats.size);
  }
  return { object_count: objectCount, total_ciphertext_bytes: totalBytes };
}

// ---------------------------------------------------------------------------
// Task ring (ADR-0030 §5.3: in-memory FIFO, capacity 20, cleared on restart)
// ---------------------------------------------------------------------------

export class WebConsoleTaskRing {
  readonly #items: WebConsoleTaskEntry[] = [];

  constructor(readonly capacity: number = 20) {}

  record(entry: WebConsoleTaskEntry): void {
    this.#items.unshift(entry);
    if (this.#items.length > this.capacity) this.#items.length = this.capacity;
  }

  list(): readonly WebConsoleTaskEntry[] {
    return [...this.#items];
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
};

const FORBIDDEN_BODY = "Forbidden.";
const NOT_FOUND_BODY = "Not found.";
const METHOD_BODY = "Method not allowed.";

export interface WebConsoleServerOptions {
  readonly service: { readonly version: string; readonly build: string };
  readonly headStatus: () => Promise<WebConsoleStatusDto["head"]>;
  readonly storageStats: () => Promise<{ object_count: number; total_ciphertext_bytes: number } | undefined>;
  readonly reportSummary: () => Promise<WebConsoleStatusDto["report"]>;
  readonly tasks: WebConsoleTaskRing;
  /** Defaults to an OS-assigned ephemeral port; only tests pass a fixed one. */
  readonly port?: number;
  /** Sanitized log (method/path/status/duration). Never receives the token. */
  readonly log?: (line: string) => void;
  /** Test-only hook: may delay, throw, or destroy `request.socket` before handling. */
  readonly faultInjector?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

export interface RunningWebConsoleServer {
  readonly port: number;
  /** Process capability token — memory-only, never logged, never persisted. */
  readonly token: string;
  readonly close: () => Promise<void>;
}

function forbiddenHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? "");
  }
  return values;
}

function tokensMatch(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  return expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes);
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", String(Buffer.byteLength(body, "utf8")));
  response.statusCode = status;
  response.end(body);
}

async function buildStatusDto(options: WebConsoleServerOptions, startedAtMs: number): Promise<WebConsoleStatusDto> {
  const nowMs = Date.now();
  const observedAt = iso(nowMs);
  let head: WebConsoleStatusDto["head"];
  try {
    head = await options.headStatus();
  } catch {
    head = { present: false, sequence: null, created_at: null, verdict: "unknown", checked_at: observedAt };
  }
  let storage: WebConsoleStatusDto["storage"];
  try {
    const stats = await options.storageStats();
    storage =
      stats === undefined
        ? { object_count: null, total_ciphertext_bytes: null, observed_at: observedAt }
        : { object_count: stats.object_count, total_ciphertext_bytes: stats.total_ciphertext_bytes, observed_at: observedAt };
  } catch {
    storage = { object_count: null, total_ciphertext_bytes: null, observed_at: observedAt };
  }
  let report: WebConsoleStatusDto["report"];
  try {
    report = await options.reportSummary();
  } catch {
    report = null;
  }
  return {
    schema: "p1-web-console-status-v1",
    service: {
      status: "ok",
      version: options.service.version,
      build: options.service.build,
      started_at: iso(startedAtMs),
      uptime_seconds: Math.floor((nowMs - startedAtMs) / 1000)
    },
    head,
    storage,
    tasks: { items: options.tasks.list() },
    report
  };
}

export async function startWebConsoleServer(options: WebConsoleServerOptions): Promise<RunningWebConsoleServer> {
  if (options.port !== undefined && !Number.isInteger(options.port)) throw new Error("port must be an integer.");
  const token = randomBytes(32).toString("base64url"); // 256-bit CSPRNG (ADR-0030 §3.3.1)
  const startedAtMs = Date.now();
  const log = options.log ?? (() => {});

  const server: Server = createServer((request, response) => {
    const startedAt = Date.now();
    const finish = (status: number, contentType: string, body: string): void => {
      log(`${request.method ?? "-"} ${request.url ?? "-"} status=${status} bytes=${Buffer.byteLength(body, "utf8")} duration_ms=${Date.now() - startedAt}`);
      send(response, status, contentType, body);
    };
    void (async () => {
      if (options.faultInjector !== undefined) await options.faultInjector(request, response);
      if (response.writableEnded) return;

      // Gate order is frozen (ADR-0031 §2.1): Host -> Fetch Metadata -> session ->
      // route. Every gate fails closed BEFORE any data source is touched.
      const hostValues = forbiddenHeaderValues(request, "host");
      const expectedHost = `127.0.0.1:${(server.address() as { port: number }).port}`;
      if (hostValues.length !== 1 || hostValues[0] !== expectedHost) {
        finish(403, "text/plain; charset=utf-8", FORBIDDEN_BODY);
        return;
      }
      const fetchSite = request.headers["sec-fetch-site"];
      if (fetchSite !== "same-origin" && fetchSite !== "none") {
        finish(403, "text/plain; charset=utf-8", FORBIDDEN_BODY);
        return;
      }
      if (request.method !== "GET") {
        finish(405, "text/plain; charset=utf-8", METHOD_BODY);
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1.invalid").pathname;

      if (pathname === "/") {
        finish(200, "text/html; charset=utf-8", CONSOLE_HTML);
        return;
      }
      if (pathname === "/app.js") {
        finish(200, "text/javascript; charset=utf-8", CONSOLE_JS);
        return;
      }
      if (pathname === "/app.css") {
        finish(200, "text/css; charset=utf-8", CONSOLE_CSS);
        return;
      }
      if (pathname === "/bootstrap") {
        // The token exists ONLY in this JSON body and the page's volatile memory.
        finish(200, "application/json", JSON.stringify({ token }));
        return;
      }
      if (pathname === "/api/status") {
        const presented = request.headers["x-console-session"];
        if (!tokensMatch(token, Array.isArray(presented) ? presented[0] : presented)) {
          // Uniform rejection: no hint about whether sources exist (ADR-0030 §3.3.5).
          log(`${request.method ?? "-"} ${request.url ?? "-"} code=CONSOLE_SESSION_REJECTED`);
          finish(403, "text/plain; charset=utf-8", FORBIDDEN_BODY);
          return;
        }
        const dto = await buildStatusDto(options, startedAtMs);
        finish(200, "application/json", JSON.stringify(dto));
        return;
      }
      finish(404, "text/plain; charset=utf-8", NOT_FOUND_BODY);
    })().catch(() => {
      if (!response.writableEnded) finish(500, "text/plain; charset=utf-8", "Internal error.");
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, "127.0.0.1", resolveListen);
  });
  const close = async (): Promise<void> => {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
  };
  return { port: (server.address() as { port: number }).port, token, close };
}

// ---------------------------------------------------------------------------
// Static assets (ADR-0031 §2: same-origin files only, no inline scripts, no
// third-party resources; the page renders DTO fields via textContent only)
// ---------------------------------------------------------------------------

export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EKD 本机状态</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<h1>EKD 本机状态（只读）</h1>
<p id="notice" class="hidden"></p>
<main id="content" class="hidden">
  <section><h2>服务</h2><dl id="service"></dl></section>
  <section><h2>Head</h2><dl id="head"></dl></section>
  <section><h2>存储（密文侧）</h2><dl id="storage"></dl></section>
  <section><h2>最近任务（本进程）</h2><div id="tasks"></div></section>
  <section><h2>报告摘要（本会话）</h2><dl id="report"></dl></section>
</main>
<p class="footnote">checked_at 是本次检查时间，不代表 head 或报告的新鲜度。</p>
</body>
</html>
`;

export const CONSOLE_CSS = `:root { color-scheme: light; font-family: system-ui, sans-serif; }
body { margin: 2rem auto; max-width: 46rem; padding: 0 1rem; }
.hidden { display: none; }
section { margin: 1.25rem 0; padding: 0.75rem 1rem; border: 1px solid #ccc; border-radius: 6px; }
h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; margin: 0; }
dt { color: #555; } dd { margin: 0; word-break: break-all; }
.verdict-ok { color: #1a7f37; font-weight: 600; }
.verdict-unknown { color: #777; font-weight: 600; }
.verdict-failed { color: #c62828; font-weight: 600; }
.task { padding: 0.35rem 0; border-bottom: 1px dotted #ddd; }
.footnote { color: #888; font-size: 0.85rem; }
button { margin: 0.5rem 0; }
`;

export const CONSOLE_JS = `(() => {
"use strict";
const VERDICT_LABEL = {
  verified: ["已验证", "verdict-ok"],
  not_checked: ["未检查", "verdict-unknown"],
  unknown: ["未知", "verdict-unknown"],
  signature_invalid: ["签名无效", "verdict-failed"],
  device_unregistered: ["设备未注册", "verdict-failed"],
  rollback_detected: ["检测到回滚", "verdict-failed"],
  fork_detected: ["检测到分叉", "verdict-failed"],
  unreadable: ["不可读", "verdict-failed"]
};

function pair(list, name, value, verdictClass) {
  const dt = document.createElement("dt");
  dt.textContent = name;
  const dd = document.createElement("dd");
  dd.textContent = value === null || value === undefined ? "—" : String(value);
  if (verdictClass) dd.className = verdictClass;
  list.append(dt, dd);
}

function renderHead(list, head) {
  const label = head.present ? (VERDICT_LABEL[head.verdict] ?? [head.verdict, "verdict-unknown"]) : ["无有效 head", "verdict-unknown"];
  pair(list, "是否存在（经验证）", head.present ? "是" : "否");
  pair(list, "验证结论", label[0], label[1]);
  pair(list, "sequence", head.sequence);
  pair(list, "created_at", head.created_at);
  pair(list, "checked_at", head.checked_at);
}

function renderStorage(list, storage) {
  pair(list, "对象数量", storage.object_count, storage.object_count === null ? "verdict-unknown" : undefined);
  pair(list, "密文总字节", storage.total_ciphertext_bytes, storage.total_ciphertext_bytes === null ? "verdict-unknown" : undefined);
  pair(list, "observed_at", storage.observed_at);
}

function renderTasks(container, items) {
  container.textContent = "";
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "verdict-unknown";
    empty.textContent = "进程已重启，暂无任务历史";
    container.append(empty);
    return;
  }
  for (const task of items) {
    const row = document.createElement("p");
    row.className = "task";
    row.textContent =
      (task.kind === "snapshot" ? "快照" : "恢复") + " · " +
      (task.status === "complete" ? "完成" : "失败(" + (task.error_code ?? "未知错误") + ")") +
      " · " + task.started_at + " → " + task.completed_at +
      " · " + task.duration_ms + " ms · 对象 " + task.object_count + " · 密文 " + task.total_ciphertext_bytes + " B";
    row.className += task.status === "complete" ? " verdict-ok" : " verdict-failed";
    container.append(row);
  }
}

function renderReport(list, report) {
  if (report === null) {
    pair(list, "本会话报告", "暂无（进程内尚未产生报告）", "verdict-unknown");
    return;
  }
  pair(list, "schema", report.schema_version);
  pair(list, "结论", report.verdict);
  pair(list, "created_at", report.created_at);
  pair(list, "对象数量", report.object_count);
  pair(list, "密文总字节", report.total_ciphertext_bytes);
}

async function refresh(token) {
  const notice = document.getElementById("notice");
  const response = await fetch("/api/status", { headers: { "X-Console-Session": token }, cache: "no-store" });
  if (!response.ok) {
    notice.textContent = "状态读取失败（" + response.status + "）；会话可能已失效，请刷新页面重新自举。";
    notice.classList.remove("hidden");
    return;
  }
  notice.classList.add("hidden");
  document.getElementById("content").classList.remove("hidden");
  const dto = await response.json();
  const service = document.getElementById("service");
  service.textContent = "";
  pair(service, "状态", dto.service.status, dto.service.status === "ok" ? "verdict-ok" : "verdict-failed");
  pair(service, "版本", dto.service.version);
  pair(service, "构建", dto.service.build);
  pair(service, "started_at", dto.service.started_at);
  pair(service, "运行时长（秒）", dto.service.uptime_seconds);
  renderHead(document.getElementById("head"), dto.head);
  renderStorage(document.getElementById("storage"), dto.storage);
  renderTasks(document.getElementById("tasks"), dto.tasks.items);
  renderReport(document.getElementById("report"), dto.report);
}

(async () => {
  const notice = document.getElementById("notice");
  try {
    const boot = await fetch("/bootstrap", { cache: "no-store" });
    if (!boot.ok) throw new Error("bootstrap " + boot.status);
    const body = await boot.json();
    const token = body.token;
    const button = document.createElement("button");
    button.textContent = "刷新";
    button.addEventListener("click", () => { void refresh(token); });
    document.querySelector("h1").after(button);
    await refresh(token);
  } catch (error) {
    notice.textContent = "会话自举失败；请确认服务仍在运行后刷新页面。";
    notice.classList.remove("hidden");
  }
})();
})();
`;
