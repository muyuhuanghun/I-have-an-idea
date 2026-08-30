# Phase 4A Snapshot 创建流水线实现与复审报告

> 日期：2026-08-30
>
> 状态：实现提交 `fbdf325` 已由开发者显式授权纳管；本文保留提交前 dirty-source 历史并附提交后复核
>
> 基线：`3cbe53d03fdcabd9ef51db3165a9784adfb8617b`（Phase 4-0 接受提交之后）

## 1. 授权范围

2026-08-30 用户单独授权 Phase 4-A：按已接受的 ADR-0017 实现 snapshot 创建编排（§3 输入输出、§4 六阶段顺序、§6 碰撞重试、§7 日志绑定、§8 orphan 语义、§9 错误收敛）、§10 十四条测试边界，以及 `snapshot-log-v1` 机器门。明确不含：CLI 接线、Phase 4-B 恢复、HTTP ObjectStore、插件接线、任何 ACC/DP/registry 状态变化。

## 2. 实现内容

### 2.1 共享核心编排

`packages/core/src/snapshot.ts` 新增 `createSnapshotV1`，严格按 ADR-0017 §4 执行六阶段：

1. 预检。Recovery File 目标校验（§4.1 第 1 步）先于日志打开（第 2 步）：目标不可用时运行失败，不创建日志文件、不写对象、不创建 Recovery File，因此也不存在失败事件。日志 sink 打开失败收敛为 `LOG_WRITE_FAILED`。完整 Vault 枚举复用 `scanVault`，本切片为其新增 case-collision 检查（§4.1.3，`CASE_COLLISION`）：仅 ASCII 大小写不同的路径无法在大小写不敏感目标上恢复，扫描期失败关闭。
2. 根材料。单一 recovery root 经 `deriveDomainDataRootV1` → `deriveManifestKeyV1` / `deriveObjectWrapKeyV1` 派生全部密钥；Recovery File 用显式 `encodeRecoveryFileV1` 编码并传入同一 root，§4.2 指出的 `generateRecoveryFileV1` 内部再生成 root 的陷阱在结构上被绕开。
3. 逐文件 seal + 原子 put。仅 `ObjectStore.put` 返回 `OBJECT_ID_COLLISION` 时整对象重试（每次重新生成 object ID/key/nonce/AAD/wrapped key/ciphertext），file 与 Manifest 对象各 8 次总尝试；其余错误立即终止。二次遍历读取（scan 定长、文件阶段重读）尺寸不一致映射为 `FILE_CHANGED_DURING_SCAN`；深度稳定性由 adapter 的 stamp 机制承担。
4. Manifest 对象。parent snapshot ID 全零；编码器预检一次，格式违规在任何发布尝试前失败。
5. 日志封口。`snapshot_prepared` 写入后 flush/fsync/close；此后不存在任何必须成功的日志或报告 I/O，完成由 read-back、函数返回与（未来接线后的）exit 0 共同证明。
6. Recovery File 最后独占写入 + 逐字节 read-back。

§8 orphan 语义：失败结果的 orphan 计数为本 run 已成功 `put` 但未被成功的 Recovery File 可达的对象数；碰撞目标属于旧对象不计入；未发布任何对象时为 0。不删除、不回滚、不扩展端口。§9 错误收敛：结构化稳定码在冻结 allowlist 内原样透传，其余异常一律收敛为 `HONEST_CLAIM_VIOLATION`，原始 OS/library 错误只保留在内部 cause，不进入结果对象与日志。明文、recovery root 与三个派生密钥在 `finally` 中原位清零。

端口新增 `SnapshotLogSink` 与 `RecoveryFileTarget`（core `ports.ts`）；路径 containment 完全位于 adapter 侧，core 不持有路径字符串，§7.2 的禁日志项在结构上不可能违反。`SnapshotCreateError` 与冻结码 allowlist 加入 core `errors.ts`。

### 2.2 Node 适配

`packages/adapters/src/node-snapshot-io.ts` 实现两个端口：日志 sink 与 Recovery File 目标都接受 Vault 与 ObjectStore 双根，所有写入路径在 adapter 内做双根词法 containment，父目录不得为重解析点，创建为独占模式，写入后 fsync + close + 逐字节 read-back 比对；已存在目标永不覆盖，write 与 close 双失败时保留先发原因（同一稳定码，无观察差异）。

`node-vault.ts` 的 `readStableFile` stamp-before/read/stamp-after 语义不变，内部读取替换为按文件实际大小一次性预分配加 1 MiB 线性分块（§5 的 `vault_read_chunk_bytes`，适配器常量 `VAULT_SOURCE_READ_CHUNK_BYTES` 有测试绑定到已接受的 `p0-runtime-limits-v1.json`）；稳定性变化之外的读取失败收敛为 `SOURCE_FILE_READ_FAILED`，不再外泄原始 errno。

### 2.3 机器门

