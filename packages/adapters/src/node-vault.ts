import type { VaultEntry, VaultSource } from "@ekd/core";
import { AdapterNotImplementedError } from "./errors.js";

/** Node-side read-only Vault port placeholder. It deliberately performs no filesystem I/O. */
export class NodeVaultSource implements VaultSource {
  constructor(readonly rootPath: string) {}

  listFiles(): AsyncIterable<VaultEntry> {
    const iterator: AsyncIterator<VaultEntry> = {
      next: async () => {
        throw new AdapterNotImplementedError("NodeVaultSource");
      }
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
}
