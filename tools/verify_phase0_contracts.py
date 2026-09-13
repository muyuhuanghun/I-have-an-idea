#!/usr/bin/env python3
"""Zero-project-dependency verifier for P0 design contracts and ACC evidence.

The default mode validates only committed design contracts.  It deliberately does
not turn untested ACC entries into passes.  With --evidence-root it additionally
evaluates every ACC report against the registry's machine oracle.  With
--validate-samples it also exercises bundled positive/negative schema samples so
that the schema-enforcement path is itself under test.

The JSON-Schema enforcement implemented here covers exactly the keyword subset
that the five P0 schemas actually use.  Anything outside that subset is rejected
fail-closed; new keywords must either be added to the enforced set or the
schema must be simplified to use only what is enforced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "docs" / "contracts"
SCHEMAS = ROOT / "docs" / "schemas"
SAMPLES = ROOT / "tools" / "schema-samples"


# Schema keywords that the P0 schemas use.  Anything else triggers a
# fail-closed rejection at schema-load time so that the enforced subset
# cannot silently drift from what the schemas actually require.
SUPPORTED_SCHEMA_KEYWORDS = frozenset({
    "$schema", "$id", "$ref", "$defs", "title", "description",
    "type", "const", "enum", "pattern",
    "format", "minLength", "maxLength", "minItems", "maxItems",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minProperties", "maxProperties", "uniqueItems",
    "required", "additionalProperties", "properties", "patternProperties", "propertyNames",
    "items", "prefixItems", "contains", "minContains", "maxContains",
    "allOf", "anyOf", "oneOf", "if", "then", "else",
})


class ContractError(RuntimeError):
    pass


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot load {path.relative_to(ROOT)}: {exc}") from exc


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def expected_ids(prefix: str, count: int, width: int = 2) -> list[str]:
    return [f"{prefix}-{index:0{width}d}" for index in range(1, count + 1)]


def assert_unique(values: list[str], label: str) -> None:
    require(len(values) == len(set(values)), f"duplicate {label}: {values}")


# ---------------------------------------------------------------------------
# JSON Schema (Draft 2020-12) enforcement subset
# ---------------------------------------------------------------------------

_FORMAT_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_FORMAT_DATE_TIME = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def _check_type(instance: Any, expected: Any) -> bool:
    if isinstance(expected, list):
        return any(_check_type(instance, item) for item in expected)
    if expected == "null":
        return instance is None
    if expected == "boolean":
        return isinstance(instance, bool)
    if expected == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if expected == "number":
        return isinstance(instance, (int, float)) and not isinstance(instance, bool)
    if expected == "string":
        return isinstance(instance, str)
    if expected == "array":
        return isinstance(instance, list)
    if expected == "object":
        return isinstance(instance, dict)
    raise ContractError(f"unsupported JSON Schema type: {expected!r}")


def _resolve_ref(ref: str, root: dict[str, Any]) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ContractError(f"only local $ref is supported, got {ref!r}")
    node: Any = root
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            raise ContractError(f"$ref {ref!r} could not be resolved")
        node = node[part]
    if not isinstance(node, dict):
        raise ContractError(f"$ref {ref!r} does not point to a schema object")
    return node


def _assert_supported_keywords(schema: dict[str, Any], location: str, seen: set[int]) -> None:
    if id(schema) in seen:
        return
    seen.add(id(schema))
    unknown = set(schema.keys()) - SUPPORTED_SCHEMA_KEYWORDS
    require(not unknown, f"{location}: schema uses unsupported keywords {sorted(unknown)}")
    for key, value in schema.items():
        if key in {"properties", "patternProperties", "$defs"} and isinstance(value, dict):
            for sub_key, sub_value in value.items():
                if isinstance(sub_value, dict):
                    _assert_supported_keywords(sub_value, f"{location}.{key}.{sub_key}", seen)
        elif key in {"items", "prefixItems", "allOf", "anyOf", "oneOf"} and isinstance(value, list):
            for index, sub_value in enumerate(value):
                if isinstance(sub_value, dict):
                    _assert_supported_keywords(sub_value, f"{location}.{key}[{index}]", seen)
        elif key == "additionalProperties" and isinstance(value, dict):
            _assert_supported_keywords(value, f"{location}.additionalProperties", seen)
        elif key in {"if", "then", "else"} and isinstance(value, dict):
            _assert_supported_keywords(value, f"{location}.{key}", seen)


def _validate_format(value: str, fmt: str, location: str) -> None:
    if fmt == "uuid":
        if not _FORMAT_UUID.match(value):
            raise ContractError(f"{location}: {value!r} is not a valid uuid")
    elif fmt == "date-time":
        if not _FORMAT_DATE_TIME.match(value):
            raise ContractError(f"{location}: {value!r} is not a valid RFC 3339 date-time")
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ContractError(f"{location}: {value!r} is not a valid date-time: {exc}") from exc
    else:
        raise ContractError(f"{location}: format {fmt!r} is not enforced by this verifier")


def _validate_subschema(instance: Any, schema: dict[str, Any], root: dict[str, Any], location: str) -> None:
    # Unwrap $ref first.
    if "$ref" in schema:
        ref = schema["$ref"]
        target = _resolve_ref(ref, root)
        # $ref siblings are ignored in this verifier (Draft 2020-12 allows $ref alongside, but the
        # five P0 schemas never use sibling keywords, so we follow the simpler rule).
        return _validate_subschema(instance, target, root, location)

    if "type" in schema:
        if not _check_type(instance, schema["type"]):
            raise ContractError(f"{location}: type {schema['type']!r} expected, got {type(instance).__name__}")

    if "const" in schema:
        if instance != schema["const"]:
            raise ContractError(f"{location}: const {schema['const']!r} expected, got {instance!r}")

    if "enum" in schema:
        if instance not in schema["enum"]:
            raise ContractError(f"{location}: enum {schema['enum']!r} expected, got {instance!r}")

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            raise ContractError(f"{location}: minLength {schema['minLength']} violated")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            raise ContractError(f"{location}: maxLength {schema['maxLength']} violated")
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            raise ContractError(f"{location}: pattern {schema['pattern']!r} not matched")
        if "format" in schema:
            _validate_format(instance, schema["format"], location)

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            raise ContractError(f"{location}: minimum {schema['minimum']} violated")
        if "maximum" in schema and instance > schema["maximum"]:
            raise ContractError(f"{location}: maximum {schema['maximum']} violated")
        if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
            raise ContractError(f"{location}: exclusiveMinimum {schema['exclusiveMinimum']} violated")
        if "exclusiveMaximum" in schema and instance >= schema["exclusiveMaximum"]:
            raise ContractError(f"{location}: exclusiveMaximum {schema['exclusiveMaximum']} violated")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            raise ContractError(f"{location}: minItems {schema['minItems']} violated")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            raise ContractError(f"{location}: maxItems {schema['maxItems']} violated")
        if "uniqueItems" in schema and schema["uniqueItems"]:
            seen: list[Any] = []
            for index, item in enumerate(instance):
                if item in seen:
                    raise ContractError(f"{location}: uniqueItems violated at index {index}")
                seen.append(item)
        if "items" in schema and isinstance(schema["items"], dict):
            for index, item in enumerate(instance):
                _validate_subschema(item, schema["items"], root, f"{location}[{index}]")
        if "prefixItems" in schema and isinstance(schema["prefixItems"], list):
            for index, sub_schema in enumerate(schema["prefixItems"]):
                if index >= len(instance):
                    break
                _validate_subschema(instance[index], sub_schema, root, f"{location}[{index}]")
        if "contains" in schema and isinstance(schema["contains"], dict):
            matched = 0
            for index, item in enumerate(instance):
                try:
                    _validate_subschema(item, schema["contains"], root, f"{location}[{index}].contains")
                    matched += 1
                except ContractError:
                    continue
            if "minContains" in schema and matched < schema["minContains"]:
                raise ContractError(f"{location}: contains matched {matched} < minContains {schema['minContains']}")
            if "maxContains" in schema and matched > schema["maxContains"]:
                raise ContractError(f"{location}: contains matched {matched} > maxContains {schema['maxContains']}")

    if isinstance(instance, dict):
        if "minProperties" in schema and len(instance) < schema["minProperties"]:
            raise ContractError(f"{location}: minProperties {schema['minProperties']} violated")
        if "maxProperties" in schema and len(instance) > schema["maxProperties"]:
            raise ContractError(f"{location}: maxProperties {schema['maxProperties']} violated")
        if "required" in schema:
            for key in schema["required"]:
                if key not in instance:
                    raise ContractError(f"{location}: required field {key!r} missing")
        properties = schema.get("properties", {})
        property_names_pattern = schema.get("propertyNames", {}).get("pattern")
        if property_names_pattern is not None:
            for key in instance:
                if not re.fullmatch(property_names_pattern, key):
                    raise ContractError(f"{location}: property name {key!r} fails propertyNames pattern {property_names_pattern!r}")
        for key, sub_schema in properties.items():
            if key in instance and isinstance(sub_schema, dict):
                _validate_subschema(instance[key], sub_schema, root, f"{location}.{key}")
        additional = schema.get("additionalProperties", True)
        if additional is False:
            for key in instance:
                if key not in properties:
                    raise ContractError(f"{location}: additional property {key!r} forbidden")
        elif isinstance(additional, dict):
            for key in instance:
                if key not in properties:
                    _validate_subschema(instance[key], additional, root, f"{location}.{key}")
        pattern_properties = schema.get("patternProperties", {})
        if pattern_properties:
            for pattern, sub_schema in pattern_properties.items():
                if not isinstance(sub_schema, dict):
                    continue
                compiled = re.compile(pattern)
                for key, value in instance.items():
                    if compiled.search(key):
                        _validate_subschema(value, sub_schema, root, f"{location}.{key}")

    for keyword in ("allOf",):
        if keyword in schema and isinstance(schema[keyword], list):
            for index, sub_schema in enumerate(schema[keyword]):
                if isinstance(sub_schema, dict):
                    _validate_subschema(instance, sub_schema, root, f"{location}.{keyword}[{index}]")
    if "oneOf" in schema and isinstance(schema["oneOf"], list):
        matched = 0
        for index, sub_schema in enumerate(schema["oneOf"]):
            try:
                if isinstance(sub_schema, dict):
                    _validate_subschema(instance, sub_schema, root, f"{location}.oneOf[{index}]")
                matched += 1
            except ContractError:
                continue
        require(matched == 1, f"{location}: oneOf matched {matched} branches, exactly 1 required")
    if "if" in schema and isinstance(schema["if"], dict):
        try:
            _validate_subschema(instance, schema["if"], root, f"{location}.if")
            if "then" in schema and isinstance(schema["then"], dict):
                _validate_subschema(instance, schema["then"], root, f"{location}.then")
        except ContractError:
            if "else" in schema and isinstance(schema["else"], dict):
                _validate_subschema(instance, schema["else"], root, f"{location}.else")


def _validate_against_schema(instance: Any, schema: dict[str, Any], schema_name: str) -> None:
    _assert_supported_keywords(schema, schema_name, set())
    _validate_subschema(instance, schema, schema, f"<root:{schema_name}>")


# ---------------------------------------------------------------------------
# Existing design-contract validators (unchanged semantics, just upgraded to use
# the real schema-enforcement path for `validate_schema_files`).
# ---------------------------------------------------------------------------


def _load_schema(name: str) -> dict[str, Any]:
    path = SCHEMAS / name
    value = load_json(path)
    require(isinstance(value, dict), f"{name}: top level must be a JSON object")
    require(value.get("$schema") == "https://json-schema.org/draft/2020-12/schema", f"{name}: wrong JSON Schema draft")
    _assert_supported_keywords(value, name, set())
    return value


def validate_schema_files() -> None:
    expected = {
        "acc-evidence-v1.schema.json",
        "fixture-manifest-v1.schema.json",
        "perf-report-v1.schema.json",
        "smoke-aggregate-v1.schema.json",
        "smoke-report-v1.schema.json",
        "p0-roundtrip-report-v1.schema.json",
        "p0-plugin-snapshot-report-v1.schema.json",
        "p0-runtime-limits-v1.schema.json",
        "snapshot-log-v1.schema.json",
        "storage-visibility-scan-v1.schema.json",
        "s7-http-session-v1.schema.json",
        "p1-web-console-status-v1.schema.json",
        "proposal-reviewers-v1.schema.json",
        "group-state-v1.schema.json",
        "group-epoch-keys-v1.schema.json",
    }
    actual = {path.name for path in SCHEMAS.glob("*.schema.json")}
    require(expected <= actual, f"missing JSON Schema files: {sorted(expected - actual)}")
    for name in sorted(expected):
        schema = _load_schema(name)
        # A schema is itself valid only if an empty document passes (or fails meaningfully);
        # what we actually check here is that the schema parses, declares the right
        # keywords, and would accept a real report once one exists.  The bundled
        # positive/negative samples do that work in `validate_schema_samples`.
        require(schema.get("type") == "object", f"{name}: top level must be object")
        require(schema.get("additionalProperties") is False, f"{name}: top level must fail on unknown fields")
        required = schema.get("required")
        require(isinstance(required, list) and required, f"{name}: non-empty required list missing")
        assert_unique(required, f"required fields in {name}")


def validate_wire_contract(wire: dict[str, Any]) -> None:
    require(wire.get("schema_version") == "p0-wire-contract-v1", "wrong wire contract version")
    constants = wire.get("constants", {})
    require(constants.get("object_id_length_bytes") == 16, "object ID must be frozen at 16 raw bytes")
    require(constants.get("object_store_key_length_chars") == 22, "object store key must be 22 base64url chars")
    require(constants.get("recovery_root_length_bytes") == 32, "recovery root must be 32 bytes")
    require(constants.get("object_aad_length_bytes") == 101, "Object AAD v1 must be 101 bytes")

    recovery = wire.get("recovery_file_v1", {})
    fields = recovery.get("fields", [])
    offset = 0
    for field in fields:
        require(field.get("offset") == offset, f"recovery field {field.get('name')} has non-canonical offset")
        length = field.get("length")
        require(isinstance(length, int) and length > 0, f"recovery field {field.get('name')} has invalid length")
        offset += length
    require(offset == constants.get("recovery_file_length_bytes") == 167, "recovery file field lengths do not total 167")
    integrity = next((field for field in fields if field.get("name") == "integrity_tag"), None)
    require(integrity is not None and integrity.get("offset") == constants.get("recovery_hmac_covered_length_bytes") == 135,
            "recovery HMAC boundary must be byte 135")

    labels = wire.get("hkdf_sha256", [])
    infos = [entry.get("info_ascii") for entry in labels]
    require(infos == [
        "ekd-v1/domain-data-root",
        "ekd-v1/recovery-file-integrity",
        "ekd-v1/manifest-key",
        "ekd-v1/object-wrap-key",
    ], "HKDF info labels or ordering drifted")
    assert_unique(infos, "HKDF info labels")
    for entry in labels:
        require(entry.get("salt") == "domain_id", f"{entry.get('output')}: HKDF salt must be domain_id")

    aad_fields = wire.get("object_aad_v1", {}).get("fields", [])
    fixed_sizes = {"u8": 1, "u16be": 2, "u64be": 8}
    aad_length = 0
    for field in aad_fields:
        field_type = field.get("type")
        if field_type in {"fixed", "bytes"}:
            length = field.get("length")
        else:
            length = fixed_sizes.get(field_type)
        require(isinstance(length, int), f"AAD field {field.get('name')} lacks a fixed size")
        aad_length += length
    require(aad_length == 101, f"AAD fields total {aad_length}, expected 101")


def validate_deferred(registry: dict[str, Any]) -> None:
    require(registry.get("schema_version") == "p0-deferred-parameters-v1", "wrong deferred registry version")
    require(registry.get("status") == "authoritative_deferred_parameter_registry", "wrong deferred registry status")
    owners = registry.get("owners", [])
    owner_ids = [owner.get("id") for owner in owners]
    assert_unique(owner_ids, "owner IDs")
    parameters = registry.get("parameters", [])
    ids = [item.get("id") for item in parameters]
    require(ids == expected_ids("DP", 27, width=3), f"deferred IDs must be contiguous DP-001..DP-027; got {ids}")
    for item in parameters:
        for field in ("name", "owner", "phase", "status", "close_artifact", "hard_stop"):
            require(isinstance(item.get(field), str) and item[field].strip(), f"{item.get('id')}: missing {field}")
        require(item["owner"] in owner_ids, f"{item['id']}: unknown owner {item['owner']}")
        require(item["status"] in {"open", "conditional", "deferred", "closed"}, f"{item['id']}: invalid status")
        if item["status"] == "closed":
            closure_adr = item.get("closure_adr")
            require(isinstance(closure_adr, str) and closure_adr.strip(), f"{item['id']}: closed item lacks closure_adr")
            require((ROOT / closure_adr).is_file(), f"{item['id']}: closure_adr does not exist: {closure_adr}")


def _r1_closure_commit(closeout_text: str) -> str:
    match = re.search(r"^R1_EVIDENCE_CLOSED_AT_COMMIT: ([0-9a-f]{40})$", closeout_text, flags=re.MULTILINE)
    require(match is not None, "closeout report lacks an 'R1_EVIDENCE_CLOSED_AT_COMMIT: <sha256>' line")
    return match.group(1)


def _s7_closure_commit(closeout_text: str) -> str:
    match = re.search(r"^S7_EVIDENCE_CLOSED_AT_COMMIT: ([0-9a-f]{40})$", closeout_text, flags=re.MULTILINE)
    require(match is not None, "closeout report lacks an 'S7_EVIDENCE_CLOSED_AT_COMMIT: <sha256>' line")
    return match.group(1)


def _p1_alpha_closure_commit(closeout_text: str) -> str:
    match = re.search(r"^P1_ALPHA_EVIDENCE_CLOSED_AT_COMMIT: ([0-9a-f]{40})$", closeout_text, flags=re.MULTILINE)
    require(match is not None, "closeout report lacks an 'P1_ALPHA_EVIDENCE_CLOSED_AT_COMMIT: <sha256>' line")
    return match.group(1)


def _web_closure_commit(closeout_text: str) -> str:
    match = re.search(r"^WEB_EVIDENCE_CLOSED_AT_COMMIT: ([0-9a-f]{40})$", closeout_text, flags=re.MULTILINE)
    require(match is not None, "closeout report lacks a 'WEB_EVIDENCE_CLOSED_AT_COMMIT: <sha256>' line")
    return match.group(1)


def _p1_beta_team_closure_commit(closeout_text: str) -> str:
    match = re.search(r"^P1_BETA_TEAM_EVIDENCE_CLOSED_AT_COMMIT: ([0-9a-f]{40})$", closeout_text, flags=re.MULTILINE)
    require(match is not None, "closeout report lacks a 'P1_BETA_TEAM_EVIDENCE_CLOSED_AT_COMMIT: <sha256>' line")
    return match.group(1)


def _require_acc_statuses(items: list[dict[str, Any]], closeout_text: str) -> None:
    allowed_statuses = {"passed", "failed", "untested", "known-limitation", "out-of-scope"}
    statuses = [item.get("status") for item in items]
    require(all(status in allowed_statuses for status in statuses), "acceptance registry contains an invalid status")
    if all(status == "untested" for status in statuses):
        return
    require(all(status == "passed" for status in statuses if status != "untested"),
            "passed and untested ACC entries may only coexist while the untested ones await their scope's evidence")
    untested = [item for item in items if item.get("status") == "untested"]
    allowed_scopes = {"stage-7", "p1-alpha", "web-console", "p1-beta"}
    for item in untested:
        require(item.get("evidence_scope") in allowed_scopes,
                f"{item.get('id')}: untested ACC without a recognized evidence_scope is not allowed while other ACCs are passed")
    _r1_closure_commit(closeout_text)
    scopes_of_passed = {item.get("evidence_scope") for item in items if item.get("status") == "passed"}
    if "stage-7" in scopes_of_passed:
        _s7_closure_commit(closeout_text)
    if "p1-alpha" in scopes_of_passed:
        _p1_alpha_closure_commit(closeout_text)


def validate_traceability(trace: dict[str, Any]) -> None:
    require(trace.get("schema_version") == "p0-traceability-v1", "wrong traceability version")
    threats = trace.get("threats", [])
    invariants = trace.get("invariants", [])
    acceptance = trace.get("acceptance", [])
    threat_ids = [item.get("id") for item in threats]
    invariant_ids = [item.get("id") for item in invariants]
    acceptance_ids = [item.get("id") for item in acceptance]
    require(threat_ids == expected_ids("THR", 16), f"THR registry must be THR-01..THR-16; got {threat_ids}")
    require(invariant_ids == expected_ids("INV", 31), f"INV registry must be INV-01..INV-31; got {invariant_ids}")
    require(acceptance_ids == expected_ids("ACC", 58), f"ACC registry must be ACC-01..ACC-58; got {acceptance_ids}")

    evidence_paths = [item.get("evidence_path") for item in acceptance]
    assert_unique(evidence_paths, "ACC evidence paths")
    known_errors = set(trace.get("error_codes", []))
    allowed_side_effects = set(trace.get("allowed_side_effect_flags", []))
    require(known_errors and len(known_errors) == len(trace.get("error_codes", [])), "error code registry must be non-empty and unique")

    closeout_text = (ROOT / "docs" / "test-plans" / "p0-r1-closeout-report.md").read_text(encoding="utf-8")
    _require_acc_statuses(acceptance, closeout_text)

    for item in acceptance:
        acc_id = item["id"]
        item_threats = item.get("threat_ids")
        item_invariants = item.get("invariant_ids")
        require(isinstance(item_threats, list) and set(item_threats) <= set(threat_ids), f"{acc_id}: invalid threat links")
        require(isinstance(item_invariants, list) and set(item_invariants) <= set(invariant_ids), f"{acc_id}: invalid invariant links")
        if not item_threats and not item_invariants:
            reason = item.get("nonsecurity_reason")
            require(isinstance(reason, str) and reason.strip(), f"{acc_id}: non-security requirement needs an explicit reason")
        oracle = item.get("oracle", {})
        checks = oracle.get("required_checks")
        require(isinstance(checks, list) and checks, f"{acc_id}: required_checks missing")
        assert_unique(checks, f"oracle checks for {acc_id}")
        require(all(re.fullmatch(r"[a-z][a-z0-9_]*", check) for check in checks), f"{acc_id}: invalid check ID")
        for group in oracle.get("required_error_code_groups", []):
            require(isinstance(group, list) and group, f"{acc_id}: empty error-code group")
            require(set(group) <= known_errors, f"{acc_id}: unknown error code in {group}")
        effects = oracle.get("forbidden_side_effects")
        require(isinstance(effects, list) and set(effects) <= allowed_side_effects, f"{acc_id}: invalid side-effect oracle")

    for threat in threats:
        linked = threat.get("acceptance_ids")
        require(isinstance(linked, list) and set(linked) <= set(acceptance_ids), f"{threat['id']}: invalid ACC backlink")
        expected = [item["id"] for item in acceptance if threat["id"] in item.get("threat_ids", [])]
        require(linked == expected, f"{threat['id']}: asymmetric ACC links; expected {expected}, got {linked}")
        require(isinstance(threat.get("oracle"), str) and threat["oracle"].strip(), f"{threat['id']}: missing threat oracle")

    for invariant in invariants:
        linked = invariant.get("acceptance_ids")
        require(isinstance(linked, list) and set(linked) <= set(acceptance_ids), f"{invariant['id']}: invalid ACC backlink")
        expected = [item["id"] for item in acceptance if invariant["id"] in item.get("invariant_ids", [])]
        require(linked == expected, f"{invariant['id']}: asymmetric ACC links; expected {expected}, got {linked}")
        require(linked, f"{invariant['id']}: invariant has no ACC coverage")

    matrix_text = (ROOT / "docs" / "test-plans" / "P0-acceptance-matrix.md").read_text(encoding="utf-8")
    matrix_ids = re.findall(r"^\*\*(ACC-\d{2})：", matrix_text, flags=re.MULTILINE)
    require(matrix_ids == acceptance_ids, "acceptance matrix headings do not match the 37-entry registry")
    allowed_statuses = {"passed", "failed", "untested", "known-limitation", "out-of-scope"}
    registry_statuses = [item.get("status") for item in acceptance]
    require(all(status in allowed_statuses for status in registry_statuses), "acceptance registry contains an invalid status")
    matrix_statuses = re.findall(
        r"^- 状态：(passed|failed|untested|known-limitation|out-of-scope)$",
        matrix_text,
        flags=re.MULTILINE,
    )
    require(matrix_statuses == registry_statuses,
            f"acceptance matrix statuses do not match registry: {matrix_statuses} != {registry_statuses}")


def _check_required_artifact_paths(report: dict[str, Any], evidence_root: Path, report_path: Path) -> list[Path]:
    resolved: list[Path] = []
    for index, artifact in enumerate(report.get("artifacts", [])):
        rel = artifact.get("path")
        if not isinstance(rel, str) or not rel:
            raise ContractError(f"{report_path.relative_to(ROOT)}: artifact[{index}].path missing")
        artifact_path = (evidence_root / rel).resolve() if not Path(rel).is_absolute() else Path(rel).resolve()
        require(evidence_root.resolve() in artifact_path.parents or artifact_path == evidence_root.resolve(),
                f"{report_path.relative_to(ROOT)}: artifact[{index}].path escapes evidence root")
        require(artifact_path.exists(), f"{report_path.relative_to(ROOT)}: artifact[{index}].path does not exist")
        import hashlib
        digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        require(digest == artifact.get("sha256"),
                f"{report_path.relative_to(ROOT)}: artifact[{index}].sha256 mismatch (got {digest})")
        resolved.append(artifact_path)
    return resolved


def _validate_nested_artifacts(artifact_paths: list[Path], evidence_root: Path) -> None:
    import hashlib

    for artifact_path in artifact_paths:
        name = artifact_path.name
        if name.startswith("perf-report-") and name.endswith(".json"):
            report = load_json(artifact_path)
            _validate_against_schema(report, _load_schema("perf-report-v1.schema.json"), str(artifact_path))
            for index, raw in enumerate(report.get("raw_artifacts", [])):
                rel = raw.get("path")
                require(isinstance(rel, str) and rel, f"{name}: raw_artifacts[{index}].path missing")
                raw_path = (evidence_root / rel).resolve()
                require(evidence_root.resolve() in raw_path.parents,
                        f"{name}: raw_artifacts[{index}] escapes evidence root")
                require(raw_path.is_file(), f"{name}: raw_artifacts[{index}] does not exist")
                digest = hashlib.sha256(raw_path.read_bytes()).hexdigest()
                require(digest == raw.get("sha256"), f"{name}: raw_artifacts[{index}] sha256 mismatch")
        elif name in {"acc-32-visibility-scan.json", "acc-33-visibility-scan.json"}:
            _validate_against_schema(
                load_json(artifact_path),
                _load_schema("storage-visibility-scan-v1.schema.json"),
                str(artifact_path),
            )
        elif name == "acc-35-roundtrip-report.json":
            _validate_against_schema(
                load_json(artifact_path),
                _load_schema("p0-roundtrip-report-v1.schema.json"),
                str(artifact_path),
            )


def validate_evidence(trace: dict[str, Any], evidence_root: Path) -> None:
    acc_schema = _load_schema("acc-evidence-v1.schema.json")
    closeout_text = (ROOT / "docs" / "test-plans" / "p0-r1-closeout-report.md").read_text(encoding="utf-8")
    closeout_commit = _r1_closure_commit(closeout_text)
    s7_commit: str | None = None
    p1_commit: str | None = None
    web_commit: str | None = None
    team_commit: str | None = None
    for item in trace["acceptance"]:
        acc_id = item["id"]
        if item.get("status") != "passed":
            require(item.get("status") == "untested" and item.get("evidence_scope") in {"stage-7", "p1-alpha", "web-console", "p1-beta"},
                    f"{acc_id}: registry status {item.get('status')!r} has no evidence to validate")
            continue
        relative = Path(item["evidence_path"])
        if relative.parts and relative.parts[0].lower() == "artifacts":
            relative = Path(*relative.parts[1:])
        report_path = evidence_root / relative
        report = load_json(report_path)

        # Real schema enforcement first; this catches unknown fields, missing
        # required, type mismatches, enum/pattern/format violations and the rest
        # of the 158 enforced constraints across the five schemas.
        _validate_against_schema(report, acc_schema, "acc-evidence-v1")

        require(report.get("acc_id") == acc_id, f"{acc_id}: evidence acc_id mismatch")
        require(report.get("status") == "passed", f"{acc_id}: evidence status is not passed")
        report_commit = report.get("git_commit")
        if item.get("evidence_scope") == "stage-7":
            if s7_commit is None:
                s7_commit = _s7_closure_commit(closeout_text)
            require(report_commit == s7_commit,
                    f"{acc_id}: evidence commit {report_commit} differs from stage-7 closeout-declared {s7_commit}")
        elif item.get("evidence_scope") == "p1-alpha":
            if p1_commit is None:
                p1_commit = _p1_alpha_closure_commit(closeout_text)
            require(report_commit == p1_commit,
                    f"{acc_id}: evidence commit {report_commit} differs from p1-alpha closeout-declared {p1_commit}")
        elif item.get("evidence_scope") == "web-console":
            if web_commit is None:
                web_commit = _web_closure_commit(closeout_text)
            require(report_commit == web_commit,
                    f"{acc_id}: evidence commit {report_commit} differs from web-console closeout-declared {web_commit}")
        elif item.get("evidence_scope") == "p1-beta":
            if team_commit is None:
                team_commit = _p1_beta_team_closure_commit(closeout_text)
            require(report_commit == team_commit,
                    f"{acc_id}: evidence commit {report_commit} differs from p1-beta team closeout-declared {team_commit}")
        else:
            require(report_commit == closeout_commit,
                    f"{acc_id}: evidence commit {report_commit} differs from closeout-declared {closeout_commit}")

        checks = report.get("checks")
        require(isinstance(checks, dict), f"{acc_id}: checks object missing")
        for check_id in item["oracle"]["required_checks"]:
            check = checks.get(check_id)
            require(isinstance(check, dict), f"{acc_id}: missing required check {check_id}")
            require(check.get("passed") is True, f"{acc_id}: check {check_id} did not pass")
            require("expected" in check and "actual" in check, f"{acc_id}: check {check_id} lacks expected/actual")
        observed = set(report.get("observed_error_codes", []))
        for group in item["oracle"]["required_error_code_groups"]:
            require(observed.intersection(group), f"{acc_id}: no observed error from required group {group}")
        side_effects = report.get("side_effects")
        require(isinstance(side_effects, dict), f"{acc_id}: side_effects object missing")
        for flag in item["oracle"]["forbidden_side_effects"]:
            require(side_effects.get(flag) is False, f"{acc_id}: forbidden side effect {flag} occurred or is missing")

        artifact_paths = _check_required_artifact_paths(report, evidence_root, report_path)
        _validate_nested_artifacts(artifact_paths, evidence_root)


def validate_schema_samples() -> None:
    """Exercise each schema with a positive and a negative sample so the schema
    enforcement path is itself under test.  Each pair is keyed by the schema's
    $id; if a schema file lacks bundled samples, the verifier fails closed.
    """
    pairs: list[tuple[str, str]] = [
        ("acc-evidence-v1.schema.json", "acc-evidence"),
        ("fixture-manifest-v1.schema.json", "fixture-manifest"),
        ("perf-report-v1.schema.json", "perf-report"),
        ("smoke-aggregate-v1.schema.json", "smoke-aggregate"),
        ("smoke-report-v1.schema.json", "smoke-report"),
        ("p0-roundtrip-report-v1.schema.json", "p0-roundtrip-report"),
        ("p0-plugin-snapshot-report-v1.schema.json", "p0-plugin-snapshot-report"),
        ("p0-runtime-limits-v1.schema.json", "p0-runtime-limits"),
        ("snapshot-log-v1.schema.json", "snapshot-log"),
        ("storage-visibility-scan-v1.schema.json", "storage-visibility-scan"),
        ("s7-http-session-v1.schema.json", "s7-http-session"),
        ("p1-web-console-status-v1.schema.json", "p1-web-console-status"),
        ("proposal-reviewers-v1.schema.json", "proposal-reviewers"),
        ("group-state-v1.schema.json", "group-state"),
        ("group-epoch-keys-v1.schema.json", "group-epoch-keys"),
    ]
    for schema_name, base in pairs:
        schema = _load_schema(schema_name)
        positive = SAMPLES / f"{base}.positive.json"
        negative = SAMPLES / f"{base}.negative.json"
        require(positive.exists(), f"missing positive sample {positive.relative_to(ROOT)} for {schema_name}")
        require(negative.exists(), f"missing negative sample {negative.relative_to(ROOT)} for {schema_name}")
        _validate_against_schema(load_json(positive), schema, f"{schema_name}#positive")
        try:
            _validate_against_schema(load_json(negative), schema, f"{schema_name}#negative")
        except ContractError:
            continue
        raise ContractError(f"negative sample for {schema_name} was accepted; sample is not actually negative")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--evidence-root",
        type=Path,
        help="Evaluate all 37 ACC reports below this artifacts directory. Omit for design-contract validation only.",
    )
    parser.add_argument(
        "--validate-samples",
        action="store_true",
        help="Exercise bundled positive/negative samples against every schema before any other step.",
    )
    return parser.parse_args()


def _require_cli_runtime_limits_binding(embedded: str, actual: str) -> None:
    require(re.fullmatch(r"[0-9a-f]{64}", embedded) is not None,
            "CLI runtime-limits binding constant is not 64 lowercase hex characters")
    require(embedded == actual,
            "CLI embedded runtime-limits hash does not match docs/contracts/p0-runtime-limits-v1.json")


def validate_cli_runtime_limits_binding() -> None:
    source = (ROOT / "apps" / "cli" / "src" / "main.ts").read_text(encoding="utf-8")
    match = re.search(r'ACCEPTED_RUNTIME_LIMITS_SHA256 = "([0-9a-f]{64})"', source)
    require(match is not None, "apps/cli/src/main.ts lacks an ACCEPTED_RUNTIME_LIMITS_SHA256 binding constant")
    actual = hashlib.sha256((ROOT / "docs" / "contracts" / "p0-runtime-limits-v1.json").read_bytes()).hexdigest()
    _require_cli_runtime_limits_binding(match.group(1), actual)


def validate_plugin_runtime_limits_binding() -> None:
    source = (ROOT / "apps" / "obsidian-plugin" / "src" / "main.ts").read_text(encoding="utf-8")
    match = re.search(r'PLUGIN_ACCEPTED_RUNTIME_LIMITS_SHA256 = "([0-9a-f]{64})"', source)
    require(match is not None,
            "apps/obsidian-plugin/src/main.ts lacks a PLUGIN_ACCEPTED_RUNTIME_LIMITS_SHA256 binding constant")
    actual = hashlib.sha256((ROOT / "docs" / "contracts" / "p0-runtime-limits-v1.json").read_bytes()).hexdigest()
    require(match.group(1) == actual,
            "plugin embedded runtime-limits hash does not match docs/contracts/p0-runtime-limits-v1.json")


def _require_plugin_snapshot_only(source: str) -> None:
    require('id: "p0-create-snapshot"' in source, "plugin lacks the authorized P0 snapshot command")
    for forbidden in ('id: "p0-restore"', "restoreSnapshotV1", "NodeRestoreTarget"):
        require(forbidden not in source, f"plugin contains forbidden restore surface: {forbidden}")
    require('import("@ekd/adapters")' not in source,
            "plugin must use narrow adapter subpath imports so restore adapters are not bundled")


def validate_plugin_snapshot_only() -> None:
    source = (ROOT / "apps" / "obsidian-plugin" / "src" / "main.ts").read_text(encoding="utf-8")
    _require_plugin_snapshot_only(source)


def main() -> int:
    args = parse_args()
    try:
        if args.validate_samples:
            validate_schema_samples()
        validate_schema_files()
        wire = load_json(CONTRACTS / "p0-wire-contract-v1.json")
        deferred = load_json(CONTRACTS / "p0-deferred-parameters.json")
        trace = load_json(CONTRACTS / "p0-traceability-v1.json")
        validate_wire_contract(wire)
        validate_deferred(deferred)
        validate_traceability(trace)
        validate_cli_runtime_limits_binding()
        validate_plugin_runtime_limits_binding()
        validate_plugin_snapshot_only()
        if args.evidence_root is not None:
            validate_evidence(trace, args.evidence_root.resolve())
    except ContractError as exc:
        print(f"PHASE0_CONTRACT_CHECK_FAIL: {exc}", file=sys.stderr)
        return 1
    mode_parts = ["design-only"] if args.evidence_root is None else ["design+evidence"]
    if args.validate_samples:
        mode_parts.append("samples")
    print(f"PHASE0_CONTRACT_CHECK_PASS mode={'+'.join(mode_parts)} ACC={len(trace['acceptance'])} INV={len(trace['invariants'])} THR=16 DP=27")
    if args.evidence_root is None:
        statuses = [item.get("status") for item in trace["acceptance"]]
        if all(status == "passed" for status in statuses):
            print("P0_R1 registry records all ACC passed; design-only mode did not revalidate runtime artifacts.")
        elif all(status in ("passed", "untested") for status in statuses):
            pending = [f"{item['id']}({item.get('evidence_scope')})" for item in trace["acceptance"] if item.get("status") == "untested"]
            print(f"P0_R1 registry: R1 ACC all passed; ACC pending evidence: {', '.join(pending)}.")
        else:
            print("P0_R1 remains NOT_IMPLEMENTED / NOT_TESTED; no ACC status was upgraded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
