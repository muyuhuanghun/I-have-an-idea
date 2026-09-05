// ADR-0026 §2.2-2.5: head directory behaviour — pointer signatures, INV-17 monotonicity,
// INV-18 rollback/fork rejection, and the devices.json registration boundary.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHeadRecordV1, type Bytes, type HeadError } from "@ekd/core";
import { WebCryptoDeviceSignatureProvider } from "../../crypto/src/device-signature.js";
import { HeadDirectory, encodeHeadPointerBytes } from "../src/head-directory.js";


const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

const DOMAIN = new Uint8Array(32).fill(0x41);
const DEVICE = new Uint8Array(16).fill(0x51);

interface TestDevice {
  readonly directory: HeadDirectory;
  readonly signer: WebCryptoDeviceSignatureProvider;
  readonly publicKeySpki: Bytes;
  readonly deviceId: Bytes;
}

async function makeDirectory(): Promise<TestDevice> {
  const root = await mkdtemp(join(tmpdir(), "ekd-head-dir-"));
  temporaryRoots.push(root);
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const signer = new WebCryptoDeviceSignatureProvider(new Uint8Array(pkcs8));
  const spkiBytes: Bytes = new Uint8Array(spki);
  const directory = new HeadDirectory(join(root, "head-dir"), {
    signPointer: async (pointer) => signer.signHead(encodeHeadPointerBytes(pointer)).then((signature) => Buffer.from(signature).toString("base64url")),
    verifier: {
      verifyHeadSignature: (signedBytes, signature, spkiBytesForHead) => signer.verifyHeadSignature(signedBytes, signature, spkiBytesForHead),
      verifyPointerSignature: (pointer, spkiBytesForPointer, signatureBase64url) =>
        signer.verifyHeadSignature(encodeHeadPointerBytes(pointer), new Uint8Array(Buffer.from(signatureBase64url, "base64url")), spkiBytesForPointer)
    }
  });
  await directory.ensureDirectory();
  await directory.registerDevice(DEVICE, Buffer.from(spki).toString("base64url"));
  return { directory, signer, publicKeySpki: spkiBytes, deviceId: DEVICE };
}

async function publishFixture(directory: HeadDirectory, signer: WebCryptoDeviceSignatureProvider, sequence: number, snapshotSeed: number, parentSeed: number) {
  const record = await createHeadRecordV1(
    {
      domainId: DOMAIN,
      snapshotId: new Uint8Array(32).fill(snapshotSeed),
      parentSnapshotId: new Uint8Array(32).fill(parentSeed),
      sequence,
      deviceId: DEVICE,
      createdAtUnix: 1_700_000_000_000 + sequence
    },
    signer
  );
  const headObjectKey = `head-object-${sequence}-${snapshotSeed.toString(16)}`;
  const store = {
    put: async (key: string, value: Bytes) => {
      await writeFile(join(directory.rootPath, `${key}.object`), value);
    },
    get: async (key: string) => {
      try {
        return new Uint8Array(await readFile(join(directory.rootPath, `${key}.object`)));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    }
  };
  await directory.publishHead(DOMAIN, record, headObjectKey, store);
  return { record, headObjectKey, store };
}

describe("HeadDirectory (ADR-0026, INV-17/18)", () => {
  it("registers devices, publishes heads and reads back the verified chain", async () => {
    const { directory, signer, publicKeySpki } = await makeDirectory();
    await expect(directory.readLatestHead(DOMAIN, { get: async () => undefined, put: async () => {} })).resolves.toBeUndefined();

    const { headObjectKey, store } = await publishFixture(directory, signer, 1, 0x11, 0x00);
    const latest = await directory.readLatestHead(DOMAIN, store);
    expect(latest).toBeDefined();
    expect(Number(latest!.record.sequence)).toBe(1);
    expect(latest!.pointer.head_object_key).toBe(headObjectKey);
    expect(await directory.registeredPublicKey(DEVICE)).toBe(Buffer.from(publicKeySpki).toString("base64url"));
    await expect(directory.localHighWaterMark(DOMAIN)).resolves.toBe(1);
  });

  it("rejects sequence rollback with HEAD_ROLLBACK_DETECTED", async () => {
    const { directory, signer } = await makeDirectory();
    await publishFixture(directory, signer, 2, 0x21, 0x00);
    await expect(publishFixture(directory, signer, 1, 0x22, 0x00)).rejects.toMatchObject({ code: "HEAD_ROLLBACK_DETECTED" });
  });

  it("rejects same-sequence forks with HEAD_FORK_DETECTED and complete evidence", async () => {
    const { directory, signer } = await makeDirectory();
    await publishFixture(directory, signer, 3, 0x31, 0x00);
    let forkMessage = "";
    try {
      await publishFixture(directory, signer, 3, 0x32, 0x00);
      expect.unreachable("fork must be rejected");
    } catch (error) {
      expect((error as HeadError).code).toBe("HEAD_FORK_DETECTED");
      forkMessage = error instanceof Error ? error.message : String(error);
    }
    const evidence = JSON.parse(forkMessage.slice(forkMessage.indexOf("{")));
    expect(evidence.incumbent_head_object_key).toContain("3");
    expect(evidence.challenger_head_object_key).toContain("3");
    expect(evidence.incumbent_head_object_key).not.toBe(evidence.challenger_head_object_key);
  });

  it("rejects tampered pointers and unregistered devices", async () => {
    const { directory, signer } = await makeDirectory();
    await publishFixture(directory, signer, 1, 0x41, 0x00);
    const pointerPath = join(directory.rootPath, (await directory.listPointerFiles())[0]);
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { sequence: number };
    await writeFile(pointerPath, `${JSON.stringify({ ...pointer, sequence: pointer.sequence + 5 }, null, 2)}\n`, "utf8");
    await expect(directory.readLatestHead(DOMAIN, { get: async () => undefined, put: async () => {} })).rejects.toMatchObject({ code: "HEAD_SIGNATURE_INVALID" });

    const stranger = await mkdtemp(join(tmpdir(), "ekd-head-stranger-"));
    temporaryRoots.push(stranger);
    const unregistered = new HeadDirectory(stranger, {
      signPointer: async () => "",
      verifier: { verifyHeadSignature: async () => true, verifyPointerSignature: async () => true }
    });
    const record = await createHeadRecordV1(
      { domainId: DOMAIN, snapshotId: new Uint8Array(32).fill(0x51), parentSnapshotId: new Uint8Array(32).fill(0), sequence: 1, deviceId: DEVICE, createdAtUnix: 0 },
      signer
    );
    await expect(unregistered.publishHead(DOMAIN, record, "head-object-1", { get: async () => undefined, put: async () => {} }))
      .rejects.toMatchObject({ code: "HEAD_DEVICE_UNREGISTERED" });
  });
});
