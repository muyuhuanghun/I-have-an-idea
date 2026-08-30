from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
import tempfile
import unittest

from tools import verify_restore as verifier


def recovery_bytes() -> bytes:
    data = bytearray(verifier.RECOVERY_LENGTH)
    data[:4] = verifier.RECOVERY_MAGIC
    data[4] = 1
    data[5] = 1
    domain_id = bytes(range(32))
    recovery_root = bytes(range(32, 64))
    data[verifier.DOMAIN_ID_OFFSET:verifier.SUITE_ID_OFFSET] = domain_id
    data[verifier.SUITE_ID_OFFSET] = verifier.SUPPORTED_SUITE_ID
    data[verifier.RECOVERY_ROOT_OFFSET:verifier.RECOVERY_ROOT_OFFSET + 32] = recovery_root
    data[71:103] = bytes(range(64, 96))
    data[103:119] = bytes(range(16))
    fingerprint = hashlib.sha256(verifier.FINGERPRINT_LABEL + domain_id).digest()[:verifier.FINGERPRINT_LENGTH]
    data[verifier.FINGERPRINT_OFFSET:verifier.FINGERPRINT_OFFSET + verifier.FINGERPRINT_LENGTH] = fingerprint
    integrity_key = verifier.hkdf_sha256(recovery_root, domain_id, verifier.INTEGRITY_INFO, 32)
    tag = hmac.new(integrity_key, data[:verifier.HMAC_COVERED_LENGTH], hashlib.sha256).digest()
    data[verifier.INTEGRITY_TAG_OFFSET:verifier.INTEGRITY_TAG_OFFSET + 32] = tag
    return bytes(data)


class VerifyRestoreTests(unittest.TestCase):
    def test_missing_roots_fail_instead_of_matching_as_empty(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ekd-verify-parent-") as parent:
            missing = str(Path(parent) / "missing")
            with self.assertRaises(verifier.VerificationError):
                verifier.walk(missing, "source")

    def test_real_empty_directories_are_valid(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ekd-source-") as source:
            with tempfile.TemporaryDirectory(prefix="ekd-restored-") as restored:
                self.assertEqual(verifier.walk(source, "source"), {})
                self.assertEqual(verifier.walk(restored, "restored"), {})

    def test_reparse_root_is_rejected_when_supported(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ekd-link-parent-") as parent:
            real_root = Path(parent) / "real"
            real_root.mkdir()
            link_root = Path(parent) / "alias"
            try:
                os.symlink(real_root, link_root, target_is_directory=True)
            except OSError:
                self.skipTest("directory symlink creation is unavailable")
            with self.assertRaises(verifier.VerificationError):
                verifier.walk(str(link_root), "source")

    def test_streaming_comparison_detects_equal_and_different_bytes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ekd-compare-") as parent:
            left = Path(parent) / "left.bin"
            right = Path(parent) / "right.bin"
            left.write_bytes(b"a" * (verifier.COMPARE_CHUNK_BYTES + 1))
            right.write_bytes(left.read_bytes())
            self.assertTrue(verifier.files_equal(str(left), str(right)))
            right.write_bytes(b"a" * verifier.COMPARE_CHUNK_BYTES + b"b")
            self.assertFalse(verifier.files_equal(str(left), str(right)))

    def test_recovery_fingerprint_is_checked_independently_of_hmac(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ekd-recovery-") as parent:
            recovery_path = Path(parent) / "snapshot.recovery"
            valid = bytearray(recovery_bytes())
            recovery_path.write_bytes(valid)
            self.assertEqual(verifier.verify_recovery_file(str(recovery_path)), [])

            valid[verifier.FINGERPRINT_OFFSET] ^= 0xFF
            domain_id = bytes(valid[verifier.DOMAIN_ID_OFFSET:verifier.SUITE_ID_OFFSET])
            recovery_root = bytes(valid[verifier.RECOVERY_ROOT_OFFSET:verifier.RECOVERY_ROOT_OFFSET + 32])
            integrity_key = verifier.hkdf_sha256(recovery_root, domain_id, verifier.INTEGRITY_INFO, 32)
            tag = hmac.new(integrity_key, valid[:verifier.HMAC_COVERED_LENGTH], hashlib.sha256).digest()
            valid[verifier.INTEGRITY_TAG_OFFSET:verifier.INTEGRITY_TAG_OFFSET + 32] = tag
            recovery_path.write_bytes(valid)
            self.assertIn(
                "recovery file non-secret fingerprint is not canonical",
                verifier.verify_recovery_file(str(recovery_path)),
            )


if __name__ == "__main__":
    unittest.main()
