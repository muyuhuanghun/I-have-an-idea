import { describe, expect, it } from "vitest";
import { CORE_VERSION, createCore, type CorePorts } from "../src/index.js";

const ports: CorePorts = {
  vaultSource: { listFiles: async function* () {} },
  cryptoProvider: {
    randomBytes: () => new Uint8Array(),
    sha256: async () => new Uint8Array(),
    hmacSha256: async () => new Uint8Array(),
    verifyHmacSha256: async () => false,
    aeadEncrypt: async () => ({ ciphertext: new Uint8Array(), tag: new Uint8Array() }),
    aeadDecrypt: async () => new Uint8Array(),
    hkdfSha256: async () => new Uint8Array(),
    wrapKey: async () => new Uint8Array(),
    unwrapKey: async () => new Uint8Array()
  },
  objectStore: {
    put: async () => undefined,
    get: async () => undefined
  },
  randomSource: { randomBytes: () => new Uint8Array() },
  clock: { nowMilliseconds: () => 0 }
};

describe("shared core scaffold", () => {
  it("exposes the Phase 3B core version", () => {
    expect(CORE_VERSION).toBe("phase3b-object-codecs-v1");
  });

  it("keeps the supplied ports as the only wiring surface", () => {
    const core = createCore(ports);
    expect(core.ports).toBe(ports);
    expect(Object.isFrozen(core)).toBe(true);
  });
});
