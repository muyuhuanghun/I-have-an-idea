import type { VaultEntry, VaultSource } from "@ekd/core";
import { Buffer } from "node:buffer";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { VaultAdapterError } from "./errors.js";

/**
 * ADR-0017 §5: the source adapter reads in chunks of exactly the accepted
 * `p0-runtime-limits-v1` value; tests bind this constant to the contract file.
 */
export const VAULT_SOURCE_READ_CHUNK_BYTES = 1_048_576;

interface FileStamp {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface StableReadDependencies {
  readonly stamp: (absolutePath: string) => Promise<FileStamp>;
  readonly read: (absolutePath: string) => Promise<Uint8Array>;
}

async function nodeFileStamp(absolutePath: string): Promise<FileStamp> {
  const stats = await lstat(absolutePath, { bigint: true });
  if (!stats.isFile()) {
    throw new VaultAdapterError(
      "REPARSE_POINT_FOUND",
      absolutePath,
      `Vault entry stopped being a regular file before it could be read: ${absolutePath}`
    );
  }
  return {
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    device: stats.dev,
    inode: stats.ino
  };
}

const NODE_STABLE_READ_DEPENDENCIES: StableReadDependencies = {
  stamp: nodeFileStamp,
  read: async (absolutePath) => {
    // ADR-0017 §5: one preallocation sized from the file itself, then linear 1 MiB reads;
    // never repeated concatenation. Any growth or shrink is caught by the stamp comparison.
    const handle = await open(absolutePath, "r");
    try {
      const stats = await handle.stat();
      const buffer = Buffer.allocUnsafe(stats.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          Math.min(VAULT_SOURCE_READ_CHUNK_BYTES, buffer.length - offset),
          offset
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return new Uint8Array(buffer.subarray(0, offset));
    } finally {
      await handle.close();
    }
  }
};

function stampsEqual(left: FileStamp, right: FileStamp): boolean {
  return left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.device === right.device &&
    left.inode === right.inode;
}

/** ADR-0017 §9.2: read failures other than an observed stability change converge to this code. */
function toSourceReadFailed(error: unknown, absolutePath: string): VaultAdapterError {
  if (error instanceof VaultAdapterError) return error;
  return new VaultAdapterError("SOURCE_FILE_READ_FAILED", absolutePath, "Vault file could not be read.", {
    cause: error
  });
}

export async function readStableFile(
  absolutePath: string,
  dependencies: StableReadDependencies = NODE_STABLE_READ_DEPENDENCIES
): Promise<Uint8Array> {
  let before: FileStamp;
  try {
    before = await dependencies.stamp(absolutePath);
  } catch (error) {
    throw toSourceReadFailed(error, absolutePath);
  }
  let bytes: Uint8Array;
  try {
    bytes = await dependencies.read(absolutePath);
  } catch (error) {
    throw toSourceReadFailed(error, absolutePath);
  }
  let after: FileStamp;
  try {
    after = await dependencies.stamp(absolutePath);
  } catch (error) {
    throw toSourceReadFailed(error, absolutePath);
  }
  if (!stampsEqual(before, after) || BigInt(bytes.byteLength) !== after.size) {
    throw new VaultAdapterError(
      "FILE_CHANGED_DURING_SCAN",
      absolutePath,
      `File changed while it was being scanned: ${absolutePath}`
    );
  }
  return bytes;
}

function rawUtf8Order(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const commonLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < commonLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) throw new Error("Directory order comparison failed.");
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.length - rightBytes.length;
}

function toRelativePath(rootPath: string, absolutePath: string): string {
  const value = relative(rootPath, absolutePath);
  if (value.length === 0 || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new VaultAdapterError(
      "ENTRY_PATH_ESCAPE",
      value,
      `Filesystem entry escaped the configured Vault root: ${absolutePath}`
    );
  }
  return value.split(sep).join("/");
}

/** Sequential, read-only Node adapter. Concurrency is intentionally bounded at one file. */
export class NodeVaultSource implements VaultSource {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  async *#walk(rootPath: string, directoryPath: string): AsyncGenerator<VaultEntry> {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    directoryEntries.sort((left, right) => rawUtf8Order(left.name, right.name));
    for (const directoryEntry of directoryEntries) {
      const absolutePath = join(directoryPath, directoryEntry.name);
      const relativePath = toRelativePath(rootPath, absolutePath);
      const stats = await lstat(absolutePath, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw new VaultAdapterError(
          "REPARSE_POINT_FOUND",
          relativePath,
          `Vault contains a symbolic link or junction: ${relativePath}`
        );
      }
      if (stats.isDirectory()) {
        if (directoryEntry.name === ".obsidian") continue;
        yield* this.#walk(rootPath, absolutePath);
      } else if (stats.isFile()) {
        yield { relativePath, readBytes: async () => readStableFile(absolutePath) };
      } else {
        throw new VaultAdapterError(
          "REPARSE_POINT_FOUND",
          relativePath,
          `Vault contains an unsupported filesystem entry: ${relativePath}`
        );
      }
    }
  }

  async *listFiles(): AsyncGenerator<VaultEntry> {
    const rootStats = await lstat(this.rootPath, { bigint: true });
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new VaultAdapterError(
        "REPARSE_POINT_FOUND",
        ".",
        `Vault root must be a real directory, not a link or special entry: ${this.rootPath}`
      );
    }
    yield* this.#walk(this.rootPath, this.rootPath);
  }
}
