# Phase 1 Scaffold and Crypto Portability Smoke — Status Report

> 报告版本：v0.6
> 日期：2026-08-29
> 适用仓库：`I_have_an_idea`
> 关联文档：README §27、`docs/product/P0_EXECUTION_PLAN.md` §12、`docs/decisions/0012-p0-machine-contracts-and-gates.md`、`docs/protocol/P0-crypto-smoke-test-plan.md`

## 1. 范围与授权

本报告只覆盖用户单独授权的 Phase 1 工程 workspace、共享核心与适配器骨架、统一 lint/typecheck/test、最小 Obsidian 插件和三环境密码 smoke harness。

本阶段不实现生产 Recovery / Manifest / Object codec，不进入 Phase 2 / Phase 3，也不自动 commit 或 push。正式矩阵和 ADR-0013 已关闭 DP-001..005，但这不等于后续阶段获得授权。

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

## 5. 正式运行证据

正式矩阵绑定 clean source commit `63db4eeb71a3ddab527000453a389a53cabe0db1`。统一门在构建前通过；CLI 与插件 build metadata 分别绑定各自 bundle、同一 lockfile 和同一 vector set。

| 环境 | Web Crypto | Noble 2.3.0 |
|---|---|---|
| Windows Node CLI | 14/14，schema/raw/bundle/clean 绑定有效 | 14/14，schema/raw/bundle/clean 绑定有效 |
| Windows Obsidian 1.13.7 | 隔离 Vault 真实运行，14/14 | 隔离 Vault 真实运行，14/14 |
| Android Obsidian 1.12.7 | YLP-W00 / Android 16 / arm64-v8a，14/14，设备签名独立验签通过 | 同一真机，14/14，设备签名独立验签通过 |
| 三环境 aggregate | `cross_env_pass` | `cross_env_pass` |

证据根为 `artifacts/test-reports/crypto-smoke/formal-63db4eeb/`。Web Crypto aggregate SHA-256 为 `0c151722aa78b3fe415333b8bb277d3a504aa8883dfc26d1ec9822f656262331`；Noble aggregate SHA-256 为 `237f1b289df8a3d4c7a42d7ae844da43517536b4fa6af4bd4432d9c69aa6d699`。六份 source report 的 path/hash 由各自 aggregate 绑定。

Android 两份报告的 `device_binding.verified=true`，公钥指纹均为 `1dd114eeef1ce9503f644d86e75e6069c12166c4d1515f536b8a27b211b76a6b`；Node 聚合器和独立 Web Crypto 验签均通过。完整证据和选择理由见 ADR-0013。

## 6. DP-001..005 状态

| DP | 权威含义 | 当前状态 |
|---|---|---|
| DP-001 | 生产密码候选实现及精确版本 | CLOSED；Web Crypto wrapper `0.1.0` |
| DP-002 | AEAD suite_id、算法及 key/nonce/tag 长度 | CLOSED；ADR-0013 Suite 1 |
| DP-003 | 对象密钥 wrap 算法、wrap key length 与 wrapped bytes 合同 | CLOSED；AES-256-KW，32 字节 KEK，32 字节 object key 包装为 40 字节 |
| DP-004 | 算法级 KAT 的精确 bytes 与来源 | CLOSED；14 个 required 向量及 manifest/hash 已由六份正式报告绑定 |
| DP-005 | Android 真机、Obsidian、插件与设备签名精确身份 | CLOSED；两候选均有真机 verified binding 和独立验签证据 |

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

该命令通过只代表设计合同/schema 门有效，不会自行关闭 P0-R1、ACC 或 DP；DP-001..005 的关闭依据是 ADR-0013 及其绑定的正式矩阵。

## 8. Phase 1 关闭与停止点

Phase 1 授权范围已经完成：工程骨架、统一门、最小插件、六个正式矩阵单元、两个 `cross_env_pass`、ADR-0013 和 DP-001..005 registry 状态均已形成。当前只做关闭材料复审，不自动提交或推送。

P0-R1 仍未实现，37 个 ACC 仍为 `untested`，fixture、生产 Recovery/Manifest/Object codec、压力测试和 HTTP ObjectStore 均未开始。必须停在此处；Phase 2/3 需要用户另行明确授权。
