import { encodeObjectStoreKeyV1 } from "@ekd/core";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectoryObjectStoreV1, ObjectStoreAdapterError } from "../src/index.js";

const KEY = encodeObjectStoreKeyV1(Uint8Array.from({ length: 16 }, (_value, index) => index));
const OTHER_KEY = encodeObjectStoreKeyV1(new Uint8Array(16).fill(1));
const CASE_VARIANT_KEY = `a${KEY.slice(1)}`;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

async function makeStoreRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "ekd-object-store-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

async function rejectionCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ObjectStoreAdapterError) return error.code;
    throw error;
  }
  throw new Error("Expected the ObjectStore operation to fail.");
}

/** Returns false when the platform refuses to create the link (e.g. unprivileged Windows symlinks). */
async function createReparseLink(linkPath: string, targetPath: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await symlink(targetPath, linkPath, "junction");
    } else {
      await symlink(targetPath, linkPath, "dir");
    }
    return true;
  } catch {
    return false;
  }
}

describe("DirectoryObjectStoreV1 keys and containment", () => {
  it("rejects non-canonical keys on both put and get without touching the filesystem", async () => {
    const store = new DirectoryObjectStoreV1(await makeStoreRoot());
    const invalidKeys = [
      "AAECAwQFBgcICQoLDA0ODw==",
      "AAECAwQFBgcICQoLDA0OD",
      "AAECAwQFBgcICQoLDA0ODwX",
      "AAECAwQFBgcICQoLDA0ODx",
      "AAAAAAAAAAAAAAAAAAAAA/",
      "../../etc-passwd"
    ];
    for (const key of invalidKeys) {
      expect(await rejectionCode(() => store.put(key, new Uint8Array([1])))).toBe("OBJECT_ID_INVALID");
      expect(await rejectionCode(() => store.get(key))).toBe("OBJECT_ID_INVALID");
    }
  });

  it("keeps case-only-different keys from overwriting each other on case-insensitive filesystems", async () => {
    const store = new DirectoryObjectStoreV1(await makeStoreRoot());
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    await store.put(KEY, first);
    if (process.platform === "win32") {
      expect(await rejectionCode(() => store.put(CASE_VARIANT_KEY, second))).toBe("OBJECT_ID_COLLISION");
      expect(await store.get(KEY)).toEqual(first);
    } else {
      await store.put(CASE_VARIANT_KEY, second);
      expect(await store.get(KEY)).toEqual(first);
      expect(await store.get(CASE_VARIANT_KEY)).toEqual(second);
    }
  });
});

