// ADR-0032/0033/0034 + ADR-0035 (P1-beta team protocol, T2): the file-backed team
// registries — signed canonical-JSON files with append-only journals for anti-rollback
// (same shape as the head directory's history journal), the pairwise epoch-CEK
// distribution flow, and the governance recovery material/orchestration. Signature
// verification and canonical encodings live in @ekd/core; this layer owns files,
// journals, CSPRNG and the wrapping orchestration.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  TeamProtocolError,
  admitReviewer,
  base64UrlToBytes,
  bytesToBase64Url,
  encodeEpochKeysBytes,
  encodeGroupStateBytes,
  encodeProposalReviewersBytes,
  encodeRecoveryAdmissionBytes,
  initialGroupState,
  joinMember as applyJoin,
  parseEpochKeysBytes,
  parseGroupStateBytes,
  parseProposalReviewersBytes,
  removeMember as applyRemove,
  revokeReviewer as applyRevoke,
  verifyRecoveryAdmission,
  type DeviceSignaturePort,
  type EpochKeyDistributionV1,
  type GroupStateV1,
  type KeyAgreementPort,
  type ProposalReviewerEntryV1,
  type ProposalReviewerRegistryV1,
  type RecoveryAdmissionV1,
  type TeamErrorCode,
  type UnsignedGroupStateV1,
  type UnsignedProposalReviewerRegistryV1
} from "@ekd/core";

