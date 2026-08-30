# P0 密码候选三环境 Smoke Test 合同

> 文档版本：v1.1
> 当前状态：schema、required vector profile 和裁决规则已冻结；Web Crypto/Noble 两候选正式三环境矩阵均为 `cross_env_pass`，ADR-0013 已完成选择
> 日期：2026-08-29
> 权威：ADR-0011/0012/0013、`smoke-report-v1.schema.json`、`smoke-aggregate-v1.schema.json`

## 1. 职责

定义 candidate × algorithm suite × environment 的可执行选型门槛。本文和 schema 不证明任何库兼容、安全或已选中；只有真实三环境 `cross_env_pass` 才能进入 suite 选择 ADR。

## 2. 候选和环境

本轮至少比较两条候选路径：平台 Web Crypto `SubtleCrypto`（项目 wrapper `0.1.0`），以及 `@noble/ciphers@2.3.0` + `@noble/hashes@2.3.0`。`libsodium-wrappers` 不属于本轮 Phase 1 矩阵；如需加入，必须先显式修改本合同并实现对应适配器，不能把缺失报告视为已比较。一次只选择一个生产实现，不拼装自创协议。

该矩阵只冻结正式比较范围，不预先选择默认实现。两个候选都必须完成下列三个环境的同 suite 运行；至少一个候选取得 `cross_env_pass` 后，才能由 suite selection ADR 作出选择。

每个 candidate × suite 必须在相同 vector manifest 下运行：

1. `windows-node-cli`；
2. `windows-obsidian`；
3. `android-obsidian`，真实设备、非模拟器。

不同 suite 不能合并成一次通过。suite_id、key/nonce/tag length 和 AAD contract 必须一致；当前 AAD contract 固定为 `ekd-object-aad-v1-101-bytes`。

## 3. 报告 schema 与缺项规则

每次运行产出一份 `smoke-report-v1`。完整 required 字段以 JSON Schema 为准，至少绑定：

- run/time/commit；candidate name/version/package integrity/bundle hash；
- suite name/id/key/nonce/tag/AAD；
- environment OS/runtime/device/architecture/lockfile/source/bundle；
- vector manifest/path/count/hash；
- 每个 vector 的 required/status/expected/actual/error/duration/RSS；
- process exit code/timeout/uncaught error；
- aggregate counts/verdict；environment manifest/hash；raw artifacts；
- Android 的 device signature、public key fingerprint、run/vector/plugin hash 和 verified 状态。

以下不是 incomplete，而是 **invalid**：

- required 字段缺失、类型错误或未知字段；
- source commit、bundle/vector/lockfile hash 缺失；
- aggregate count 与 vector results 不一致；
- required vector 数量/类别不满足 §4；
- Android device binding 缺失或 `verified != true`；
- desktop report 非法携带 Android device binding；
- process exit/timeout/uncaught error 与 verdict 矛盾。

invalid report 不进入跨环境裁决，也不能作为“基本通过”的选型证据。

## 4. Required vectors：恰好 14 个最低集合

| 类别 | 数量 | 机器判定 |
|---|---:|---|
| AEAD KAT | 3 | 固定 ciphertext/tag 逐字节等于来源明确的 expected bytes；覆盖空/0x00/正常边界 |
| tamper ciphertext | 1 | `OBJECT_AEAD_FAILED`，无部分明文 |
| tamper tag | 1 | `OBJECT_AEAD_FAILED`，无部分明文 |
| tamper nonce | 1 | `OBJECT_AEAD_FAILED`，无部分明文 |
| tamper AAD | 1 | `OBJECT_AEAD_FAILED` 或 `OBJECT_AAD_MISMATCH` |
| HKDF KAT | 2 | 与固定 expected bytes 一致 |
| HKDF label isolation | 1 | ADR-0011 四个 canonical label 的派生输出互异并匹配向量 |
| random roundtrip | 1 | CSPRNG key/nonce + 随机明文逐字节往返 |
| random-source-errors | 1 | 短读、失败和全零分别返回 `RANDOM_SOURCE_SHORT_READ`、`RANDOM_SOURCE_FAILED`、`RANDOM_SOURCE_ALL_ZERO`；生产无 `Math.random` 回退 |
| wrap KAT | 1 | wrap/unwrap 固定向量一致 |
| bad wrap material | 1 | 稳定错误、无对象密钥输出 |

