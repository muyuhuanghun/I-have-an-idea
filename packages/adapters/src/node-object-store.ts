import { decodeObjectStoreKeyV1 } from "@ekd/core";
import type { Bytes, ObjectStore } from "@ekd/core";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ObjectStoreAdapterError } from "./errors.js";

function errnoOf(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function isEnoent(error: unknown): boolean {
  return errnoOf(error) === "ENOENT";
}

function ioFailed(key: string, message: string, cause: unknown): ObjectStoreAdapterError {
  return new ObjectStoreAdapterError("OBJECT_STORE_IO_FAILED", key, message, { cause });
}

/** ADR-0015 §2: every key must survive the shared core's canonical 22-character base64url check. */
function canonicalStoreKey(key: string): string {
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

/**
 * ADR-0015 Directory ObjectStore v1 for Node: one flat directory of immutable objects whose
 * filenames are canonical ObjectStore keys. Publication is fsync-then-atomic-hard-link, so
 * readers only ever observe a complete object or its absence.
 */
export class DirectoryObjectStoreV1 implements ObjectStore {
  readonly rootPath: string;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  async put(key: string, value: Bytes): Promise<void> {
    const canonicalKey = canonicalStoreKey(key);
    await this.#enqueue(canonicalKey, () => this.#put(canonicalKey, value));
  }

  async get(key: string): Promise<Bytes | undefined> {
    const canonicalKey = canonicalStoreKey(key);
    return this.#enqueue(canonicalKey, () => this.#get(canonicalKey));
  }

  /** Serialize same-key operations within this instance; first writer wins, later ones collide. */
  #enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => {
        if (this.#chains.get(key) === tail) this.#chains.delete(key);
      },
      () => {
        if (this.#chains.get(key) === tail) this.#chains.delete(key);
      }
    );
    this.#chains.set(key, tail);
    return run;
  }

  /** ADR-0015 §2.3: root must exist, be a real directory, and not be a reparse point. */
  async #requireStoreRoot(key: string): Promise<string> {
    let rootStats: Stats;
    try {
      rootStats = await lstat(this.rootPath);
    } catch (error) {
      throw ioFailed(".", "Store root is unavailable.", error);
    }
    if (rootStats.isSymbolicLink()) {
      throw new ObjectStoreAdapterError(
        "REPARSE_POINT_FOUND",
        ".",
        "Store root must be a real directory, not a symbolic link or junction."
      );
    }
    if (!rootStats.isDirectory()) {
      throw ioFailed(".", "Store root is not a directory.", new Error(`Not a directory: ${this.rootPath}`));
    }
    return join(this.rootPath, key);
  }

  /** ADR-0015 §5: existing entries are inspected without following reparse points. */
  async #inspectEntry(key: string, target: string): Promise<Stats | undefined> {
    let stats: Stats;
    try {
      stats = await lstat(target);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw ioFailed(key, "Store entry state could not be inspected.", error);
    }
    if (stats.isSymbolicLink()) {
      throw new ObjectStoreAdapterError(
        "REPARSE_POINT_FOUND",
        key,
        "Store entry is a symbolic link or junction; reparse points are never followed."
      );
    }
    return stats;
  }

  async #put(key: string, value: Bytes): Promise<void> {
    const target = await this.#requireStoreRoot(key);
    if ((await this.#inspectEntry(key, target)) !== undefined) {
      throw new ObjectStoreAdapterError(
        "OBJECT_ID_COLLISION",
        key,
        "ObjectStore already contains this key; immutable objects are never overwritten."
      );
    }

    const tempPath = `${target}.tmp`;
    try {
      await unlink(tempPath);
    } catch (error) {
      if (!isEnoent(error)) throw ioFailed(key, "Stale temp file could not be removed.", error);
    }

    let tempCreated = false;
    let publishFailure: { readonly error: unknown } | undefined;
    try {
      let handle: FileHandle;
      try {
        handle = await open(tempPath, "wx", 0o600);
      } catch (error) {
        throw ioFailed(key, "Temp file could not be created exclusively.", error);
      }
      tempCreated = true;
      try {
        try {
          await handle.writeFile(value);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        throw ioFailed(key, "Temp file could not be written and synced.", error);
      }
      try {
        await link(tempPath, target);
      } catch (error) {
        if (errnoOf(error) === "EEXIST") {
          throw new ObjectStoreAdapterError(
            "OBJECT_ID_COLLISION",
            key,
            "ObjectStore already contains this key; immutable objects are never overwritten."
          );
        }
        throw ioFailed(key, "Atomic publish via hard link failed.", error);
      }
    } catch (error) {
      publishFailure = { error };
    }
    if (tempCreated) {
      try {
        await unlink(tempPath);
      } catch (error) {
        if (!isEnoent(error)) throw ioFailed(key, "Temp file could not be removed.", error);
      }
    }
    if (publishFailure !== undefined) throw publishFailure.error;

    try {
      await this.#syncStoreRoot();
    } catch (error) {
      throw ioFailed(
        key,
        "Directory durability sync failed after publish; the object remains published and complete.",
        error
      );
    }
  }

  async #get(key: string): Promise<Bytes | undefined> {
    const target = await this.#requireStoreRoot(key);
    const stats = await this.#inspectEntry(key, target);
    if (stats === undefined) return undefined;
    if (!stats.isFile()) {
      throw ioFailed(key, "Store entry is not a regular file.", new Error(`Not a regular file: ${target}`));
    }
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw ioFailed(key, "Store entry could not be read.", error);
    }
  }

  /** ADR-0015 §7: POSIX requires a directory fsync after publish; Windows cannot fsync a directory handle. */
  async #syncStoreRoot(): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(this.rootPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
