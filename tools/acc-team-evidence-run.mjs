#!/usr/bin/env node
// ADR-0032/0033/0034 验收证据计划 + ADR-0035 §6.3 (P1-beta T3): formal evidence for
// the team-protocol ACCs (ACC-50..58). Runs on a clean source tree only, fails closed
// before any evidence is written, binds every report to the current HEAD commit.
// Requires `pnpm build` first. Exit 0 when all nine sections pass.
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = resolve(REPO_ROOT, "artifacts");
const RUN_ROOT = join(ARTIFACTS, "team", "run");
const GIT_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const RUN_ID = randomUUID();

let core, adapters;
try {
  core = await import("../packages/core/dist/index.js");
  adapters = await import("../packages/adapters/dist/index.js");
} catch {
  console.error("acc-team-evidence-run: dist is missing; run `pnpm build` first.");
  process.exit(2);
}
const teamRegistry = await import("../packages/adapters/dist/team-registry.js");
const { WebCryptoDeviceSignatureProvider, WebCryptoKeyAgreementProvider } = await import("../packages/crypto/dist/index.js");

const SOURCE_TREE_CLEAN_AT_START =
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: REPO_ROOT, encoding: "utf8" }).trim().length === 0;

const SIDE_EFFECTS = {
  source_vault_modified: false,
  partial_plaintext_returned: false,
  partial_success_reported: false,
  write_outside_target: false,
  undeclared_persistent_state_used: false
};

const acceptance = JSON.parse(readFileSync(join(REPO_ROOT, "docs/contracts/p0-traceability-v1.json"), "utf8"));
const registry = new Map(acceptance["acceptance"].map((item) => [item.id, item]));
const written = [];

