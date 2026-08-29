# Phase 1 Scaffold and Crypto Portability Smoke — Status Report

> 报告版本：v0.5
> 日期：2026-08-29
> 适用仓库：`I_have_an_idea`
> 关联文档：README §27、`docs/product/P0_EXECUTION_PLAN.md` §12、`docs/decisions/0012-p0-machine-contracts-and-gates.md`、`docs/protocol/P0-crypto-smoke-test-plan.md`

## 1. 范围与授权

本报告只覆盖用户单独授权的 Phase 1 工程 workspace、共享核心与适配器骨架、统一 lint/typecheck/test、最小 Obsidian 插件和三环境密码 smoke harness。

本阶段不实现生产 Recovery / Manifest / Object codec，不进入 Phase 2 / Phase 3，也不自动 commit 或 push。`cross_env_pass` 取得前，DP-001..005 保持开放，生产协议编码继续硬停止。

## 2. 已实施结构

```text
package.json, pnpm-workspace.yaml, pnpm-lock.yaml
tsconfig.base.json, tsconfig.json, eslint.config.mjs
tools/check-imports.mjs
tools/phase1-build-meta.mjs
packages/core/                   共享端口和未配置 provider
packages/crypto/                 Web Crypto 与 Noble 两个候选适配器
packages/smoke/                  固定 14 向量 runner、schema validator、Node 聚合器
packages/adapters/               Node / Obsidian VaultSource 骨架
apps/cli/                        Node smoke 与 aggregate 命令
apps/obsidian-plugin/            Windows / Android 最小 smoke 插件
fixtures/crypto-vectors/         hash-bound 固定向量
```

`packages/core` 和 `packages/crypto` 受 import gate 约束，不得引入 Node filesystem、Electron、Obsidian 或 localhost 实现。当前没有生产 Recovery File、Manifest、Object Envelope、ObjectStore、扫描器或恢复器。

## 3. 候选实现与固定向量

- `WebCryptoAes256Provider`：平台 Web Crypto，版本标识 `wrapper-0.1.0`。
- `NobleAes256Provider`：精确固定 `@noble/ciphers@2.3.0` 与 `@noble/hashes@2.3.0`，lockfile 绑定对应包完整性。
- 候选共享同一套 AES-256-GCM、HKDF-SHA-256、AES-256-KW 接口和稳定错误码。
- required 向量固定为 14 个：3 个 AEAD KAT、4 个 AEAD 篡改拒绝、2 个 RFC 5869 HKDF KAT、1 个 canonical label isolation、1 个随机 roundtrip、1 个 random-source 错误注入、1 个 AES-KW KAT、1 个坏 wrapped material 拒绝。
- fixed vectors 只用于 Phase 1 候选兼容性判断，不构成生产 Recovery/Manifest/Object codec。

## 4. Schema 与 Android 强绑定

插件构建时内嵌与 Node 聚合器相同的 `docs/schemas/smoke-report-v1.schema.json`。插件在写入最终 report 前调用 `createSmokeReportSchemaValidator`；schema-invalid 报告不会落盘。

Android 报告必须同时满足：

1. `device_model`、Android 版本、architecture 均为非空环境字段；
2. 插件运行时生成或读取本设备的 ECDSA P-256 smoke key；
3. 签名绑定 `run_id + vector_manifest_sha256 + plugin_bundle_sha256`；
4. report 包含公钥指纹、公钥和 `verified=true`；
5. Node 聚合器重新验证签名，`device_binding=null` 或验签失败均得到 `cross_env_invalid`。

该 key 只证明 smoke 报告由同一插件运行时密钥签发，不是硬件 attestation，也不是生产设备密钥。生产移动端密钥保护仍由 DP-026 管理。

此前未获授权的 `0013-p1-smoke-report-device-binding-optional.md` 已删除，schema 和聚合器已恢复 ADR-0012 / DP-005 的 Android verified binding 强门。

## 5. 当前运行证据

