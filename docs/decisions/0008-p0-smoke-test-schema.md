# ADR-0008：Smoke Test JSON Schema、环境清单与错误码 Oracle

- 状态：部分取代；当前 schema 权威是 `docs/schemas/smoke-*.schema.json`
- 日期：2026-08-27
- 决策者：开发者
- 相关文档：P0-crypto-smoke-test-plan.md §4.3、threat-traceability.md §4

> 历史边界：下文示例 JSON 曾被误写成“已冻结 schema”，但示例不能验证 required、类型、未知字段或跨字段裁决。当前只以 JSON Schema 文件和 ADR-0012/一致性检查的缺项失败规则为准。

## 历史背景

P0-crypto-smoke-test-plan.md §4.3 已定义 smoke test 的 12 步执行流程和报告输出路径，但未冻结 JSON 报告的完整 schema、环境清单采集规则、错误码 oracle 与候选/套件/环境矩阵的对应关系。threat-traceability.md §4 给出 22 个规范错误码，但未明确 smoke 报告如何关联到这些错误码。

无冻结 schema 时，不同环境/候选/套件产生的报告无法机器对比，跨环境结果汇总只能人工拼接。本 ADR 冻结 schema、环境清单和错误码 oracle，使三环境 × 多候选 × 多套件的结果可自动合并和裁决。

## 历史决策（当前由 ADR-0012 和 JSON Schema 取代）

### 1. Smoke 报告 JSON Schema（v1）

每个候选 × 套件 × 环境运行产出一份 JSON 报告。Schema 字段：

```json
{
  "schema_version": "smoke-report-v1",
  "run_id": "<uuid-v4>",
  "timestamp_utc": "<ISO-8601>",
  "git_commit": "<sha>",
  "candidate": {
    "name": "<e.g. libsodium-wrappers>",
    "version": "<semver>",
    "bundle_hash": "<sha256 of candidate build artifact>"
  },
  "algorithm_suite": {
    "name": "<e.g. XChaCha20-Poly1305>",
    "suite_id": "<1 byte hex>",
    "key_length_bytes": <int>,
    "nonce_length_bytes": <int>,
    "tag_length_bytes": <int>,
    "aad_encoding": "<e.g. ekd-v1 object aad 85 bytes>"
  },
  "environment": {
    "id": "<e.g. windows-node-cli | windows-obsidian | android-obsidian>",
    "os": "<e.g. Windows 11 23H2>",
    "runtime_version": "<e.g. Node 20.10.0 or Obsidian 1.5.8>",
    "device_model": "<e.g. Pixel 7 or null for desktop>",
    "architecture": "<e.g. x64 or arm64-v8a>",
    "lockfile_hash": "<sha256 of dependency lockfile>"
  },
  "test_vectors": {
    "manifest_path": "fixtures/crypto-vectors/manifest.json",
    "manifest_hash": "<sha256>",
    "vector_count": <int>,
    "vectors_hash": "<sha256 of concatenated vectors>"
  },
  "vector_results": [
    {
      "vector_id": "<e.g. aead-kat-001>",
      "category": "<kat | random-roundtrip | tamper | hkdf | wrap | edge>",
      "status": "passed | failed | error | skipped",
      "expected": "<sha256 of expected output or null>",
      "actual": "<sha256 of actual output or null>",
      "error_code": "<canonical error code from threat-traceability.md §4 or null>",
      "duration_ms": <int>,
      "peak_rss_bytes": <int>
    }
  ],
  "aggregate": {
    "passed": <int>,
    "failed": <int>,
    "error": <int>,
    "skipped": <int>,
    "verdict": "pass | fail | incomplete"
  },
  "environment_manifest": {
    "recorded_at": "<ISO-8601>",
    "items": [
      {"key": "node_version", "value": "20.10.0"},
      {"key": "pnpm_version", "value": "8.12.0"},
      {"key": "candidate_version", "value": "<semver>"},
      {"key": "build_tool", "value": "<e.g. esbuild 0.20.0>"}
    ]
  }
}
```

schema_version 必须为 `"smoke-report-v1"`。任何字段缺失或类型错误视为该报告无效。

### 2. 报告裁决规则

`aggregate.verdict` 由 `vector_results` 自动推导：

