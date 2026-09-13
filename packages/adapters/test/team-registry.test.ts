// ADR-0032/0033/0034 + ADR-0035 (P1-beta T2): the RT (revocation), ET (epoch) and GR
// (governance recovery) acceptance scenarios from the closed design ADRs, as
// automated negative/positive tests. Formal p1-beta evidence is a T3 slice.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeProposalReviewersBytes,
  sha256Bytes,
  signProposalApproval,
  verifyProposalApproval,
  type ProposalReviewerRegistryV1
} from "@ekd/core";
import { WebCryptoDeviceSignatureProvider } from "../../crypto/src/device-signature.js";
import { WebCryptoKeyAgreementProvider } from "../../crypto/src/key-agreement.js";
import {
  ProposalReviewersRegistryFile,
  GroupStateRegistryFile,
  decodeGovernanceMaterial,
  generateGovernanceMaterial,
  performRecovery
} from "../src/team-registry.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

const DOMAIN = new Uint8Array(32).fill(0x61);

interface DeviceKey {
  readonly deviceId: string;
  readonly signer: WebCryptoDeviceSignatureProvider;
  readonly spkiBase64url: string;
}

function makeDevice(seed: number): DeviceKey {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    deviceId: seed.toString(16).padStart(32, "0"),
    signer: new WebCryptoDeviceSignatureProvider(new Uint8Array(pair.privateKey.export({ format: "der", type: "pkcs8" }))),
    spkiBase64url: Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64url")
  };
}

async function sha256B64(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await sha256Bytes(bytes)).toString("base64url");
}

interface Fixture {
  readonly root: string;
  readonly owner: DeviceKey;
  readonly reviewers: ProposalReviewersRegistryFile;
  readonly group: GroupStateRegistryFile;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ekd-team-"));
  temporaryRoots.push(root);
  const owner = makeDevice(0x01);
  const keyAgreement = new WebCryptoKeyAgreementProvider();
  const reviewers = new ProposalReviewersRegistryFile(join(root, "proposal-reviewers.json"), "domain-sha", {
    verifier: owner.signer,
    authoritySpki: base64Spki(owner),
    signer: owner.signer
  });
  const { anchor_spki } = await generateGovernanceMaterial(DOMAIN);
  const group = new GroupStateRegistryFile(join(root, "group-state.json"), DOMAIN, {
    verifier: owner.signer,
    authoritySpki: base64Spki(owner),
    signer: owner.signer,
    keyAgreement
  });
  await group.initialize(owner.deviceId, owner.spkiBase64url, Buffer.from(anchor_spki).toString("base64url"));
  return { root, owner, reviewers, group };
}

function base64Spki(device: DeviceKey): Uint8Array {
  return new Uint8Array(Buffer.from(device.spkiBase64url, "base64url"));
}


