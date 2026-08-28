import { sha256 } from "@noble/hashes/sha2.js";

export function sha256Bytes(input: Uint8Array): Uint8Array {
  return sha256(input);
}

export function sha256Hex(input: Uint8Array): string {
  return bytesToHex(sha256Bytes(input));
}

export function bytesToHex(input: Uint8Array): string {
  let result = "";
  for (const value of input) {
    result += value.toString(16).padStart(2, "0");
  }
  return result;
}

export function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new TypeError("Expected an even-length hexadecimal string.");
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function allZero(input: Uint8Array): boolean {
  for (const value of input) {
    if (value !== 0) {
      return false;
    }
  }
  return true;
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToBase64Url(input: Uint8Array): string {
  let result = "";
  for (let index = 0; index < input.length; index += 3) {
    const first = input[index]!;
    const second = input[index + 1];
    const third = input[index + 2];
    result += BASE64URL_ALPHABET[first >>> 2];
    result += BASE64URL_ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) {
      result += BASE64URL_ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)];
    }
    if (third !== undefined) {
      result += BASE64URL_ALPHABET[third & 63];
    }
  }
  return result;
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new TypeError("Expected unpadded base64url.");
  }
  const result = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result[offset] = (accumulator >>> bits) & 0xff;
      offset += 1;
    }
  }
  return result;
}
