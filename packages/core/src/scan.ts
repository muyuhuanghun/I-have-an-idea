import { VaultScanError } from "./errors.js";
import { canonicalRelativePathBytes, compareBytes, windowsCaseFoldV1 } from "./paths.js";
import type { VaultSource } from "./ports.js";

export type ContentClass = "canvas" | "c" | "image" | "markdown" | "other-supported" | "pdf" | "python";

export interface ScannedVaultFile {
  readonly relativePath: string;
  readonly plaintextSize: bigint;
  readonly contentClass: ContentClass;
}

export interface VaultScanResult {
  readonly files: readonly ScannedVaultFile[];
  readonly totalBytes: bigint;
}

const CONTENT_CLASSES: Readonly<Record<string, ContentClass>> = Object.freeze({
  ".canvas": "canvas",
  ".c": "c",
  ".cpp": "c",
  ".gif": "image",
  ".h": "c",
  ".hpp": "c",
  ".jpeg": "image",
  ".jpg": "image",
  ".md": "markdown",
  ".pdf": "pdf",
  ".png": "image",
  ".py": "python",
  ".webp": "image"
});

function contentClass(relativePath: string): ContentClass | undefined {
  const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return CONTENT_CLASSES[fileName.slice(dot).toLowerCase()];
}

function obsidianConfigurationSuffix(relativePath: string): string | undefined {
  const prefix = ".obsidian/";
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : undefined;
}

export async function scanVault(source: VaultSource): Promise<VaultScanResult> {
  const files: Array<ScannedVaultFile & { readonly pathBytes: Uint8Array }> = [];
  const seenPaths = new Set<string>();
  const caseFoldedPaths = new Map<string, string>();
  const unsupportedPaths: string[] = [];
  let totalBytes = 0n;

  for await (const entry of source.listFiles()) {
    // The root Obsidian configuration tree is explicitly outside the content set. Its hidden
    // root is allowed only for exclusion; the suffix is validated under a legal placeholder
    // root first so `.obsidian/../x` and malformed separators cannot be silently skipped.
    const obsidianSuffix = obsidianConfigurationSuffix(entry.relativePath);
    if (obsidianSuffix !== undefined) {
      try {
        canonicalRelativePathBytes(`obsidian-config/${obsidianSuffix}`);
      } catch {
        throw new VaultScanError(
          "ENTRY_PATH_ESCAPE",
          "Obsidian configuration entry is not a contained canonical relative path.",
          [entry.relativePath]
        );
      }
      continue;
    }
    let pathBytes: Uint8Array;
    try {
      pathBytes = canonicalRelativePathBytes(entry.relativePath);
    } catch {
      throw new VaultScanError(
        "ENTRY_PATH_ESCAPE",
        `Vault entry is not a canonical relative path: ${entry.relativePath}`,
        [entry.relativePath]
      );
    }
    if (seenPaths.has(entry.relativePath)) {
      throw new VaultScanError(
        "ENTRY_PATH_DUPLICATE",
        `Vault source yielded the same path more than once: ${entry.relativePath}`,
        [entry.relativePath]
      );
    }
    seenPaths.add(entry.relativePath);

    // ADR-0017 §4.1.3: vaults whose files differ only by case cannot restore onto
    // case-insensitive targets, so they fail closed before any object is written.
    const caseFolded = windowsCaseFoldV1(entry.relativePath);
    const caseConflict = caseFoldedPaths.get(caseFolded);
    if (caseConflict !== undefined) {
      throw new VaultScanError(
        "CASE_COLLISION",
        "Vault contains paths that collide under the frozen Windows case-folding rule.",
        [caseConflict, entry.relativePath]
      );
    }
    caseFoldedPaths.set(caseFolded, entry.relativePath);

    const classified = contentClass(entry.relativePath);
    if (classified === undefined) {
      unsupportedPaths.push(entry.relativePath);
      continue;
    }

    const plaintextSize = BigInt((await entry.readBytes()).byteLength);
    files.push({
      relativePath: entry.relativePath,
      plaintextSize,
      contentClass: classified,
      pathBytes
    });
    totalBytes += plaintextSize;
  }

  if (unsupportedPaths.length > 0) {
    unsupportedPaths.sort((left, right) => compareBytes(canonicalRelativePathBytes(left), canonicalRelativePathBytes(right)));
    throw new VaultScanError(
      "UNSUPPORTED_FILES_FOUND",
      `Vault contains ${unsupportedPaths.length} unsupported file(s).`,
      Object.freeze(unsupportedPaths)
    );
  }

  files.sort((left, right) => compareBytes(left.pathBytes, right.pathBytes));
  const publicFiles = files.map((file) => Object.freeze({
    relativePath: file.relativePath,
    plaintextSize: file.plaintextSize,
    contentClass: file.contentClass
  }));
  return Object.freeze({
    files: Object.freeze(publicFiles),
    totalBytes
  });
}
