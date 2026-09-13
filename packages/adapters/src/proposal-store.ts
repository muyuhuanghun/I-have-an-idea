// ADR-0039 (P1-beta product wiring): the proposal content layer on top of the T2
// team-protocol registries. Proposals are AES-256-GCM objects sealed under the
// current epoch CEK (AAD binds proposal id), stored one-file-per-proposal in the
// team domain state directory. Approvals are ADR-0032 signature records appended
// into the proposal object, which is then re-sealed. Registry/migrator layers never
// see plaintext; only active members holding the epoch CEK can read.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  TeamProtocolError,
  type CryptoProvider,
  type DeviceSignaturePort,
  type ProposalReviewerRegistryV1
} from "@ekd/core";

const PROPOSAL_SCHEMA_VERSION = "team-proposal-v1";

export interface TeamProposalRecordV1 {
  readonly schema_version: typeof PROPOSAL_SCHEMA_VERSION;
  readonly proposal_id: string;
  readonly epoch: number;
  readonly author_device_id: string;
  readonly created_at: string;
  readonly title: string;
  readonly content: string;
  readonly approvals: readonly ProposalApprovalRecordV1[];
}

export interface ProposalApprovalRecordV1 {
  readonly reviewer_id: string;
  readonly registry_state_sha256: string;
  readonly signature_base64url: string;
  readonly approved_at: string;
}

export interface ProposalSummary {
  readonly proposal_id: string;
  readonly epoch: number;
  readonly author_device_id: string;
  readonly created_at: string;
  readonly title: string;
  readonly approvals: readonly ProposalApprovalRecordV1[];
}

export interface ProposalStoreOptions {
  /** Team domain state directory (the T2 registries' directory). */
  readonly proposalsDir: string;
  /** The project's standard AEAD provider (AES-256-GCM), keyed by callers with the epoch CEK. */
  readonly aead: CryptoProvider;
}

function proposalPath(options: ProposalStoreOptions, proposalId: string): string {
  if (!/^[0-9a-f]{32}$/u.test(proposalId)) {
    throw new TeamProtocolError("GRP_MEMBER_NOT_ACTIVE", "Proposal id must be 32 lowercase hexadecimal characters.");
  }
  return join(options.proposalsDir, `${proposalId}.proposal`);
}

function aadFor(proposalId: string): Uint8Array {
  return new TextEncoder().encode(`team-proposal-v1:${proposalId}`);
}

function sha256Hex(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return createHash("sha256").update(binary, "binary").digest("hex");
}

function canonicalApprovalJson(value: unknown): string {
  return JSON.stringify(value);
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // missing directory = no proposals yet
  }
}

function approvalCanonicalBytes(input: {
  proposalId: string;
  epoch: number;
  contentSha256: string;
  reviewerId: string;
  registryStateSha256: string;
  approvedAt: string;
}): Uint8Array {
  return new TextEncoder().encode(
    canonicalApprovalJson({
      proposal_id: input.proposalId,
      epoch: input.epoch,
      content_sha256: input.contentSha256,
      reviewer_id: input.reviewerId,
      registry_state_sha256: input.registryStateSha256,
      approved_at: input.approvedAt
    })
  );
}

export class ProposalStore {
  readonly #options: ProposalStoreOptions;

  constructor(options: ProposalStoreOptions) {
    this.#options = options;
  }

