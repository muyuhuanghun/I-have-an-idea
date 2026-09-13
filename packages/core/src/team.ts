// ADR-0032/0033/0034 + ADR-0035 §2 (P1-beta team protocol, T1 contract frozen): the
// pure protocol layer — canonical registry encodings, the epoch/approval state
// machines and their verification. No Node dependencies; crypto flows through
// globalThis.crypto.subtle (same runtime contract as the device signature provider)
// and the existing ports (DeviceSignaturePort for ECDSA, KeyAgreementPort for ECDH).
import type { Bytes, DeviceSignaturePort } from "./ports.js";

export type TeamErrorCode =
  | "PRO_REGISTRY_SIGNATURE_INVALID"
  | "PRO_REGISTRY_ROLLBACK"
  | "PRO_REVIEWER_UNREGISTERED"
  | "PRO_REVIEWER_REVOKED"
  | "PRO_APPROVAL_SIGNATURE_INVALID"
  | "GRP_EPOCH_ROLLBACK"
  | "GRP_MEMBER_NOT_ACTIVE"
  | "GRP_NOT_A_MEMBER"
  | "GRP_WRAP_DECRYPT_FAILED"
  | "GRP_STATE_SIGNATURE_INVALID"
  | "GOV_MATERIAL_INVALID"
  | "GOV_MATERIAL_DOMAIN_MISMATCH"
  | "GOV_RECOVERY_ANCHOR_INVALID";

export class TeamProtocolError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "TeamProtocolError";
  }
}

function teamError(code: TeamErrorCode, message: string, cause?: unknown): TeamProtocolError {
  return new TeamProtocolError(code, message, cause === undefined ? undefined : { cause });
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (c?.subtle === undefined) {
    throw new Error("WebCrypto subtle is unavailable; the team protocol requires a WebCrypto runtime.");
  }
  return c.subtle;
}