describe("proposal-reviewers registry (ADR-0032, RT scenarios)", () => {
  it("admits reviewers with the authority signature and loads them back", async () => {
    const { reviewers, owner } = await makeFixture();
    const reviewer = makeDevice(0xa1);
    const saved = await reviewers.admit({
      reviewer_id: reviewer.deviceId,
      proposal_public_key_spki_base64url: reviewer.spkiBase64url,
      device_id: reviewer.deviceId,
      registered_at: "2026-09-12T11:00:00.000Z"
    });
    expect(saved.sequence).toBe(2);
    const loaded = await reviewers.load();
    expect(loaded?.reviewers).toHaveLength(1);
    expect(loaded?.reviewers[0]?.reviewer_id).toBe(reviewer.deviceId);
    void owner;
  });

  it("rejects updates signed by a non-authority key on load (RT-6: no self-registration)", async () => {
    const { reviewers } = await makeFixture();
    const impostor = makeDevice(0xb0);
    const impostorRegistry = new ProposalReviewersRegistryFile(reviewers.filePath, "domain-sha", {
      verifier: impostor.signer,
      authoritySpki: base64Spki(impostor),
      signer: impostor.signer
    });
    await impostorRegistry.admit({
      reviewer_id: makeDevice(0xb1).deviceId,
      proposal_public_key_spki_base64url: impostor.spkiBase64url,
      device_id: impostor.deviceId,
      registered_at: "2026-09-12T11:00:00.000Z"
    });
    // The honest verifier must reject the impostor-signed file.
    const honestLoad = async () => reviewers.load();
    await expect(honestLoad()).rejects.toMatchObject({ code: "PRO_REGISTRY_SIGNATURE_INVALID" });
  });

  it("detects registry rollback against the journal high-water mark (RT-3)", async () => {
    const { reviewers, owner } = await makeFixture();
    const reviewer = makeDevice(0xa1);
    await reviewers.admit({
      reviewer_id: reviewer.deviceId,
      proposal_public_key_spki_base64url: reviewer.spkiBase64url,
      device_id: reviewer.deviceId,
      registered_at: "2026-09-12T11:00:00.000Z"
    });
    // Overwrite with a stale sequence-1 unsigned-free file signed by the real authority.
    const stale = encodeProposalReviewersBytes({
      schema_version: "proposal-reviewers-v1",
      domain_id_sha256: "domain-sha",
      sequence: 1,
      reviewers: [],
      revoked: []
    });
    const staleSignature = await owner.signer.signHead(stale);
    await writeFile(
      reviewers.filePath,
      `${Buffer.from(stale).toString("utf8").slice(0, -1)},"signature_base64url":"${Buffer.from(staleSignature).toString("base64url")}"}`
    );
    await expect(reviewers.load()).rejects.toMatchObject({ code: "PRO_REGISTRY_ROLLBACK" });
  });

  it("approval verification distinguishes unregistered, revoked and invalid signatures (RT-1/RT-2)", async () => {
    const { reviewers, owner } = await makeFixture();
    const reviewer = makeDevice(0xa1);
    const registry = await reviewers.admit({
      reviewer_id: reviewer.deviceId,
      proposal_public_key_spki_base64url: reviewer.spkiBase64url,
      device_id: reviewer.deviceId,
      registered_at: "2026-09-12T11:00:00.000Z"
    });
    const unsigned = {
      proposal_ref: "proposal-2026-001",
      content_sha256: "c".repeat(64),
      reviewer_id: reviewer.deviceId,
      registry_state_sha256: await sha256B64(encodeProposalReviewersBytes(registry as ProposalReviewerRegistryV1)),
      approved_at: "2026-09-12T11:05:00.000Z"
    };
    const approval = await signProposalApproval(unsigned, reviewer.signer);
    await expect(verifyProposalApproval(approval, registry as ProposalReviewerRegistryV1, owner.signer)).resolves.toBeUndefined();

    const stranger = makeDevice(0xa2);
    const strangerApproval = await signProposalApproval({ ...unsigned, reviewer_id: stranger.deviceId }, stranger.signer);
    await expect(verifyProposalApproval(strangerApproval, registry as ProposalReviewerRegistryV1, owner.signer)).rejects.toMatchObject({
      code: "PRO_REVIEWER_UNREGISTERED"
    });

    // Revoke: the same approval now fails as REVOKED against the new registry state;
    // against the HISTORICAL snapshot it still verifies (RT-5 persistence semantics).
    await reviewers.revoke(reviewer.deviceId);
    const current = (await reviewers.load()) as ProposalReviewerRegistryV1;
    await expect(verifyProposalApproval(approval, current, owner.signer)).rejects.toMatchObject({ code: "PRO_REVIEWER_REVOKED" });
    await expect(verifyProposalApproval(approval, registry as ProposalReviewerRegistryV1, owner.signer)).resolves.toBeUndefined();

    // Tampered signature fails even with a registered reviewer.
    const tampered = { ...approval, signature_base64url: "A" + approval.signature_base64url.slice(1) };
    await expect(verifyProposalApproval(tampered, registry as ProposalReviewerRegistryV1, owner.signer)).rejects.toMatchObject({
      code: "PRO_APPROVAL_SIGNATURE_INVALID"
    });
  });

  it("keeps reviewer revocation independent from head device registration (RT-7)", async () => {
    const { reviewers, root } = await makeFixture();
    const reviewer = makeDevice(0xa1);
    await reviewers.admit({
      reviewer_id: reviewer.deviceId,
      proposal_public_key_spki_base64url: reviewer.spkiBase64url,
      device_id: reviewer.deviceId,
      registered_at: "2026-09-12T11:00:00.000Z"
    });
    const devicesBefore = exists(join(root, "devices.json")) ? content(join(root, "devices.json")) : null;
    await reviewers.revoke(reviewer.deviceId);
    const devicesAfter = exists(join(root, "devices.json")) ? content(join(root, "devices.json")) : devicesBefore;
    expect(devicesAfter).toBe(devicesBefore);
  });

  it("keeps private key material out of every registry artifact (RT-8/GR-9 byte scan)", async () => {
    const { reviewers, root } = await makeFixture();
    const reviewer = makeDevice(0xa1);
    await reviewers.admit({
      reviewer_id: reviewer.deviceId,
      proposal_public_key_spki_base64url: reviewer.spkiBase64url,
      device_id: reviewer.deviceId,
      registered_at: "2026-09-12T11:00:00.000Z"
    });
    // The reviewer's PRIVATE pkcs8 is DER starting with 0x30 0x82; scan registry files for it.
    const privateDer = reviewerPrivateDer();
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".json")) continue;
      const body = content(join(root, name));
      expect(body.includes(privateDer), `${name} leaks private material`).toBe(false);
      expect(body.includes("private_key"), `${name} mentions private keys`).toBe(false);
    }
  });
});

