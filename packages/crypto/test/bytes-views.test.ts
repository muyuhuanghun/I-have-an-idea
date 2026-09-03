import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { asArrayBuffer } from "../src/shared.js";

describe("asArrayBuffer view handling", () => {
  it("copies exactly the viewed range for standalone arrays", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = new Uint8Array(asArrayBuffer(bytes));
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("honors byteOffset views instead of leaking the whole backing buffer", () => {
    // Node Buffers are pooled views (byteOffset > 0) and Buffer.prototype.slice
    // returns views, so the helper must derive the range from the view itself.
    const pool = Buffer.alloc(8 + 4);
    pool.set([1, 2, 3, 4], 8);
    const view = pool.subarray(8);
    expect(view.byteOffset).toBe(8);
    const result = new Uint8Array(asArrayBuffer(view));
    expect(result.byteLength).toBe(4);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
