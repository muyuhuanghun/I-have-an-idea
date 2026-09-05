import { canonicalRelativePathBytes } from "@ekd/core";
import type { BigIntStats } from "node:fs";
import type * as NodeFsPromisesApi from "node:fs/promises";
import type * as NodePathApi from "node:path";

type NodeFsPromises = typeof NodeFsPromisesApi;
type NodePath = typeof NodePathApi;

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === code;
}

function pathContains(root: string, candidate: string, nodePath: NodePath): boolean {
  const relation = nodePath.relative(nodePath.resolve(root), nodePath.resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !nodePath.isAbsolute(relation));
}

async function physicalPathIdentity(pathValue: string, nodeFs: NodeFsPromises, nodePath: NodePath): Promise<string> {
  try {
    return await nodeFs.realpath(pathValue);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
  }
  return nodePath.resolve(await nodeFs.realpath(nodePath.dirname(pathValue)), nodePath.basename(pathValue));
}

export async function requireSnapshotPathsDisjoint(
  paths: readonly (readonly [label: string, pathValue: string])[],
  nodeFs: NodeFsPromises,
  nodePath: NodePath
): Promise<void> {
  let identities: readonly (readonly [label: string, pathValue: string])[];
  try {
    identities = await Promise.all(paths.map(async ([label, pathValue]) =>
      [label, await physicalPathIdentity(pathValue, nodeFs, nodePath)] as const
    ));
  } catch (error) {
    throw new Error(`Snapshot filesystem identity could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      const first = identities[left];
      const second = identities[right];
      if (first === undefined || second === undefined) throw new Error("Snapshot path identity list is incomplete.");
      if (
        pathContains(first[1], second[1], nodePath) ||
        pathContains(second[1], first[1], nodePath)
      ) {
        throw new Error(`${first[0]} and ${second[0]} must not contain each other.`);
      }
    }
  }
}

export async function requireNewReportTarget(
  reportPath: string,
  nodeFs: NodeFsPromises,
  nodePath: NodePath
): Promise<void> {
  try {
    await nodeFs.lstat(reportPath);
    throw new Error("Plugin snapshot report already exists; reports are never overwritten.");
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
  }
  const parent = await nodeFs.lstat(nodePath.dirname(reportPath));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("Plugin snapshot report parent must be an existing real directory.");
  }
}

export async function requireRealDirectory(
  pathValue: string,
  label: string,
  nodeFs: NodeFsPromises
): Promise<void> {
  const stats = await nodeFs.lstat(pathValue);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be an existing real directory, not a symbolic link or junction.`);
  }
}

export function createNodeVaultPathValidator(
  vaultRoot: string,
  nodeFs: NodeFsPromises,
  nodePath: NodePath,
  errorFactory: (
    code: "ENTRY_PATH_ESCAPE" | "FILE_CHANGED_DURING_SCAN" | "REPARSE_POINT_FOUND" | "SOURCE_FILE_READ_FAILED",
    relativePath: string,
    message: string,
    cause?: unknown
  ) => Error
): (relativePath: string) => Promise<void> {
  const fileStamps = new Map<string, {
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
    readonly device: bigint;
    readonly inode: bigint;
  }>();
  return async (relativePath) => {
    try {
      canonicalRelativePathBytes(relativePath);
    } catch (error) {
      throw errorFactory("ENTRY_PATH_ESCAPE", relativePath, "Obsidian returned a non-canonical Vault path.", error);
    }
    const segments = relativePath.split("/");
    let current = vaultRoot;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) throw errorFactory("ENTRY_PATH_ESCAPE", relativePath, "Vault path segment is missing.");
      current = nodePath.join(current, segment);
      let stats: BigIntStats;
      try {
        stats = await nodeFs.lstat(current, { bigint: true });
      } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) {
          throw errorFactory("FILE_CHANGED_DURING_SCAN", relativePath, "Vault entry disappeared during snapshot.", error);
        }
        throw errorFactory("SOURCE_FILE_READ_FAILED", relativePath, "Vault entry state could not be inspected.", error);
      }
      if (stats.isSymbolicLink()) {
        throw errorFactory("REPARSE_POINT_FOUND", relativePath, "Vault path contains a symbolic link or junction.");
      }
      const isFinal = index === segments.length - 1;
      if ((!isFinal && !stats.isDirectory()) || (isFinal && !stats.isFile())) {
        throw errorFactory("REPARSE_POINT_FOUND", relativePath, "Vault path contains an unsupported filesystem entry.");
      }
      if (isFinal) {
        const stamp = {
          size: stats.size,
          mtimeNs: stats.mtimeNs,
          ctimeNs: stats.ctimeNs,
          device: stats.dev,
          inode: stats.ino
        };
        const previous = fileStamps.get(relativePath);
        if (
          previous !== undefined &&
          (previous.size !== stamp.size ||
            previous.mtimeNs !== stamp.mtimeNs ||
            previous.ctimeNs !== stamp.ctimeNs ||
            previous.device !== stamp.device ||
            previous.inode !== stamp.inode)
        ) {
          throw errorFactory("FILE_CHANGED_DURING_SCAN", relativePath, "Vault file identity or metadata changed during snapshot.");
        }
        fileStamps.set(relativePath, stamp);
      }
    }
  };
}

export async function writeReportExclusive(
  reportPath: string,
  bytes: Uint8Array,
  nodeFs: NodeFsPromises
): Promise<void> {
  const handle = await nodeFs.open(reportPath, "wx");
  let failure: unknown;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
}
