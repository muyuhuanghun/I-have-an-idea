// ADR-0024 (Phase 7-A): localhost HTTP ObjectStore. The server mirrors Directory
// ObjectStore v1 semantics over node:http (127.0.0.1 bind, per-run bearer token,
// 2 MiB object cap) and reuses a DirectoryObjectStoreV1 as its storage backend; the
// client implements the EXISTING core `ObjectStore` port, so snapshot/restore cores
// stay untouched (§18: needing a core change would mean the port boundary failed).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeObjectStoreKeyV1 } from "@ekd/core";
import type { Bytes, ObjectStore } from "@ekd/core";
import { ObjectStoreAdapterError } from "./errors.js";
import type { DirectoryObjectStoreV1 } from "./node-object-store.js";

export const DEFAULT_MAX_OBJECT_BYTES = 2 * 1024 * 1024;

function canonicalKey(key: string): string {
  try {
    decodeObjectStoreKeyV1(key);
  } catch (error) {
    throw new ObjectStoreAdapterError(
      "OBJECT_ID_INVALID",
      key,
      "ObjectStore key must be the canonical 22-character base64url encoding of a 16-byte object ID.",
      { cause: error }
    );
  }
  return key;
}

function ioFailed(key: string, message: string, cause?: unknown): ObjectStoreAdapterError {
  return new ObjectStoreAdapterError("OBJECT_STORE_IO_FAILED", key, message, cause === undefined ? undefined : { cause });
}

