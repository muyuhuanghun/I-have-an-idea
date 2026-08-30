import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRestoreErrorCode, isSnapshotCreateErrorCode } from "../src/index.js";

interface CaseOracle {
  readonly schema_version: string;
  readonly scenarios: readonly { readonly id: string; readonly input: string; readonly expected_code: string }[];
}

const oracle = JSON.parse(
  await readFile(join(process.cwd(), "../../fixtures/edge-cases/case-oracle.json"), "utf8")
) as CaseOracle;

describe("DP-007 edge-case oracle", () => {
  it("freezes at least the ADR-0019 §3 scenario classes with registry-stable codes", () => {
    expect(oracle.schema_version).toBe("edge-case-oracle-v1");
    expect(oracle.scenarios.length).toBeGreaterThanOrEqual(15);
    const ids = new Set(oracle.scenarios.map((scenario) => scenario.id));
    for (const required of [
      "reserved-device-upper",
      "reserved-char-colon",
      "trailing-space",
      "hidden-segment",
      "escape-parent",
      "case-fold-a-angstrom",
      "case-fold-ascii",
      "reparse-symlink",
      "unsupported-exe",
      "scan-mutation",
      "object-missing",
      "object-tampered",
      "recovery-hmac",
      "target-nonempty",
      "target-write-failure",
      "log-write-failure"
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });

  it("maps every expected code to a frozen stable code", () => {
    for (const scenario of oracle.scenarios) {
      const valid =
        isRestoreErrorCode(scenario.expected_code) || isSnapshotCreateErrorCode(scenario.expected_code);
      expect(valid).toBe(true);
    }
  });
});
