import type { Bytes, CryptoProvider, RandomSource } from "@ekd/core";

export type EnvironmentId = "windows-node-cli" | "windows-obsidian" | "android-obsidian";

export type VectorCategory =
  | "aead-kat"
  | "aead-tamper-ciphertext"
  | "aead-tamper-tag"
  | "aead-tamper-nonce"
  | "aead-tamper-aad"
  | "hkdf-kat"
  | "hkdf-info-isolation"
  | "random-roundtrip"
  | "random-source-errors"
  | "wrap-kat"
  | "wrap-bad-material"
  | "perf-micro"
  | "candidate-specific";

export interface AeadKatVector {
  readonly vector_id: string;
  readonly category: "aead-kat";
  readonly required: true;
  readonly source_id: string;
  readonly source_locator: string;
  readonly key_hex: string;
  readonly nonce_hex: string;
  readonly aad_hex: string;
  readonly plaintext_hex: string;
  readonly ciphertext_hex: string;
  readonly tag_hex: string;
}

export interface AeadTamperVector {
  readonly vector_id: string;
  readonly category:
    | "aead-tamper-ciphertext"
    | "aead-tamper-tag"
    | "aead-tamper-nonce"
    | "aead-tamper-aad";
  readonly required: true;
  readonly source_id: string;
  readonly base_vector_id: string;
  readonly mutation: { readonly field: "ciphertext" | "tag" | "nonce" | "aad"; readonly byte_index: number; readonly xor: number };
  readonly expected_error_codes: readonly string[];
}

export interface HkdfKatVector {
  readonly vector_id: string;
  readonly category: "hkdf-kat";
  readonly required: true;
  readonly source_id: string;
  readonly source_locator: string;
  readonly ikm_hex: string;
  readonly salt_hex: string;
  readonly info_hex: string;
  readonly length_bytes: number;
  readonly okm_hex: string;
}

export interface HkdfIsolationVector {
  readonly vector_id: string;
  readonly category: "hkdf-info-isolation";
  readonly required: true;
  readonly source_id: string;
  readonly source_locator: string;
  readonly ikm_hex: string;
  readonly salt_hex: string;
  readonly length_bytes: number;
  readonly outputs: readonly { readonly label_ascii: string; readonly okm_hex: string }[];
}

export interface RandomRoundtripVector {
  readonly vector_id: string;
  readonly category: "random-roundtrip";
  readonly required: true;
  readonly source_id: string;
  readonly key_length_bytes: number;
  readonly nonce_length_bytes: number;
  readonly plaintext_length_bytes: number;
  readonly aad_length_bytes: number;
}

export interface RandomSourceErrorsVector {
  readonly vector_id: string;
  readonly category: "random-source-errors";
  readonly required: true;
  readonly source_id: string;
  readonly subchecks: readonly ["short-read", "failure", "all-zero"];
  readonly expected_error_codes: readonly ["RANDOM_SOURCE_SHORT_READ", "RANDOM_SOURCE_FAILED", "RANDOM_SOURCE_ALL_ZERO"];
}

export interface WrapKatVector {
  readonly vector_id: string;
  readonly category: "wrap-kat";
  readonly required: true;
  readonly source_id: string;
  readonly source_locator: string;
  readonly kek_hex: string;
  readonly key_material_hex: string;
  readonly wrapped_hex: string;
}

export interface WrapBadMaterialVector {
  readonly vector_id: string;
  readonly category: "wrap-bad-material";
  readonly required: true;
  readonly source_id: string;
  readonly base_vector_id: string;
  readonly mutation: { readonly field: "wrapped"; readonly byte_index: number; readonly xor: number };
  readonly expected_error_codes: readonly ["OBJECT_KEY_UNWRAP_FAILED"];
}

export type RequiredVector =
  | AeadKatVector
  | AeadTamperVector
  | HkdfKatVector
  | HkdfIsolationVector
  | RandomRoundtripVector
  | RandomSourceErrorsVector
  | WrapKatVector
  | WrapBadMaterialVector;

