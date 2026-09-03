import type { Bytes } from "@ekd/core";
import { CryptoPrimitiveError } from "./errors.js";

export type RandomBytesFunction = (length: number) => Bytes;

export function assertByteLength(bytes: Bytes, expected: number, label: string): void {
  if (bytes.byteLength !== expected) {
    throw new CryptoPrimitiveError(
      "CRYPTO_INPUT_INVALID",
      `${label} must be ${expected} bytes; got ${bytes.byteLength}.`
    );
  }
}

export function checkedRandomBytes(source: RandomBytesFunction, length: number): Bytes {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new CryptoPrimitiveError("CRYPTO_INPUT_INVALID", "Random byte length must be a positive safe integer.");
  }

  let value: Bytes;
  try {
    value = source(length);
  } catch (error) {
    if (error instanceof CryptoPrimitiveError) {
      throw error;
    }
    throw new CryptoPrimitiveError("RANDOM_SOURCE_FAILED", "The random source failed.", { cause: error });
  }

  if (value.byteLength !== length) {
    throw new CryptoPrimitiveError(
      "RANDOM_SOURCE_SHORT_READ",
      `The random source returned ${value.byteLength} bytes; expected ${length}.`
    );
  }
  if (value.every((byte) => byte === 0)) {
    throw new CryptoPrimitiveError("RANDOM_SOURCE_ALL_ZERO", "The random source returned only zero bytes.");
  }
  return value.slice();
}

export function asArrayBuffer(bytes: Bytes): ArrayBuffer {
  // Uint8Array views must be honored exactly: Node Buffers are pooled (byteOffset > 0)
  // and Buffer.prototype.slice returns views rather than copies, so deriving the range
  // from the view and copying via ArrayBuffer.prototype.slice is the only safe path.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
