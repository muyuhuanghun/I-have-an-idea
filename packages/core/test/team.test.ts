// ADR-0035 §2 (P1-beta T2): core protocol-layer guarantees — canonical-JSON
// determinism, closed canonical form on parse, the epoch state machine and the
// pairwise-wrapping AAD layout.
import { describe, expect, it } from "vitest";
import {
  TeamProtocolError,
  admitReviewer,
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalTeamJson,
  encodeGroupStateBytes,
  encodeProposalReviewersBytes,
  emptyProposalReviewerRegistry,
  epochWrapAad,
  initialGroupState,
  joinMember,
  parseGroupStateBytes,
  removeMember,
  revokeReviewer
} from "../src/team.js";

const DOMAIN_SHA = "a".repeat(64);
const SPKI = "b".repeat(86);
const ANCHOR = "c".repeat(86);

describe("canonical encodings (ADR-0035 §2)", () => {
  it("produces byte-identical output for identical content", () => {
    const a = encodeProposalReviewersBytes(emptyProposalReviewerRegistry(DOMAIN_SHA));
    const b = encodeProposalReviewersBytes(emptyProposalReviewerRegistry(DOMAIN_SHA));
    expect(bytesToBase64Url(a)).toBe(bytesToBase64Url(b));
  });

  it("base64url helpers round-trip", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 255]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    expect(canonicalTeamJson({ a: 1 })).toBe('{"a":1}');
  });
});

describe("epoch state machine (ADR-0033 §3)", () => {
  it("every membership change advances the epoch and records removals append-only", () => {
    let state = initialGroupState(DOMAIN_SHA, "0".repeat(64), SPKI, ANCHOR);
    expect(state.epoch).toBe(1);
    state = joinMember(state, "1".repeat(64), SPKI);
    expect(state.epoch).toBe(2);
    state = joinMember(state, "2".repeat(64), SPKI);
    expect(state.epoch).toBe(3);
    state = removeMember(state, "1".repeat(64));
    expect(state.epoch).toBe(4);
    expect(state.members.map((entry) => entry.device_id)).toEqual(["0".repeat(64), "2".repeat(64)]);
    expect(state.removed).toEqual([{ device_id: "1".repeat(64), removed_epoch: 4 }]);
    expect(() => removeMember(state, "1".repeat(64))).toThrowError(TeamProtocolError);
  });

  it("reviewer admit/revoke keeps monotonic sequence and tombstones", () => {
    let registry = emptyProposalReviewerRegistry(DOMAIN_SHA);
    registry = admitReviewer(registry, {
      reviewer_id: "r".repeat(64),
      proposal_public_key_spki_base64url: SPKI,
      device_id: "0".repeat(64),
      registered_at: "2026-09-12T00:00:00.000Z"
    });
    expect(registry.sequence).toBe(2);
    registry = revokeReviewer(registry, "r".repeat(64), "2026-09-12T01:00:00.000Z");
    expect(registry.sequence).toBe(3);
    expect(registry.reviewers).toHaveLength(0);
    expect(registry.revoked).toHaveLength(1);
    expect(() => revokeReviewer(registry, "r".repeat(64), "2026-09-12T02:00:00.000Z")).toThrowError(TeamProtocolError);
  });
});

describe("closed canonical form on parse (ADR-0035 §2)", () => {
  it("rejects extra or missing fields; reordered fields normalize but cannot carry the old signature", () => {
    const unsigned = initialGroupState(DOMAIN_SHA, "0".repeat(64), SPKI, ANCHOR);
    const canonical = new TextDecoder().decode(encodeGroupStateBytes(unsigned));
    const extra = canonical.slice(0, -1) + ',"surprise":1}';
    expect(() => parseGroupStateBytes(new TextEncoder().encode(extra), "sig")).toThrowError(TeamProtocolError);
    const missing = canonical.replace('"epoch":1,', "");
    expect(() => parseGroupStateBytes(new TextEncoder().encode(missing), "sig")).toThrowError(TeamProtocolError);
    const reordered = canonical.replace('"epoch":1,', "");
    const tampered = `${reordered.slice(0, -1)},"epoch":1}`;
    const parsed = parseGroupStateBytes(new TextEncoder().encode(tampered), "sig");
    expect(new TextDecoder().decode(encodeGroupStateBytes(parsed))).toBe(canonical);
  });
});

describe("pairwise wrapping AAD (ADR-0035 §3.2)", () => {
  it("binds domain id, big-endian epoch and raw device-id bytes", () => {
    const domainId = new Uint8Array(32).fill(0x61);
    const aad = epochWrapAad(domainId, 7, "ff".repeat(16));
    expect(aad.byteLength).toBe(32 + 8 + 16);
    expect(aad[32 + 7]).toBe(7); // big-endian epoch byte
    expect(aad[32]).toBe(0);
    expect(Array.from(aad.slice(40, 42))).toEqual([0xff, 0xff]); // raw hex bytes, not UTF-8
    expect(bytesToBase64Url(epochWrapAad(domainId, 8, "ff".repeat(16)))).not.toBe(bytesToBase64Url(aad));
    expect(bytesToBase64Url(epochWrapAad(domainId, 7, "ee".repeat(16)))).not.toBe(bytesToBase64Url(aad));
  });
});