export interface VectorSuite {
  readonly name: string;
  readonly suite_id: number;
  readonly key_length_bytes: number;
  readonly nonce_length_bytes: number;
  readonly tag_length_bytes: number;
  readonly wrap_key_length_bytes: number;
  readonly aad_contract: "ekd-object-aad-v1-101-bytes";
}

export interface CryptoVectorManifest {
  readonly schema_version: "ekd-crypto-vector-manifest-v1";
  readonly status: string;
  readonly suite_id: number;
  readonly suite_name: string;
  readonly aad_contract: "ekd-object-aad-v1-101-bytes";
  readonly vectors_path: string;
  readonly vectors_sha256: string;
  readonly vector_count: 14;
  readonly required_vector_counts: RequiredVectorCounts;
  readonly sources: readonly Record<string, unknown>[];
}

export interface CryptoVectorsFile {
  readonly schema_version: "ekd-crypto-vectors-v1";
  readonly suite: VectorSuite;
  readonly vectors: readonly RequiredVector[];
}

export interface RequiredVectorCounts {
  readonly aead_kat: 3;
  readonly aead_tamper_ciphertext: 1;
  readonly aead_tamper_tag: 1;
  readonly aead_tamper_nonce: 1;
  readonly aead_tamper_aad: 1;
  readonly hkdf_kat: 2;
  readonly hkdf_info_isolation: 1;
  readonly random_roundtrip: 1;
  readonly random_source_errors: 1;
  readonly wrap_kat: 1;
  readonly wrap_bad_material: 1;
}

export interface LoadedVectorSet {
  readonly manifest: CryptoVectorManifest;
  readonly vectorsFile: CryptoVectorsFile;
  readonly vectors: readonly RequiredVector[];
  readonly manifestPath: string;
  readonly vectorsPath: string;
  readonly manifestPathForReport: string;
  readonly manifestSha256: string;
  readonly vectorsSha256: string;
}

export type VectorStatus = "passed" | "failed" | "error" | "skipped";

export interface VectorResult {
  readonly vector_id: string;
  readonly category: VectorCategory;
  readonly required: boolean;
  readonly status: VectorStatus;
  readonly expected_sha256: string | null;
  readonly actual_sha256: string | null;
  readonly expected_error_codes: readonly string[];
  readonly actual_error_code: string | null;
  readonly duration_ms: number;
  readonly peak_rss_bytes: number;
}

export interface AggregateCounts {
  readonly total: number;
  readonly required_total: 14;
  readonly passed: number;
  readonly failed: number;
  readonly error: number;
  readonly skipped: number;
  readonly required_passed: number;
  readonly verdict: "pass" | "fail" | "incomplete";
}

export interface CandidateMetadata {
  readonly name: string;
  readonly version: string;
  readonly package_integrity: string;
  readonly bundle_sha256: string;
}

export interface AlgorithmSuiteMetadata {
  readonly name: string;
  readonly suite_id: number;
  readonly key_length_bytes: number;
  readonly nonce_length_bytes: number;
  readonly tag_length_bytes: number;
  readonly aad_contract: "ekd-object-aad-v1-101-bytes";
}

export interface EnvironmentMetadata {
  readonly id: EnvironmentId;
  readonly os_name: string;
  readonly os_version: string;
  readonly runtime_name: string;
  readonly runtime_version: string;
  readonly device_model: string | null;
  readonly architecture: string;
  readonly lockfile_sha256: string;
  readonly source_commit: string;
  readonly bundle_sha256: string;
}

export interface EnvironmentManifestItem {
  readonly key: string;
  readonly value: string;
}

export interface EnvironmentManifest {
  readonly recorded_at: string;
  readonly items_sha256: string;
  readonly items: readonly EnvironmentManifestItem[];
}

export interface RawArtifact {
  readonly path: string;
  readonly sha256: string;
}

