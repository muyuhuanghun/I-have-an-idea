import type { VaultEntry, VaultSource } from "@ekd/core";
import { VaultAdapterError } from "./errors.js";

export interface ObsidianFileStatLike {
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
}

export interface ObsidianFileLike {
  readonly path: string;
  readonly stat: ObsidianFileStatLike;
}

/** Narrow shape needed from Obsidian, kept local so core never imports the Obsidian API. */
export interface ObsidianVaultLike {
  readonly getFiles: () => readonly ObsidianFileLike[];
  readonly getAbstractFileByPath: (path: string) => unknown;
  readonly readBinary: (file: ObsidianFileLike) => Promise<ArrayBuffer>;
}

export interface ObsidianVaultSourceOptions {
  /** Optional desktop filesystem check used to reject links/special entries without coupling to Node. */
  readonly validatePath?: (relativePath: string) => Promise<void>;
}

interface FileStamp {
  readonly path: string;
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
}

function stampOf(file: ObsidianFileLike): FileStamp {
  const { ctime, mtime, size } = file.stat;
  if (
    typeof file.path !== "string" ||
    !Number.isSafeInteger(ctime) || ctime < 0 ||
    !Number.isSafeInteger(mtime) || mtime < 0 ||
    !Number.isSafeInteger(size) || size < 0
  ) {
    throw new VaultAdapterError(
      "SOURCE_FILE_READ_FAILED",
      typeof file.path === "string" ? file.path : ".",
      "Obsidian returned invalid file metadata."
    );
  }
  return { path: file.path, ctime, mtime, size };
}

function isObsidianFileLike(value: unknown): value is ObsidianFileLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly path?: unknown; readonly stat?: unknown };
  return typeof candidate.path === "string" && typeof candidate.stat === "object" && candidate.stat !== null;
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return left.path === right.path &&
    left.ctime === right.ctime &&
    left.mtime === right.mtime &&
    left.size === right.size;
}

function rawUtf8Order(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const commonLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < commonLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) throw new Error("Obsidian path order comparison failed.");
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.length - rightBytes.length;
}

/**
 * Obsidian VaultSource binding for Phase 5-B. The public Vault API is read-only here:
 * every entry captures its listing stamp, then rechecks the current TFile before and
 * after `readBinary`. A replacement, deletion or metadata change fails closed instead
 * of allowing bytes from two different Vault states into one snapshot.
 */
export class ObsidianVaultSource implements VaultSource {
  constructor(
    readonly vault: ObsidianVaultLike,
    readonly options: ObsidianVaultSourceOptions = {}
  ) {}

  async *listFiles(): AsyncIterable<VaultEntry> {
    let listed: readonly ObsidianFileLike[];
    try {
      listed = [...this.vault.getFiles()].sort((left, right) => rawUtf8Order(left.path, right.path));
    } catch (error) {
      throw new VaultAdapterError(
        "SOURCE_FILE_READ_FAILED",
        ".",
        "Obsidian Vault files could not be listed.",
        { cause: error }
      );
    }
    for (const file of listed) {
      const listedStamp = stampOf(file);
      await this.options.validatePath?.(listedStamp.path);
      yield {
        relativePath: listedStamp.path,
        readBytes: async () => this.#readStable(listedStamp)
      };
    }
  }

  async #readStable(listedStamp: FileStamp): Promise<Uint8Array> {
    const changed = (): VaultAdapterError => new VaultAdapterError(
      "FILE_CHANGED_DURING_SCAN",
      listedStamp.path,
      "Obsidian Vault file changed while it was being read."
    );
    await this.options.validatePath?.(listedStamp.path);
    let beforeValue: unknown;
    try {
      beforeValue = this.vault.getAbstractFileByPath(listedStamp.path);
    } catch (error) {
      throw new VaultAdapterError(
        "SOURCE_FILE_READ_FAILED",
        listedStamp.path,
        "Obsidian Vault file state could not be inspected before reading.",
        { cause: error }
      );
    }
    if (!isObsidianFileLike(beforeValue)) throw changed();
    const before = stampOf(beforeValue);
    if (!sameStamp(listedStamp, before)) throw changed();

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await this.vault.readBinary(beforeValue));
    } catch (error) {
      throw new VaultAdapterError(
        "SOURCE_FILE_READ_FAILED",
        listedStamp.path,
        "Obsidian Vault file could not be read.",
        { cause: error }
      );
    }

    let afterValue: unknown;
    try {
      afterValue = this.vault.getAbstractFileByPath(listedStamp.path);
    } catch (error) {
      throw new VaultAdapterError(
        "SOURCE_FILE_READ_FAILED",
        listedStamp.path,
        "Obsidian Vault file state could not be inspected after reading.",
        { cause: error }
      );
    }
    if (!isObsidianFileLike(afterValue)) throw changed();
    const after = stampOf(afterValue);
    if (!sameStamp(before, after) || bytes.byteLength !== after.size) throw changed();
    await this.options.validatePath?.(listedStamp.path);
    return bytes;
  }
}
