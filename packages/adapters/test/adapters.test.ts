import { describe, expect, it } from "vitest";
import {
  AdapterNotImplementedError,
  NodeVaultSource,
  ObsidianVaultSource
} from "../src/index.js";

describe("adapter scaffold", () => {
  it("keeps adapter configuration without touching the host", () => {
    expect(new NodeVaultSource("C:/vault").rootPath).toBe("C:/vault");
    expect(new ObsidianVaultSource({ getMarkdownFiles: () => [] }).vault).toBeDefined();
  });

  it("fails explicitly instead of pretending a placeholder performed I/O", async () => {
    const source = new NodeVaultSource("C:/vault");
    await expect((async () => {
      for await (const entry of source.listFiles()) {
        // The placeholder never yields an entry.
        void entry;
      }
    })()).rejects.toBeInstanceOf(AdapterNotImplementedError);
  });
});
