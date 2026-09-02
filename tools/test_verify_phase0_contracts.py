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
