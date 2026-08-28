import { describe, expect, it } from "vitest";
import { CryptoProviderUnavailableError, UnconfiguredCryptoProvider } from "../src/index.js";

describe("crypto scaffold", () => {
  it("fails closed until a smoke-tested candidate is configured", () => {
    const provider = new UnconfiguredCryptoProvider();
    expect(() => provider.randomBytes(32)).toThrowError(CryptoProviderUnavailableError);
  });

  it("uses the same stable error for async primitives", async () => {
    const provider = new UnconfiguredCryptoProvider();
    await expect(provider.hkdfSha256(new Uint8Array(), new Uint8Array(), new Uint8Array(), 32))
      .rejects.toBeInstanceOf(CryptoProviderUnavailableError);
  });
});