  /** Submits a new proposal: seal under the epoch CEK and persist one file. */
  async submit(input: {
    proposalId: string;
    epoch: number;
    authorDeviceId: string;
    epochCek: Uint8Array;
    title: string;
    content: string;
  }): Promise<ProposalSummary> {
    const record: TeamProposalRecordV1 = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      proposal_id: input.proposalId,
      epoch: input.epoch,
      author_device_id: input.authorDeviceId,
      created_at: new Date().toISOString(),
      title: input.title,
      content: input.content,
      approvals: []
    };
    await this.#write(record, input.epochCek);
    return this.#summary(record);
  }

  /** Lists proposals by decrypting each file (active members can read all proposals). */
  async list(epochCek: Uint8Array): Promise<ProposalSummary[]> {
    const summaries: ProposalSummary[] = [];
    for (const name of readdirSafe(this.#options.proposalsDir)) {
      if (!name.endsWith(".proposal")) continue;
      try {
        const record = await this.#decode(name, epochCek);
        summaries.push(this.#summary(record));
      } catch (error) {
        if (error instanceof TeamProtocolError) continue; // unreadable artifact (e.g. sync conflict) — show nothing rather than fake data
        throw error;
      }
    }
    return summaries.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Reads the full proposal (content + approvals). */
  async read(proposalId: string, epochCek: Uint8Array): Promise<TeamProposalRecordV1> {
    return this.#decode(`${proposalId}.proposal`, epochCek);
  }

  /**
   * ADR-0032 approval: the reviewer signs the canonical approval bound to the current
   * registry-state hash; the record is appended into the proposal object and re-sealed.
   * v1 acceptance semantics: one reviewer approval marks the proposal accepted.
   */
  async appendApproval(input: {
    proposalId: string;
    epochCek: Uint8Array;
    registry: ProposalReviewerRegistryV1;
    registryStateSha256: string;
    reviewerDeviceId: string;
    reviewerSigner: DeviceSignaturePort;
  }): Promise<TeamProposalRecordV1> {
    const record = await this.read(input.proposalId, input.epochCek);
    if (record.approvals.some((entry) => entry.reviewer_id === input.reviewerDeviceId)) {
      throw new TeamProtocolError("PRO_APPROVAL_SIGNATURE_INVALID", "This reviewer already approved the proposal.");
    }
    const approvedAt = new Date().toISOString();
    const approvalBytes = approvalCanonicalBytes({
      proposalId: record.proposal_id,
      epoch: record.epoch,
      contentSha256: sha256Hex(new TextEncoder().encode(record.content)),
      reviewerId: input.reviewerDeviceId,
      registryStateSha256: input.registryStateSha256,
      approvedAt
    });
    const signature = await input.reviewerSigner.signHead(approvalBytes);
    const next: TeamProposalRecordV1 = {
      ...record,
      approvals: [
        ...record.approvals,
        {
          reviewer_id: input.reviewerDeviceId,
          registry_state_sha256: input.registryStateSha256,
          signature_base64url: bytesToBase64Url(signature),
          approved_at: approvedAt
        }
      ]
    };
    await this.#write(next, input.epochCek);
    return next;
  }

  /** Verifies every approval record against the given registry state (INV-25 semantics). */
  async verifyApprovals(input: {
    proposalId: string;
    epochCek: Uint8Array;
    registry: ProposalReviewerRegistryV1;
    verifier: DeviceSignaturePort;
  }): Promise<{ readonly proposalId: string; readonly allValid: boolean; readonly invalid: number; readonly total: number }> {
    const record = await this.read(input.proposalId, input.epochCek);
    let invalid = 0;
    for (const entry of record.approvals) {
      const reviewerEntry = input.registry.reviewers.find((candidate) => candidate.reviewer_id === entry.reviewer_id);
      if (reviewerEntry === undefined) {
        invalid += 1;
        continue;
      }
      const authentic = await input.verifier.verifyHeadSignature(
        approvalCanonicalBytes({
          proposalId: record.proposal_id,
          epoch: record.epoch,
          contentSha256: sha256Hex(new TextEncoder().encode(record.content)),
          reviewerId: entry.reviewer_id,
          registryStateSha256: entry.registry_state_sha256,
          approvedAt: entry.approved_at
        }),
        base64UrlToBytes(entry.signature_base64url),
        base64UrlToBytes(reviewerEntry.proposal_public_key_spki_base64url)
      );
      if (!authentic) invalid += 1;
    }
    return {
      proposalId: record.proposal_id,
      allValid: invalid === 0 && record.approvals.length > 0,
      invalid,
      total: record.approvals.length
    };
  }

  async #write(record: TeamProposalRecordV1, epochCek: Uint8Array): Promise<void> {
    const plaintext = new TextEncoder().encode(JSON.stringify(record));
    const nonce = randomBytes(12);
    const sealed = await this.#options.aead.aeadEncrypt(
      epochCek,
      nonce,
      plaintext,
      aadFor(record.proposal_id)
    );
    const envelope = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      proposal_id: record.proposal_id,
      nonce_b64: bytesToBase64Url(nonce),
      ciphertext_b64: bytesToBase64Url(sealed.ciphertext),
      tag_b64: bytesToBase64Url(sealed.tag)
    };
    mkdirSync(this.#options.proposalsDir, { recursive: true });
    writeFileSync(proposalPath(this.#options, record.proposal_id), `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  }

  async #decode(fileName: string, epochCek: Uint8Array): Promise<TeamProposalRecordV1> {
    const raw = readFileSync(join(this.#options.proposalsDir, fileName), "utf8");
    let envelope: {
      schema_version?: unknown;
      proposal_id?: unknown;
      nonce_b64?: unknown;
      ciphertext_b64?: unknown;
      tag_b64?: unknown;
    };
    try {
      envelope = JSON.parse(raw);
    } catch (error) {
      throw new TeamProtocolError("GRP_WRAP_DECRYPT_FAILED", "Unreadable proposal artifact (e.g. sync conflict).", {
        cause: error
      });
    }
    if (envelope.schema_version !== PROPOSAL_SCHEMA_VERSION || typeof envelope.proposal_id !== "string") {
      throw new TeamProtocolError("GRP_WRAP_DECRYPT_FAILED", "Unreadable proposal artifact (e.g. sync conflict).");
    }
    const proposalId = envelope.proposal_id;
    let plaintext: Uint8Array;
    try {
      plaintext = await this.#options.aead.aeadDecrypt(
        epochCek,
        base64UrlToBytes(envelope.nonce_b64 as string),
        base64UrlToBytes(envelope.ciphertext_b64 as string),
        base64UrlToBytes(envelope.tag_b64 as string),
        aadFor(proposalId)
      );
    } catch (error) {
      throw new TeamProtocolError("GRP_WRAP_DECRYPT_FAILED", "Proposal decryption failed; this device may not hold this epoch's key.", {
        cause: error
      });
    }
    const record = JSON.parse(new TextDecoder().decode(plaintext)) as TeamProposalRecordV1;
    if (record.schema_version !== PROPOSAL_SCHEMA_VERSION || record.proposal_id !== proposalId) {
      throw new TeamProtocolError("GRP_WRAP_DECRYPT_FAILED", "Proposal artifact does not match its identifier.");
    }
    return record;
  }

  #summary(record: TeamProposalRecordV1): ProposalSummary {
    return {
      proposal_id: record.proposal_id,
      epoch: record.epoch,
      author_device_id: record.author_device_id,
      created_at: record.created_at,
      title: record.title,
      approvals: record.approvals
    };
  }
}
