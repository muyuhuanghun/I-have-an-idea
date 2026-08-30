import { describe, expect, it } from "vitest";
import {
  ManifestCodecError,
  decodeManifestPlaintextV1,
  encodeManifestPlaintextV1,
  type ManifestEntryV1,
  type ManifestPlaintextV1
} from "../src/index.js";

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function entry(relativePath: string, marker: number): ManifestEntryV1 {
  return {
    relativePath,
    objectId: filled(16, marker),
    plaintextSize: BigInt(marker * 10),
    wrappedObjectKey: filled(40, marker + 16)
  };
}

function manifest(entries: readonly ManifestEntryV1[] = [entry("b.md", 2), entry("a.md", 1)]): ManifestPlaintextV1 {
  return {
    domainId: filled(32, 0x11),
    snapshotId: filled(32, 0x22),
    parentSnapshotId: filled(32, 0),
    contentPolicyVersion: 1,
    suiteId: 1,
    entries
  };
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ManifestCodecError) return error.code;
    throw error;
  }
  throw new Error("Expected Manifest codec operation to fail.");
}

describe("Canonical Manifest plaintext v1", () => {
  it("encodes entries in raw UTF-8 order and roundtrips all fields", () => {
    const encoded = encodeManifestPlaintextV1(manifest());
    expect(Array.from(encoded.slice(0, 5))).toEqual([0x45, 0x4b, 0x44, 0x4d, 1]);
    const decoded = decodeManifestPlaintextV1(encoded);
    expect(decoded.entries.map((value) => value.relativePath)).toEqual(["a.md", "b.md"]);
    expect(decoded.entries.map((value) => value.plaintextSize)).toEqual([10n, 20n]);
    expect(Array.from(decoded.domainId)).toEqual(Array.from(filled(32, 0x11)));
    expect(encodeManifestPlaintextV1(decoded)).toEqual(encoded);
  });

  it("rejects duplicate paths, duplicate object IDs, and unsafe paths before encoding", () => {
    expect(errorCode(() => encodeManifestPlaintextV1(manifest([
      entry("same.md", 1),
      entry("same.md", 2)
    ])))).toBe("ENTRY_PATH_DUPLICATE");
    expect(errorCode(() => encodeManifestPlaintextV1(manifest([
      entry("a.md", 1),
      { ...entry("b.md", 2), objectId: filled(16, 1) }
    ])))).toBe("DUPLICATE_OBJECT_REFERENCE");
    expect(errorCode(() => encodeManifestPlaintextV1(manifest([entry("../outside.md", 1)])))).toBe("ENTRY_PATH_ESCAPE");
  });

  it("rejects every frozen ADR-0009 Windows path class before encoding", () => {
    const invalidPaths = [
      "",
      "/absolute.md",
      "C:/drive.md",
      "a/../escape.md",
      "nul\0.md",
      "a\\b.md",
      "hidden/.secret.md",
      "CON.md",
      "aux/ok.md",
      "bad?.md",
      "trail./a.md",
      "trail.md ",
      `${"a".repeat(32_765)}.md`
    ];
    for (const invalidPath of invalidPaths) {
      expect(errorCode(() => encodeManifestPlaintextV1(manifest([entry(invalidPath, 1)]))))
        .toBe("ENTRY_PATH_ESCAPE");
    }
  });

  it("rejects malformed fixed fields without invoking any crypto provider", () => {
    expect(errorCode(() => encodeManifestPlaintextV1(manifest([
      { ...entry("a.md", 1), wrappedObjectKey: filled(39, 1) }
    ])))).toBe("MANIFEST_FORMAT_INVALID");
    expect(errorCode(() => encodeManifestPlaintextV1({
      ...manifest(),
      parentSnapshotId: filled(32, 1)
    }))).toBe("MANIFEST_FORMAT_INVALID");
  });

  it("rejects unsupported versions, suites, trailing bytes, and truncation", () => {
    const encoded = encodeManifestPlaintextV1(manifest());
    const badVersion = encoded.slice();
    badVersion[4] = 2;
    expect(errorCode(() => decodeManifestPlaintextV1(badVersion))).toBe("MANIFEST_VERSION_UNSUPPORTED");

    const badSuite = encoded.slice();
    badSuite[102] = 2;
    expect(errorCode(() => decodeManifestPlaintextV1(badSuite))).toBe("MANIFEST_SUITE_UNKNOWN");

    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(encoded);
    expect(errorCode(() => decodeManifestPlaintextV1(trailing))).toBe("MANIFEST_TRAILING_BYTES");
    expect(errorCode(() => decodeManifestPlaintextV1(encoded.slice(0, -1)))).toBe("MANIFEST_FORMAT_INVALID");
  });

  it("rejects invalid UTF-8 and non-canonical entry order while decoding", () => {
    const encoded = encodeManifestPlaintextV1(manifest([entry("a.md", 1), entry("b.md", 2)]));
    const invalidUtf8 = encoded.slice();
    invalidUtf8[111] = 0xff;
    expect(errorCode(() => decodeManifestPlaintextV1(invalidUtf8))).toBe("ENTRY_PATH_ESCAPE");

    const descending = encoded.slice();
    const secondPathOffset = 107 + 74 + 4;
    descending[secondPathOffset] = 0x30;
    expect(errorCode(() => decodeManifestPlaintextV1(descending))).toBe("MANIFEST_FORMAT_INVALID");
  });
});
