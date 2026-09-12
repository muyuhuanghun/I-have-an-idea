// ADR-0030/ADR-0031 (DP-027): read-only localhost web console — gate order, session
// bootstrap, DTO whitelist, projection verdicts and the task ring. Header-sensitive
// cases use raw node:http requests because browser-side fetch cannot set Fetch
// Metadata headers and undici may drop them.
import { createHash, generateKeyPairSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHeadRecordV1, type Bytes } from "@ekd/core";
import { WebCryptoDeviceSignatureProvider } from "../../crypto/src/device-signature.js";
import { HeadDirectory, encodeHeadPointerBytes } from "../src/head-directory.js";
import {
  CONSOLE_CSS,
  CONSOLE_HTML,
  CONSOLE_JS,
  projectHeadStatus,
  projectStorageStats,
  startWebConsoleServer,
  WebConsoleTaskRing,
  type WebConsoleServerOptions,
  type WebConsoleStatusDto
} from "../src/web-console.js";
import { ConsoleAdapterError } from "../src/errors.js";

const temporaryRoots: string[] = [];
const runningServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close().catch(() => {})));
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

const DOMAIN = new Uint8Array(32).fill(0x41);
const DEVICE = new Uint8Array(16).fill(0x51);
const CHECKED_AT = "2026-09-12T00:00:00.000Z";