function bytesEqual(left: Bytes, right: Bytes): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface HttpObjectStoreServerOptions {
  /** Backend directory store (§18: the directory backend is reused, not reimplemented). */
  readonly store: DirectoryObjectStoreV1;
  readonly host?: string;
  readonly port?: number;
  readonly maxObjectBytes?: number;
  /** When set, the per-run bearer token is written here with 0600 permissions. */
  readonly tokenFilePath?: string;
  /** Sanitized access log (method/key/size/status/duration). Never receives the token. */
  readonly log?: (line: string) => void;
  /** Test-only hook: may delay, throw, or destroy `request.socket` before handling. */
  readonly faultInjector?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

export interface RunningHttpObjectStoreServer {
  readonly port: number;
  readonly token: string;
  readonly close: () => Promise<void>;
}

function respond(response: ServerResponse, status: number, body?: Bytes): void {
  response.statusCode = status;
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}

function tokensMatch(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const expectedBytes = Buffer.from(`Bearer ${expected}`, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  return expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes);
}

export async function startHttpObjectStoreServer(options: HttpObjectStoreServerOptions): Promise<RunningHttpObjectStoreServer> {
  const host = options.host ?? "127.0.0.1";
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  const token = randomBytes(32).toString("base64url");
  if (options.tokenFilePath !== undefined) {
    await mkdir(dirname(options.tokenFilePath), { recursive: true });
    await writeFile(options.tokenFilePath, token, { encoding: "utf8", mode: 0o600 });
  }
  const log = options.log ?? (() => {});

  const server: Server = createServer((request, response) => {
    const startedAt = Date.now();
    const finish = (status: number, bytes: number, body?: Bytes): void => {
      log(`${request.method ?? "-"} ${request.url ?? "-"} status=${status} bytes=${bytes} duration_ms=${Date.now() - startedAt}`);
      respond(response, status, body);
    };
    void (async () => {
      if (options.faultInjector !== undefined) await options.faultInjector(request, response);
      if (response.writableEnded) return;
      if (!tokensMatch(token, request.headers.authorization)) {
        finish(401, 0);
        return;
      }
      const match = /^\/objects\/([A-Za-z0-9_-]{22})$/.exec(new URL(request.url ?? "/", "http://localhost").pathname);
      if (match === null) {
        finish(400, 0);
        return;
      }
      const key = match[1];
      if (key === undefined) {
        finish(400, 0);
        return;
      }
      try {
        canonicalKey(key);
      } catch {
        finish(400, 0);
        return;
      }

      if (request.method === "PUT") {
        const chunks: Buffer[] = [];
        let received = 0;
        let tooLarge = false;
        request.on("data", (chunk: Buffer) => {
          if (tooLarge) return;
          received += chunk.byteLength;
          if (received > maxObjectBytes) {
            tooLarge = true;
            // Respond first and drain the remainder (never destroy mid-response, or the
            // client would see a connection error instead of the frozen 413 semantics).
            finish(413, 0);
            request.resume();
            return;
          }
          chunks.push(chunk);
        });
        request.on("error", () => {
          if (!response.writableEnded) finish(400, 0);
        });
        request.on("end", async () => {
          if (tooLarge || response.writableEnded) return;
          const body = new Uint8Array(Buffer.concat(chunks));
          try {
            const existing = await options.store.get(key);
            if (existing !== undefined) {
              // Immutable objects: the same content re-published is an idempotent no-op.
              finish(bytesEqual(existing, body) ? 200 : 409, body.byteLength);
              return;
            }
            await options.store.put(key, body);
            finish(201, body.byteLength);
          } catch (error) {
            if (error instanceof ObjectStoreAdapterError && error.code === "OBJECT_ID_COLLISION") {
              // Concurrent same-content publishers race the get/put window: re-read and
              // compare so identical content still converges idempotently (ADR-0024 §2.2).
              const winner = await options.store.get(key);
              finish(winner !== undefined && bytesEqual(winner, body) ? 200 : 409, body.byteLength);
              return;
            }
            finish(500, 0);
          }
        });
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        try {
          const existing = await options.store.get(key);
          if (existing === undefined) {
            finish(404, 0);
            return;
          }
          if (request.method === "HEAD") {
            response.statusCode = 200;
            response.setHeader("Content-Length", String(existing.byteLength));
            response.end();
            log(`${request.method} ${request.url ?? "-"} status=200 bytes=${existing.byteLength} duration_ms=${Date.now() - startedAt}`);
            return;
          }
          finish(200, existing.byteLength, existing);
        } catch {
          finish(500, 0);
        }
        return;
      }

      finish(405, 0);
    })().catch(() => {
      if (!response.writableEnded) finish(500, 0);
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port ?? 0, host, () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw ioFailed(".", "HTTP ObjectStore server did not report a port.");
  return {
    port: address.port,
    token,
    close: async () => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface HttpClientObjectStoreOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Implements the EXISTING core ObjectStore port over ADR-0024 localhost HTTP semantics. */
export class HttpClientObjectStore implements ObjectStore {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof fetch;

  constructor(options: HttpClientObjectStoreOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async put(key: string, value: Bytes): Promise<void> {
    canonicalKey(key);
    const response = await this.#request(key, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(value) });
    if (response.status === 409) {
      throw new ObjectStoreAdapterError("OBJECT_ID_COLLISION", key, "HTTP ObjectStore already holds this key with different content.");
    }
    if (response.status === 413) {
      throw ioFailed(key, "Object exceeds the frozen HTTP ObjectStore size cap.");
    }
    if (response.status !== 200 && response.status !== 201) {
      throw ioFailed(key, `HTTP ObjectStore PUT failed with status ${response.status}.`);
    }
  }

  async get(key: string): Promise<Bytes | undefined> {
    canonicalKey(key);
    const response = await this.#request(key, { method: "GET" });
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw ioFailed(key, `HTTP ObjectStore GET failed with status ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Existence check at the adapter layer (HEAD); the core port intentionally stays put/get. */
  async exists(key: string): Promise<boolean> {
    canonicalKey(key);
    const response = await this.#request(key, { method: "HEAD" });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw ioFailed(key, `HTTP ObjectStore HEAD failed with status ${response.status}.`);
  }

  async #request(key: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetchImpl(`${this.#baseUrl}/objects/${key}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.#token}` },
        signal: controller.signal
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? `timed out after ${this.#timeoutMs}ms` : "connection failed";
      throw ioFailed(key, `HTTP ObjectStore request ${reason}.`, error);
    } finally {
      clearTimeout(timer);
    }
  }
}
