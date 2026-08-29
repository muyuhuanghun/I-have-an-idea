# ADR-0013：P0 密码实现与 Suite 1 选择

- 状态：Accepted
- 日期：2026-08-29
- 关闭项：DP-001、DP-002、DP-003、DP-004、DP-005
- 前置合同：ADR-0011、ADR-0012、`docs/protocol/P0-crypto-smoke-test-plan.md`

## 决策

P0 选择平台 Web Crypto `SubtleCrypto`，通过项目 `WebCryptoAes256Provider` wrapper `0.1.0` 使用。`@noble/ciphers@2.3.0` 与 `@noble/hashes@2.3.0` 已完成同矩阵比较，但不作为 P0 生产实现、自动 fallback 或混合实现。以后更换 provider、加入 fallback 或修改 suite，必须另写 ADR 并重跑对应三环境矩阵。

Suite registry v1 冻结为：

```json
{
  "registry": "ekd-p0-crypto-suite-registry-v1",
  "suites": [
    {
      "suite_id": 1,
      "provider": "webcrypto",
      "provider_version": "wrapper-0.1.0",
      "aead": "AES-256-GCM",
      "aead_key_length_bytes": 32,
      "nonce_length_bytes": 12,
      "tag_length_bytes": 16,
      "kdf": "HKDF-SHA-256",
      "wrap": "AES-256-KW",
      "wrap_key_length_bytes": 32,
      "object_key_length_bytes": 32,
      "wrapped_object_key_length_bytes": 40,
      "aad_contract": "ekd-object-aad-v1-101-bytes"
    }
  ]
}
```

Manifest 继续用 ADR-0011 已冻结的 `u16be wrapped_key_length`，Suite 1 的 32 字节 object key 经 AES-256-KW 包装后固定为 40 字节。解析器仍必须核对长度字段并拒绝坏材料。

## 证据

正式矩阵绑定 clean source commit `63db4eeb71a3ddab527000453a389a53cabe0db1`、lockfile SHA-256 `930917d393cf04ce8bcaa102c0c83e2a3544a5fa455277471eb48d3d66be0826`、vector manifest SHA-256 `a4b308d136c6f5bab08aaa582523a00f07e89fe5aaf8058d52e64409c1ec39e0` 和 vectors SHA-256 `fbc0902c8f0da529384439fe4e6d1fecaf170faab58a5aa17c190ef93d7340ff`。

| 候选 | 三环境 aggregate | aggregate SHA-256 |
|---|---|---|
| Web Crypto wrapper 0.1.0 | `artifacts/test-reports/crypto-smoke/formal-63db4eeb/webcrypto/suite-1/aggregate/smoke-aggregate.json`：`cross_env_pass` | `0c151722aa78b3fe415333b8bb277d3a504aa8883dfc26d1ec9822f656262331` |
| Noble 2.3.0 | `artifacts/test-reports/crypto-smoke/formal-63db4eeb/noble-ciphers-hashes/suite-1/aggregate/smoke-aggregate.json`：`cross_env_pass` | `237f1b289df8a3d4c7a42d7ae844da43517536b4fa6af4bd4432d9c69aa6d699` |

每个 aggregate 绑定 Windows Node、Windows Obsidian 和 Android Obsidian 各一份 schema-valid source report，三个环境均为 `pass`。Android 使用真实 YLP-W00 / Android 16 / arm64-v8a / Obsidian 1.12.7；WebCrypto run `f050df12-1406-4665-b4a0-ef555fba5d78`、Noble run `452af69d-3424-49b8-a553-a847ac62dfb3` 均为 14/14，设备公钥指纹均为 `1dd114eeef1ce9503f644d86e75e6069c12166c4d1515f536b8a27b211b76a6b`，ECDSA P-256 签名由 Node Web Crypto 独立验签通过。

固定 14 向量由 `fixtures/crypto-vectors/manifest.json` 和 `vectors.json` 定义，包括 NIST AES-256-GCM、NIST AES-256-KW、RFC 5869 HKDF、canonical label isolation、随机源错误与篡改/坏材料拒绝。manifest 与 vectors 的上述 hash 已被六份 source report 绑定。

## 选择理由

两个候选都满足功能与三环境兼容性门。选择 Web Crypto 是因为所需 AEAD、HKDF 和 AES-KW 已在目标平台实测通过，同时可复用平台密码实现，减少 P0 需要携带和升级的生产密码代码。Noble 的纯 JavaScript 实现适合作为独立比较基线，但其 JavaScript/JIT 常数时间限制和额外依赖没有带来本轮需要的生产收益。六次运行中的毫秒级时间只证明 smoke 可执行，不作为性能或安全基准。

## 边界

本 ADR 只关闭密码候选、suite、wrap、KAT 和 Android smoke 身份这五个延期项。它不实现或验证 Recovery、Manifest、Object codec，不升级任何 ACC，不表示 P0-R1、性能、供应链审计或生产安全已经通过。Phase 2/3 仍需用户另行授权。