- **pass**：所有 required 向量 `passed`，无 failed/error；
- **fail**：任何 required 向量 `failed` 或 `error`；
- **incomplete**：required 向量存在 `skipped`，且无 failed/error。

required 向量集合由本 ADR §3 固定。

### 3. Required 测试向量清单

每个候选 × 套件 × 环境必须执行的 required 向量：

| 类别 | 数量 | 验收 |
|---|---|---|
| aead-kat | 至少 3 组（每组固定 key/nonce/AAD/plaintext 包含 0x00/边界/正常） | ciphertext/tag 逐字节与官方/交叉实现一致 |
| aead-tamper-ciphertext | 1 组 | 返回 `OBJECT_AEAD_FAILED` 或等价错误码 |
| aead-tamper-tag | 1 组 | 返回 `OBJECT_AEAD_FAILED` |
| aead-tamper-nonce | 1 组 | 返回 `OBJECT_AEAD_FAILED` |
| aead-tamper-aad | 1 组 | 返回 `OBJECT_AEAD_FAILED` 或 `OBJECT_AAD_MISMATCH` |
| hkdf-kat | 2 组（不同 info 产生不同密钥） | 输出与固定向量一致；不同 info 产生不同密钥 |
| hkdf-info-isolation | 1 组 | manifest-key / object-wrap-key / recovery-file-integrity 三个标签派生结果互不相同 |
| random-roundtrip | 1 组 | 32 字节随机密钥 + 随机明文往返字节一致 |
| random-source-errors | 1 组 | 短读、失败传播、全零拒绝 |
| wrap-kat | 1 组 | 对象密钥 wrap/unwrap 与固定向量一致 |
| wrap-bad-material | 1 组 | 错误包装材料返回结构化失败 |

可选向量（skipped 计入 incomplete 不计入 fail）：

| 类别 | 用途 |
|---|---|
| perf-micro | 记录单次 AEAD 操作耗时和内存 |
| 候选专属向量 | 验证特定 API 边界 |

### 4. Android 报告机器绑定

Android Obsidian 环境的报告需额外满足：

- 报告由设备内运行的测试插件生成，签名后导出；
- 签名 JSON 包含 `device_signature`（设备 keystore 签名）、`run_id`、`vector_manifest_hash`、`plugin_bundle_hash`；
- 桌面归档时校验 `device_signature` 通过后才纳入总裁决；
- 截图不作为裁决依据；
- 同一向量不能跨设备提交（device_model + run_id 联合唯一）。

### 5. 错误码 Oracle 关联

Smoke 向量结果的 `error_code` 字段必须从 threat-traceability.md §4 的 22 个规范错误码中选取，或在向量本身不映射到这些错误码时设为 `null`。不允许自定义错误码字符串。

### 6. 跨环境合并报告

三环境报告归档到 `artifacts/test-reports/crypto-smoke/{candidate}/{suite}/`，并由 `tools/smoke-aggregate.ts` 生成合并报告：

- 合并报告 schema_version = `smoke-aggregate-v1`；
- 每个 candidate × suite 给出三环境 verdict 列表；
- 跨环境结果一致（同 candidate × suite 三环境均 pass）才记为 `cross_env_pass`；
- 任一环境 fail 记为 `cross_env_fail`；
- 任一环境 incomplete 记为 `cross_env_incomplete`。

选择 ADR 引用 `cross_env_pass` 结果作为依据。`cross_env_incomplete` 不构成选型证据。

## 后果

- Smoke 报告格式在 Phase 0 文档门禁层面冻结为 v1；
- 阶段 1 实施时必须按本 schema 产出报告，schema 不一致视为该次运行无效；
- 错误码 oracle 与 threat-traceability.md §4 一致；
- 跨环境合并可机器判定；
- 关闭报告中的"三环境全部通过"声明必须引用 `cross_env_pass`。

## 与算法参数的关系

本 ADR 冻结 schema、required 向量集合、Android 绑定、错误码 oracle。

未冻结（待 smoke 实施时按选定候选补充）：

- 具体向量二进制（key/nonce/AAD/plaintext/expected ciphertext/tag）；
- 候选包精确版本；
- 环境清单每项的具体取值。
