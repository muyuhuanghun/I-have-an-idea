import type { VaultEntry, VaultSource } from "@ekd/core";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { VaultAdapterError } from "./errors.js";

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
  read: async (absolutePath) => new Uint8Array(await readFile(absolutePath))
};

function stampsEqual(left: FileStamp, right: FileStamp): boolean {
  return left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.device === right.device &&
    left.inode === right.inode;
}

export async function readStableFile(
  absolutePath: string,
  dependencies: StableReadDependencies = NODE_STABLE_READ_DEPENDENCIES
): Promise<Uint8Array> {
  const before = await dependencies.stamp(absolutePath);
  const bytes = await dependencies.read(absolutePath);
  const after = await dependencies.stamp(absolutePath);
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
