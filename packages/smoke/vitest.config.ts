import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@ekd/crypto/webcrypto",
        replacement: resolve(__dirname, "../crypto/src/webcrypto.ts")
      },
      {
        find: "@ekd/crypto/noble",
        replacement: resolve(__dirname, "../crypto/src/noble.ts")
      },
      {
        find: /^@ekd\/core$/,
        replacement: resolve(__dirname, "../core/src/index.ts")
      }
    ]
  }
});
