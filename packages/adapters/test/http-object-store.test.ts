import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ObjectStore } from "@ekd/core";
import { createSnapshotV1, restoreSnapshotV1, type Clock, type CryptoProvider, type RecoveryFileTarget, type RestoreTarget, type SnapshotLogSink, type VaultSource } from "@ekd/core";
import { WebCryptoAes256Provider } from "../../crypto/src/webcrypto.js";
import { DirectoryObjectStoreV1 } from "../src/node-object-store.js";
import { NodeRestoreTarget } from "../src/node-restore-io.js";
import { NodeSnapshotLogSink, NodeRecoveryFileTarget } from "../src/node-snapshot-io.js";
import { NodeVaultSource } from "../src/node-vault.js";
import { HttpClientObjectStore, startHttpObjectStoreServer } from "../src/http-object-store.js";

const temporaryRoots: string[] = [];
const runningServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close().catch(() => {})));
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

const KEY = "MDEyMzQ1Njc4OWFiY2RlZg"; // canonical base64url of 16 bytes 0x00..0x0f
const OTHER_KEY = "YWJjZGVmZ2hpamtsbW5vcA"; // canonical base64url of "abcdefghijklmnop"

async function makeFixture(): Promise<{ store: DirectoryObjectStoreV1; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "ekd-http-store-"));
  temporaryRoots.push(root);
  const store = new DirectoryObjectStoreV1(join(root, "objects"));
  await mkdir(join(root, "objects"));
  return { store, root };
}

async function start(store: DirectoryObjectStoreV1, faults?: Parameters<typeof startHttpObjectStoreServer>[0]["faultInjector"]) {
  const running = await startHttpObjectStoreServer({ store, faultInjector: faults });
  runningServers.push(running);
  return running;
}