export interface ProcessInfo {
  readonly exit_code: number;
  readonly timed_out: boolean;
  readonly uncaught_error: string | null;
}

export interface DeviceBinding {
  readonly signature_algorithm: string;
  readonly public_key_fingerprint: string;
  readonly device_signature_base64url: string;
  readonly run_id: string;
  readonly vector_manifest_sha256: string;
  readonly plugin_bundle_sha256: string;
  readonly verified: boolean;
}

export interface SmokeReport {
  readonly schema_version: "smoke-report-v1";
  readonly run_id: string;
  readonly timestamp_utc: string;
  readonly git_commit: string;
  readonly candidate: CandidateMetadata;
  readonly algorithm_suite: AlgorithmSuiteMetadata;
  readonly environment: EnvironmentMetadata;
  readonly test_vectors: {
    readonly manifest_path: string;
    readonly manifest_sha256: string;
    readonly vector_count: number;
    readonly vectors_sha256: string;
  };
  readonly required_vector_counts: RequiredVectorCounts;
  readonly vector_results: readonly VectorResult[];
  readonly process: ProcessInfo;
  readonly aggregate: AggregateCounts;
  readonly environment_manifest: EnvironmentManifest;
  readonly raw_artifacts: readonly RawArtifact[];
  readonly device_binding: DeviceBinding | null;
}

export interface SmokeReportContext {
  readonly run_id: string;
  readonly timestamp_utc?: string;
  readonly git_commit: string;
  readonly candidate: CandidateMetadata;
  readonly environment: EnvironmentMetadata;
  readonly environment_manifest: EnvironmentManifest;
  readonly raw_artifacts: readonly RawArtifact[];
  readonly process?: ProcessInfo;
  readonly device_binding?: DeviceBinding | null;
  readonly algorithm_suite?: AlgorithmSuiteMetadata;
}

export interface SmokeExecutionOptions {
  /** Optional fault-injection source used to exercise the random-source guard. */
  readonly random_source?: RandomSource;
  /** A preloaded, hash-checked vector set; useful for callers that pin a path. */
  readonly vector_set?: LoadedVectorSet;
  /** Candidate-owned probes that must fail closed for the three random-source faults. */
  readonly random_source_faults?: {
    readonly short_read: RandomSource;
    readonly failure: RandomSource;
    readonly all_zero: RandomSource;
  };
}

export interface VectorRun {
  readonly vector_results: readonly VectorResult[];
  readonly aggregate: AggregateCounts;
}

export interface AggregateSourceInput {
  readonly path: string;
  /** Optional caller declaration; the aggregator always computes and checks the actual hash. */
  readonly sha256?: string;
  readonly environment_id?: EnvironmentId;
}

export interface SmokeAggregate {
  readonly schema_version: "smoke-aggregate-v1";
  readonly candidate: string;
  readonly suite_id: number;
  readonly source_reports: readonly {
    readonly environment_id: EnvironmentId;
    readonly path: string;
    readonly sha256: string;
    readonly schema_valid: boolean;
  }[];
  readonly environment_verdicts: {
    readonly "windows-node-cli": "pass" | "fail" | "incomplete" | "invalid";
    readonly "windows-obsidian": "pass" | "fail" | "incomplete" | "invalid";
    readonly "android-obsidian": "pass" | "fail" | "incomplete" | "invalid";
  };
  readonly cross_env_verdict: "cross_env_pass" | "cross_env_fail" | "cross_env_incomplete" | "cross_env_invalid";
}

export interface AggregateOptions {
  readonly root_dir: string;
  readonly expected?: {
    readonly candidate?: string;
    readonly suite_id?: number;
    readonly git_commit?: string;
    readonly vector_manifest_sha256?: string;
    readonly vectors_sha256?: string;
    readonly lockfile_sha256?: string;
  };
}

export type SmokeProvider = CryptoProvider;

export type ByteInput = Bytes;