export function bytesToBase64Url(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(text: string): Bytes {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export async function sha256Bytes(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", bytes as unknown as ArrayBuffer));
}

// ---------------------------------------------------------------------------
// Canonical JSON (ADR-0035 §2): fields in the contract-frozen order, UTF-8,
// compact separators. Encoders construct objects in the frozen order; verifiers
// re-insert parsed keys in the same order and require byte equality.
// ---------------------------------------------------------------------------

export function canonicalTeamJson(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalBytes(value: unknown): Bytes {
  return new TextEncoder().encode(canonicalTeamJson(value));
}

function reviverInOrder(parsed: unknown, template: unknown): unknown {
  if (Array.isArray(template)) {
    if (!Array.isArray(parsed)) throw teamError("PRO_REGISTRY_SIGNATURE_INVALID", "Canonical form mismatch: array expected.");
    return parsed.map((item, index) => reviverInOrder(item, template[index]));
  }
  if (typeof template === "object" && template !== null) {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw teamError("PRO_REGISTRY_SIGNATURE_INVALID", "Canonical form mismatch: object expected.");
    }
    const out: Record<string, unknown> = {};
    const source = parsed as Record<string, unknown>;
    for (const key of Object.keys(template as Record<string, unknown>)) {
      if (!(key in source)) throw teamError("PRO_REGISTRY_SIGNATURE_INVALID", `Canonical form mismatch: missing ${key}.`);
      out[key] = reviverInOrder(source[key], (template as Record<string, unknown>)[key]);
    }
    if (Object.keys(source).length !== Object.keys(out).length) {
      throw teamError("PRO_REGISTRY_SIGNATURE_INVALID", "Canonical form mismatch: unexpected extra fields.");
    }
    return out;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// proposal-reviewers-v1 (ADR-0032 / ADR-0035 §2.1)
// ---------------------------------------------------------------------------

export interface ProposalReviewerEntryV1 {
  readonly reviewer_id: string;
  readonly proposal_public_key_spki_base64url: string;
  readonly device_id: string;
  readonly registered_at: string;
}

export interface ProposalReviewerRevokedV1 {
  readonly reviewer_id: string;
  readonly revoked_at: string;
}

export interface UnsignedProposalReviewerRegistryV1 {
  readonly schema_version: "proposal-reviewers-v1";
  readonly domain_id_sha256: string;
  readonly sequence: number;
  readonly reviewers: readonly ProposalReviewerEntryV1[];
  readonly revoked: readonly ProposalReviewerRevokedV1[];
}

export interface ProposalReviewerRegistryV1 extends UnsignedProposalReviewerRegistryV1 {
  readonly signature_base64url: string;
}

export function encodeProposalReviewersBytes(registry: UnsignedProposalReviewerRegistryV1): Bytes {
  return canonicalBytes({
    schema_version: registry.schema_version,
    domain_id_sha256: registry.domain_id_sha256,
    sequence: registry.sequence,
    reviewers: registry.reviewers.map((entry) => ({
      reviewer_id: entry.reviewer_id,
      proposal_public_key_spki_base64url: entry.proposal_public_key_spki_base64url,
      device_id: entry.device_id,
      registered_at: entry.registered_at
    })),
    revoked: registry.revoked.map((entry) => ({ reviewer_id: entry.reviewer_id, revoked_at: entry.revoked_at }))
  });
}

export function parseProposalReviewersBytes(bytes: Bytes, signatureBase64url: string): ProposalReviewerRegistryV1 {
  const parsed = reviverInOrder(JSON.parse(new TextDecoder().decode(bytes)), {
    schema_version: "proposal-reviewers-v1",
    domain_id_sha256: "",
    sequence: 0,
    reviewers: [],
    revoked: []
  }) as UnsignedProposalReviewerRegistryV1;
  return { ...parsed, signature_base64url: signatureBase64url };
}

export function emptyProposalReviewerRegistry(domainIdSha256: string): UnsignedProposalReviewerRegistryV1 {
  return { schema_version: "proposal-reviewers-v1", domain_id_sha256: domainIdSha256, sequence: 1, reviewers: [], revoked: [] };
}

export function admitReviewer(
  registry: UnsignedProposalReviewerRegistryV1,
  entry: ProposalReviewerEntryV1
): UnsignedProposalReviewerRegistryV1 {
  if (registry.reviewers.some((existing) => existing.reviewer_id === entry.reviewer_id)) {
    throw teamError("PRO_REVIEWER_UNREGISTERED", "Reviewer already registered; registration is idempotent-free.");
  }
  return {
    ...registry,
    sequence: registry.sequence + 1,
    reviewers: [...registry.reviewers, entry]
  };
}

export function revokeReviewer(
  registry: UnsignedProposalReviewerRegistryV1,
  reviewerId: string,
  revokedAt: string
): UnsignedProposalReviewerRegistryV1 {
  const entry = registry.reviewers.find((candidate) => candidate.reviewer_id === reviewerId);
  if (entry === undefined) throw teamError("PRO_REVIEWER_UNREGISTERED", "Cannot revoke an unregistered reviewer.");
  return {
    ...registry,
    sequence: registry.sequence + 1,
    reviewers: registry.reviewers.filter((candidate) => candidate.reviewer_id !== reviewerId),
    revoked: [...registry.revoked, { reviewer_id: reviewerId, revoked_at: revokedAt }]
  };
}

// ---------------------------------------------------------------------------
// Proposal approval records (ADR-0032 §5: verified at acceptance time and persisted)
// ---------------------------------------------------------------------------

export interface UnsignedProposalApprovalV1 {
  readonly proposal_ref: string;
  readonly content_sha256: string;
  readonly reviewer_id: string;
  readonly registry_state_sha256: string;
  readonly approved_at: string;
}

export interface ProposalApprovalV1 extends UnsignedProposalApprovalV1 {
  readonly signature_base64url: string;
}

export function encodeProposalApprovalBytes(approval: UnsignedProposalApprovalV1): Bytes {
  return canonicalBytes({
    proposal_ref: approval.proposal_ref,
    content_sha256: approval.content_sha256,
    reviewer_id: approval.reviewer_id,
    registry_state_sha256: approval.registry_state_sha256,
    approved_at: approval.approved_at
  });
}

export async function signProposalApproval(
  approval: UnsignedProposalApprovalV1,
  signer: DeviceSignaturePort
): Promise<ProposalApprovalV1> {
  const signature = await signer.signHead(encodeProposalApprovalBytes(approval));
  return { ...approval, signature_base64url: bytesToBase64Url(signature) };
}

/**
 * INV-25: an approval is valid only when the reviewer's key is currently registered
 * (never revoked) and the signature verifies against the exact registry state the
 * approval recorded. Revocation is forward-invalidating; persisted acceptance
 * records keep their historical registry-state hash (ADR-0032 §5.3).
 */
export async function verifyProposalApproval(
  approval: ProposalApprovalV1,
  registry: ProposalReviewerRegistryV1,
  verifier: DeviceSignaturePort
): Promise<void> {
  const entry = registry.reviewers.find((candidate) => candidate.reviewer_id === approval.reviewer_id);
  if (entry === undefined) {
    const revoked = registry.revoked.some((candidate) => candidate.reviewer_id === approval.reviewer_id);
    throw teamError(revoked ? "PRO_REVIEWER_REVOKED" : "PRO_REVIEWER_UNREGISTERED", "Approval signer is not an active reviewer.");
  }
  const stateHash = bytesToBase64Url(await sha256Bytes(encodeProposalReviewersBytes(registry)));
  if (stateHash !== approval.registry_state_sha256) {
    throw teamError("PRO_APPROVAL_SIGNATURE_INVALID", "Approval was signed against a different registry state.");
  }
  const authentic = await verifier.verifyHeadSignature(
    encodeProposalApprovalBytes(approval),
    base64UrlToBytes(approval.signature_base64url),
    base64UrlToBytes(entry.proposal_public_key_spki_base64url)
  );
  if (!authentic) throw teamError("PRO_APPROVAL_SIGNATURE_INVALID", "Approval signature verification failed.");
}

// ---------------------------------------------------------------------------
// group-state-v1 (ADR-0033 / ADR-0035 §2.2)
// ---------------------------------------------------------------------------

export interface GroupMemberV1 {
  readonly device_id: string;
  readonly member_content_dh_spki_base64url: string;
  readonly joined_epoch: number;
}

export interface GroupRemovedV1 {
  readonly device_id: string;
  readonly removed_epoch: number;
}

export interface UnsignedGroupStateV1 {
  readonly schema_version: "group-state-v1";
  readonly domain_id_sha256: string;
  readonly epoch: number;
  readonly members: readonly GroupMemberV1[];
  readonly removed: readonly GroupRemovedV1[];
  readonly recovery_anchor_spki_base64url: string;
}

export interface GroupStateV1 extends UnsignedGroupStateV1 {
  readonly signature_base64url: string;
}

export function encodeGroupStateBytes(state: UnsignedGroupStateV1): Bytes {
  return canonicalBytes({
    schema_version: state.schema_version,
    domain_id_sha256: state.domain_id_sha256,
    epoch: state.epoch,
    members: state.members.map((entry) => ({
      device_id: entry.device_id,
      member_content_dh_spki_base64url: entry.member_content_dh_spki_base64url,
      joined_epoch: entry.joined_epoch
    })),
    removed: state.removed.map((entry) => ({ device_id: entry.device_id, removed_epoch: entry.removed_epoch })),
    recovery_anchor_spki_base64url: state.recovery_anchor_spki_base64url
  });
}

export function parseGroupStateBytes(bytes: Bytes, signatureBase64url: string): GroupStateV1 {
  const parsed = reviverInOrder(JSON.parse(new TextDecoder().decode(bytes)), {
    schema_version: "group-state-v1",
    domain_id_sha256: "",
    epoch: 0,
    members: [],
    removed: [],
    recovery_anchor_spki_base64url: ""
  }) as UnsignedGroupStateV1;
  return { ...parsed, signature_base64url: signatureBase64url };
}

export function initialGroupState(
  domainIdSha256: string,
  ownerDeviceId: string,
  ownerContentDhSpkiBase64url: string,
  recoveryAnchorSpkiBase64url: string
): UnsignedGroupStateV1 {
  return {
    schema_version: "group-state-v1",
    domain_id_sha256: domainIdSha256,
    epoch: 1,
    members: [{ device_id: ownerDeviceId, member_content_dh_spki_base64url: ownerContentDhSpkiBase64url, joined_epoch: 1 }],
    removed: [],
    recovery_anchor_spki_base64url: recoveryAnchorSpkiBase64url
  };
}

/** GRP-INV-01: any membership change advances the epoch; concurrency is serialized upstream. */
export function joinMember(state: UnsignedGroupStateV1, deviceId: string, contentDhSpkiBase64url: string): UnsignedGroupStateV1 {
  if (state.members.some((entry) => entry.device_id === deviceId) || state.removed.some((entry) => entry.device_id === deviceId)) {
    throw teamError("GRP_MEMBER_NOT_ACTIVE", "Device already present in the group state.");
  }
  return {
    ...state,
    epoch: state.epoch + 1,
    members: [...state.members, { device_id: deviceId, member_content_dh_spki_base64url: contentDhSpkiBase64url, joined_epoch: state.epoch + 1 }]
  };
}

export function removeMember(state: UnsignedGroupStateV1, deviceId: string): UnsignedGroupStateV1 {
  const member = state.members.find((entry) => entry.device_id === deviceId);
  if (member === undefined) throw teamError("GRP_NOT_A_MEMBER", "Cannot remove a device that is not an active member.");
  return {
    ...state,
    epoch: state.epoch + 1,
    members: state.members.filter((entry) => entry.device_id !== deviceId),
    removed: [...state.removed, { device_id: deviceId, removed_epoch: state.epoch + 1 }]
  };
}

// ---------------------------------------------------------------------------
// group-epoch-keys-v1 (ADR-0035 §2.3): per-epoch pairwise CEK distribution
// ---------------------------------------------------------------------------

export interface EpochKeyWrappingV1 {
  readonly device_id: string;
  readonly ephemeral_dh_spki_base64url: string;
  readonly nonce_b64: string;
  readonly wrapped_cek_b64: string;
}

export interface EpochKeyDistributionV1 {
  readonly schema_version: "group-epoch-keys-v1";
  readonly domain_id_sha256: string;
  readonly epoch: number;
  readonly wrapped: readonly EpochKeyWrappingV1[];
  readonly signature_base64url: string;
}

export function encodeEpochKeysBytes(dist: Omit<EpochKeyDistributionV1, "signature_base64url">): Bytes {
  return canonicalBytes({
    schema_version: dist.schema_version,
    domain_id_sha256: dist.domain_id_sha256,
    epoch: dist.epoch,
    wrapped: dist.wrapped.map((entry) => ({
      device_id: entry.device_id,
      ephemeral_dh_spki_base64url: entry.ephemeral_dh_spki_base64url,
      nonce_b64: entry.nonce_b64,
      wrapped_cek_b64: entry.wrapped_cek_b64
    }))
  });
}

export function parseEpochKeysBytes(bytes: Bytes, signatureBase64url: string): EpochKeyDistributionV1 {
  const parsed = reviverInOrder(JSON.parse(new TextDecoder().decode(bytes)), {
    schema_version: "group-epoch-keys-v1",
    domain_id_sha256: "",
    epoch: 0,
    wrapped: []
  }) as Omit<EpochKeyDistributionV1, "signature_base64url">;
  return { ...parsed, signature_base64url: signatureBase64url };
}

/** ADR-0035 §3.2: ECIES AAD binds domain/epoch/device against cross-domain and cross-member replay. */
export function epochWrapAad(domainId: Bytes, epoch: number, deviceId: string): Bytes {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(epoch), false);
  const device = deviceIdBytes(deviceId);
  const out = new Uint8Array(domainId.byteLength + 8 + device.byteLength);
  out.set(domainId, 0);
  out.set(new Uint8Array(view.buffer), domainId.byteLength);
  out.set(device, domainId.byteLength + 8);
  return out;
}

/** Registry device ids are 32-hex strings (16 bytes, devices.json v1); the AAD uses the raw bytes. */
export function deviceIdBytes(deviceId: string): Bytes {
  const pairs = deviceId.match(/../gu);
  if (pairs === null || pairs.length !== 16 || /[^0-9a-f]/u.test(deviceId)) {
    throw teamError("GRP_MEMBER_NOT_ACTIVE", "Device id must be 32 lowercase hexadecimal characters.");
  }
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

// ---------------------------------------------------------------------------
// governance recovery (ADR-0034 / ADR-0035 §4)
// ---------------------------------------------------------------------------

export interface RecoveryAdmissionV1 {
  readonly schema_version: "governance-recovery-admission-v1";
  readonly domain_id_sha256: string;
  readonly admitted_device_id: string;
  readonly superseded_device_ids: readonly string[];
  readonly epoch_at_recovery: number;
  readonly admitted_at: string;
  readonly signature_base64url: string;
}

export function encodeRecoveryAdmissionBytes(admission: Omit<RecoveryAdmissionV1, "signature_base64url">): Bytes {
  return canonicalBytes({
    schema_version: admission.schema_version,
    domain_id_sha256: admission.domain_id_sha256,
    admitted_device_id: admission.admitted_device_id,
    superseded_device_ids: [...admission.superseded_device_ids],
    epoch_at_recovery: admission.epoch_at_recovery,
    admitted_at: admission.admitted_at
  });
}

/** ADR-0034 §4.1: the anchor is the alternative authority root; its signature re-admits an owner device. */
export async function verifyRecoveryAdmission(
  admission: RecoveryAdmissionV1,
  anchorSpki: Bytes,
  verifier: DeviceSignaturePort
): Promise<void> {
  const authentic = await verifier.verifyHeadSignature(
    encodeRecoveryAdmissionBytes(admission),
    base64UrlToBytes(admission.signature_base64url),
    anchorSpki
  );
  if (!authentic) throw teamError("GOV_RECOVERY_ANCHOR_INVALID", "Recovery admission signature verification failed.");
}

/** GR-8: every accepted registry update appends an audit line; tampering is detectable via hash chaining. */
export function auditLine(sequence: number, action: string, payloadSha256: string, at: string): string {
  return canonicalTeamJson({ sequence, action, payload_sha256: payloadSha256, at });
}