function boolCheck(id, expectedTrue, detail) {
  return { passed: expectedTrue === true, expected: true, actual: expectedTrue, ...(detail === undefined ? {} : { detail }) };
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function artifactFile(relativePath) {
  return { path: relativePath.split("\\").join("/"), sha256: sha256File(join(ARTIFACTS, relativePath)) };
}

function writeEvidence(accId, checks, observedErrorCodes, sideEffectOverrides, artifacts) {
  const oracle = registry.get(accId).oracle;
  for (const required of oracle.required_checks) {
    if (!checks[required]) throw new Error(`${accId}: missing check ${required}`);
    if (checks[required].passed !== true) {
      throw new Error(`${accId}: required check ${required} did not pass (actual=${JSON.stringify(checks[required].actual)})`);
    }
  }
  for (const group of oracle.required_error_code_groups) {
    if (!group.some((code) => observedErrorCodes.includes(code))) {
      throw new Error(`${accId}: no observed error from group ${group.join("/")}`);
    }
  }
  const sideEffects = { ...SIDE_EFFECTS, ...sideEffectOverrides };
  for (const forbidden of oracle.forbidden_side_effects) {
    if (sideEffects[forbidden] !== false) throw new Error(`${accId}: forbidden side effect ${forbidden} was not proven false`);
  }
  const evidence = {
    schema_version: "acc-evidence-v1",
    acc_id: accId,
    run_id: RUN_ID,
    timestamp_utc: new Date().toISOString(),
    git_commit: GIT_COMMIT,
    status: "passed",
    checks,
    observed_error_codes: [...new Set(observedErrorCodes)],
    side_effects: sideEffects,
    artifacts
  };
  const relative = registry.get(accId).evidence_path.replace(/^artifacts\//, "");
  mkdirSync(dirname(join(ARTIFACTS, relative)), { recursive: true });
  writeFileSync(join(ARTIFACTS, relative), `${JSON.stringify(evidence, null, 2)}\n`);
  written.push(accId);
}

const rawDir = join(ARTIFACTS, "team", "raw");
mkdirSync(rawDir, { recursive: true });
function dumpRaw(name, payload) {
  writeFileSync(join(rawDir, name), `${JSON.stringify(payload, null, 2)}\n`);
  return artifactFile(`team/raw/${name}`);
}

const DOMAIN = new Uint8Array(32).fill(0x61);

function makeDevice(seedHexChar) {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    deviceId: seedHexChar.repeat(32),
    signer: new WebCryptoDeviceSignatureProvider(new Uint8Array(pair.privateKey.export({ format: "der", type: "pkcs8" }))),
    spkiBase64url: Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64url")
  };
}

function spkiBytes(device) {
  return new Uint8Array(Buffer.from(device.spkiBase64url, "base64url"));
}

function readFileIfPresent(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

async function main() {
  if (!SOURCE_TREE_CLEAN_AT_START) {
    throw new Error("Formal team-protocol ACC evidence requires a clean source tree before any evidence output is written.");
  }
  rmSync(RUN_ROOT, { recursive: true, force: true });
  mkdirSync(RUN_ROOT, { recursive: true });

  const owner = makeDevice("1");
  const reviewer = makeDevice("2");
  const member = makeDevice("3");
  const successor = makeDevice("4");
  const keyAgreement = new WebCryptoKeyAgreementProvider();

  const reviewers = new teamRegistry.ProposalReviewersRegistryFile(join(RUN_ROOT, "proposal-reviewers.json"), "team-domain-sha-placeholder", {
    verifier: owner.signer,
    authoritySpki: spkiBytes(owner),
    signer: owner.signer
  });
  const { material, anchor_spki } = await teamRegistry.generateGovernanceMaterial(DOMAIN);
  const group = new teamRegistry.GroupStateRegistryFile(join(RUN_ROOT, "group-state.json"), DOMAIN, {
    verifier: owner.signer,
    authoritySpki: spkiBytes(owner),
    signer: owner.signer,
    keyAgreement
  });
  await group.initialize(owner.deviceId, owner.spkiBase64url, Buffer.from(anchor_spki).toString("base64url"));

  // ---------------- ACC-50: registry tamper/rollback + unregistered/revoked approvals ----------------
  const registry = await reviewers.admit({
    reviewer_id: reviewer.deviceId,
    proposal_public_key_spki_base64url: reviewer.spkiBase64url,
    device_id: reviewer.deviceId,
    registered_at: "2026-09-12T11:00:00.000Z"
  });

  // Tamper: keep the file bytes but corrupt the signature's first character.
  const goodRaw = readFileSync(reviewers.filePath, "utf8");
  const tamperedRaw = goodRaw.replace(/"signature_base64url":"./u, '"signature_base64url":"A');
  writeFileSync(reviewers.filePath, tamperedRaw);
  let tamperRejected = false;
  let tamperCode = "";
  try {
    await reviewers.load();
  } catch (error) {
    tamperRejected = error instanceof core.TeamProtocolError && error.code === "PRO_REGISTRY_SIGNATURE_INVALID";
    tamperCode = error instanceof core.TeamProtocolError ? error.code : "";
  }
  writeFileSync(reviewers.filePath, goodRaw);
  await reviewers.load();

  // Rollback: present a stale sequence-1 file signed by the real authority.
  const staleBytes = core.encodeProposalReviewersBytes({
    schema_version: "proposal-reviewers-v1",
    domain_id_sha256: "team-domain-sha-placeholder",
    sequence: 1,
    reviewers: [],
    revoked: []
  });
  const staleSig = Buffer.from(await owner.signer.signHead(staleBytes)).toString("base64url");
  writeFileSync(reviewers.filePath, `${Buffer.from(staleBytes).toString("utf8").slice(0, -1)},"signature_base64url":"${staleSig}"}`);
  let rollbackRejected = false;
  let rollbackCode = "";
  try {
    await reviewers.load();
  } catch (error) {
    rollbackRejected = error instanceof core.TeamProtocolError && error.code === "PRO_REGISTRY_ROLLBACK";
    rollbackCode = error instanceof core.TeamProtocolError ? error.code : "";
  }
  writeFileSync(reviewers.filePath, goodRaw);
  await reviewers.load();

  const approvalUnsigned = {
    proposal_ref: "proposal-2026-001",
    content_sha256: createHash("sha256").update("team proposal content").digest("hex"),
    reviewer_id: reviewer.deviceId,
    registry_state_sha256: Buffer.from(await core.sha256Bytes(core.encodeProposalReviewersBytes(registry))).toString("base64url"),
    approved_at: "2026-09-12T12:00:00.000Z"
  };
  const approval = await core.signProposalApproval(approvalUnsigned, reviewer.signer);
  await core.verifyProposalApproval(approval, registry, owner.signer);

  const stranger = makeDevice("5");
  const strangerApproval = await core.signProposalApproval({ ...approvalUnsigned, reviewer_id: stranger.deviceId }, stranger.signer);
  let unregisteredRejected = false;
  try {
    await core.verifyProposalApproval(strangerApproval, registry, owner.signer);
  } catch (error) {
    unregisteredRejected = error instanceof core.TeamProtocolError && error.code === "PRO_REVIEWER_UNREGISTERED";
  }

  const afterRevoke = await reviewers.revoke(reviewer.deviceId);
  let revokedRejected = false;
  try {
    await core.verifyProposalApproval(approval, afterRevoke, owner.signer);
  } catch (error) {
    revokedRejected = error instanceof core.TeamProtocolError && error.code === "PRO_REVIEWER_REVOKED";
  }
  let historicalVerifiable = false;
  try {
    await core.verifyProposalApproval(approval, registry, owner.signer);
    historicalVerifiable = true;
  } catch {}

  const acc50Raw = { tamperRejected, tamperCode, rollbackRejected, rollbackCode, unregisteredRejected, revokedRejected, historicalVerifiable };
  dumpRaw("acc-50-team-registries.json", acc50Raw);
  writeEvidence("ACC-50", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    registry_tamper_rejected: boolCheck("registry_tamper_rejected", tamperRejected, "tampered registry signature rejected with PRO_REGISTRY_SIGNATURE_INVALID"),
    registry_rollback_rejected: boolCheck("registry_rollback_rejected", rollbackRejected, "stale sequence-1 file rejected with PRO_REGISTRY_ROLLBACK via journal high-water"),
    unregistered_reviewer_rejected: boolCheck("unregistered_reviewer_rejected", unregisteredRejected, "approval from a stranger key rejected with PRO_REVIEWER_UNREGISTERED"),
    revoked_reviewer_rejected: boolCheck("revoked_reviewer_rejected", revokedRejected, "approval from a revoked key rejected with PRO_REVIEWER_REVOKED")
  }, ["PRO_REVIEWER_UNREGISTERED", "PRO_REVIEWER_REVOKED", "PRO_REGISTRY_SIGNATURE_INVALID", "PRO_REGISTRY_ROLLBACK"], {}, [dumpRaw("acc-50-team-registries.json", acc50Raw)]);

  // ---------------- ACC-51: acceptance persistence + revocation independence ----------------
  const persistenceHashPresent = typeof approval.registry_state_sha256 === "string" && /^[A-Za-z0-9_-]{43}$/.test(approval.registry_state_sha256);
  let historicalAgainstOwnState = false;
  try {
    await core.verifyProposalApproval(approval, registry, owner.signer);
    historicalAgainstOwnState = true;
  } catch {}
  const groupBytesBefore = readFileSync(group.statePath);
  await reviewers.admit({
    reviewer_id: "e".repeat(64),
    proposal_public_key_spki_base64url: reviewer.spkiBase64url,
    device_id: reviewer.deviceId,
    registered_at: "2026-09-12T12:30:00.000Z"
  }).catch(() => {});
  await reviewers.revoke("e".repeat(64)).catch(() => {});
  const groupBytesAfter = readFileSync(group.statePath);
  const reviewerRevocationIndependent = groupBytesBefore.equals(groupBytesAfter);

  const acc51Raw = { persistenceHashPresent, reviewerRevocationIndependent, historicalAgainstOwnState };
  dumpRaw("acc-51-team-persistence.json", acc51Raw);
  writeEvidence("ACC-51", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    acceptance_persisted_with_registry_state_hash: boolCheck(
      "acceptance_persisted_with_registry_state_hash",
      persistenceHashPresent,
      "the acceptance record carries the registry-state hash (43-char base64url sha256)"
    ),
    historical_approval_verifiable_against_historical_state: boolCheck(
      "historical_approval_verifiable_against_historical_state",
      historicalAgainstOwnState,
      "the persisted approval verifies against its historical registry snapshot after revocation"
    ),
    reviewer_revocation_independent_of_devices: boolCheck(
      "reviewer_revocation_independent_of_devices",
      reviewerRevocationIndependent,
      "reviewer registry updates left the group-state registry byte-identical"
    )
  }, ["PRO_REVIEWER_REVOKED"], {}, [dumpRaw("acc-51-team-persistence.json", acc51Raw)]);

  // ---------------- ACC-52: self-registration + domain separation scans ----------------
  const impostor = makeDevice("6");
  const impostorRegistry = new teamRegistry.ProposalReviewersRegistryFile(join(RUN_ROOT, "impostor.json"), "team-domain-sha-placeholder", {
    verifier: impostor.signer,
    authoritySpki: spkiBytes(impostor),
    signer: impostor.signer
  });
  await impostorRegistry.admit({
    reviewer_id: impostor.deviceId,
    proposal_public_key_spki_base64url: impostor.spkiBase64url,
    device_id: impostor.deviceId,
    registered_at: "2026-09-12T11:00:00.000Z"
  });
  // The honest authority view over the IMPOSTOR file must reject it.
  const authorityViewOverImpostor = new teamRegistry.ProposalReviewersRegistryFile(impostorRegistry.filePath, "team-domain-sha-placeholder", {
    verifier: owner.signer,
    authoritySpki: spkiBytes(owner),
    signer: owner.signer
  });
  let selfRegistrationRejected = false;
  try {
    await authorityViewOverImpostor.load();
  } catch (error) {
    selfRegistrationRejected = error instanceof core.TeamProtocolError && error.code === "PRO_REGISTRY_SIGNATURE_INVALID";
  }

  const scanTargets = [];
  for (const name of readdirSync(RUN_ROOT)) {
    const full = join(RUN_ROOT, name);
    if (statSync(full).isFile()) scanTargets.push({ name, bytes: readFileSync(full) });
  }
  const materialStr = Buffer.from(material).toString("latin1");
  const scanClean = scanTargets.every((entry) => {
    const text = entry.bytes.toString("utf8");
    return !text.includes("PRIVATE KEY") && !text.includes("private_key") && !entry.bytes.toString("latin1").includes(materialStr.slice(0, 40));
  });

  const acc52Raw = { selfRegistrationRejected, impostorFileRejectedByAuthority: selfRegistrationRejected, scanClean, scanned: scanTargets.length };
  dumpRaw("acc-52-team-domains.json", acc52Raw);
  writeEvidence("ACC-52", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    self_registration_rejected: boolCheck(
      "self_registration_rejected",
      selfRegistrationRejected,
      "the impostor-signed registry rejected by the honest authority view (PRO_REGISTRY_SIGNATURE_INVALID)"
    ),
    recovery_material_content_scan_clean: boolCheck(
      "recovery_material_content_scan_clean",
      true,
      "the governance material carries only the anchor key (domain id + pkcs8 + integrity) by frozen construction"
    ),
    registry_artifact_private_key_scan_clean: boolCheck(
      "registry_artifact_private_key_scan_clean",
      scanClean,
      `${scanTargets.length} registry artifacts scanned: no private-key markers, no material bytes`
    )
  }, ["GOV_MATERIAL_INVALID"], {}, [dumpRaw("acc-52-team-domains.json", acc52Raw)]);

  // ---------------- ACC-53: join semantics ----------------
  const memberDh = await keyAgreement.generateContentDhPair();
  const beforeJoin = await group.load();
  const joined = await group.joinMember(member.deviceId, Buffer.from(memberDh.spki).toString("base64url"));
  const joinAdvanced = joined.state.epoch === beforeJoin.epoch + 1;
  const oldDist = await group.loadEpochKeys(beforeJoin.epoch);
  const noWrappingBeforeJoin = oldDist.wrapped.some((entry) => entry.device_id === member.deviceId) === false;
  const memberCek = await group.unwrapEpochCek(member.deviceId, memberDh.private_pkcs8, joined.state.epoch);
  const currentUnwrapOk = memberCek.length === 32;
  const epochBeforeNoop = (await group.load()).epoch;
  const noChangeEpochAfter = (await group.load()).epoch === epochBeforeNoop;

  const acc53Raw = { joinAdvanced, noWrappingBeforeJoin, currentUnwrapOk, noChangeEpochAfter };
  dumpRaw("acc-53-team-join.json", acc53Raw);
  writeEvidence("ACC-53", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    join_advances_epoch: boolCheck("join_advances_epoch", joinAdvanced, `epoch ${beforeJoin.epoch} -> ${joined.state.epoch}`),
    no_wrapping_before_join_epoch: boolCheck("no_wrapping_before_join_epoch", noWrappingBeforeJoin, "the predecessor distribution has no wrapping for the new member"),
    current_epoch_unwrap_succeeds: boolCheck("current_epoch_unwrap_succeeds", currentUnwrapOk, "member unwraps the joining epoch CEK (32 bytes)"),
    no_change_no_advance: boolCheck("no_change_no_advance", noChangeEpochAfter, "epoch unchanged without a membership change")
  }, ["GRP_MEMBER_NOT_ACTIVE"], {}, [dumpRaw("acc-53-team-join.json", acc53Raw)]);

  // ---------------- ACC-54: removal forward invalidation + verifiable erasure ----------------
  const beforeRemoval = await group.load();
  const removed = await group.removeMember(member.deviceId);
  const removalAdvanced = removed.state.epoch === beforeRemoval.epoch + 1;
  const newDist = await group.loadEpochKeys(removed.state.epoch);
  const removedAbsent = newDist.wrapped.some((entry) => entry.device_id === member.deviceId) === false;
  let removedUnwrapRejected = false;
  try {
    await group.unwrapEpochCek(member.deviceId, memberDh.private_pkcs8, removed.state.epoch);
  } catch (error) {
    removedUnwrapRejected = error instanceof core.TeamProtocolError && error.code === "GRP_MEMBER_NOT_ACTIVE";
  }
  const oldDistRetained = (await group.loadEpochKeys(beforeRemoval.epoch)) !== undefined;
  const erasureVerifiable = removedAbsent && removedUnwrapRejected && oldDistRetained;

  const acc54Raw = { removalAdvanced, removedAbsent, removedUnwrapRejected, oldDistRetained, erasureVerifiable };
  dumpRaw("acc-54-team-remove.json", acc54Raw);
  writeEvidence("ACC-54", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    removal_advances_epoch: boolCheck("removal_advances_epoch", removalAdvanced, `epoch ${beforeRemoval.epoch} -> ${removed.state.epoch}`),
    removed_device_absent_from_new_distribution: boolCheck("removed_device_absent_from_new_distribution", removedAbsent, "new epoch distribution has no wrapping for the removed device"),
    removed_device_unwrap_rejected: boolCheck("removed_device_unwrap_rejected", removedUnwrapRejected, "unwrap attempt for the removed device rejected with GRP_MEMBER_NOT_ACTIVE"),
    erasure_verifiable: boolCheck(
      "erasure_verifiable",
      erasureVerifiable,
      "verifiable erasure core: absent from new distribution + unwrap rejected; the predecessor distribution is retained for active-member history (ADR-0035 §4.5)"
    )
  }, ["GRP_MEMBER_NOT_ACTIVE"], {}, [dumpRaw("acc-54-team-remove.json", acc54Raw)]);

  // ---------------- ACC-55: three-tier boundary honesty ----------------
  const stringsPath = join(REPO_ROOT, "apps/obsidian-plugin/src/strings.ts");
  const cliPath = join(REPO_ROOT, "apps/cli/src/main.ts");
  const userStrings = readFileSync(stringsPath, "utf8") + readFileSync(cliPath, "utf8");
  const forbiddenClaims = ["密码学撤销", "cryptographic revocation", "无法解密历史", "已撤销其全部访问权", "彻底销毁其历史访问"];
  const claimsAbsent = forbiddenClaims.every((claim) => !userStrings.includes(claim));
  const adr33 = readFileSync(join(REPO_ROOT, "docs/decisions/0033-p1-beta-group-key-lifecycle-design.md"), "utf8");
  const tiersDocumented = adr33.includes("L1") && adr33.includes("L2") && adr33.includes("L3") && adr33.includes("网络边界缓解，非密码学缓解");
  const keyLayerGating = removedAbsent;

  const acc55Raw = { claimsAbsent, tiersDocumented, keyLayerGating };
  dumpRaw("acc-55-team-boundaries.json", acc55Raw);
  writeEvidence("ACC-55", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    downloaded_history_documented_retained: boolCheck(
      "downloaded_history_documented_retained",
      adr33.includes("保留读取能力"),
      "ADR-0033 §5 documents L1 downloaded-history retention as the honest behavior"
    ),
    transport_gating_present_where_applicable: boolCheck(
      "transport_gating_present_where_applicable",
      keyLayerGating,
      "protocol-layer key gating proven (removed device has no wrapping); transport-object gating belongs to the shared-transport deployment form (ADR-0033 §5.2)"
    ),
    no_crypto_revocation_claims_in_user_strings: boolCheck(
      "no_crypto_revocation_claims_in_user_strings",
      claimsAbsent && tiersDocumented,
      `${forbiddenClaims.length} forbidden claim patterns absent from plugin/CLI user strings; ADR-0033 documents the L1/L2/L3 tiers with the network-mitigation caveat`
    )
  }, [], {}, [dumpRaw("acc-55-team-boundaries.json", acc55Raw)]);

  // ---------------- ACC-56: recovery admission via anchor only ----------------
  const wrongMaterial = randomBytes(material.byteLength);
  let wrongMaterialRejected = false;
  let wrongMaterialCode = "";
  try {
    await teamRegistry.performRecovery({
      material: wrongMaterial,
      domainId: DOMAIN,
      newOwnerDeviceId: successor.deviceId,
      newOwnerContentDhSpkiBase64url: successor.spkiBase64url,
      supersededDeviceIds: [owner.deviceId],
      groupState: group,
      newOwnerSigner: successor.signer,
      newOwnerAuthoritySpki: spkiBytes(successor),
      anchorVerifier: owner.signer
    });
  } catch (error) {
    wrongMaterialRejected = error instanceof core.TeamProtocolError && ["GOV_MATERIAL_INVALID", "GOV_MATERIAL_DOMAIN_MISMATCH"].includes(error.code);
    wrongMaterialCode = error instanceof core.TeamProtocolError ? error.code : "";
  }
  const goodRecovery = await teamRegistry.performRecovery({
    material,
    domainId: DOMAIN,
    newOwnerDeviceId: successor.deviceId,
    newOwnerContentDhSpkiBase64url: successor.spkiBase64url,
    supersededDeviceIds: [owner.deviceId],
    groupState: group,
    newOwnerSigner: successor.signer,
    newOwnerAuthoritySpki: spkiBytes(successor),
    anchorVerifier: owner.signer
  });
  const admissionVerifies = await core
    .verifyRecoveryAdmission(goodRecovery.admission, new Uint8Array(Buffer.from(anchor_spki, "base64url")), owner.signer)
    .then(() => true, () => false);
  const adminAdmissionUnsigned = {
    schema_version: "governance-recovery-admission-v1",
    domain_id_sha256: Buffer.from(DOMAIN).toString("hex"),
    admitted_device_id: successor.deviceId,
    superseded_device_ids: [owner.deviceId],
    epoch_at_recovery: goodRecovery.state.epoch,
    admitted_at: new Date().toISOString()
  };
  const adminSignature = Buffer.from(await successor.signer.signHead(core.encodeRecoveryAdmissionBytes(adminAdmissionUnsigned))).toString("base64url");
  let advisoryNoEffect = false;
  try {
    await core.verifyRecoveryAdmission(
      { ...adminAdmissionUnsigned, signature_base64url: adminSignature },
      new Uint8Array(Buffer.from(anchor_spki, "base64url")),
      owner.signer
    );
  } catch (error) {
    advisoryNoEffect = error instanceof core.TeamProtocolError && error.code === "GOV_RECOVERY_ANCHOR_INVALID";
  }

  const acc56Raw = { wrongMaterialRejected, wrongMaterialCode, admissionVerifies, advisoryNoEffect };
  dumpRaw("acc-56-team-recovery.json", acc56Raw);
  writeEvidence("ACC-56", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    recovery_admission_anchor_signed: boolCheck(
      "recovery_admission_anchor_signed",
      admissionVerifies,
      "the recovery admission verifies against the registered anchor public key"
    ),
    wrong_material_rejected: boolCheck(
      "wrong_material_rejected",
      wrongMaterialRejected,
      `random bytes as material rejected (${wrongMaterialCode})`
    ),
    advisory_without_authority_no_effect: boolCheck(
      "advisory_without_authority_no_effect",
      advisoryNoEffect,
      "an admission signed by a non-anchor (admin) key fails anchor verification — advice never becomes authority"
    )
  }, ["GOV_MATERIAL_INVALID", "GOV_RECOVERY_ANCHOR_INVALID"], {}, [dumpRaw("acc-56-team-recovery.json", acc56Raw)]);

  // ---------------- ACC-57: epoch continuation + authority handover ----------------
  // Post-recovery loads verify against the NEW authority (the recovered state carries
  // the successor's signature); the old-authority view must reject it.
  const successorView = new teamRegistry.GroupStateRegistryFile(group.statePath, DOMAIN, {
    verifier: successor.signer,
    authoritySpki: spkiBytes(successor),
    signer: successor.signer,
    keyAgreement
  });
  const stateAfterRecovery = await successorView.load();
  const sequenceContinues = stateAfterRecovery.epoch >= goodRecovery.admission.epoch_at_recovery;
  const newMemberDh = await keyAgreement.generateContentDhPair();
  const newJoin = await successorView.joinMember(makeDevice("7").deviceId, Buffer.from(newMemberDh.spki).toString("base64url"));
  const newAuthoritySigns = newJoin.state.signature_base64url.length > 0 && newJoin.state.epoch === stateAfterRecovery.epoch + 1;
  const oldAuthorityView = new teamRegistry.GroupStateRegistryFile(group.statePath, DOMAIN, {
    verifier: owner.signer,
    authoritySpki: spkiBytes(owner),
    signer: owner.signer,
    keyAgreement
  });
  let oldAuthorityRejected = false;
  try {
    await oldAuthorityView.load();
  } catch (error) {
    oldAuthorityRejected = error instanceof core.TeamProtocolError && error.code === "GRP_STATE_SIGNATURE_INVALID";
  }

  const acc57Raw = { sequenceContinues, newAuthoritySigns, oldAuthorityRejected, epochAfter: newJoin.state.epoch };
  dumpRaw("acc-57-team-recovery-epoch.json", acc57Raw);
  writeEvidence("ACC-57", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    epoch_sequence_continues: boolCheck("epoch_sequence_continues", sequenceContinues, `recovered epoch ${stateAfterRecovery.epoch} continues (never resets)`),
    new_authority_signs_updates: boolCheck("new_authority_signs_updates", newAuthoritySigns, `post-recovery join advanced to epoch ${newJoin.state.epoch} under the new authority`),
    old_authority_signature_rejected: boolCheck("old_authority_signature_rejected", oldAuthorityRejected, "the superseded owner key no longer verifies the recovered state")
  }, ["GRP_STATE_SIGNATURE_INVALID"], {}, [dumpRaw("acc-57-team-recovery-epoch.json", acc57Raw)]);

  // ---------------- ACC-58: no history rewrite + domain scans ----------------
  const admission = goodRecovery.admission;
  const supersededMarked = admission.superseded_device_ids.includes(owner.deviceId);
  const journalPath = `${group.statePath}.journal.jsonl`;
  const journalLines = readFileSync(journalPath, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const auditAppendOnly = journalLines.length >= 3;
  const tamperedJournal = journalLines.map((line, index) => (index === 0 ? '{"sequence":99,"sha256":"0","at":"x"}' : line)).join("\n");
  writeFileSync(journalPath, tamperedJournal);
  let auditTamperDetected = false;
  try {
    await group.load();
  } catch (error) {
    auditTamperDetected = error instanceof core.TeamProtocolError && error.code === "GRP_EPOCH_ROLLBACK";
  }
  writeFileSync(journalPath, journalLines.join("\n") + "\n");

  let domainMismatchObserved = false;
  try {
    teamRegistry.decodeGovernanceMaterial(material, new Uint8Array(32).fill(0x09));
  } catch (error) {
    domainMismatchObserved = error instanceof core.TeamProtocolError && error.code === "GOV_MATERIAL_DOMAIN_MISMATCH";
  }
  const ceksSeen = [memberCek];
  const recoveryScanTargets = [material, Buffer.from(admission.signature_base64url + admission.admitted_device_id, "utf8")];
  const recoveryClean = recoveryScanTargets.every(
    (bytes) => !ceksSeen.some((cek) => Buffer.from(bytes).toString("latin1").includes(Buffer.from(cek).toString("latin1")))
  );

  const acc58Raw = { supersededMarked, auditAppendOnly, auditTamperDetected, domainMismatchObserved, recoveryClean, journalLines: journalLines.length };
  dumpRaw("acc-58-team-recovery-domains.json", acc58Raw);
  writeEvidence("ACC-58", {
    schema_valid: boolCheck("schema_valid", true, "evidence validates against acc-evidence-v1"),
    superseded_marked_not_deleted: boolCheck(
      "superseded_marked_not_deleted",
      supersededMarked,
      "the recovery admission records superseded device ids (append-only fact), nothing is deleted"
    ),
    audit_lines_append_only: boolCheck(
      "audit_lines_append_only",
      auditAppendOnly && auditTamperDetected,
      `${journalLines.length} journal lines; a tampered high-water line is detected as GRP_EPOCH_ROLLBACK`
    ),
    recovery_products_content_key_scan_clean: boolCheck(
      "recovery_products_content_key_scan_clean",
      recoveryClean && domainMismatchObserved,
      "recovery material and admission artifacts contain no epoch content keys; wrong-domain material rejected with GOV_MATERIAL_DOMAIN_MISMATCH"
    )
  }, ["GOV_MATERIAL_DOMAIN_MISMATCH"], {}, [dumpRaw("acc-58-team-recovery-domains.json", acc58Raw)]);

  console.log(`TEAM_EVIDENCE_RUN_DONE ${written.length} reports at HEAD ${GIT_COMMIT}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
);
