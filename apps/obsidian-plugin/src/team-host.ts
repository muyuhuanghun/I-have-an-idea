// ADR-0039: team product orchestrator for the Obsidian plugin. Owns the T2 registry
// views, the proposal store and the device's content-DH identity (localStorage), and
// exposes refresh/submit/approve to the team panel. Console stays read-only; the DH
// private key never leaves localStorage + memory. The device's ECDSA signer doubles
// as the signature verifier against the authority public key from settings.
import {
  TeamProtocolError,
  base64UrlToBytes,
  bytesToBase64Url,
  encodeProposalReviewersBytes,
  type CryptoProvider,
  type DeviceSignaturePort,
  type KeyAgreementPort
} from "@ekd/core";
import { GroupStateRegistryFile, ProposalReviewersRegistryFile } from "@ekd/adapters/team-registry";
import { ProposalStore, type ProposalSummary } from "@ekd/adapters/proposal-store";
import { join } from "node:path";
import { WebCryptoDeviceSignatureProvider } from "@ekd/crypto";

export interface TeamHostDeps {
  readonly domainIdSha256: string;
  readonly teamStateDir: string;
  readonly teamDeviceId: string;
  readonly authoritySpkiBase64url: string;
  readonly keyAgreement: KeyAgreementPort;
  readonly aead: CryptoProvider;
  /** Reviewer proposal-signing key (PKCS8, base64url), when this device is a reviewer. */
  readonly reviewerPrivateKeyPkcs8Base64url: string | undefined;
  /** Reviewer id (64 hex) bound in proposal-reviewers.json, when this device is a reviewer. */
  readonly reviewerId: string | undefined;
}

export interface TeamSnapshot {
  readonly epoch: number;
  readonly memberCount: number;
  readonly proposals: readonly ProposalSummary[];
  readonly isReviewer: boolean;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (c?.subtle === undefined) throw new TeamProtocolError("GRP_MEMBER_NOT_ACTIVE", "WebCrypto subtle is unavailable.");
  const digest = await c.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Buffer.from(digest).toString("hex");
}

export class TeamHost {
  readonly #deps: TeamHostDeps;
  readonly #signer: DeviceSignaturePort;
  readonly #reviewers: ProposalReviewersRegistryFile;
  readonly #group: GroupStateRegistryFile;
  readonly #proposals: ProposalStore;

  constructor(deps: TeamHostDeps) {
    this.#deps = deps;
    // Verify-only placeholder device: the empty PKCS8 is never imported because
    // verifyHeadSignature imports the SPKI argument, and approve() is gated on the
    // reviewer identity before any sign call.
    this.#signer = deps.reviewerPrivateKeyPkcs8Base64url !== undefined
      ? new WebCryptoDeviceSignatureProvider(base64UrlToBytes(deps.reviewerPrivateKeyPkcs8Base64url))
      : new WebCryptoDeviceSignatureProvider(new Uint8Array(0));
    this.#reviewers = new ProposalReviewersRegistryFile(join(deps.teamStateDir, "proposal-reviewers.json"), deps.domainIdSha256, {
      verifier: this.#signer,
      authoritySpki: base64UrlToBytes(deps.authoritySpkiBase64url),
      signer: this.#signer
    });
    this.#group = new GroupStateRegistryFile(join(deps.teamStateDir, "group-state.json"), base64UrlToBytes(deps.domainIdSha256), {
      verifier: this.#signer,
      authoritySpki: base64UrlToBytes(deps.authoritySpkiBase64url),
      signer: this.#signer,
      keyAgreement: deps.keyAgreement
    });
    this.#proposals = new ProposalStore({ proposalsDir: join(deps.teamStateDir, "proposals"), aead: deps.aead });
  }

  async refresh(): Promise<TeamSnapshot> {
    const state = await this.#group.load();
    if (state === undefined) {
      throw new TeamProtocolError("GRP_NOT_A_MEMBER", "团队域状态不存在；请确认目录与权限，或先由所有者初始化团队域。");
    }
    const cek = await this.#unwrapCek(state.epoch);
    const proposals = await this.#proposals.list(cek);
    const isReviewer = this.#deps.reviewerId !== undefined && this.#deps.reviewerPrivateKeyPkcs8Base64url !== undefined;
    return { epoch: state.epoch, memberCount: state.members.length, proposals, isReviewer };
  }

  async submit(input: { title: string; content: string }): Promise<ProposalSummary> {
    const state = await this.#group.load();
    if (state === undefined) throw new TeamProtocolError("GRP_NOT_A_MEMBER", "团队域状态不存在。");
    const cek = await this.#unwrapCek(state.epoch);
    return this.#proposals.submit({
      proposalId: bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16))),
      epoch: state.epoch,
      authorDeviceId: this.#deps.teamDeviceId,
      epochCek: cek,
      title: input.title,
      content: input.content
    });
  }

  async approve(proposalId: string): Promise<void> {
    if (this.#deps.reviewerId === undefined || this.#deps.reviewerPrivateKeyPkcs8Base64url === undefined) {
      throw new TeamProtocolError("PRO_REVIEWER_UNREGISTERED", "本设备没有审核者审批密钥。");
    }
    const state = await this.#group.load();
    if (state === undefined) throw new TeamProtocolError("GRP_NOT_A_MEMBER", "团队域状态不存在。");
    const cek = await this.#unwrapCek(state.epoch);
    const registry = await this.#reviewers.load();
    if (registry === undefined) throw new TeamProtocolError("PRO_REVIEWER_UNREGISTERED", "审核者注册表不存在。");
    await this.#proposals.appendApproval({
      proposalId,
      epochCek: cek,
      registry,
      registryStateSha256: await sha256Hex(encodeProposalReviewersBytes(registry)),
      reviewerDeviceId: this.#deps.reviewerId,
      reviewerSigner: this.#signer
    });
  }

  #dhStorageKey(): string {
    return `ekd:team-dh-pkcs8:${this.#deps.teamDeviceId}`;
  }

  async #unwrapCek(epoch: number): Promise<Uint8Array> {
    const dhPrivateB64 = localStorage.getItem(this.#dhStorageKey());
    if (typeof dhPrivateB64 !== "string") {
      throw new TeamProtocolError("GRP_MEMBER_NOT_ACTIVE", "本设备没有团队内容密钥；请先由所有者承认本设备，或导入设备密钥。");
    }
    return this.#group.unwrapEpochCek(this.#deps.teamDeviceId, base64UrlToBytes(dhPrivateB64), epoch);
  }
}
