const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const leftByte = left[index];
    const rightByte = right[index];
    if (leftByte === undefined || rightByte === undefined) throw new Error("Byte comparison index escaped its input.");
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return left.length - right.length;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
}

export function canonicalRelativePathBytes(relativePath: string): Uint8Array {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/u.test(relativePath)
  ) {
    throw new Error("Path is not a canonical relative Vault path.");
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error("Path contains an unsafe or non-canonical segment.");
  }

  const encoded = UTF8_ENCODER.encode(relativePath);
  if (UTF8_DECODER.decode(encoded) !== relativePath) {
    throw new Error("Path is not representable as strict UTF-8.");
  }
  return encoded;
}

export function decodeCanonicalRelativePath(bytes: Uint8Array): string {
  const decoded = UTF8_DECODER.decode(bytes);
  const canonical = canonicalRelativePathBytes(decoded);
  if (!bytesEqual(bytes, canonical)) throw new Error("Path bytes are not canonical strict UTF-8.");
  return decoded;
}
