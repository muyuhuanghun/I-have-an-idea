import type { VaultEntry, VaultSource } from "@ekd/core";
import { AdapterNotImplementedError } from "./errors.js";

/** Narrow shape needed from Obsidian, kept local so core never imports the Obsidian API. */
export interface ObsidianVaultLike {
  readonly getMarkdownFiles: () => readonly unknown[];
}

/** Obsidian Vault port placeholder. The plugin owns the real API binding in a later step. */
export class ObsidianVaultSource implements VaultSource {
  constructor(readonly vault: ObsidianVaultLike) {}

  listFiles(): AsyncIterable<VaultEntry> {
    const iterator: AsyncIterator<VaultEntry> = {
      next: async () => {
        throw new AdapterNotImplementedError("ObsidianVaultSource");
      }
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
}
