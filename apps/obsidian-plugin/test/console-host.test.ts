// ADR-0031 §13 (DP-027 plugin-host wiring): the PluginConsoleHost wrapper — start/stop
// lifecycle, session-domain sources, and task-ring feeding. The shared server's own
// security behaviour is covered by the adapters web-console tests and WEB-ACC-44..49.
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginConsoleHost, type PluginConsoleReportSummary } from "../src/console-host.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

function hit(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

function makeHost(overrides: Partial<ConstructorParameters<typeof PluginConsoleHost>[0]> = {}): PluginConsoleHost {
  return new PluginConsoleHost({
    version: "p1-console-v1",
    build: async () => "b".repeat(40),
    objectStorePath: () => undefined,
    ...overrides
  });
}

const REPORT: PluginConsoleReportSummary = {
  schema_version: "p0-plugin-snapshot-report-v1",
  verdict: "pass",
  created_at: "2026-09-12T10:00:05.000Z",
  object_count: 4,
  total_ciphertext_bytes: 661
};

describe("PluginConsoleHost (ADR-0031 §13)", () => {
  it("starts on loopback, serves the session sources and reports an honest not_checked head", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "ekd-plugin-console-"));
    temporaryRoots.push(storeRoot);
    await writeFile(join(storeRoot, "obj-one"), new Uint8Array(30));
    await writeFile(join(storeRoot, "obj-two"), new Uint8Array(12));
    const host = makeHost({ objectStorePath: () => storeRoot });
    expect(host.running).toBe(false);
    const url = await host.start();
    expect(host.running).toBe(true);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const port = Number(/:(\d+)\//.exec(url)?.[1]);

    const boot = await hit(port, "/bootstrap", { "Sec-Fetch-Site": "none" });
    expect(boot.status).toBe(200);
    const token = (JSON.parse(boot.body) as { token: string }).token;
    const status = JSON.parse(
      (await hit(port, "/api/status", { "Sec-Fetch-Site": "same-origin", "X-Console-Session": token })).body
    ) as {
      service: { build: string };
      head: { present: boolean; verdict: string };
      storage: { object_count: number; total_ciphertext_bytes: number };
      report: unknown;
      tasks: { items: unknown[] };
    };
    expect(status.service.build).toBe("b".repeat(40));
    expect(status.head).toMatchObject({ present: false, verdict: "not_checked" });
    expect(status.storage).toMatchObject({ object_count: 2, total_ciphertext_bytes: 42 });
    expect(status.report).toBeNull();
    expect(status.tasks.items).toEqual([]);

    // Restart is idempotent while running; stop really closes the server.
    expect(await host.start()).toBe(url);
    await host.stop();
    expect(host.running).toBe(false);
    await expect(hit(port, "/bootstrap", { "Sec-Fetch-Site": "none" })).rejects.toThrow();
  });

  it("maps unconfigured or broken store paths to unavailable, never to zero", async () => {
    const host = makeHost({ objectStorePath: () => undefined });
    const url = await host.start();
    const port = Number(/:(\d+)\//.exec(url)?.[1]);
    const boot = await hit(port, "/bootstrap", { "Sec-Fetch-Site": "none" });
    const token = (JSON.parse(boot.body) as { token: string }).token;
    const status = JSON.parse(
      (await hit(port, "/api/status", { "Sec-Fetch-Site": "same-origin", "X-Console-Session": token })).body
    ) as { storage: { object_count: number | null } };
    expect(status.storage.object_count).toBeNull();
    await host.stop();
  });

  it("feeds the task ring and report summary from snapshot outcomes", async () => {
    const host = makeHost();
    const url = await host.start();
    const port = Number(/:(\d+)\//.exec(url)?.[1]);
    host.recordSnapshotSuccess(REPORT, "2026-09-12T10:00:00.000Z", 5000);
    host.recordSnapshotFailure("LOG_WRITE_FAILED", "2026-09-12T10:05:00.000Z", "2026-09-12T10:05:01.000Z", 1000);

    const boot = await hit(port, "/bootstrap", { "Sec-Fetch-Site": "none" });
    const token = (JSON.parse(boot.body) as { token: string }).token;
    const status = JSON.parse(
      (await hit(port, "/api/status", { "Sec-Fetch-Site": "same-origin", "X-Console-Session": token })).body
    ) as {
      report: { schema_version: string; verdict: string; object_count: number } | null;
      tasks: { items: Array<{ status: string; error_code: string | null; object_count: number }> };
    };
    expect(status.report).toMatchObject({ schema_version: "p0-plugin-snapshot-report-v1", verdict: "pass", object_count: 4 });
    expect(status.tasks.items).toHaveLength(2);
    expect(status.tasks.items[0]).toMatchObject({ status: "failed", error_code: "LOG_WRITE_FAILED", object_count: 0 });
    expect(status.tasks.items[1]).toMatchObject({ status: "complete", object_count: 4, total_ciphertext_bytes: 661 });
    // Nothing outside the whitelist leaks through the plugin wiring either.
    expect(JSON.stringify(status)).not.toContain("file_count");
    expect(JSON.stringify(status)).not.toContain("total_plaintext_bytes");
    await host.stop();
  });

  it("keeps the ring capped at 20 entries across many runs", async () => {
    const host = makeHost();
    for (let index = 0; index < 25; index += 1) {
      host.recordSnapshotSuccess({ ...REPORT, created_at: `2026-09-12T00:${String(index % 60).padStart(2, "0")}:00.000Z` }, "2026-09-12T00:00:00.000Z", index);
    }
    const started = await host.start();
    const port = Number(/:(\d+)\//.exec(started)?.[1]);
    const boot = await hit(port, "/bootstrap", { "Sec-Fetch-Site": "none" });
    const token = (JSON.parse(boot.body) as { token: string }).token;
    const status = JSON.parse(
      (await hit(port, "/api/status", { "Sec-Fetch-Site": "same-origin", "X-Console-Session": token })).body
    ) as { tasks: { items: unknown[] } };
    expect(status.tasks.items).toHaveLength(20);
    await host.stop();
  });

  it("creates its own store fixture layout without escaping the temp root", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "ekd-plugin-console-mkdir-"));
    temporaryRoots.push(storeRoot);
    await mkdir(join(storeRoot, "nested"), { recursive: true });
    const host = makeHost({ objectStorePath: () => join(storeRoot, "nested") });
    const url = await host.start();
    const port = Number(/:(\d+)\//.exec(url)?.[1]);
    const boot = await hit(port, "/bootstrap", { "Sec-Fetch-Site": "none" });
    const token = (JSON.parse(boot.body) as { token: string }).token;
    const status = JSON.parse(
      (await hit(port, "/api/status", { "Sec-Fetch-Site": "same-origin", "X-Console-Session": token })).body
    ) as { storage: { object_count: number } };
    expect(status.storage.object_count).toBe(0); // an empty real directory is a truthful 0
    await host.stop();
  });
});