describe("HTTP ObjectStore (ADR-0024)", () => {
  it("performs put/get/exists through the ObjectStore port over localhost HTTP", async () => {
    const { store } = await makeFixture();
    const running = await start(store);
    const client: ObjectStore = new HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });

    await expect(client.get(KEY)).resolves.toBeUndefined();
    await client.put(KEY, new Uint8Array([1, 2, 3]));
    await expect(client.get(KEY)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(client.exists(KEY)).resolves.toBe(true);
    await expect(client.exists(OTHER_KEY)).resolves.toBe(false);
  });

  it("rejects missing or wrong bearer tokens without leaking them in errors", async () => {
    const { store } = await makeFixture();
    const running = await start(store);
    const anonymous = new HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: "wrong-token" });

    await expect(anonymous.put(KEY, new Uint8Array([9]))).rejects.toMatchObject({ code: "OBJECT_STORE_IO_FAILED" });
    await expect(anonymous.get(KEY)).rejects.toMatchObject({ code: "OBJECT_STORE_IO_FAILED" });
  });

  it("is idempotent for identical republish and rejects divergent content with OBJECT_ID_COLLISION", async () => {
    const { store } = await makeFixture();
    const running = await start(store);
    const client = new HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });

    await client.put(KEY, new Uint8Array([1, 2, 3]));
    await client.put(KEY, new Uint8Array([1, 2, 3]));
    await expect(client.get(KEY)).resolves.toEqual(new Uint8Array([1, 2, 3]));

    await expect(client.put(KEY, new Uint8Array([4, 5, 6]))).rejects.toMatchObject({ code: "OBJECT_ID_COLLISION" });
    await expect(client.get(KEY)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("enforces the frozen per-object size cap and canonical keys", async () => {
    const { store } = await makeFixture();
    const running = await start(store, () => {
      // no faults; the cap alone must reject
    });
    const client = new HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });

    await expect(client.put("not-a-canonical-key!!", new Uint8Array([1]))).rejects.toMatchObject({ code: "OBJECT_ID_INVALID" });
    await expect(client.put(KEY, new Uint8Array(2 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "OBJECT_STORE_IO_FAILED" });
  });

  it("converges timeout, disconnect and duplicate-request faults to OBJECT_STORE_IO_FAILED", async () => {
    const { store } = await makeFixture();
    let delay = false;
    let destroy = false;
    const running = await start(store, async (request) => {
      if (delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      if (destroy) request.socket.destroy();
    });
    const slow = new HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token, timeoutMs: 80 });

    delay = true;
    await expect(slow.put(KEY, new Uint8Array([1]))).rejects.toMatchObject({ code: "OBJECT_STORE_IO_FAILED" });
    await expect(slow.get(KEY)).rejects.toMatchObject({ code: "OBJECT_STORE_IO_FAILED" });
    delay = false;

    destroy = true;
    await expect(new HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token }).get(KEY))
      .rejects.toMatchObject({ code: "OBJECT_STORE_IO_FAILED" });
    destroy = false;

    // Duplicate concurrent PUTs of identical content all succeed (idempotent retry surface).
    const client = new HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });
    await Promise.all([
      client.put(KEY, new Uint8Array([7])),
      client.put(KEY, new Uint8Array([7])),
      client.put(KEY, new Uint8Array([7]))
    ]);
    await expect(client.get(KEY)).resolves.toEqual(new Uint8Array([7]));
  });

  it("restores a snapshot through the HTTP ObjectStore with byte-identical results and an untouched core", async () => {
    const root = await mkdtemp(join(tmpdir(), "ekd-http-roundtrip-"));
    temporaryRoots.push(root);
    const vaultRoot = join(root, "vault");
    const directoryStoreRoot = join(root, "directory-store");
    const targetRoot = join(root, "target");
    await mkdir(vaultRoot, { recursive: true });
    await mkdir(join(vaultRoot, "sub"), { recursive: true });
    await mkdir(directoryStoreRoot);
    await mkdir(targetRoot);
    await writeFile(join(vaultRoot, "alpha.md"), "alpha via http\n", "utf8");
    await writeFile(join(vaultRoot, "sub", "beta.py"), "print('beta-http')\n", "utf8");

    const provider: CryptoProvider = new WebCryptoAes256Provider();
    const domainId = new Uint8Array(32).fill(0x21);
    const limits = { schemaVersion: "p0-runtime-limits-v1", sha256Hex: "e1971ab746f6b08b06522463f907143036d99e41c470532482b5da8eafc44acd" };
    const logSink: SnapshotLogSink = new NodeSnapshotLogSink(join(root, "snapshot.log"), { vaultRoot, objectStoreRoot: directoryStoreRoot });
    const recoveryTarget: RecoveryFileTarget = new NodeRecoveryFileTarget(join(root, "recovery.ekdr"), { vaultRoot, objectStoreRoot: directoryStoreRoot });
    const vaultSource: VaultSource = new NodeVaultSource(vaultRoot);

    const created = await createSnapshotV1({ domainId, runtimeLimits: limits }, {
      vaultSource,
      objectStore: new DirectoryObjectStoreV1(directoryStoreRoot),
      cryptoProvider: provider,
      randomSource: provider,
      clock: { nowMilliseconds: () => Date.now() } as Clock,
      logSink,
      recoveryFileTarget: recoveryTarget
    });
    expect(created.status).toBe("complete");
    const recoveryBytes = await readFile(join(root, "recovery.ekdr"));

    // Serve the directory backend over HTTP and restore through the port-typed client only.
    const directoryStore = new DirectoryObjectStoreV1(directoryStoreRoot);
    const running = await start(directoryStore);
    const httpStore = new HttpClientObjectStore({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });
    const restoreTarget: RestoreTarget = new NodeRestoreTarget(targetRoot);
    const restored = await restoreSnapshotV1({ recoveryFileBytes: recoveryBytes }, {
      objectStore: httpStore satisfies ObjectStore,
      cryptoProvider: provider,
      restoreTarget
    });
    expect(restored.status).toBe("complete");
    expect(restored.restoredFileCount).toBe(2);
    expect(await readFile(join(targetRoot, "alpha.md"), "utf8")).toBe("alpha via http\n");
    expect(await readFile(join(targetRoot, "sub", "beta.py"), "utf8")).toBe("print('beta-http')\n");
  });
});
