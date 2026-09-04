import type { RecoveryFileTarget, SnapshotLogSink } from "@ekd/core";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SnapshotAdapterError } from "./errors.js";

/** Containment comparison for already-normalized lexical or physical identities. */
function outsideRoot(root: string | undefined, target: string): boolean {
  if (root === undefined) return true;
  const relativePath = relative(resolve(root), resolve(target));
  return (
    relativePath !== "" &&
    (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
  );
}

async function physicalPathIdentity(pathValue: string): Promise<string> {
  try {
    return await realpath(pathValue);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  const parentIdentity = await realpath(dirname(pathValue));
  return resolve(parentIdentity, basename(pathValue));
}

async function requireOutsideRoots(
  vaultRoot: string | undefined,
  objectStoreRoot: string | undefined,
  target: string,
  code: SnapshotAdapterErrorCodeOf
): Promise<void> {
  try {
    const [targetIdentity, vaultIdentity, objectStoreIdentity] = await Promise.all([
      physicalPathIdentity(target),
      vaultRoot === undefined ? undefined : physicalPathIdentity(vaultRoot),
      objectStoreRoot === undefined ? undefined : physicalPathIdentity(objectStoreRoot)
    ]);
    if (outsideRoot(vaultIdentity, targetIdentity) && outsideRoot(objectStoreIdentity, targetIdentity)) return;
  } catch (error) {
    throw new SnapshotAdapterError(
      code,
      "Snapshot path filesystem identity could not be resolved.",
      { cause: error }
    );
  }
  throw new SnapshotAdapterError(
    code,
    "Snapshot target must stay outside both the Vault root and the ObjectStore root."
  );
}

type SnapshotAdapterErrorCodeOf = "LOG_WRITE_FAILED" | "RECOVERY_FILE_WRITE_FAILED";

/** ADR-0017 §4.1.1: the target must not exist yet and its parent must be a real directory. */
async function requireAbsentWithRealParent(target: string, code: SnapshotAdapterErrorCodeOf): Promise<void> {
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return;
    throw new SnapshotAdapterError(code, "Snapshot target state could not be inspected.", { cause: error });
  }
  const detail = stats.isDirectory()
    ? "Snapshot target already exists as a directory."
    : "Snapshot target already exists; exclusive creation never overwrites.";
  throw new SnapshotAdapterError(code, detail);
}

async function requireRealParentDirectory(target: string, code: SnapshotAdapterErrorCodeOf): Promise<void> {
  let parentStats;
  try {
    parentStats = await lstat(dirname(target));
  } catch (error) {
    throw new SnapshotAdapterError(code, "Snapshot target parent is unavailable.", { cause: error });
  }
  if (parentStats.isSymbolicLink()) {
    throw new SnapshotAdapterError(code, "Snapshot target parent must not be a symbolic link or junction.");
  }
  if (!parentStats.isDirectory()) {
    throw new SnapshotAdapterError(code, "Snapshot target parent must be a real directory.");
  }
}

/**
 * ADR-0017 §3.1/§4.1: mandatory snapshot run log on a Node file. Exclusive creation happens
 * in `open`; every open/write/flush/close failure is `LOG_WRITE_FAILED`. Paths stay on the
 * adapter side and never reach the orchestration, so they cannot enter the log.
 */
export class NodeSnapshotLogSink implements SnapshotLogSink {
  readonly #vaultRoot: string | undefined;
  readonly #objectStoreRoot: string | undefined;
  readonly #logPath: string;
  #handle: Awaited<ReturnType<typeof open>> | undefined;

  constructor(logPath: string, roots: { readonly vaultRoot?: string; readonly objectStoreRoot?: string } = {}) {
    this.#logPath = resolve(logPath);
    this.#vaultRoot = roots.vaultRoot === undefined ? undefined : resolve(roots.vaultRoot);
    this.#objectStoreRoot = roots.objectStoreRoot === undefined ? undefined : resolve(roots.objectStoreRoot);
  }

  async open(): Promise<void> {
    if (this.#handle !== undefined) {
      throw new SnapshotAdapterError("LOG_WRITE_FAILED", "Snapshot log sink is already open.");
    }
    const fail = (message: string, cause?: unknown): SnapshotAdapterError =>
      new SnapshotAdapterError("LOG_WRITE_FAILED", message, cause === undefined ? undefined : { cause });
    await requireOutsideRoots(this.#vaultRoot, this.#objectStoreRoot, this.#logPath, "LOG_WRITE_FAILED");
    await requireAbsentWithRealParent(this.#logPath, "LOG_WRITE_FAILED");
    await requireRealParentDirectory(this.#logPath, "LOG_WRITE_FAILED");
    try {
      this.#handle = await open(this.#logPath, "wx");
    } catch (error) {
      throw fail("Snapshot log sink could not be created exclusively.", error);
    }
  }

  async writeLine(line: string): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) {
      throw new SnapshotAdapterError("LOG_WRITE_FAILED", "Snapshot log sink is not open.");
    }
    try {
      await handle.writeFile(`${line}\n`, "utf8");
    } catch (error) {
      throw new SnapshotAdapterError("LOG_WRITE_FAILED", "Snapshot log sink write failed.", { cause: error });
    }
  }

  async flushAndClose(): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) return;
    this.#handle = undefined;
    try {
      await handle.sync();
    } catch (error) {
      throw new SnapshotAdapterError("LOG_WRITE_FAILED", "Snapshot log sink could not be flushed.", { cause: error });
    }
    try {
      await handle.close();
    } catch (error) {
      throw new SnapshotAdapterError("LOG_WRITE_FAILED", "Snapshot log sink could not be closed.", { cause: error });
    }
  }
}