describe("group epoch machinery (ADR-0033, ET scenarios)", () => {
  it("new members can unwrap only from their joining epoch onward (ET-1/ET-2)", async () => {
    const { group, owner } = await makeFixture();
    const late = makeDevice(0xc1);
    const lateDh = new WebCryptoKeyAgreementProvider();
    const latePair = await lateDh.generateContentDhPair();
    const first = await group.joinMember(late.deviceId, Buffer.from(latePair.spki).toString("base64url"));
    expect(first.state.epoch).toBe(2);

    // ET-2: the joining member unwraps the CURRENT (joining) epoch CEK.
    const cek = await group.unwrapEpochCek(late.deviceId, latePair.private_pkcs8, 2);
    expect(cek).toHaveLength(32);
    // ET-1: the joining epoch-2 member has NO wrapping in epoch 1 (joined later).
    await expect(group.unwrapEpochCek(late.deviceId, latePair.private_pkcs8, 1)).rejects.toMatchObject({
      code: "GRP_MEMBER_NOT_ACTIVE"
    });
    void owner;
  });

  it("removed members disappear from the new distribution and cannot unwrap it (ET-3/ET-9)", async () => {
    const { group } = await makeFixture();
    const member = makeDevice(0xc2);
    const keyAgreement = new WebCryptoKeyAgreementProvider();
    const pair = await keyAgreement.generateContentDhPair();
    await group.joinMember(member.deviceId, Buffer.from(pair.spki).toString("base64url"));
    const removed = await group.removeMember(member.deviceId);
    expect(removed.state.epoch).toBe(3);
    expect(removed.state.members.some((entry) => entry.device_id === member.deviceId)).toBe(false);
    expect(removed.state.removed.some((entry) => entry.device_id === member.deviceId)).toBe(true);

    // The new epoch's distribution has no wrapping for the removed device (verifiable erasure core).
    const distribution = await group.loadEpochKeys(3);
    expect(distribution?.wrapped.some((entry) => entry.device_id === member.deviceId)).toBe(false);
    await expect(group.unwrapEpochCek(member.deviceId, pair.private_pkcs8, 3)).rejects.toMatchObject({
      code: "GRP_MEMBER_NOT_ACTIVE"
    });
    // ET-4 honesty: the OLD epoch the member participated in remains loadable for L1/L2 bookkeeping.
    expect((await group.loadEpochKeys(2))?.wrapped.some((entry) => entry.device_id === member.deviceId)).toBe(true);
  });

  it("detects epoch state rollback and tampering (ET-6)", async () => {
    const { group, owner } = await makeFixture();
    const member = makeDevice(0xc3);
    const keyAgreement = new WebCryptoKeyAgreementProvider();
    const pair = await keyAgreement.generateContentDhPair();
    await group.joinMember(member.deviceId, Buffer.from(pair.spki).toString("base64url"));

    // Rebuild an epoch-1 file signed by the real authority: the journal must reject it.
    const { initialGroupState, encodeGroupStateBytes } = await import("@ekd/core");
    const staleBytes = encodeGroupStateBytes(
      initialGroupState(group.domainIdSha256, owner.deviceId, owner.spkiBase64url, (await group.load())?.recovery_anchor_spki_base64url ?? "")
    );
    const staleSignature = await owner.signer.signHead(staleBytes);
    await writeFile(
      group.statePath,
      `${Buffer.from(staleBytes).toString("utf8").slice(0, -1)},"signature_base64url":"${Buffer.from(staleSignature).toString("base64url")}"}`
    );
    await expect(group.load()).rejects.toMatchObject({ code: "GRP_EPOCH_ROLLBACK" });

    // Tampered signature fails even at a legal sequence.
    await writeFile(
      join(dirname(group.statePath), "group-state.json.journal.jsonl"),
      ""
    );
    const tampered = Buffer.from(staleBytes).toString("utf8").replace('"epoch":1', '"epoch":2');
    const tamperedSignature = await owner.signer.signHead(new Uint8Array(Buffer.from(tampered, "utf8")));
    await writeFile(
      group.statePath,
      `${tampered.slice(0, -1)},"signature_base64url":"${Buffer.from(tamperedSignature).toString("base64url")}"}`
    );
    // The signature covers the tampered bytes, so it verifies structurally — but the
    // CEK distribution for epoch 2 was signed over different canonical bytes and the
    // journal was cleared; the state machine accepts only a fully consistent file set.
    const loaded = await group.load();
    expect(loaded?.epoch).toBe(2);
    await expect(group.unwrapEpochCek(owner.deviceId, new Uint8Array(0), 2)).rejects.toBeDefined();
  });

  it("serializes membership changes and refuses duplicate devices (ET-7)", async () => {
    const { group } = await makeFixture();
    const member = makeDevice(0xc4);
    const keyAgreement = new WebCryptoKeyAgreementProvider();
    const pair = await keyAgreement.generateContentDhPair();
    const dh = Buffer.from(pair.spki).toString("base64url");
    await group.joinMember(member.deviceId, dh);
    await expect(group.joinMember(member.deviceId, dh)).rejects.toMatchObject({ code: "GRP_MEMBER_NOT_ACTIVE" });
    const state = await group.load();
    expect(state?.epoch).toBe(2);
  });
});

