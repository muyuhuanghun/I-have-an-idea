import { open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const RECOVERY_FILE_V1_LENGTH = 167;

function isWithin(rootPath: string, targetPath: string): boolean {
  const relation = relative(rootPath, targetPath);
  return relation.length === 0 || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Create a Recovery File outside the Vault without overwriting an existing file.
 * The write handle is closed before the file is read back from disk.
 */
export async function writeRecoveryFileAndReadBack(
  vaultRootPath: string,
  recoveryFilePath: string,
  bytes: Uint8Array
): Promise<Uint8Array> {
  if (bytes.byteLength !== RECOVERY_FILE_V1_LENGTH) {
    throw new RangeError(`Recovery File must be exactly ${RECOVERY_FILE_V1_LENGTH} bytes.`);
  }

  const canonicalVaultRoot = await realpath(resolve(vaultRootPath));
  const requestedPath = resolve(recoveryFilePath);
  const canonicalParent = await realpath(dirname(requestedPath));
  const canonicalRecoveryPath = join(canonicalParent, basename(requestedPath));
  if (isWithin(canonicalVaultRoot, canonicalRecoveryPath)) {
    throw new RangeError("Recovery File path must be outside the Vault root.");
  }

  const handle = await open(canonicalRecoveryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const reread = new Uint8Array(await readFile(canonicalRecoveryPath));
  if (!bytesEqual(bytes, reread)) {
    throw new Error("Recovery File readback does not match the bytes written to disk.");
  }
  return reread;
}