/**
 * ADR-0017 §4.6: Recovery File target on a Node file. Exclusive create, fsync, close, and a
 * byte-exact read-back; the authoritative write never overwrites an existing file, and a
 * crash-left truncated file stays on disk to be rejected by strict decoding rather than being
 * silently cleaned up.
 */
export class NodeRecoveryFileTarget implements RecoveryFileTarget {
  readonly #vaultRoot: string | undefined;
  readonly #objectStoreRoot: string | undefined;
  readonly #recoveryPath: string;

  constructor(recoveryPath: string, roots: { readonly vaultRoot?: string; readonly objectStoreRoot?: string } = {}) {
    this.#recoveryPath = resolve(recoveryPath);
    this.#vaultRoot = roots.vaultRoot === undefined ? undefined : resolve(roots.vaultRoot);
    this.#objectStoreRoot = roots.objectStoreRoot === undefined ? undefined : resolve(roots.objectStoreRoot);
  }

  async verifyTargetAbsent(): Promise<void> {
    const code: SnapshotAdapterErrorCodeOf = "RECOVERY_FILE_WRITE_FAILED";
    await requireOutsideRoots(this.#vaultRoot, this.#objectStoreRoot, this.#recoveryPath, code);
    await requireAbsentWithRealParent(this.#recoveryPath, code);
    await requireRealParentDirectory(this.#recoveryPath, code);
  }

  async writeExclusiveAndReadBack(bytes: Uint8Array): Promise<void> {
    const code: SnapshotAdapterErrorCodeOf = "RECOVERY_FILE_WRITE_FAILED";
    const fail = (message: string, cause?: unknown): SnapshotAdapterError =>
      new SnapshotAdapterError(code, message, cause === undefined ? undefined : { cause });
    await requireOutsideRoots(this.#vaultRoot, this.#objectStoreRoot, this.#recoveryPath, code);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.#recoveryPath, "wx");
    } catch (error) {
      throw fail("Recovery File could not be created exclusively.", error);
    }
    let operationFailure: unknown;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      operationFailure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      // A close failure after a write failure must not mask the earlier cause; both map
      // to the same stable code, so keep the first one.
      if (operationFailure === undefined) operationFailure = error;
    }
    if (operationFailure !== undefined) {
      throw fail("Recovery File could not be written, synced, and closed.", operationFailure);
    }
    let readBack: Uint8Array;
    try {
      readBack = new Uint8Array(await readFile(this.#recoveryPath));
    } catch (error) {
      throw fail("Recovery File could not be read back.", error);
    }
    if (readBack.byteLength !== bytes.byteLength) {
      throw fail("Recovery File read-back length does not match the written bytes.");
    }
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (readBack[index] !== bytes[index]) {
        throw fail("Recovery File read-back bytes do not match the written bytes.");
      }
    }
  }
}