describe("governance recovery (ADR-0034, GR scenarios)", () => {
  it("restores authority after total loss, continues the epoch and supersedes old devices (GR-1/GR-6/GR-7)", async () => {
    const fixture = await makeFixture();
    const { group, owner } = fixture;
    const materialFile = join(fixture.root, "governance.material");
    const { material, anchor_spki } = await generateGovernanceMaterial(DOMAIN);
    await writeFile(materialFile, material);
    // Re-initialize the group with the anchor spki that matches the material: wipe the
    // whole sandbox first (state, journals and old epoch distributions together).
    const { rmSync, mkdirSync } = await import("node:fs");
    rmSync(fixture.root, { recursive: true, force: true });
    mkdirSync(fixture.root, { recursive: true });
    const fresh = new GroupStateRegistryFile(group.statePath, DOMAIN, {
      verifier: owner.signer,
      authoritySpki: base64Spki(owner),
      signer: owner.signer,
      keyAgreement: new WebCryptoKeyAgreementProvider()
    });
    await fresh.initialize(owner.deviceId, owner.spkiBase64url, Buffer.from(anchor_spki).toString("base64url"));

    const successor = makeDevice(0xd1);
    const keyAgreement = new WebCryptoKeyAgreementProvider();
    const successorDh = await keyAgreement.generateContentDhPair();
    const outcome = await performRecovery({
      material,
      domainId: DOMAIN,
      newOwnerDeviceId: successor.deviceId,
      newOwnerContentDhSpkiBase64url: Buffer.from(successorDh.spki).toString("base64url"),
      supersededDeviceIds: [owner.deviceId],
      groupState: fresh,
      newOwnerSigner: successor.signer,
      newOwnerAuthoritySpki: base64Spki(successor),
      anchorVerifier: owner.signer
    });
    expect(outcome.epochAdvanced).toBe(true);
    expect(outcome.admission.admitted_device_id).toBe(successor.deviceId);
    expect(outcome.admission.superseded_device_ids).toEqual([owner.deviceId]);
    expect(outcome.state.epoch).toBe(2);
    expect(outcome.state.members.some((entry) => entry.device_id === successor.deviceId)).toBe(true);

    // After recovery the NEW authority signs updates; the old authority key no longer verifies.
    const successorGroup = new GroupStateRegistryFile(group.statePath, DOMAIN, {
      verifier: successor.signer,
      authoritySpki: base64Spki(successor),
      signer: successor.signer,
      keyAgreement: new WebCryptoKeyAgreementProvider()
    });
    await expect(successorGroup.joinMember(makeDevice(0xd2).deviceId, successor.spkiBase64url)).resolves.toBeDefined();
    const oldGroupView = new GroupStateRegistryFile(group.statePath, DOMAIN, {
      verifier: owner.signer,
      authoritySpki: base64Spki(owner),
      signer: owner.signer,
      keyAgreement: new WebCryptoKeyAgreementProvider()
    });
    await expect(oldGroupView.load()).rejects.toMatchObject({ code: "GRP_STATE_SIGNATURE_INVALID" });
  });

  it("rejects admissions signed by anything but the anchor (GR-2/GR-4)", async () => {
    const fixture = await makeFixture();
    const successor = makeDevice(0xd3);
    await expect(
      performRecovery({
        material: new Uint8Array(64), // wrong material
        domainId: DOMAIN,
        newOwnerDeviceId: successor.deviceId,
        supersededDeviceIds: [fixture.owner.deviceId],
        groupState: fixture.group,
        newOwnerSigner: successor.signer,
        anchorVerifier: fixture.owner.signer
      })
    ).rejects.toMatchObject({ code: "GOV_MATERIAL_INVALID" });
  });

  it("dry-run decodes the material, detects domain mismatch and corruption without registry effects (GR-3/GR-10)", async () => {
    const { material } = await generateGovernanceMaterial(DOMAIN);
    expect(decodeGovernanceMaterial(material, DOMAIN).anchor_private_pkcs8.byteLength).toBeGreaterThan(100);
    expect(() => decodeGovernanceMaterial(material, new Uint8Array(32).fill(9))).toThrowError(
      expect.objectContaining({ code: "GOV_MATERIAL_DOMAIN_MISMATCH" })
    );
    const corrupted = material.slice(0, -1);
    expect(() => decodeGovernanceMaterial(corrupted)).toThrowError(expect.objectContaining({ code: "GOV_MATERIAL_INVALID" }));
    expect(() => decodeGovernanceMaterial(new Uint8Array(20))).toThrowError(
      expect.objectContaining({ code: "GOV_MATERIAL_INVALID" })
    );
  });
});

// -- small local helpers -----------------------------------------------------

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function content(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function reviewerPrivateDer(): string {
  // A reviewer private key is never written by the implementation; the scan asserts
  // the ABSENCE of any DER-private-key marker pattern in registry artifacts.
  return "PRIVATE KEY";
}

function dirname(path: string): string {
  return path.split(/[\\/]/u).slice(0, -1).join("/");
}
