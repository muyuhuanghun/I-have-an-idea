#!/usr/bin/env python3
"""ADR-0018 §5.2: independent fresh-process restore verifier (stdlib only).

Compares the source Vault directory against the restored directory — the path sets must be
equal and every file must match byte for byte — and optionally re-verifies the Recovery File
structure and HMAC-SHA256 integrity tag by deriving the integrity key with RFC 5869 HKDF.

The verifier deliberately does not decrypt any object: Python's standard library has no
AES-GCM, and ciphertext-side correctness is covered by AEAD authentication plus the TS test
suite. Exit codes: 0 = consistent, 1 = inconsistent, 2 = usage error.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import stat
import sys

RECOVERY_LENGTH = 167
RECOVERY_MAGIC = bytes([0x45, 0x4B, 0x44, 0x52])
DOMAIN_ID_OFFSET = 6
SUITE_ID_OFFSET = 38
RECOVERY_ROOT_OFFSET = 39
HMAC_COVERED_LENGTH = 135
INTEGRITY_TAG_OFFSET = 135
FINGERPRINT_OFFSET = 119
FINGERPRINT_LENGTH = 16
FINGERPRINT_LABEL = b"ekd-v1/recovery-fingerprint"
INTEGRITY_INFO = b"ekd-v1/recovery-file-integrity"
SUPPORTED_SUITE_ID = 1
COMPARE_CHUNK_BYTES = 1024 * 1024


class VerificationError(Exception):
    """Fail-closed input or filesystem condition in the independent verifier."""


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    """RFC 5869 HKDF with SHA-256 (extract + expand)."""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm = b""
    block = b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def verify_recovery_file(path: str) -> list[str]:
    problems: list[str] = []
    with open(path, "rb") as handle:
        data = handle.read()
    if len(data) != RECOVERY_LENGTH:
        return [f"recovery file is {len(data)} bytes; expected {RECOVERY_LENGTH}"]
    if data[:4] != RECOVERY_MAGIC:
        problems.append("recovery file magic does not match EKDR")
    if data[4] != 1 or data[5] != 1:
        problems.append("recovery file format or protocol version is unsupported")
    if data[SUITE_ID_OFFSET] != SUPPORTED_SUITE_ID:
        problems.append("recovery file suite is unsupported")
    domain_id = data[DOMAIN_ID_OFFSET:SUITE_ID_OFFSET]
    recovery_root = data[RECOVERY_ROOT_OFFSET:RECOVERY_ROOT_OFFSET + 32]
    if recovery_root == b"\x00" * 32:
        problems.append("recovery root is all zero")
    expected_fingerprint = hashlib.sha256(FINGERPRINT_LABEL + domain_id).digest()[:FINGERPRINT_LENGTH]
    actual_fingerprint = data[FINGERPRINT_OFFSET:FINGERPRINT_OFFSET + FINGERPRINT_LENGTH]
    if not hmac.compare_digest(expected_fingerprint, actual_fingerprint):
        problems.append("recovery file non-secret fingerprint is not canonical")
    integrity_key = hkdf_sha256(recovery_root, domain_id, INTEGRITY_INFO, 32)
    expected_tag = hmac.new(integrity_key, data[:HMAC_COVERED_LENGTH], hashlib.sha256).digest()
    if not hmac.compare_digest(expected_tag, data[INTEGRITY_TAG_OFFSET:INTEGRITY_TAG_OFFSET + 32]):
        problems.append("recovery file HMAC integrity tag does not match")
    return problems


def is_reparse_point(info: os.stat_result) -> bool:
    attributes = getattr(info, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return stat.S_ISLNK(info.st_mode) or bool(reparse_flag and attributes & reparse_flag)


def require_real_directory(root: str, label: str) -> None:
    try:
        info = os.lstat(root)
    except OSError as error:
        raise VerificationError(f"{label} directory is unavailable: {error}") from error
    if is_reparse_point(info):
        raise VerificationError(f"{label} directory is a reparse point")
    if not stat.S_ISDIR(info.st_mode):
        raise VerificationError(f"{label} path is not a directory")


def raise_walk_error(error: OSError) -> None:
    raise error


def walk(root: str, label: str) -> dict[str, tuple[str, int]]:
    require_real_directory(root, label)
    files: dict[str, tuple[str, int]] = {}
    for current, directories, names in os.walk(root, topdown=True, onerror=raise_walk_error, followlinks=False):
        retained_directories: list[str] = []
        for name in directories:
            absolute = os.path.join(current, name)
            info = os.lstat(absolute)
            if is_reparse_point(info):
                raise VerificationError(f"{label} tree contains a reparse-point directory: {os.path.relpath(absolute, root)}")
            if not stat.S_ISDIR(info.st_mode):
                raise VerificationError(f"{label} tree contains a non-directory entry in the directory list")
            if name != ".obsidian":
                retained_directories.append(name)
        directories[:] = retained_directories
        for name in names:
            absolute = os.path.join(current, name)
            info = os.lstat(absolute)
            if is_reparse_point(info):
                raise VerificationError(f"{label} tree contains a reparse-point file: {os.path.relpath(absolute, root)}")
            if not stat.S_ISREG(info.st_mode):
                raise VerificationError(f"{label} tree contains a non-regular file: {os.path.relpath(absolute, root)}")
            relative = os.path.relpath(absolute, root).replace(os.sep, "/")
            files[relative] = (absolute, info.st_size)
    return files


def files_equal(left_path: str, right_path: str) -> bool:
    with open(left_path, "rb") as left, open(right_path, "rb") as right:
        while True:
            left_chunk = left.read(COMPARE_CHUNK_BYTES)
            right_chunk = right.read(COMPARE_CHUNK_BYTES)
            if left_chunk != right_chunk:
                return False
            if not left_chunk:
                return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Independent source-vs-restored verifier.")
    parser.add_argument("--source", required=True, help="original Vault directory")
    parser.add_argument("--restored", required=True, help="restored directory")
    parser.add_argument("--recovery", help="Recovery File to structurally re-verify")
    args = parser.parse_args()

    problems: list[str] = []
    if args.recovery is not None:
        try:
            problems.extend(verify_recovery_file(args.recovery))
        except OSError as error:
            problems.append(f"recovery file could not be read: {error}")

    try:
        source = walk(args.source, "source")
        restored = walk(args.restored, "restored")
    except (OSError, VerificationError) as error:
        print(f"RESTORE_VERIFY_FAIL: directory walk failed: {error}")
        return 1

    source_paths = set(source)
    restored_paths = set(restored)
    for path in sorted(source_paths - restored_paths):
        problems.append(f"missing in restored output: {path}")
    for path in sorted(restored_paths - source_paths):
        problems.append(f"unexpected in restored output: {path}")
    for path in sorted(source_paths & restored_paths):
        source_record = source[path]
        restored_record = restored[path]
        if source_record[1] != restored_record[1] or not files_equal(source_record[0], restored_record[0]):
            problems.append(f"byte mismatch: {path}")

    if problems:
        for problem in problems:
            print(f"RESTORE_VERIFY_PROBLEM: {problem}")
        print("RESTORE_VERIFY_FAIL")
        return 1
    print(f"RESTORE_VERIFY_PASS files={len(source_paths)} bytes={sum(record[1] for record in source.values())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
