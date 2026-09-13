// ADR-0039 (P1-beta product wiring): the proposal content layer — seal under the
// epoch CEK, list/read, approval append with registry-state binding, wrong-key and
// AAD binding rejection.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProposalReviewerRegistryV1 } from "@ekd/core";
import { WebCryptoAes256Provider } from "../../crypto/src/webcrypto.js";
import { WebCryptoDeviceSignatureProvider } from "../../crypto/src/device-signature.js";
import { ProposalStore } from "../src/proposal-store.js";

const temporaryRoots: string[] = [];
const aead = new WebCryptoAes256Provider();

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

async function makeStore(): Promise<{ store: ProposalStore; proposalsDir: string; cek: Uint8Array; wrongCek: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), "ekd-proposal-"));
  temporaryRoots.push(root);
  const proposalsDir = join(root, "proposals");
  return {
    store: new ProposalStore({ proposalsDir, aead }),
    proposalsDir,
    cek: randomBytes(32),
    wrongCek: randomBytes(32)
  };
}

// The registry reviewer uses a REAL key pair; its signer is kept for approval tests.
const reviewerPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const reviewerSpki = Buffer.from(reviewerPair.publicKey.export({ format: "der", type: "spki" })).toString("base64url");
const registrySigner = new WebCryptoDeviceSignatureProvider(
  new Uint8Array(reviewerPair.privateKey.export({ format: "der", type: "pkcs8" }))
);
const registry: ProposalReviewerRegistryV1 = {
  schema_version: "proposal-reviewers-v1",
  domain_id_sha256: "a".repeat(64),
  sequence: 2,
  reviewers: [
    {
      reviewer_id: "2".repeat(64),
      proposal_public_key_spki_base64url: reviewerSpki,
      device_id: "2".repeat(32),
      registered_at: "2026-09-12T11:00:00.000Z"
    }
  ],
  revoked: [],
  signature_base64url: "x".repeat(86)
};

function makeSigner(): WebCryptoDeviceSignatureProvider {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return new WebCryptoDeviceSignatureProvider(new Uint8Array(pair.privateKey.export({ format: "der", type: "pkcs8" })));
}