合计 14。可增加 `perf-micro` 或 candidate-specific optional vector，但不能替代 required vector。精确向量字节由 DP-004 关闭。

## 5. 单报告裁决

先验证 schema，再由 vector results 和 process 字段自动推导：

- `pass`：14 个 required 全部 passed；required 无 skipped/failed/error；process exit 0、未 timeout、无 uncaught error；
- `fail`：任一 required failed/error，或进程失败；
- `incomplete`：schema valid，且 required 仅有 skipped、没有 failed/error；
- `invalid`：schema/绑定/计数不合法，不是报告内的有效 verdict。

optional skipped 不把 pass 降为 incomplete。aggregate 不能由调用者手填覆盖逐向量事实。

## 6. 三环境合并

每个 candidate × suite 的三份 source report 由 `smoke-aggregate-v1` 绑定 path/hash：

- 三环境各且仅一份；
- candidate、suite、commit、vector manifest 和 bundle 必须符合本轮矩阵；
- 任一 source invalid → `cross_env_invalid`；
- 任一 fail → `cross_env_fail`；
- 无 fail/invalid 但任一 incomplete → `cross_env_incomplete`；
- 三份均 pass → `cross_env_pass`。

只有 `cross_env_pass` 可被 suite 选择 ADR 引用。

## 7. 执行顺序与失败关闭

```text
1. 固定 lockfile/source/bundle/vector/environment 并计算 hash
2. schema 校验运行配置
3. 加载 candidate；记录初始化失败
4. 运行 CSPRNG 与错误传播检查
5. 运行 3 AEAD KAT 和 4 tamper vectors
6. 运行 2 HKDF KAT 与 label isolation
7. 运行 random roundtrip、wrap KAT 和 bad material
8. 收集 exit/time/RSS/raw artifacts
9. 生成 report，再由独立 aggregator 重算 counts/verdict
10. schema 校验 report；invalid 时停止该矩阵单元
11. 三环境齐备后生成 aggregate
```

库无法导入、依赖环境缺失全局对象、使用非 CSPRNG、AEAD 返回脏数据、错误被吞、required vector 缺项，都直接 fail/invalid，不继续把结果包装成 pass。

## 8. Android 证据

Android 报告必须由设备内测试插件生成并签名导出，绑定同一 run ID、vector manifest hash 和 plugin bundle hash。桌面归档只接收 `device_binding.verified=true` 的报告。截图只可辅助排障，不进入 oracle。

Obsidian 移动端不得假设 Node/Electron/Buffer 可用；候选 API、WASM 初始化和 Web Crypto 能力必须真机实测。

## 9. 延期项与当前事实

- DP-001：candidate 及精确版本；
- DP-002：AEAD suite 和长度；
- DP-003：wrap 算法；
- DP-004：KAT bytes；
- DP-005：Android 环境和签名身份。

它们各自的 owner、阶段、关闭产物和硬停止条件见延期 registry。正式矩阵绑定 clean commit `63db4eeb71a3ddab527000453a389a53cabe0db1`：两个候选均在 Windows Node、Windows Obsidian 和真实 Android Obsidian 中完成 14/14 required vectors，两个 aggregate 均为 `cross_env_pass`。ADR-0013 选择 Web Crypto wrapper `0.1.0` 和 Suite 1，DP-001..005 已关闭；Noble 保留为比较基线，不是生产 fallback。该结论不授权 Phase 2/3，也不升级任何 ACC。
