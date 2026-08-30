import { canonicalRelativePathBytes, type RestoreTarget } from "@ekd/core";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { SnapshotAdapterError } from "./errors.js";

const execFileAsync = promisify(execFile);
const WINDOWS_REPARSE_PROBE = `& {
  param([string]$p)
  $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    [Console]::Out.Write("REPARSE")
  } else {
    [Console]::Out.Write("REGULAR")
  }
}`;

export type ReparsePointProbe = (absolutePath: string) => Promise<boolean>;

export interface NodeRestoreTargetOptions {
  /** Test seam; production defaults to the Windows FILE_ATTRIBUTE_REPARSE_POINT probe. */
  readonly reparsePointProbe?: ReparsePointProbe;
}

async function defaultReparsePointProbe(absolutePath: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_REPARSE_PROBE, absolutePath],
    { encoding: "utf8", windowsHide: true }
  );
  const verdict = result.stdout.trim();
  if (verdict === "REPARSE") return true;
  if (verdict === "REGULAR") return false;
  throw new Error("Windows reparse-point probe returned an invalid verdict.");
}

/**
 * ADR-0018 §3.2: restore output boundary on a Node directory. The caller creates the empty
 * target; `verifyEmptyTarget` rejects missing/non-directory/non-empty targets and checks both
 * symlink/junction type and Windows FILE_ATTRIBUTE_REPARSE_POINT before any write (INV-08).
 * Canonical paths are re-validated defensively so a crafted Manifest
 * cannot escape the target (INV-06/ACC-19). Files are written without fsync or read-back —
 * independent verification belongs to the external Python verifier.
 */
export class NodeRestoreTarget implements RestoreTarget {
  readonly #targetRoot: string;
  readonly #reparsePointProbe: ReparsePointProbe;

  constructor(targetRoot: string, options: NodeRestoreTargetOptions = {}) {
    this.#targetRoot = resolve(targetRoot);
    this.#reparsePointProbe = options.reparsePointProbe ?? defaultReparsePointProbe;
  }

  async verifyEmptyTarget(): Promise<void> {
    let rootStats;
    try {
      rootStats = await lstat(this.#targetRoot);
    } catch {
      throw new SnapshotAdapterError("NON_EMPTY_TARGET", "Restore target is missing; the caller must create an empty directory.");
    }
    if (rootStats.isSymbolicLink()) {
      throw new SnapshotAdapterError("REPARSE_POINT_FOUND", "Restore target must not be a symbolic link or junction.");
    }
    let hasReparseAttribute: boolean;
    try {
      hasReparseAttribute = await this.#reparsePointProbe(this.#targetRoot);
    } catch (error) {
      // ADR-0009 当前参数状态: an uninspectable target is treated as a reparse risk and
      // fails closed under REPARSE_POINT_FOUND — "cannot prove it is safe" must not be
      // reported as "target is non-empty".
      throw new SnapshotAdapterError(
        "REPARSE_POINT_FOUND",
        "Restore target reparse-point attributes could not be inspected; it is treated as a reparse risk.",
        { cause: error }
      );
    }
    if (hasReparseAttribute) {
      throw new SnapshotAdapterError("REPARSE_POINT_FOUND", "Restore target has a Windows reparse-point attribute.");
    }
    if (!rootStats.isDirectory()) {
      throw new SnapshotAdapterError("NON_EMPTY_TARGET", "Restore target must be a real directory.");
    }
    let entries;
    try {
      entries = await readdir(this.#targetRoot);
    } catch (error) {
      throw new SnapshotAdapterError("NON_EMPTY_TARGET", "Restore target state could not be inspected.", { cause: error });
    }
    if (entries.length > 0) {
      throw new SnapshotAdapterError("NON_EMPTY_TARGET", `Restore target must be empty; it contains ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`);
    }
  }

  async writeRestoredFile(relativePath: string, bytes: Uint8Array): Promise<void> {
    try {
      canonicalRelativePathBytes(relativePath);
    } catch (error) {
      throw new SnapshotAdapterError("ENTRY_PATH_ESCAPE", "Restored path is not a canonical relative Vault path.", { cause: error });
    }
    const target = join(this.#targetRoot, relativePath);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    } catch (error) {
      throw new SnapshotAdapterError(
        "RESTORE_TARGET_WRITE_FAILED",
        "Restore target could not persist the requested file.",
        { cause: error }
      );
    }
  }
}