describe("ProposalStore (ADR-0039)", () => {
  it("submits, lists and reads proposals sealed under the epoch CEK", async () => {
    const { store, cek, proposalsDir } = await makeStore();
    const summary = await store.submit({
      proposalId: randomBytes(16).toString("hex"),
      epoch: 2,
      authorDeviceId: "1".repeat(32),
      epochCek: cek,
      title: "引入提案模板",
      content: "提案正文内容"
    });
    expect(summary.title).toBe("引入提案模板");
    const list = await store.list(cek);
    expect(list).toHaveLength(1);
    const full = await store.read(summary.proposal_id, cek);
    expect(full.content).toBe("提案正文内容");
    expect(full.approvals).toEqual([]);
    // The artifact on disk must not contain plaintext content or title.
    const raw = await readFile(join(proposalsDir, `${summary.proposal_id}.proposal`), "utf8");
    expect(raw).not.toContain("提案正文内容");
    expect(raw).not.toContain("引入提案模板");
  });

  it("rejects decryption under a wrong CEK (fail closed)", async () => {
    const { store, cek, wrongCek } = await makeStore();
    const submitted = await store.submit({
      proposalId: randomBytes(16).toString("hex"),
      epoch: 2,
      authorDeviceId: "1".repeat(32),
      epochCek: cek,
      title: "t",
      content: "c"
    });
    await expect(store.read(submitted.proposal_id, wrongCek)).rejects.toMatchObject({
      code: "GRP_WRAP_DECRYPT_FAILED"
    });
    // Unreadable artifacts are skipped in list (never faked as readable).
    await expect(store.list(wrongCek)).resolves.toEqual([]);
  });

  it("appends approvals with registry-state binding and rejects double approval", async () => {
    const { store, cek } = await makeStore();
    const submitted = await store.submit({
      proposalId: randomBytes(16).toString("hex"),
      epoch: 2,
      authorDeviceId: "1".repeat(32),
      epochCek: cek,
      title: "t",
      content: "c"
    });
    const stateHash = "a".repeat(43);
    const after = await store.appendApproval({
      proposalId: submitted.proposal_id,
      epochCek: cek,
      registry,
      registryStateSha256: stateHash,
      reviewerDeviceId: "2".repeat(64),
      reviewerSigner: registrySigner
    });
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]?.registry_state_sha256).toBe(stateHash);
    await expect(
      store.appendApproval({
        proposalId: submitted.proposal_id,
        epochCek: cek,
        registry,
        registryStateSha256: stateHash,
        reviewerDeviceId: "2".repeat(64),
        reviewerSigner: registrySigner
      })
    ).rejects.toMatchObject({ code: "PRO_APPROVAL_SIGNATURE_INVALID" });
  });

  it("verifies approval signatures against the registry and rejects foreign reviewers", async () => {
    const { store, cek } = await makeStore();
    const submitted = await store.submit({
      proposalId: randomBytes(16).toString("hex"),
      epoch: 2,
      authorDeviceId: "1".repeat(32),
      epochCek: cek,
      title: "t",
      content: "c"
    });
    await store.appendApproval({
      proposalId: submitted.proposal_id,
      epochCek: cek,
      registry,
      registryStateSha256: "a".repeat(43),
      reviewerDeviceId: "2".repeat(64),
      reviewerSigner: registrySigner
    });
    const ok = await store.verifyApprovals({
      proposalId: submitted.proposal_id,
      epochCek: cek,
      registry,
      verifier: registrySigner
    });
    expect(ok.allValid).toBe(true);
    expect(ok.total).toBe(1);
    // A foreign reviewer with no registry entry counts as invalid.
    const foreign = makeSigner();
    await store.appendApproval({
      proposalId: submitted.proposal_id,
      epochCek: cek,
      registry,
      registryStateSha256: "a".repeat(43),
      reviewerDeviceId: "9".repeat(64),
      reviewerSigner: foreign
    });
    const after = await store.verifyApprovals({
      proposalId: submitted.proposal_id,
      epochCek: cek,
      registry,
      verifier: foreign
    });
    expect(after.allValid).toBe(false);
    expect(after.invalid).toBe(1);
  });

  it("keeps readable artifacts readable when a sibling artifact is corrupt", async () => {
    const { store, cek, proposalsDir } = await makeStore();
    const a = await store.submit({
      proposalId: "a".repeat(32),
      epoch: 2,
      authorDeviceId: "1".repeat(32),
      epochCek: cek,
      title: "A",
      content: "content-a"
    });
    await writeFile(join(proposalsDir, "corrupt.proposal"), "{ broken", "utf8");
    const list = await store.list(cek);
    expect(list).toHaveLength(1);
    expect(list[0]?.proposal_id).toBe(a.proposal_id);
  });

  it("binds the AAD to the proposal id: ciphertext from one proposal fails on another", async () => {
    const { store, cek, proposalsDir } = await makeStore();
    const a = await store.submit({
      proposalId: "a".repeat(32),
      epoch: 2,
      authorDeviceId: "1".repeat(32),
      epochCek: cek,
      title: "A",
      content: "content-a"
    });
    const bId = "b".repeat(32);
    // Copy a's ciphertext envelope over b's id: the AAD mismatch must fail decryption.
    const raw = await readFile(join(proposalsDir, `${a.proposal_id}.proposal`), "utf8");
    await writeFile(
      join(proposalsDir, `${bId}.proposal`),
      raw.replace(`"proposal_id": "${a.proposal_id}"`, `"proposal_id": "${bId}"`),
      "utf8"
    );
    await expect(store.read(bId, cek)).rejects.toMatchObject({ code: "GRP_WRAP_DECRYPT_FAILED" });
  });
});
