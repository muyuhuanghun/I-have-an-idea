from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from tools import verify_phase0_contracts as verifier


class Phase0EvidenceVerifierTests(unittest.TestCase):
    def test_perf_schema_requires_binding_and_raw_artifacts(self) -> None:
        schema = verifier._load_schema("perf-report-v1.schema.json")
        sample = verifier.load_json(verifier.SAMPLES / "perf-report.positive.json")
        verifier._validate_against_schema(sample, schema, "positive")

        without_binding = dict(sample)
        del without_binding["evidence_binding"]
        with self.assertRaises(verifier.ContractError):
            verifier._validate_against_schema(without_binding, schema, "without-binding")

        without_raw = dict(sample)
        without_raw["raw_artifacts"] = []
        with self.assertRaises(verifier.ContractError):
            verifier._validate_against_schema(without_raw, schema, "without-raw")

    def test_acc_status_rule_allows_only_full_evidence_backed_flip(self) -> None:
        closure = "R1_EVIDENCE_CLOSED_AT_COMMIT: " + "a" * 40 + "\n"
        verifier._require_acc_statuses(["untested"] * 37, "")
        verifier._require_acc_statuses(["passed"] * 37, closure)
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses(["passed"] * 37, "")
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses(["passed"] * 36 + ["untested"], closure)
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses(["bogus"] * 37, closure)

    def test_evidence_commit_must_match_closeout_declaration(self) -> None:
        closure = "R1_EVIDENCE_CLOSED_AT_COMMIT: " + "b" * 40 + "\n"
        self.assertEqual(verifier._r1_closure_commit(closure), "b" * 40)
        with self.assertRaises(verifier.ContractError):
            verifier._r1_closure_commit("no marker line here")

    def test_cli_runtime_limits_binding_must_match_contract_file(self) -> None:
        verifier._require_cli_runtime_limits_binding("c" * 64, "c" * 64)
        with self.assertRaises(verifier.ContractError):
            verifier._require_cli_runtime_limits_binding("d" * 64, "c" * 64)
        with self.assertRaises(verifier.ContractError):
            verifier._require_cli_runtime_limits_binding("NOT_A_HASH", "c" * 64)

    def test_nested_perf_raw_artifact_hash_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ekd-phase0-verifier-") as temporary:
            evidence_root = Path(temporary)
            raw_path = evidence_root / "performance-reports" / "raw" / "probe.txt"
            raw_path.parent.mkdir(parents=True)
            raw_path.write_bytes(b"bound raw artifact\n")

            report = verifier.load_json(verifier.SAMPLES / "perf-report.positive.json")
            report["raw_artifacts"] = [{
                "path": "performance-reports/raw/probe.txt",
                "sha256": hashlib.sha256(raw_path.read_bytes()).hexdigest(),
            }]
            report_path = evidence_root / "performance-reports" / "perf-report-probe.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")

            verifier._validate_nested_artifacts([report_path], evidence_root)
            raw_path.write_bytes(b"tampered\n")
            with self.assertRaises(verifier.ContractError):
                verifier._validate_nested_artifacts([report_path], evidence_root)


if __name__ == "__main__":
    unittest.main()