function teamError(code: TeamErrorCode, message: string, cause?: unknown): TeamProtocolError {
  return new TeamProtocolError(code, message, cause === undefined ? undefined : { cause });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The signed file = canonical unsigned bytes minus `}` + the frozen trailing signature field (ADR-0035 §2). */
function signedFileText(canonicalBytes: Uint8Array, signatureBase64url: string): string {
  const text = Buffer.from(canonicalBytes).toString("utf8");
  if (!text.endsWith("}")) throw teamError("PRO_REGISTRY_SIGNATURE_INVALID", "Canonical form must end with '}'.");
  return `${text.slice(0, -1)},"signature_base64url":${JSON.stringify(signatureBase64url)}}`;
}

/** Reads a signed file and returns the exact canonical bytes that must verify. */
function readSignedFile(
  filePath: string,
  journalPath: string,
  rollbackCode: "PRO_REGISTRY_ROLLBACK" | "GRP_EPOCH_ROLLBACK",
  invalidCode: "PRO_REGISTRY_SIGNATURE_INVALID" | "GRP_STATE_SIGNATURE_INVALID",
  sequenceField: "sequence" | "epoch",
  /** Epoch-key distributions persist by design; their reads skip the journal gate (ADR-0035 §4.5). */
  enforceRollback = true
): { canonicalBytes: Uint8Array; signature_base64url: string } | undefined {
  if (!existsSync(filePath)) return undefined;
  const raw = readFileSync(filePath, "utf8").trim();
  if (raw.length === 0) return undefined;
  const marker = `,"signature_base64url":`;
  const cut = raw.lastIndexOf(marker);
  if (cut < 0) throw teamError(invalidCode, "Registry file lacks a signature field.");
  // The signed file replaced the canonical object's closing `}` with the signature
  // field; restore that brace to reconstruct the exact signed-over canonical bytes.
  const canonical = `${raw.slice(0, cut)}}`;
  const valueText = raw.slice(cut + marker.length);
  if (!valueText.endsWith("}")) throw teamError(invalidCode, "Registry signature field is malformed.");
  const signature = JSON.parse(valueText.slice(0, -1)) as unknown;
  if (typeof signature !== "string") throw teamError(invalidCode, "Registry signature field is malformed.");
  const fileSequence = Number((JSON.parse(canonical) as Record<string, unknown>)[sequenceField] ?? 0);
  if (enforceRollback) {
    if (!existsSync(journalPath)) {
      // No journal: the file must itself be a valid first state (sequence >= 1).
      if (fileSequence < 1) throw teamError(rollbackCode, "Registry sequence must start at 1.");
      return { canonicalBytes: new Uint8Array(Buffer.from(canonical, "utf8")), signature_base64url: signature };
    }
    const lines = readFileSync(journalPath, "utf8").split("\n").filter((line) => line.trim().length > 0);
    const highWater = lines.reduce((max, line) => Math.max(max, (JSON.parse(line) as { sequence: number }).sequence), 0);
    if (fileSequence < highWater) {
      throw teamError(rollbackCode, `Registry sequence ${fileSequence} is behind the journal high-water mark ${highWater}.`);
    }
  }
  return { canonicalBytes: new Uint8Array(Buffer.from(canonical, "utf8")), signature_base64url: signature };
}

/** Epoch-key distributions persist by design (ADR-0035 §4.5); reads never hit the journal gate, commits must advance it. */
function assertCommitable(journalPath: string, sequence: number): void {
  if (!existsSync(journalPath)) return;
  const lines = readFileSync(journalPath, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const highWater = lines.reduce((max, line) => Math.max(max, (JSON.parse(line) as { sequence: number }).sequence), 0);
  if (sequence <= highWater) {
    throw teamError("GRP_EPOCH_ROLLBACK", `Epoch ${sequence} does not advance the journal high-water mark ${highWater}.`);
  }
}

function commitFile(
  filePath: string,
  canonicalBytes: Uint8Array,
  signatureBase64url: string,
  journalPath: string,
  sequence: number
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${signedFileText(canonicalBytes, signatureBase64url)}\n`, "utf8");
  appendFileSync(journalPath, `${JSON.stringify({ sequence, sha256: sha256Hex(Buffer.from(signedFileText(canonicalBytes, signatureBase64url), "utf8")), at: new Date().toISOString() })}\n`, "utf8");
}

async function verifySignature(
  verifier: DeviceSignaturePort,
  authoritySpki: Uint8Array,
  canonicalBytes: Uint8Array,
  signatureBase64url: string,
  invalidCode: "PRO_REGISTRY_SIGNATURE_INVALID" | "GRP_STATE_SIGNATURE_INVALID",
  label: string
): Promise<void> {
  const authentic = await verifier.verifyHeadSignature(canonicalBytes, base64UrlToBytes(signatureBase64url), authoritySpki);
  if (!authentic) throw teamError(invalidCode, `${label} signature verification failed.`);
}

// ---------------------------------------------------------------------------
// proposal-reviewers-v1
// ---------------------------------------------------------------------------

export interface TeamRegistryFileOptions {
  /** Verifies registry signatures against the CURRENT authority device key. */
  readonly verifier: DeviceSignaturePort;
  /** The authority device key that signs updates (v1: single owner device). */
  readonly authoritySpki: Uint8Array;
  readonly signer: DeviceSignaturePort;
}

export class ProposalReviewersRegistryFile {
  readonly #journalPath: string;

  constructor(
    readonly filePath: string,
    readonly domainIdSha256: string,
    private readonly options: TeamRegistryFileOptions
  ) {
    this.#journalPath = `${filePath}.journal.jsonl`;
  }

  async load(): Promise<ProposalReviewerRegistryV1 | undefined> {
    const file = readSignedFile(this.filePath, this.#journalPath, "PRO_REGISTRY_ROLLBACK", "PRO_REGISTRY_SIGNATURE_INVALID", "sequence");
    if (file === undefined) return undefined;
    await verifySignature(this.options.verifier, this.options.authoritySpki, file.canonicalBytes, file.signature_base64url, "PRO_REGISTRY_SIGNATURE_INVALID", "proposal-reviewers");
    return parseProposalReviewersBytes(file.canonicalBytes, file.signature_base64url);
  }

  async save(next: UnsignedProposalReviewerRegistryV1): Promise<ProposalReviewerRegistryV1> {
    const bytes = encodeProposalReviewersBytes(next);
    const signature = bytesToBase64Url(await this.options.signer.signHead(bytes));
    commitFile(this.filePath, bytes, signature, this.#journalPath, next.sequence);
    return { ...next, signature_base64url: signature };
  }

  async admit(entry: ProposalReviewerEntryV1): Promise<ProposalReviewerRegistryV1> {
    const current = (await this.load()) ?? {
      schema_version: "proposal-reviewers-v1" as const,
      domain_id_sha256: this.domainIdSha256,
      sequence: 1,
      reviewers: [],
      revoked: []
    };
    return this.save(admitReviewer(current, entry));
  }

  async revoke(reviewerId: string): Promise<ProposalReviewerRegistryV1> {
    const current = await this.load();
    if (current === undefined) throw teamError("PRO_REVIEWER_UNREGISTERED", "Registry does not exist yet.");
    return this.save(applyRevoke(current, reviewerId, new Date().toISOString()));
  }
}

// ---------------------------------------------------------------------------
// group-state-v1 + group-epoch-keys-v1
// ---------------------------------------------------------------------------

export interface EpochAdvanceResult {
  readonly state: GroupStateV1;
  readonly distribution: EpochKeyDistributionV1;
  /** Only returned to the authority immediately after advancing; members unwrap from the distribution file. */
  readonly cek: Uint8Array;
}

export class GroupStateRegistryFile {
  readonly #journalPath: string;
  readonly #keysJournalPath: string;

  constructor(
    readonly statePath: string,
    readonly domainId: Uint8Array,
    private readonly options: TeamRegistryFileOptions & { readonly keyAgreement: KeyAgreementPort }
  ) {
    this.#journalPath = `${statePath}.journal.jsonl`;
    this.#keysJournalPath = `${statePath}.epoch-keys.journal.jsonl`;
  }

  get domainIdSha256(): string {
    return sha256Hex(this.domainId);
  }

  #keysPath(epoch: number): string {
    return join(dirname(this.statePath), `group-epoch-keys-${epoch}-v1.json`);
  }

  async load(): Promise<GroupStateV1 | undefined> {
    const file = readSignedFile(this.statePath, this.#journalPath, "GRP_EPOCH_ROLLBACK", "GRP_STATE_SIGNATURE_INVALID", "epoch");
    if (file === undefined) return undefined;
    await verifySignature(this.options.verifier, this.options.authoritySpki, file.canonicalBytes, file.signature_base64url, "GRP_STATE_SIGNATURE_INVALID", "group-state");
    return parseGroupStateBytes(file.canonicalBytes, file.signature_base64url);
  }

  async loadEpochKeys(epoch: number): Promise<EpochKeyDistributionV1 | undefined> {
    const path = this.#keysPath(epoch);
    if (!existsSync(path)) return undefined;
    const file = readSignedFile(path, this.#keysJournalPath, "GRP_EPOCH_ROLLBACK", "GRP_STATE_SIGNATURE_INVALID", "epoch", false);
    if (file === undefined) return undefined;
    await verifySignature(this.options.verifier, this.options.authoritySpki, file.canonicalBytes, file.signature_base64url, "GRP_STATE_SIGNATURE_INVALID", "group-epoch-keys");
    return parseEpochKeysBytes(file.canonicalBytes, file.signature_base64url);
  }

  async initialize(
    ownerDeviceId: string,
    ownerContentDhSpkiBase64url: string,
    recoveryAnchorSpkiBase64url: string
  ): Promise<EpochAdvanceResult> {
    if (existsSync(this.statePath)) throw teamError("GRP_STATE_SIGNATURE_INVALID", "Group state already exists; initialization is exclusive.");
    return this.#advance(
      initialGroupState(this.domainIdSha256, ownerDeviceId, ownerContentDhSpkiBase64url, recoveryAnchorSpkiBase64url)
    );
  }

  /**
   * The signer defaults to the current authority. Recovery passes the NEW owner
   * signer: the old authority is unavailable by definition during recovery.
   */
  async joinMember(deviceId: string, memberContentDhSpkiBase64url: string, signer?: DeviceSignaturePort): Promise<EpochAdvanceResult> {
    const current = await this.load();
    if (current === undefined) throw teamError("GRP_NOT_A_MEMBER", "Group state does not exist yet.");
    return this.#advance(applyJoin(current, deviceId, memberContentDhSpkiBase64url), signer);
  }

  async removeMember(deviceId: string, signer?: DeviceSignaturePort): Promise<EpochAdvanceResult> {
    const current = await this.load();
    if (current === undefined) throw teamError("GRP_NOT_A_MEMBER", "Group state does not exist yet.");
    return this.#advance(applyRemove(current, deviceId), signer);
  }

  /**
   * ET-9/GRP-INV-04 (ADR-0035 §4.5): the new epoch's distribution contains exactly the
   * active members — the removed device's entry disappears, which is the verifiable
   * erasure core; active members keep historical epoch distributions (backup semantics).
   */
  async #advance(next: UnsignedGroupStateV1, signer: DeviceSignaturePort = this.options.signer): Promise<EpochAdvanceResult> {
    const cek = new Uint8Array(randomBytes(32));
    const wrapped: Array<{ device_id: string; ephemeral_dh_spki_base64url: string; nonce_b64: string; wrapped_cek_b64: string }> = [];
    for (const member of next.members) {
      const wrappedFor = await this.options.keyAgreement.wrapCek({
        domainId: this.domainId,
        epoch: next.epoch,
        deviceId: member.device_id,
        recipientSpki: base64UrlToBytes(member.member_content_dh_spki_base64url),
        cek
      });
      wrapped.push({
        device_id: member.device_id,
        ephemeral_dh_spki_base64url: bytesToBase64Url(wrappedFor.ephemeral_spki),
        nonce_b64: bytesToBase64Url(wrappedFor.nonce),
        wrapped_cek_b64: bytesToBase64Url(wrappedFor.wrapped_cek)
      });
    }
    const distributionUnsigned = {
      schema_version: "group-epoch-keys-v1" as const,
      domain_id_sha256: this.domainIdSha256,
      epoch: next.epoch,
      wrapped
    };
    const distBytes = encodeEpochKeysBytes(distributionUnsigned);
    const distSignature = bytesToBase64Url(await signer.signHead(distBytes));
    const keysPath = this.#keysPath(next.epoch);
    mkdirSync(dirname(keysPath), { recursive: true });
    assertCommitable(this.#keysJournalPath, next.epoch);
    commitFile(keysPath, distBytes, distSignature, this.#keysJournalPath, next.epoch);

    const stateBytes = encodeGroupStateBytes(next);
    const stateSignature = bytesToBase64Url(await signer.signHead(stateBytes));
    assertCommitable(this.#journalPath, next.epoch);
    commitFile(this.statePath, stateBytes, stateSignature, this.#journalPath, next.epoch);
    return {
      state: { ...next, signature_base64url: stateSignature },
      distribution: { ...distributionUnsigned, signature_base64url: distSignature },
      cek
    };
  }

  /** Member-side unwrap; any mismatch is GRP_WRAP_DECRYPT_FAILED (keys stay in caller memory). */
  async unwrapEpochCek(deviceId: string, ownPrivatePkcs8: Uint8Array, epoch: number): Promise<Uint8Array> {
    const distribution = await this.loadEpochKeys(epoch);
    if (distribution === undefined) throw teamError("GRP_MEMBER_NOT_ACTIVE", `No key distribution for epoch ${epoch}.`);
    const entry = distribution.wrapped.find((candidate) => candidate.device_id === deviceId);
    if (entry === undefined) throw teamError("GRP_MEMBER_NOT_ACTIVE", "This device has no wrapping in the epoch distribution.");
    try {
      return await this.options.keyAgreement.unwrapCek({
        domainId: this.domainId,
        epoch,
        deviceId,
        own_private_pkcs8: ownPrivatePkcs8,
        ephemeral_spki: base64UrlToBytes(entry.ephemeral_dh_spki_base64url),
        nonce: base64UrlToBytes(entry.nonce_b64),
        wrapped_cek: base64UrlToBytes(entry.wrapped_cek_b64)
      });
    } catch (error) {
      throw teamError("GRP_WRAP_DECRYPT_FAILED", "Epoch CEK unwrap failed.", error);
    }
  }

  /** Same membership, epoch+1, fresh CEK (ADR-0034 recovery rotation). */
  async rotateEpoch(signer: DeviceSignaturePort): Promise<EpochAdvanceResult> {
    const current = await this.load();
    if (current === undefined) throw teamError("GRP_NOT_A_MEMBER", "Group state does not exist yet.");
    return this.#advance({ ...current, epoch: current.epoch + 1 }, signer);
  }
}

// ---------------------------------------------------------------------------
// governance recovery material (ADR-0034 / ADR-0035 §4)
// ---------------------------------------------------------------------------

const MATERIAL_MAGIC = new Uint8Array([0x45, 0x4b, 0x44, 0x47, 0x4f, 0x56, 0x01, 0x00]); // "EKDGOV" 0x01 0x00

function subtleCrypto(): SubtleCrypto {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (c?.subtle === undefined) throw teamError("GOV_MATERIAL_INVALID", "WebCrypto subtle is unavailable.");
  return c.subtle;
}

async function signWithPkcs8(pkcs8: Uint8Array, bytes: Uint8Array): Promise<Uint8Array> {
  const key = await subtleCrypto().importKey("pkcs8", pkcs8 as unknown as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return new Uint8Array(await subtleCrypto().sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes as unknown as ArrayBuffer));
}

export function encodeGovernanceMaterial(domainId: Uint8Array, anchorPrivatePkcs8: Uint8Array): Uint8Array {
  const len = anchorPrivatePkcs8.byteLength;
  const out = new Uint8Array(8 + 1 + 32 + 2 + len + 32);
  out.set(MATERIAL_MAGIC, 0);
  out[8] = 1;
  out.set(domainId, 9);
  new DataView(out.buffer).setUint16(41, len, false);
  out.set(anchorPrivatePkcs8, 43);
  out.set(createHash("sha256").update(out.subarray(0, 43 + len)).digest(), out.byteLength - 32);
  return out;
}

export function decodeGovernanceMaterial(material: Uint8Array, domainId?: Uint8Array): { domain_id: Uint8Array; anchor_private_pkcs8: Uint8Array } {
  if (material.byteLength < 8 + 1 + 32 + 2 + 32) throw teamError("GOV_MATERIAL_INVALID", "Governance material is too short.");
  for (let index = 0; index < MATERIAL_MAGIC.byteLength; index += 1) {
    if (material[index] !== MATERIAL_MAGIC[index]) throw teamError("GOV_MATERIAL_INVALID", "Governance material magic mismatch.");
  }
  if (material[8] !== 1) throw teamError("GOV_MATERIAL_INVALID", "Unsupported governance material version.");
  const domain_id = material.slice(9, 41);
  if (domainId !== undefined) {
    for (let index = 0; index < 32; index += 1) {
      if (domain_id[index] !== domainId[index]) throw teamError("GOV_MATERIAL_DOMAIN_MISMATCH", "Material belongs to a different domain.");
    }
  }
  const len = new DataView(material.buffer, material.byteOffset, material.byteLength).getUint16(41, false);
  if (material.byteLength !== 8 + 1 + 32 + 2 + len + 32) throw teamError("GOV_MATERIAL_INVALID", "Governance material length mismatch.");
  const digest = createHash("sha256").update(material.subarray(0, 43 + len)).digest();
  for (let index = 0; index < 32; index += 1) {
    if (digest[index] !== material[43 + len + index]) throw teamError("GOV_MATERIAL_INVALID", "Governance material integrity check failed.");
  }
  return { domain_id, anchor_private_pkcs8: material.slice(43, 43 + len) };
}

export async function generateGovernanceMaterial(domainId: Uint8Array): Promise<{ material: Uint8Array; anchor_spki: Uint8Array }> {
  const pair = await subtleCrypto().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtleCrypto().exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await subtleCrypto().exportKey("spki", pair.publicKey));
  return { material: encodeGovernanceMaterial(domainId, pkcs8), anchor_spki: spki };
}

export interface RecoveryOutcome {
  readonly admission: RecoveryAdmissionV1;
  readonly state: GroupStateV1;
  readonly epochAdvanced: boolean;
}

/**
 * ADR-0034 §5 (six steps): validate material → anchor-signed admission (admit the new
 * owner device, supersede the old) → join the new device if needed (epoch may advance,
 * sequence never resets) → re-sign the state with the new authority → audit.
 */
export async function performRecovery(input: {
  material: Uint8Array;
  domainId: Uint8Array;
  newOwnerDeviceId: string;
  newOwnerContentDhSpkiBase64url?: string;
  supersededDeviceIds: readonly string[];
  groupState: GroupStateRegistryFile;
  /** The NEW owner device's signing key: it takes over registry updates after recovery. */
  newOwnerSigner: DeviceSignaturePort;
  /** The new authority's public key — post-recovery loads verify against it. */
  newOwnerAuthoritySpki: Uint8Array;
  /** Verifies the anchor-signed admission (anchor spki comes from the loaded group state). */
  anchorVerifier: DeviceSignaturePort;
}): Promise<RecoveryOutcome> {
  const decoded = decodeGovernanceMaterial(input.material, input.domainId);
  const currentState = await input.groupState.load();
  if (currentState === undefined) throw teamError("GRP_NOT_A_MEMBER", "Group state must exist before recovery.");
  const anchorSpki = base64UrlToBytes(currentState.recovery_anchor_spki_base64url);

  let next: UnsignedGroupStateV1 = {
    schema_version: currentState.schema_version,
    domain_id_sha256: currentState.domain_id_sha256,
    epoch: currentState.epoch,
    members: currentState.members,
    removed: currentState.removed,
    recovery_anchor_spki_base64url: currentState.recovery_anchor_spki_base64url
  };
  let epochAdvanced = false;
  if (
    input.newOwnerContentDhSpkiBase64url !== undefined &&
    !next.members.some((entry) => entry.device_id === input.newOwnerDeviceId)
  ) {
    next = applyJoin(next, input.newOwnerDeviceId, input.newOwnerContentDhSpkiBase64url);
    epochAdvanced = true;
  }

  const admissionUnsigned = {
    schema_version: "governance-recovery-admission-v1" as const,
    domain_id_sha256: next.domain_id_sha256,
    admitted_device_id: input.newOwnerDeviceId,
    superseded_device_ids: [...input.supersededDeviceIds],
    epoch_at_recovery: next.epoch,
    admitted_at: new Date().toISOString()
  };
  const admissionBytes = encodeRecoveryAdmissionBytes(admissionUnsigned);
  const admission: RecoveryAdmissionV1 = {
    ...admissionUnsigned,
    signature_base64url: bytesToBase64Url(await signWithPkcs8(decoded.anchor_private_pkcs8, admissionBytes))
  };
  await verifyRecoveryAdmission(admission, anchorSpki, input.anchorVerifier);

  // Recovery always ROTATES the epoch: the fresh CEK is wrapped for all active members
  // (including the admitted owner device) and signed by the NEW authority.
  if (epochAdvanced) {
    await input.groupState.joinMember(input.newOwnerDeviceId, input.newOwnerContentDhSpkiBase64url as string, input.newOwnerSigner);
  } else {
    await input.groupState.rotateEpoch(input.newOwnerSigner);
  }
  // Post-recovery reads verify against the NEW authority key, not the superseded one.
  const recoveredFile = readSignedFile(
    input.groupState.statePath,
    `${input.groupState.statePath}.journal.jsonl`,
    "GRP_EPOCH_ROLLBACK",
    "GRP_STATE_SIGNATURE_INVALID",
    "epoch",
    false
  );
  if (recoveredFile === undefined) throw teamError("GRP_NOT_A_MEMBER", "Recovered group state is missing.");
  await verifySignature(
    input.newOwnerSigner,
    input.newOwnerAuthoritySpki,
    recoveredFile.canonicalBytes,
    recoveredFile.signature_base64url,
    "GRP_STATE_SIGNATURE_INVALID",
    "group-state (recovered)"
  );
  const state = parseGroupStateBytes(recoveredFile.canonicalBytes, recoveredFile.signature_base64url);
  return { admission, state, epochAdvanced };
}
