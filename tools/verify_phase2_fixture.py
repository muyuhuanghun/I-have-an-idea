#!/usr/bin/env python3
"""Validate the small Phase 2 fixture without running performance workloads."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from verify_phase0_contracts import (
    ROOT,
    ContractError,
    _load_schema,
    _validate_against_schema,
    load_json,
    require,
)


REQUIRED_TINY_COVERAGE = {
    "markdown", "image", "pdf", "canvas", "c", "python",
    "empty-file", "chinese-path", "deep-path",
}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--allow-dirty-dev",
        action="store_true",
        help="Allow review-only validation when the declared generator commit does not yet contain the generator.",
    )
    return parser.parse_args()


def git_generator_bytes(commit: str, repository_path: str) -> bytes | None:
    result = subprocess.run(
        ["git", "show", f"{commit}:{repository_path}"],
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


def git_paths_are_tracked_and_clean(paths: list[Path]) -> bool:
    relative_paths = [path.resolve().relative_to(ROOT).as_posix() for path in paths]
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", *relative_paths],
        cwd=ROOT,
        capture_output=True,
        check=False,
        text=True,
    )
    if status.returncode != 0 or status.stdout.strip():
        return False
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", *relative_paths],
        cwd=ROOT,
        capture_output=True,
        check=False,
        text=True,
    )
    return tracked.returncode == 0


def validate_fixture(manifest_path: Path, allow_dirty_dev: bool) -> tuple[dict[str, object], str]:
    manifest_path = manifest_path.resolve()
    require(manifest_path.is_file(), f"fixture manifest does not exist: {manifest_path}")
    manifest = load_json(manifest_path)
    schema = _load_schema("fixture-manifest-v1.schema.json")
    _validate_against_schema(manifest, schema, "fixture-manifest-v1")
    require(manifest["profile"] == "tiny", "Phase 2 verifier only accepts the authorized tiny profile")
    require(manifest["constraints"]["verdict"] == "pass", "fixture constraint verdict is not pass")
    require(not manifest["constraints"]["validation_errors"], "fixture has validation errors")
    require(REQUIRED_TINY_COVERAGE <= set(manifest["feature_coverage"]), "tiny fixture feature coverage is incomplete")

    vault_root = manifest_path.parent / "vault"
    require(vault_root.is_dir(), "fixture vault directory is missing")
    declared_paths = [entry["relative_path"] for entry in manifest["entries"]]
    require(declared_paths == sorted(declared_paths, key=lambda value: value.encode("utf-8")), "fixture entries are not in UTF-8 byte order")
    require(len(declared_paths) == len(set(declared_paths)), "fixture contains duplicate paths")
    actual_paths = sorted(
        (path.relative_to(vault_root).as_posix() for path in vault_root.rglob("*") if path.is_file()),
        key=lambda value: value.encode("utf-8"),
    )
    require(actual_paths == declared_paths, "fixture file set does not match manifest entries")

    total_bytes = 0
    for entry in manifest["entries"]:
        target = (vault_root / entry["relative_path"]).resolve()
        require(vault_root.resolve() in target.parents, f"fixture path escapes vault root: {entry['relative_path']}")
        data = target.read_bytes()
        total_bytes += len(data)
        require(len(data) == entry["size_bytes"], f"fixture size mismatch: {entry['relative_path']}")
        require(sha256_bytes(data) == entry["sha256"], f"fixture digest mismatch: {entry['relative_path']}")

    require(manifest["totals"]["files"] == len(manifest["entries"]), "fixture file total mismatch")
    require(manifest["totals"]["bytes"] == total_bytes, "fixture byte total mismatch")
    entries_bytes = json.dumps(
        manifest["entries"], ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    require(sha256_bytes(entries_bytes) == manifest["entries_sha256"], "fixture entries digest mismatch")

    generator = manifest["generator"]
    generator_path = (ROOT / generator["path"]).resolve()
    require(ROOT in generator_path.parents, "generator path escapes repository")
    require(generator_path.is_file(), "fixture generator is missing")
    require(sha256_bytes(generator_path.read_bytes()) == generator["sha256"], "working generator digest mismatch")
    committed_bytes = git_generator_bytes(generator["git_commit"], generator["path"])
    commit_bound = committed_bytes is not None and sha256_bytes(committed_bytes) == generator["sha256"]
    provenance_paths = [generator_path, manifest_path, *[vault_root / path for path in declared_paths]]
    clean_and_tracked = git_paths_are_tracked_and_clean(provenance_paths)
    formal = commit_bound and clean_and_tracked
    if not formal and not allow_dirty_dev:
        raise ContractError("fixture provenance is not commit-bound, tracked, and clean")
    return manifest, "formal" if formal else "review-only"


def main() -> int:
    args = parse_args()
    try:
        manifest, mode = validate_fixture(args.manifest, args.allow_dirty_dev)
    except ContractError as exc:
        print(f"PHASE2_FIXTURE_CHECK_FAIL: {exc}")
        return 1
    print(
        "PHASE2_FIXTURE_CHECK_PASS "
        f"mode={mode} files={manifest['totals']['files']} bytes={manifest['totals']['bytes']} "
        f"fixture_id={manifest['fixture_id']}"
    )
    if mode != "formal":
        print("Review evidence cannot close DP-006/DP-009 until the generator is committed and the fixture is regenerated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