| 环境 | 当前证据 | 是否可关闭 DP |
|---|---|---|
| Windows Node CLI / WebCrypto | dirty source 下 14/14，`verdict=pass` | 否，dev-only |
| Windows Node CLI / Noble 2.3.0 | dirty source 下 14/14，`verdict=pass` | 否，dev-only |
| Windows Obsidian / WebCrypto | 隔离 Vault 已加载当前 bundle 并由 Obsidian 1.13.7 真实运行；14/14、`verdict=pass`、report schema-valid、raw artifact hash 一致；`source_tree_state=dirty`，run `7f3e265d-2e75-464a-a65b-43ca63b51031` | 否，dev-only |
| Android Obsidian / WebCrypto | 真机 YLP-W00 / Android 16 / arm64-v8a 已运行；14/14、`verdict=pass`、report schema-valid、raw artifact hash 一致、`device_binding.verified=true`、ECDSA P-256 签名经 Windows Node 独立验签通过；`source_tree_state=dirty`，run `5072c1a4-c35f-4490-8605-b49febfa3bed` | 否，dev-only |
| 三环境 aggregate | `cross_env_invalid`（三份报告均绑定 dirty source，聚合器要求 clean） | 否 |

所有报告都必须绑定同一 source commit、lockfile、candidate、suite 与 vector set。工作树 dirty 时，即使单环境 14/14，也不得被聚合器接受为正式证据。

本次 Windows Obsidian 报告位于 `artifacts/phase1-test-vault/phase1-smoke-output/reports/windows-obsidian-webcrypto-7f3e265d-2e75-464a-a65b-43ca63b51031.json`；其 `candidate.bundle_sha256` 为 `e2106785d21a2f3b1bf342b0828bee3a5dcefa9d985853157e8bb11778e03346`，与隔离 Vault 中当前 `main.js` 及构建 metadata 一致。这只是现场开发 smoke 证据，不是 `cross_env_pass`。

## 6. DP-001..005 状态

| DP | 权威含义 | 当前状态 |
|---|---|---|
| DP-001 | 生产密码候选实现及精确版本 | OPEN；两个候选并行，尚未选择默认实现 |
| DP-002 | AEAD suite_id、算法及 key/nonce/tag 长度 | OPEN；候选参数已用于 dev smoke，缺三环境正式选择证据 |
| DP-003 | 对象密钥 wrap 算法、wrap key length 与 wrapped bytes 合同 | OPEN；AES-256-KW KAT 已通过三环境 dev-only，缺 clean-source 正式证据 |
| DP-004 | 算法级 KAT 的精确 bytes 与来源 | OPEN；14 个向量和 manifest 已存在，尚未由正式选择 ADR 关闭 |
| DP-005 | Android 真机、Obsidian、插件与设备签名精确身份 | OPEN；强绑定门已恢复，Android 真机报告已产出且设备签名验签有效，但仍缺 clean-source 正式报告聚合（`cross_env_pass`）与 suite selection ADR |

## 7. 统一门与回归范围

统一命令为：

```text
pnpm run test:all
```

它依次运行 lint、全 workspace typecheck、单元/集成测试、shared-core import gate 和所有构建。smoke 聚合测试必须同时证明：

- 三份 clean、hash-bound、schema-valid 且 Android 已验签的报告可得到 `cross_env_pass`；
- 同一 Android 报告把 `device_binding` 改为 `null` 后必须得到 `cross_env_invalid`；
- 任一报告把 `source_tree_state` 改为 `dirty` 后必须得到 `cross_env_invalid`。

Phase 0 schema 反身门另行运行：

```text
python tools/verify_phase0_contracts.py --validate-samples
```

该命令通过只代表设计合同/schema 门有效，不代表 P0-R1、ACC 或 DP 已关闭。

## 8. 关闭 DP-001..005 仍需的证据

1. Phase 1 实现及 dev-only 复审已由用户手动提交并推送，实施提交为 `927eb4efc5c33117df72e95256a9ffe7120a8902`。
2. 将 Web Crypto + Noble 2.3.0 两候选矩阵的合同修正纳入新的用户手动提交；在该提交之前不得生成正式证据。
3. 从新的 clean source 运行一次统一门并重建，确认 CLI 与插件 build metadata 都绑定同一 clean commit。
4. 对 Web Crypto 和 Noble 各执行一次 `windows-node-cli`、`windows-obsidian`、`android-obsidian`，共六份正式 source report；Android 两份报告都必须带可由聚合器重新验签的 verified device binding。
5. 每个候选分别聚合其三份报告，共生成两份 aggregate。被选择的候选必须取得 `cross_env_pass`；另一候选必须形成完整、有效的比较结果，不能因缺报告或非法绑定而成为无效比较。
6. 只有取得可引用的 `cross_env_pass` 后，才写入 suite selection ADR，更新权威 deferred registry，关闭 DP-001..005。
7. 停下复审；不得自动进入 Phase 2 / Phase 3。