新增 `docs/schemas/snapshot-log-v1.schema.json`：五种事件（preflight_complete / file_published / manifest_published / snapshot_prepared / snapshot_failed）的 if/then 分支 schema，顶层 `additionalProperties: false`。路径、文件名、marker 与秘密在结构上不可表达——没有任何属性接受它们；`run_id`、object key、各 hex 字段、UTC 时间戳与 `error_code` 枚举全部冻结。正反样例各一份接入 `python tools/verify_phase0_contracts.py --validate-samples`，反样例注入 `vault_relative_path` 泄漏攻击字段并被拒绝。

## 3. 复审判定

独立复审（GPT，2026-08-30）判定：验收通过，无阻塞问题。三个边界条目如实固化：

1. **CLI 接线未包含**。ADR-0017 §3.2 规定编排只返回内存结果；CLI 命令属后续 harness 切片，§2 完成定义中的"CLI exit 0"留待接线时闭环。
2. **二次遍历读取**。scan 阶段定长一次读取、文件 seal 阶段重读一次（端口未暴露 stat API）；尺寸不一致映射为 `FILE_CHANGED_DURING_SCAN`，深度稳定性由 adapter stamp 承担。
3. **§10.7 后半"第二份 root 负例"**由 recovery codec 既有 HMAC 完整性测试覆盖，未重复新增。

复审稿本身含六处事实性错误，已在本报告中按实现与代码事实修正后再固化：(1) snapshot-log-v1 样例为 1 正 + 1 反（"5" 是 schema 事件分支数），全库三个 schema 各一对；(2) 验证器入口是 `python tools/verify_phase0_contracts.py --validate-samples`，不存在 `pnpm run schema:validate`；(3) `schemas/test/snapshot-log-v1.test.ts` 与 `node-vault.test.ts` 两个文件不存在，对应覆盖来自 python 验证器与 `adapters/test/node-snapshot-io.test.ts` 及既有 `adapters.test.ts`；(4) stamp 变化映射为 `FILE_CHANGED_DURING_SCAN`，`SOURCE_FILE_READ_FAILED` 只收稳定性变化之外的读取失败；(5) orphan 语义按本报告 §2.1 的精确表述，不是"任何失败即视为 orphan"；(6) import gate 的入口是 `pnpm run check:imports`（build 链第一步），不存在 `import:gate` 脚本。

## 4. 测试与门禁证据

26 个新增测试覆盖 ADR-0017 §10 十四条边界：核心 15 个（端到端 + 从 Recovery File 中的 root 重派生密钥解开 Manifest 与文件对象；各阶段失败路径；预检零写入；碰撞 1..7 成功/第 8 次失败；Manifest 碰撞与非碰撞不重试；日志 open/seal 失败；目标已存在与 read-back 失败；runtime-limits hash 不匹配；root/派生密钥/明文清零；结果与日志无路径/文件名/marker/内容；case-collision；真实合同文件 hash 绑定）、适配器 11 个（日志 sink 独占与 containment、Recovery File 独占与不覆盖、多分块字节级一致、`SOURCE_FILE_READ_FAILED` 与 `FILE_CHANGED_DURING_SCAN` 收敛、分块常量合同绑定）。

统一门禁：lint、typecheck（6 项目）、test 113/113（core 40 / crypto 18 / adapters 50 / smoke 5）、shared-core import gate、build（6 项目）全部通过。`--validate-samples` 输出 `PHASE0_CONTRACT_CHECK_PASS ACC=37 INV=16 THR=5 DP=26`，P0-R1 保持 NOT_IMPLEMENTED / NOT_TESTED。staged 与工作树空白检查通过。开发中自检修复三处：未使用的 `afterEach` 导入、编排层 `open` 失败未收敛为 `LOG_WRITE_FAILED`、`openFileObjectV1` 调用漏传 `envelope`。

## 5. 证据边界与停止点

全部结果是 dirty-source implementation review evidence，不是正式 ACC evidence。DP-001..026 状态零变化，机器 registry 零变化（`SOURCE_FILE_READ_FAILED` 与 `RECOVERY_FILE_WRITE_FAILED` 已随 Phase 4-0 接受注册），37 个 ACC 全部保持 `untested`，P0-R1 未实现、未测试。

开发者已于 2026-08-30 显式授权两笔提交与推送。实现提交 `fbdf325`（20 文件 = 复审时 12 修改 + 7 新增 + 本报告）创建后，在 clean HEAD 上复跑统一门禁 113/113（core 40 / crypto 18 / adapters 50 / smoke 5）、shared-core import gate、build 与 design-only+samples 合同校验（ACC=37 INV=16 THR=5 DP=26）全部 PASS，随后按既定惯例以 reconcile 提交回写状态措辞。这些仍不是正式 ACC evidence；CLI 接线、Phase 4-B 恢复、HTTP ObjectStore、插件接线与 P0-R1 证据门仍需各自明确授权。