describe("DirectoryObjectStoreV1 immutable roundtrip", () => {
  it("roundtrips bytes, reads idempotently, returns independent buffers, and reports absent keys as undefined", async () => {
    const store = new DirectoryObjectStoreV1(await makeStoreRoot());
    const value = new Uint8Array([1, 2, 3]);
    await store.put(KEY, value);
    expect(await store.get(KEY)).toEqual(value);
    expect(await store.get(KEY)).toEqual(value);
    expect(await store.get(OTHER_KEY)).toBeUndefined();
    await store.put(OTHER_KEY, new Uint8Array());
    expect(await store.get(OTHER_KEY)).toEqual(new Uint8Array());
    const returned = await store.get(KEY);
    expect(returned).not.toBe(value);
  });

  it("never overwrites a published object and returns OBJECT_ID_COLLISION instead", async () => {
    const rootPath = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(rootPath);
    const first = new Uint8Array([1, 1]);
    const second = new Uint8Array([2, 2]);
    await store.put(KEY, first);
    expect(await rejectionCode(() => store.put(KEY, second))).toBe("OBJECT_ID_COLLISION");
    expect(await store.get(KEY)).toEqual(first);
    expect(await readdir(rootPath)).toEqual([KEY]);
  });

  it("serializes same-process writes so the first put wins and later ones collide", async () => {
    const store = new DirectoryObjectStoreV1(await makeStoreRoot());
    const first = new Uint8Array([3]);
    const second = new Uint8Array([4]);
    const results = await Promise.allSettled([store.put(KEY, first), store.put(KEY, second)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    const rejection = results[1] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(ObjectStoreAdapterError);
    expect((rejection.reason as ObjectStoreAdapterError).code).toBe("OBJECT_ID_COLLISION");
    expect(await store.get(KEY)).toEqual(first);
  });

  it("keeps published bytes readable from a fresh instance after the writing handle is gone", async () => {
    const rootPath = await makeStoreRoot();
    const writer = new DirectoryObjectStoreV1(rootPath);
    const value = new Uint8Array([5, 6, 7]);
    await writer.put(KEY, value);
    const reader = new DirectoryObjectStoreV1(rootPath);
    expect(await reader.get(KEY)).toEqual(value);
  });
});

describe("DirectoryObjectStoreV1 atomic publish and cleanup", () => {
  it("removes a stale temp file during publish and leaves only the canonical key behind", async () => {
    const rootPath = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(rootPath);
    const value = new Uint8Array([8, 8]);
    await writeFile(join(rootPath, `${KEY}.tmp`), new Uint8Array([7, 7, 7]));
    await store.put(KEY, value);
    expect(await store.get(KEY)).toEqual(value);
    expect(await readdir(rootPath)).toEqual([KEY]);
  });

  it("treats a directory occupying a key as a collision on put and a normalized failure on get", async () => {
    const rootPath = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(rootPath);
    await mkdir(join(rootPath, KEY));
    expect(await rejectionCode(() => store.put(KEY, new Uint8Array([1])))).toBe("OBJECT_ID_COLLISION");
    expect(await rejectionCode(() => store.get(KEY))).toBe("OBJECT_STORE_IO_FAILED");
  });

  it("refuses to operate when the root is missing or a plain file", async () => {
    const missingRoot = join(await makeStoreRoot(), "absent");
    const missingStore = new DirectoryObjectStoreV1(missingRoot);
    expect(await rejectionCode(() => missingStore.put(KEY, new Uint8Array([1])))).toBe("OBJECT_STORE_IO_FAILED");
    expect(await rejectionCode(() => missingStore.get(KEY))).toBe("OBJECT_STORE_IO_FAILED");

    const filePath = join(await makeStoreRoot(), "plain-file");
    await writeFile(filePath, new Uint8Array([1]));
    const fileStore = new DirectoryObjectStoreV1(filePath);
    expect(await rejectionCode(() => fileStore.put(KEY, new Uint8Array([1])))).toBe("OBJECT_STORE_IO_FAILED");
    expect(await rejectionCode(() => fileStore.get(KEY))).toBe("OBJECT_STORE_IO_FAILED");
  });
});

describe("DirectoryObjectStoreV1 reparse point rejection", () => {
  it("rejects a store root that is a symbolic link or junction", async () => {
    const outerRoot = await makeStoreRoot();
    const realRoot = join(outerRoot, "real-root");
    await mkdir(realRoot);
    const linkPath = join(outerRoot, "link-root");
    if (!(await createReparseLink(linkPath, realRoot))) return;
    const store = new DirectoryObjectStoreV1(linkPath);
    expect(await rejectionCode(() => store.put(KEY, new Uint8Array([1])))).toBe("REPARSE_POINT_FOUND");
    expect(await rejectionCode(() => store.get(KEY))).toBe("REPARSE_POINT_FOUND");
  });

  it("rejects a reparse point occupying a key without following or replacing it", async () => {
    const rootPath = await makeStoreRoot();
    const store = new DirectoryObjectStoreV1(rootPath);
    const targetDirectory = join(rootPath, "outside-target");
    await mkdir(targetDirectory);
    if (!(await createReparseLink(join(rootPath, KEY), targetDirectory))) return;
    expect(await rejectionCode(() => store.get(KEY))).toBe("REPARSE_POINT_FOUND");
    expect(await rejectionCode(() => store.put(KEY, new Uint8Array([1])))).toBe("REPARSE_POINT_FOUND");
    expect(await readdir(targetDirectory)).toEqual([]);
  });
});