interface RawResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function raw(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

/** Raw-socket request for header shapes a normal client cannot produce (missing or duplicated Host). */
function rawSocket(port: number, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.end(`GET /bootstrap HTTP/1.1\r\n${payload}Connection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
      const body = data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      resolve({ status, body });
    });
    socket.on("error", reject);
  });
}

function baseSources(): Pick<WebConsoleServerOptions, "headStatus" | "storageStats" | "reportSummary" | "tasks"> {
  return {
    headStatus: async () => ({ present: false, sequence: null, created_at: null, verdict: "not_checked", checked_at: CHECKED_AT }),
    storageStats: async () => ({ object_count: 2, total_ciphertext_bytes: 100 }),
    reportSummary: async () => null,
    tasks: new WebConsoleTaskRing()
  };
}

async function startConsole(overrides: Partial<WebConsoleServerOptions> = {}): Promise<{ port: number; token: string }> {
  const running = await startWebConsoleServer({
    service: { version: "test-v1", build: "a".repeat(40) },
    ...baseSources(),
    ...overrides
  });
  runningServers.push(running);
  return { port: running.port, token: running.token };
}

function sessionHeaders(token: string): Record<string, string> {
  // A browser page would send sec-fetch-site: same-origin on this fetch.
  return { "X-Console-Session": token, "Sec-Fetch-Site": "same-origin" };
}

async function makeHeadFixture(): Promise<{ directory: HeadDirectory; signer: WebCryptoDeviceSignatureProvider; storeRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "ekd-console-"));
  temporaryRoots.push(root);
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signer = new WebCryptoDeviceSignatureProvider(new Uint8Array(pair.privateKey.export({ format: "der", type: "pkcs8" })));
  const spkiBase64url = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64url");
  const directory = new HeadDirectory(join(root, "head-dir"), {
    signPointer: async (pointer) => signer.signHead(encodeHeadPointerBytes(pointer)).then((signature) => Buffer.from(signature).toString("base64url")),
    verifier: {
      verifyHeadSignature: (signedBytes, signature, spkiBytes) => signer.verifyHeadSignature(signedBytes, signature, spkiBytes),
      verifyPointerSignature: (pointer, spkiBytes, signatureBase64url) =>
        signer.verifyHeadSignature(encodeHeadPointerBytes(pointer), new Uint8Array(Buffer.from(signatureBase64url, "base64url")), spkiBytes)
    }
  });
  await directory.ensureDirectory();
  await directory.registerDevice(DEVICE, spkiBase64url);
  // Dedicated flat object directory: a real store root contains only object files
  // (the head directory lives elsewhere), and the storage aggregate fails closed
  // on any non-file entry.
  const storeRoot = join(root, "objects");
  await mkdir(storeRoot);
  return { directory, signer, storeRoot };
}

async function publishFixture(
  directory: HeadDirectory,
  signer: WebCryptoDeviceSignatureProvider,
  storeRoot: string,
  sequence: number
): Promise<void> {
  const record = await createHeadRecordV1(
    {
      domainId: DOMAIN,
      snapshotId: new Uint8Array(32).fill(0x11),
      parentSnapshotId: new Uint8Array(32).fill(0x00),
      sequence,
      deviceId: DEVICE,
      createdAtUnix: 1_700_000_000_000 + sequence
    },
    signer
  );
  const headObjectKey = `head-object-${sequence}`;
  const store = {
    put: async (key: string, value: Bytes) => {
      await writeFile(join(storeRoot, key), value);
    },
    get: async (key: string) => {
      try {
        return new Uint8Array(await readFile(join(storeRoot, key)));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    }
  };
  await directory.publishHead(DOMAIN, record, headObjectKey, store);
}

function pointerFileName(domainId: Bytes): string {
  return `head-${createHash("sha256").update(domainId).digest("hex").slice(0, 16)}.json`;
}

function journalFileName(domainId: Bytes): string {
  return `history-${createHash("sha256").update(domainId).digest("hex").slice(0, 16)}.jsonl`;
}

const SECURITY_HEADER_SET: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
};

function expectSecurityHeaders(headers: RawResponse["headers"]): void {
  for (const [name, value] of Object.entries(SECURITY_HEADER_SET)) {
    expect(headers[name], `header ${name}`).toBe(value);
  }
}

describe("web console server (ADR-0030/0031, DP-027)", () => {
  it("serves static assets and the frozen security header set without exposing the token", async () => {
    const { port, token } = await startConsole();
    for (const path of ["/", "/app.js", "/app.css"]) {
      const response = await raw(port, path, { headers: { "Sec-Fetch-Site": "same-origin" } });
      expect(response.status).toBe(200);
      expectSecurityHeaders(response.headers);
      expect(response.body).not.toContain(token);
    }
    // /bootstrap is the one sanctioned delivery channel; its JSON body is checked below.
    const bootstrap = await raw(port, "/bootstrap", { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(bootstrap.status).toBe(200);
    expectSecurityHeaders(bootstrap.headers);
    expect(CONSOLE_HTML).toContain('/app.js');
    expect(CONSOLE_HTML).toContain('/app.css');
    expect(CONSOLE_HTML).not.toContain("<script>");
    expect(CONSOLE_HTML).not.toContain("onclick");
    expect(CONSOLE_JS).not.toContain("localStorage");
    expect(CONSOLE_CSS.length).toBeGreaterThan(0);
  });

  it("hands the capability token only through the bootstrap JSON body", async () => {
    const { port, token } = await startConsole();
    const bootstrap = await raw(port, "/bootstrap", { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(bootstrap.headers["content-type"]).toContain("application/json");
    const parsed = JSON.parse(bootstrap.body) as { token?: unknown };
    expect(parsed).toEqual({ token });
    expect(token.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url
    const second = await raw(port, "/bootstrap", { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect((JSON.parse(second.body) as { token: string }).token).toBe(token); // per-process token
  });

  it("rejects /api/status without or with a wrong token using one uniform body", async () => {
    const { port } = await startConsole();
    const missing = await raw(port, "/api/status", { headers: { "Sec-Fetch-Site": "same-origin" } });
    const wrong = await raw(port, "/api/status", { headers: sessionHeaders("wrong-token-wrong-token-wrong-token") });
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(missing.body).toBe("Forbidden.");
    expect(wrong.body).toBe(missing.body);
    expect(wrong.headers["content-type"]).toContain("text/plain");
  });

  it("serves the whitelisted DTO on /api/status and nothing else", async () => {
    const { port, token } = await startConsole();
    const response = await raw(port, "/api/status", { headers: sessionHeaders(token) });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const dto = JSON.parse(response.body) as WebConsoleStatusDto;
    expect(Object.keys(dto).sort()).toEqual(["head", "report", "schema", "service", "storage", "tasks"]);
    expect(dto.schema).toBe("p1-web-console-status-v1");
    expect(Object.keys(dto.service).sort()).toEqual(["build", "started_at", "status", "uptime_seconds", "version"]);
    expect(dto.service.build).toBe("a".repeat(40));
    expect(dto.storage).toEqual({ object_count: 2, total_ciphertext_bytes: 100, observed_at: expect.any(String) });
    expect(dto.report).toBeNull();
    expect(dto.tasks.items).toEqual([]);
    // Whitelist scan: sensitive metadata and secrets must not exist anywhere.
    const serialized = response.body;
    for (const marker of ["file_count", "total_plaintext_bytes", "domainId", "device_id", "public_key", "signature", "token"]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("rejects unknown Host values, missing and duplicated Host headers before touching sources", async () => {
    const { port } = await startConsole({
      headStatus: async () => {
        throw new Error("sources must not be reached");
      }
    });
    for (const host of ["127.0.0.1:9999", "evil.example:443", "localhost"]) {
      const response = await raw(port, "/bootstrap", { headers: { Host: host, "Sec-Fetch-Site": "none" } });
      expect(response.status, `host=${host}`).toBe(403);
      expect(response.body).toBe("Forbidden.");
    }
    // HTTP/1.1 requires a Host header: Node's parser itself answers 400 before the
    // handler runs. Parser-level and handler-level rejections are both fail-closed.
    const missing = await rawSocket(port, "Sec-Fetch-Site: none\r\n");
    expect([400, 403]).toContain(missing.status);
    const duplicated = await rawSocket(port, `Host: 127.0.0.1:${port}\r\nHost: evil.example\r\nSec-Fetch-Site: none\r\n`);
    expect([400, 403]).toContain(duplicated.status);
  });

  it("accepts sec-fetch-site same-origin/none and rejects same-site, cross-site and missing on every route", async () => {
    const { port, token } = await startConsole();
    for (const site of ["same-origin", "none"]) {
      expect((await raw(port, "/bootstrap", { headers: { "Sec-Fetch-Site": site } })).status).toBe(200);
      expect((await raw(port, "/api/status", { headers: { "Sec-Fetch-Site": site, "X-Console-Session": token } })).status).toBe(200);
    }
    for (const site of ["same-site", "cross-site", "invalid-value"]) {
      expect((await raw(port, "/bootstrap", { headers: { "Sec-Fetch-Site": site } })).status, site).toBe(403);
      expect(
        (await raw(port, "/api/status", { headers: { "Sec-Fetch-Site": site, "X-Console-Session": token } })).status,
        site
      ).toBe(403);
    }
    const missingSite = await raw(port, "/bootstrap");
    expect(missingSite.status).toBe(403);
  });

  it("answers 405 for non-GET methods and 404 for unknown paths with fixed bodies and no reflection", async () => {
    const { port, token } = await startConsole();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await raw(port, "/api/status", { method, headers: sessionHeaders(token) });
      expect(response.status, method).toBe(405);
      expect(response.body).toBe("Method not allowed.");
    }
    expect((await raw(port, "/bootstrap", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(405);
    const unknown = await raw(port, "/api/whatever?leak=TOPSECRET", { headers: sessionHeaders(token) });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe("Not found.");
    expect(unknown.body).not.toContain("TOPSECRET");
    expect(unknown.body).not.toContain("whatever");
    const status = await raw(port, `/api/status?probe=TOPSECRET`, { headers: sessionHeaders(token) });
    expect(status.body).not.toContain("TOPSECRET");
  });

  it("maps source failures to unknown/unavailable without leaking raw errors", async () => {
    const { port, token } = await startConsole({
      headStatus: async () => {
        throw new Error("raw internal detail with C:\\Users\\someone\\secret");
      },
      storageStats: async () => {
        throw new ConsoleAdapterError("CONSOLE_SOURCE_UNAVAILABLE", "storage", "store root vanished");
      },
      reportSummary: async () => {
        throw new Error("raw report failure");
      }
    });
    const response = await raw(port, "/api/status", { headers: sessionHeaders(token) });
    expect(response.status).toBe(200);
    const dto = JSON.parse(response.body) as WebConsoleStatusDto;
    expect(dto.head).toEqual({ present: false, sequence: null, created_at: null, verdict: "unknown", checked_at: expect.any(String) });
    expect(dto.storage).toEqual({ object_count: null, total_ciphertext_bytes: null, observed_at: expect.any(String) });
    expect(dto.report).toBeNull();
    expect(response.body).not.toContain("C:\\Users");
    // undefined storage source is equally unavailable
    const running2 = await startConsole({ storageStats: async () => undefined });
    const dto2 = JSON.parse((await raw(running2.port, "/api/status", { headers: sessionHeaders(running2.token) })).body) as WebConsoleStatusDto;
    expect(dto2.storage).toEqual({ object_count: null, total_ciphertext_bytes: null, observed_at: expect.any(String) });
  });

  it("lists recorded tasks newest-first with a hard capacity of 20", () => {
    const ring = new WebConsoleTaskRing();
    for (let index = 1; index <= 25; index += 1) {
      ring.record({
        kind: "snapshot",
        status: "complete",
        started_at: `2026-09-12T00:00:${String(index).padStart(2, "0")}.000Z`,
        completed_at: `2026-09-12T00:00:${String(index).padStart(2, "0")}.500Z`,
        duration_ms: 500,
        object_count: index,
        total_ciphertext_bytes: index * 10,
        error_code: null
      });
    }
    const items = ring.list();
    expect(items).toHaveLength(20);
    expect(items[0]?.object_count).toBe(25);
    expect(items[19]?.object_count).toBe(6);
    expect(items).not.toBe(ring.list()); // defensive copy
  });
});

describe("read-only projections (ADR-0030 §2.2.4/§7.0)", () => {
  it("projects a verified head from the existing primitives", async () => {
    const { directory, signer, storeRoot } = await makeHeadFixture();
    await publishFixture(directory, signer, storeRoot, 1);
    const projection = await projectHeadStatus(directory, DOMAIN, {
      get: async (key) => new Uint8Array(await readFile(join(storeRoot, key))),
      put: async () => {}
    });
    expect(projection.present).toBe(true);
    expect(projection.verdict).toBe("verified");
    expect(projection.sequence).toBe(1);
    expect(projection.created_at).toBe("2023-11-14T22:13:20.001Z");
  });

  it("reports not_checked when no head exists and signature_invalid for a missing head object", async () => {
    const { directory, storeRoot } = await makeHeadFixture();
    const absent = await projectHeadStatus(directory, DOMAIN, { get: async () => undefined, put: async () => {} });
    expect(absent.verdict).toBe("not_checked");
    expect(absent.present).toBe(false);

    const pointer = { head_object_key: "absent-key", sequence: 1, device_id: Buffer.from(DEVICE).toString("hex") };
    const signature = Buffer.from(await (async () => {
      const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const signer = new WebCryptoDeviceSignatureProvider(new Uint8Array(pair.privateKey.export({ format: "der", type: "pkcs8" })));
      return signer.signHead(encodeHeadPointerBytes(pointer));
    })()).toString("base64url");
    await writeFile(join(directory.rootPath, pointerFileName(DOMAIN)), JSON.stringify({ ...pointer, pointer_signature_base64url: signature }));
    const missingObject = await projectHeadStatus(directory, DOMAIN, { get: async () => undefined, put: async () => {} });
    expect(missingObject.verdict).toBe("signature_invalid");
    void storeRoot;
  });

  it("reports device_unregistered for a pointer signed by a stranger device", async () => {
    const { directory } = await makeHeadFixture();
    const strangerPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const strangerSigner = new WebCryptoDeviceSignatureProvider(new Uint8Array(strangerPair.privateKey.export({ format: "der", type: "pkcs8" })));
    const pointer = { head_object_key: "k", sequence: 1, device_id: "61".repeat(16) };
    const signature = Buffer.from(await strangerSigner.signHead(encodeHeadPointerBytes(pointer))).toString("base64url");
    await writeFile(join(directory.rootPath, pointerFileName(DOMAIN)), JSON.stringify({ ...pointer, pointer_signature_base64url: signature }));
    const projection = await projectHeadStatus(directory, DOMAIN, { get: async () => undefined, put: async () => {} });
    expect(projection.verdict).toBe("device_unregistered");
  });

  it("stays honest when the journal holds a higher sequence than the pointer (publish-time property)", async () => {
    // The current read primitives verify the pointer chain but do not re-check the
    // journal on read; the projection must NOT fake a rollback verdict from raw
    // files (ADR-0030 §2.2.4/§6) — it reports what was actually verified.
    const { directory, signer, storeRoot } = await makeHeadFixture();
    await publishFixture(directory, signer, storeRoot, 1);
    const journalPath = join(directory.rootPath, journalFileName(DOMAIN));
    await writeFile(journalPath, `${JSON.stringify({ head_object_key: "future", sequence: 5, device_id: "61".repeat(16) })}\n`, { encoding: "utf8", flag: "a" });
    const projection = await projectHeadStatus(directory, DOMAIN, {
      get: async (key) => new Uint8Array(await readFile(join(storeRoot, key))),
      put: async () => {}
    });
    expect(projection.verdict).toBe("verified");
    expect(projection.sequence).toBe(1);
    expect(projection.present).toBe(true);
  });

  it("aggregates storage ciphertext-side counts and fails closed on reparse points or unexpected entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "ekd-console-store-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "obj-one"), new Uint8Array(10));
    await writeFile(join(root, "obj-two"), new Uint8Array(32));
    await expect(projectStorageStats(root)).resolves.toEqual({ object_count: 2, total_ciphertext_bytes: 42 });

    await mkdir(join(root, "subdir"));
    await expect(projectStorageStats(join(root, "subdir"))).resolves.toEqual({ object_count: 0, total_ciphertext_bytes: 0 });

    const linkRoot = await mkdtemp(join(tmpdir(), "ekd-console-store-link-"));
    temporaryRoots.push(linkRoot);
    await writeFile(join(linkRoot, "real"), new Uint8Array(5));
    await symlink(join(linkRoot, "real"), join(linkRoot, "alias"));
    await expect(projectStorageStats(linkRoot)).rejects.toMatchObject({ code: "CONSOLE_SOURCE_UNAVAILABLE" });

    await expect(projectStorageStats(join(root, "does-not-exist"))).rejects.toMatchObject({
      code: "CONSOLE_SOURCE_UNAVAILABLE"
    });
  });

  it("feeds served DTOs from the projections and an empty ring on a fresh process", async () => {
    const { directory, signer, storeRoot } = await makeHeadFixture();
    await publishFixture(directory, signer, storeRoot, 3);
    const ring = new WebConsoleTaskRing();
    ring.record({
      kind: "restore",
      status: "failed",
      started_at: "2026-09-12T01:00:00.000Z",
      completed_at: "2026-09-12T01:00:02.000Z",
      duration_ms: 2000,
      object_count: 4,
      total_ciphertext_bytes: 400,
      error_code: "MISSING_OBJECT"
    });
    const { port, token } = await startConsole({
      headStatus: () =>
        projectHeadStatus(directory, DOMAIN, {
          get: async (key) => new Uint8Array(await readFile(join(storeRoot, key))),
          put: async () => {}
        }),
      storageStats: () => projectStorageStats(storeRoot),
      tasks: ring,
      reportSummary: async () => ({
        schema_version: "p0-plugin-snapshot-report-v1",
        verdict: "complete",
        created_at: "2026-09-12T01:05:00.000Z",
        object_count: 4,
        total_ciphertext_bytes: 400
      })
    });
    const dto = JSON.parse((await raw(port, "/api/status", { headers: sessionHeaders(token) })).body) as WebConsoleStatusDto;
    expect(dto.head.verdict).toBe("verified");
    expect(dto.head.sequence).toBe(3);
    expect(dto.storage).toMatchObject({ object_count: 1 });
    expect(dto.tasks.items).toHaveLength(1);
    expect(dto.tasks.items[0]).toMatchObject({ kind: "restore", status: "failed", error_code: "MISSING_OBJECT" });
    expect(dto.report).toMatchObject({ schema_version: "p0-plugin-snapshot-report-v1", object_count: 4 });
    expect(dto.service.status).toBe("ok");
  });
});
