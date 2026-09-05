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

    @staticmethod
    def __status_items(passed: int, extra_untested: int = 0, scope: str = "stage-7") -> list[dict[str, object]]:
        items: list[dict[str, object]] = [{"id": f"ACC-{index:02d}", "status": "passed"} for index in range(1, passed + 1)]
        items.extend(
            {"id": f"ACC-{len(items) + 1:02d}", "status": "untested", "evidence_scope": scope}
            for _ in range(extra_untested)
        )
        return items

    def test_acc_status_rule_allows_only_full_evidence_backed_flip(self) -> None:
        closure = "R1_EVIDENCE_CLOSED_AT_COMMIT: " + "a" * 40 + "\n"
        both = closure + "S7_EVIDENCE_CLOSED_AT_COMMIT: " + "f" * 40 + "\n"
        verifier._require_acc_statuses([{"id": f"ACC-{index:02d}", "status": "untested"} for index in range(1, 44)], "")
        verifier._require_acc_statuses(self.__status_items(37), closure)
        verifier._require_acc_statuses(self.__status_items(40, extra_untested=3, scope="p1-alpha"), closure)
        items_s7 = self.__status_items(40, extra_untested=3, scope="stage-7")
        for item in items_s7:
            item["status"] = "passed"
        verifier._require_acc_statuses(items_s7, both)
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses(items_s7, closure)
        items_p1 = self.__status_items(40, extra_untested=3, scope="p1-alpha")
        for item in items_p1:
            item["status"] = "passed"
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses(items_p1, both)
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses(self.__status_items(37), "")
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses(self.__status_items(36) + [{"id": "ACC-37", "status": "untested"}], closure)
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses([{"id": "ACC-01", "status": "bogus"}], closure)
        with self.assertRaises(verifier.ContractError):
            verifier._require_acc_statuses(self.__status_items(37) + [{"id": "ACC-38", "status": "untested", "evidence_scope": "made-up-scope"}], closure)

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

    def test_plugin_snapshot_report_schema_rejects_plaintext_domain_id(self) -> None:
        schema = verifier._load_schema("p0-plugin-snapshot-report-v1.schema.json")
        sample = verifier.load_json(verifier.SAMPLES / "p0-plugin-snapshot-report.positive.json")
        verifier._validate_against_schema(sample, schema, "positive")

        leaked = dict(sample)
        leaked["domain_id_hex"] = "00" * 32
        with self.assertRaises(verifier.ContractError):
            verifier._validate_against_schema(leaked, schema, "plaintext-domain-id")

    def test_plugin_snapshot_only_gate_rejects_restore_surface_and_broad_adapter_import(self) -> None:
        valid = 'id: "p0-create-snapshot"\nimport("@ekd/adapters/obsidian-vault")\n'
        verifier._require_plugin_snapshot_only(valid)
        for forbidden in ('id: "p0-restore"', "restoreSnapshotV1", "NodeRestoreTarget", 'import("@ekd/adapters")'):
            with self.assertRaises(verifier.ContractError):
                verifier._require_plugin_snapshot_only(valid + forbidden)

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
