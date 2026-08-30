# ADR-0017：P0 Snapshot 创建流水线 v1 合同

- 状态：已接受（2026-08-30 开发者确认全部四个合同点；Phase 4-A/4-B 未授权、未实施）
- 日期：2026-08-30
- 草案阶段：Phase 4-0
- 决策者：开发者
- 相关文档：ADR-0003、ADR-0009、ADR-0011、ADR-0012、ADR-0015、ADR-0016、`P0-recovery-and-object-format.md`、`P0-fixture-and-performance-baseline.md`、`P0_EXECUTION_PLAN.md`、`docs/contracts/p0-deferred-parameters.json`（DP-012）、`docs/contracts/p0-runtime-limits-v1.json`、`docs/schemas/p0-runtime-limits-v1.schema.json`

> 本 ADR 已由开发者于 2026-08-30 确认接受。它仍不授权 Phase 4-A/4-B 实现，不修改任何 ACC 状态，不关闭 DP-012，也不进入恢复、HTTP ObjectStore 或 Obsidian 插件接线；随接受完成的文档动作见 §12。

## 1. 背景与本阶段边界

Phase 3B 已提供内存中的 file object、Manifest object 与 Recovery File 编解码；Phase 3C 已冻结并实现不可变 Directory ObjectStore；Phase 3D 已冻结并实现存储可见性扫描工具。这些组件尚未被一个真实 snapshot 创建流程串起来。

Phase 4-0 只回答下面七个合同问题：

1. snapshot 创建的阶段、输入、输出与成功点；
2. DP-012 的拟议 chunk、并发和队列上限；
3. object ID 碰撞在编排层如何重试；
4. file objects、Manifest object 和 Recovery File 的发布顺序；
5. 运行日志如何与一次 snapshot 绑定，同时避免泄漏路径、内容和密钥；
6. 失败后不可删除对象怎样按 orphan 处理；
7. 任一步骤失败时，怎样保证不会把 snapshot 报成完成。

本草案不设计 restore pipeline；Phase 4-B 仍须单独授权。它也不实现任何端口、CLI、schema、测试或运行代码。

## 2. 术语与唯一成功定义

- **run**：一次 snapshot 创建尝试，由运行时生成非秘密的 `run_id`，只用于日志和证据关联，不进入 wire format。
- **published object**：Directory ObjectStore 的 `put` 已返回成功的不可变对象。
- **orphan object**：本 run 已发布，但没有被一个成功返回的 Recovery File 所指向或到达的对象。P0 不提供 delete/list/GC，因此这里只识别和报告，不自动删除。
- **prepared**：全部 file objects 与 Manifest object 已发布，强制日志已经写入、flush、关闭，Recovery File 尚未写入。
- **complete**：Recovery File 已用独占创建写到 Vault 外，完成 fsync/close，并由同一进程重新读取后与待写入的 167 字节逐字节一致；随后 snapshot 创建函数成功返回、CLI 以 0 退出。
- **failed**：上述 complete 条件没有全部成立。任何“对象已经写了一部分”“Manifest 已发布”或“Recovery File 路径上存在某个文件”都不能单独升级成 complete。

Recovery File 是恢复入口，但 P0 不把“路径存在”当作事务提交标记：进程崩溃可能留下截断文件，最终判定必须同时依赖本次运行的成功返回与严格 read-back。未来新进程读取时仍必须重新执行 167 字节、magic/version/suite 与 HMAC 的现有严格解码。

## 3. Phase 4-A 的拟议输入与输出

### 3.1 输入

未来 Phase 4-A 的共享核心编排只接受明确注入的依赖和参数：

| 输入 | 合同 |
|---|---|
| `VaultSource` | 只读取已允许的 Vault 文件；不跟随 symlink/junction；扫描与稳定读取规则沿用 ADR-0009 |
| `ObjectStore` | ADR-0015 的不可变 `put/get` 端口；本流程不要求 list/delete/rename |
| `CryptoProvider`、`RandomSource` | 沿用 Phase 3B 冻结接口与错误收敛；所有秘密随机量都来自 `RandomSource` |
| `domain_id` | 恰好 32 字节、非秘密，由调用者明确提供；本草案不引入 domain registry |
| Recovery File 目标 | Vault 外、ObjectStore 外、尚不存在；最终写入必须是独占创建，禁止覆盖 |
| 强制日志 sink | Vault 外、ObjectStore 外、尚不存在；二进制/JSONL 写入、flush、close 任一步失败均为 `LOG_WRITE_FAILED` |
| runtime limits | 必须与已接受版本的 `p0-runtime-limits-v1.json` 字节/hash 绑定；不能用调用参数放宽 |

`Clock` 只允许产生日志时间与性能采样时间，不能进入对象 ID、nonce、key 或 wire format。

### 3.2 返回结果

编排函数只返回内存中的 `SnapshotCreateResultV1`，不得在成功后再依赖一个必须写盘的报告才能把 snapshot 判为 complete：

- `status`: `complete` 或 `failed`；
- `run_id`；
- 成功时的 `snapshot_id`、`manifest_object_id`、file/object 计数与明文字节总数；
- 失败时的稳定 `error_code`、失败阶段、已发布 object ID 清单与 orphan 数；
- `recovery_file_created` 与 `required_log_closed` 布尔值；
- 使用的 runtime-limits 版本和 SHA-256。

禁止返回或持久化 recovery root、Domain Data Root、Manifest Key、Object Wrap Key、每对象 key、nonce、wrapped key、明文、原始路径或文件名。面向 P0-R1 的正式 report/schema 与 hash binding 属于后续获批工作；本节只冻结最小语义，不把草案当成 ACC-35 evidence。

## 4. 创建顺序

未来实现必须严格按下列顺序执行。除碰撞循环外，不允许跨阶段并行或调换发布顺序。

### 4.1 阶段 0：预检，不写 ObjectStore

1. 校验 Recovery File 和日志目标位于 Vault/ObjectStore 外，目标不存在，父目录不是 symlink/junction；存在性检查只是减少孤儿的 fast path，最终独占创建才是竞态权威。
2. 打开强制日志 sink；如果不能独占创建，立即以 `LOG_WRITE_FAILED` 失败。
3. 完整枚举 Vault，执行 canonical path、扩展名、reparse point、case collision 与 unsupported-file 检查。发现任何不支持输入时，在写入第一个对象之前失败。
4. 生成 `run_id`，但不生成或打印任何路径映射。

预检减少可避免的 orphan；它不承诺源文件在后续读取期间不变化，稳定读取仍须逐文件检查。

### 4.2 阶段 1：生成本次 snapshot 的根材料

1. 用 `RandomSource` 生成恰好 32 字节 recovery root 与 32 字节 snapshot ID；执行长度、provider failure 与全零检查。
2. 从这份 recovery root 派生 Domain Data Root，后续 Manifest Key 与 Object Wrap Key 都必须来自同一根。
3. recovery root 只保留在内存中，直到最终 Recovery File 编码完成；成功或失败都在 `finally` 中 best-effort 原位清零。

现有 `generateRecoveryFileV1` 会在调用点内部新生成 recovery root，不能在流水线末尾直接调用，否则会与已发布对象使用的根不同。Phase 4-A 若获批，必须复用现有 `encodeRecoveryFileV1` 并把同一 recovery root 显式传入，或增加一个只生成并返回受管根材料的受测 API；不得生成第二份 root 来“补”Recovery File。

### 4.3 阶段 2：顺序创建 file objects

对 canonical 顺序中的每个文件：

1. 用 1 MiB source-read chunk 执行稳定读取，按文件读取前后 stamp 检查 `FILE_CHANGED_DURING_SCAN`；chunk 只约束 I/O，不声称 AES-GCM 是增量式。
2. 当前 WebCrypto codec 需要整文件 AEAD buffer，因此只允许一个文件进入内存：禁止预取下一个文件，禁止全 Vault 缓冲，禁止并发 seal/put。
3. 为本次尝试生成新 object ID、object key 与 nonce，调用 `sealFileObjectV1`。
4. 用 canonical key 调用 `ObjectStore.put`。成功后把 `ManifestEntryV1` 和已发布 object ID 加入本 run 的内存清单。
5. `OBJECT_ID_COLLISION` 才允许进入下一次尝试；其余错误立即失败。每次碰撞重试必须重新生成 object ID、object key、nonce、AAD、wrapped key 与 ciphertext，不能复用前一次任何密码材料。
6. 无论成功或失败，读取到的明文 buffer 都在最小可见范围的 `finally` 中 best-effort 原位清零；不得清零已作为非秘密输出返回的 object ID。

### 4.4 阶段 3：创建 Manifest object

1. 使用现有 canonical Manifest encoder；Manifest entries 必须按 canonical path 排序，并继续拒绝重复 path 与重复 object ID。
2. 以与 file object 相同的 8 次总尝试规则生成、seal、publish Manifest object；碰撞后必须生成新的 manifest object ID、nonce、AAD 与密文。
3. Manifest object 发布成功前禁止编码或写入 Recovery File。

P0 v1 的 parent snapshot ID 仍为 32 字节全零；本草案不引入 mutable head、snapshot chain 或多版本索引。

### 4.5 阶段 4：准备并封口强制日志

1. 写入 `snapshot_prepared` 记录，其中只能包含 §7 的安全字段。
2. flush/fsync 并关闭强制日志 sink；任何失败返回 `LOG_WRITE_FAILED`，且不写 Recovery File。
3. 日志关闭后不再有必须成功的日志或报告 I/O。成功路径也不追加 `snapshot_complete`；complete 由 Recovery File read-back、函数成功返回与进程 exit 0 共同证明。

这条顺序是为了满足 ACC-34：如果强制日志不可写，snapshot 必须在 Recovery File 发布前失败。不能先发布 Recovery File，再把日志失败当成一个无关告警。

### 4.6 阶段 5：最后写 Recovery File

1. 用阶段 1 的同一份 recovery root、domain ID、snapshot ID 和已经成功发布的 manifest object ID 调用严格 Recovery File encoder，得到恰好 167 字节。
2. 目标必须在 Vault 外且尚不存在；用独占创建写入，权限/ACL 尽力收紧，完成文件 fsync、close，再重新读取。
3. read-back 必须与待写字节逐字节一致；任何短写、额外字节、读取错误或 mismatch 都失败。
4. 禁止覆盖旧 Recovery File；禁止在 Recovery File 成功 read-back 后再执行任何决定 snapshot 成败的持久化写入。
5. 成功后函数返回 complete，CLI 退出 0。正式 P0-R1 harness 必须捕获完整 stdout/stderr，并在新进程中重新读取 Recovery File；这不等于授权 Phase 4-B restore。

Recovery File 直接独占写入而不是声称跨平台原子 rename：现有 Node 合同能保证 no-overwrite、fsync 与 read-back，不能保证崩溃瞬间路径永远不可见。崩溃留下的截断文件会被严格 167 字节/HMAC 解码拒绝，创建进程也不会报告 complete。若以后要求“路径出现即提交”的更强语义，必须另开 ADR，不能在本合同下偷换保证。

## 5. DP-012 与内存边界

配套 `docs/contracts/p0-runtime-limits-v1.json` 已随本 ADR 接受冻结（`contract_status=accepted`），并已接入 `verify_phase0_contracts.py` 的 schema 与正反样例机器门：

| 参数 | 冻结值 | 含义 |
|---|---:|---|
| `vault_read_chunk_bytes` | 1,048,576 | source adapter 的 I/O chunk；不是 streaming AEAD 声明 |
| `max_file_processing_concurrency` | 1 | 同时只处理一个 Vault 文件 |
| `max_prefetch_queue_entries` | 0 | 禁止明文预取队列 |
| `max_in_flight_plaintext_files` | 1 | 最多一个整文件明文 buffer |
| `max_in_flight_ciphertext_files` | 1 | 最多一个尚未完成 put 的 file envelope |
| file object 发布总尝试 | 8 | 包含首次尝试，即最多 7 次 collision retry |
| Manifest object 发布总尝试 | 8 | 包含首次尝试，即最多 7 次 collision retry |

这组值只消除实现自由度，不凭文字关闭 DP-012。当前 codec 的 AES-GCM 是整文件操作，所以内存上界仍受单个最大文件影响；1 MiB chunk 不能被宣传成“单文件恒定内存”。Phase 4-A 必须用已知 size 预分配一次或等价的线性拷贝策略，禁止反复拼接导致 O(n²) 临时内存。

DP-012 在下列证据齐全前继续保持 `open`：小/大 representative fixture 的 schema-valid `perf-report-v1`、报告与 build/runtime-limits 的 hash binding、采样间隔不大于 100ms、两组 peak RSS 都不大于 512 MiB，且 large-small peak RSS 增量不大于 128 MiB。接受本 ADR 只能把这些值变成实现约束，不能把缺失的性能证据写成已完成。

## 6. 碰撞重试合同与旧计划措辞修正

ADR-0015 已冻结：create-if-absent 的权威碰撞点是 `ObjectStore.put` 的原子 hard-link 发布。当前端口没有 `exists` 或 reservation；即使先 `get`，也有跨进程 TOCTOU 竞态。因此 `P0_EXECUTION_PLAN.md` §8.4 中“碰撞必须在加密前检查”的字面要求不能作为实现合同。

开发者已确认接受；下列精确定义已取代 `P0_EXECUTION_PLAN.md` §8.4 的原句：

> 每个对象先用新 ID/key/nonce 完整 seal，再调用不可变 ObjectStore 的原子 put；只有 put 返回 `OBJECT_ID_COLLISION` 才整对象重新生成。不得覆盖、不得只换文件名、不得复用 key/nonce/ciphertext，且不得把其他 I/O 错误当碰撞重试。

碰撞总尝试达到 8 次仍未发布时，返回最后一次 `OBJECT_ID_COLLISION` 并使整个 snapshot 失败。失败路径不发布 Recovery File。`OBJECT_STORE_IO_FAILED`、`REPARSE_POINT_FOUND`、随机源失败和 codec 错误都不进入碰撞循环。

## 7. 日志与证据绑定

### 7.1 可持久化字段

强制日志使用一行一条 canonical JSON 的 `snapshot-log-v1` 语义。Phase 4-A 获批时才实现 schema。允许字段仅包括：

- schema/version、`run_id`、事件名、UTC 时间、阶段；
- 文件 ordinal、已完成文件数、总文件数、明文字节计数；
- canonical object ID / ObjectStore key、对象密文字节数；
- `snapshot_id`、`manifest_object_id`（均为非秘密随机标识）；
- 稳定公共错误码、collision attempt、runtime-limits 版本与 SHA-256；
- `published_object_count`、`orphan_object_count`。

### 7.2 永不持久化字段

禁止把下列内容写入强制日志、stdout、stderr、默认错误 message 或 evidence report：

- Vault 绝对/相对路径、目录名、文件名、扩展名、原始 `VaultScanError.paths`；
- 明文、内容片段、marker 实例、文件内容 hash、路径 hash；
- Recovery File 字节、recovery root、Domain Data Root、Manifest Key、Object Wrap Key、对象 key、nonce、wrapped key；
- provider/OS error 中可能携带路径或用户数据的原始 message/stack。

面向用户的本地 UI 如果未来需要显示涉事文件，必须作为单独的受信交互面设计，不能复用被 ACC-32/33 扫描的进程日志。当前 CLI 只输出稳定 code、run ID 和阶段，不打印 error 对象或路径数组。

### 7.3 正式 evidence 的外部绑定

snapshot pipeline 不在运行时自行宣称 ACC-32/33 通过。正式 P0-R1 harness 必须在创建进程退出后：

1. 保存完整 stdout/stderr 原始字节，不允许截断或 UTF-8 替换；
2. hash-bind build/lockfile、已接受 runtime-limits、日志字节、Recovery File、ObjectStore inventory、创建结果与扫描报告；
3. 向 ADR-0016 scanner 传入本次 run 的三族 marker 和全部可获得秘密角色；
4. 在 schema/hashes 全部验证后才形成 ACC evidence。

scanner 的 pass 只是一个 oracle 结果，不自动把 ACC 从 `untested` 改成 passed；ACC 状态更新仍需单独的 P0-R1 evidence gate。

## 8. Orphan 合同

1. P0 Directory ObjectStore 不提供 delete/list/GC；snapshot pipeline 绝不靠删除来回滚，也不扩展端口绕开 ADR-0015。
2. 在任一 file object 发布之后失败，先前成功发布的对象可能成为 orphan；如果 Manifest 已发布而 Recovery File 失败，Manifest 与其引用的 file objects 全部按 orphan 记录。
3. 本 run 的内存结果和安全日志只记录已经由本 run 成功 `put` 的 object IDs、数量和失败阶段。碰撞目标是旧对象，不属于本 run，也不能列入本 run orphan。
4. orphan 不影响已存在对象的不可变性；后续 snapshot 可以继续使用新随机 ID 创建。不得扫描内容、猜测所有权或自动删除“看起来无人引用”的对象。
5. GC、orphan 回收、保留策略、多 snapshot reachability 与 mutable head 全部超出 Phase 4-0/4-A，必须另行设计和授权。

Orphan 是失败后的诚实残留，不是 snapshot 完成证据。错误报告必须同时给出 `status=failed`、`recovery_file_created=false`（或 read-back 未确认）、已发布数量和可安全记录的 object ID；禁止因为对象均已成功写入就把失败降级成 warning。

## 9. 失败关闭与公共错误码提案

### 9.1 已有错误码的直接使用

| 场景 | 公共 code |
|---|---|
| source 在读取期间变化 | `FILE_CHANGED_DURING_SCAN` |
| unsupported/reparse/case/path 输入 | 复用已冻结的对应 scan code |
| random source 短读、失败、全零 | `RANDOM_SOURCE_*` 对应 code |
| file/Manifest codec 失败 | 对应已冻结 `OBJECT_*` / `MANIFEST_*` code |
| object ID 碰撞耗尽 | `OBJECT_ID_COLLISION` |
| ObjectStore 非碰撞 I/O | `OBJECT_STORE_IO_FAILED` |
| 强制日志 write/flush/close | `LOG_WRITE_FAILED` |

顶层不新增 `SNAPSHOT_INCOMPLETE`：结果的 `status=failed` 与原始稳定 code 已经表达失败，另加一个聚合码只会遮蔽原因。`INCOMPLETE_RESTORE` 只属于 restore，禁止借给创建流程使用。

### 9.2 两个缺口，已确认注册

现有 registry 曾没有准确覆盖以下两个边界；开发者已确认注册，两码已随本 ADR 接受补入 `p0-traceability-v1.json#error_codes`（机器 registry +2）：

| 拟议 code | 使用边界 |
|---|---|
| `SOURCE_FILE_READ_FAILED` | source 文件稳定性检查以外的 EACCES/EIO/短读/读取失败；不得错误归为文件变化 |
| `RECOVERY_FILE_WRITE_FAILED` | Recovery File 目标已存在、越界、独占创建/write/fsync/close/read-back 失败 |

两码已随接受提交加入冻结 registry；Phase 4-A 实现必须使用这两个稳定 code 并配齐测试，不得在实现时临时造码。任何未预期异常都要在编排边界收敛成一个已冻结 code 后返回非零；不得把原始含路径异常直接透传到日志。

## 10. 必须实现的测试边界（仅列合同，不在 Phase 4-0 执行）

Phase 4-A 若获批，至少应有以下自动化测试；这些测试通过也不自动改变 ACC 状态：

1. tiny Vault 正常创建：多个 file objects → Manifest → 最后 Recovery File，Fresh read-back 可严格解码；
2. 任一阶段失败都没有 success 返回，且 Recovery File 不在日志封口前创建；
3. unsupported/case/reparse 预检失败时 ObjectStore 零写入；
4. 稳定读取 mutation 返回 `FILE_CHANGED_DURING_SCAN`，先前对象按 orphan 报告；
5. file object 第 1..7 次 collision 后成功，每次 ID/key/nonce/ciphertext 全新；第 8 次 collision 整体失败；
6. Manifest collision 使用相同规则；非 collision I/O 不重试；
7. Recovery File 使用最初 recovery root，fresh process 能解开 Manifest；用第二份 root 的负例必须失败；
8. Recovery target 已存在或 read-back mismatch 时不覆盖，整体失败；
9. 日志 sink 在 open/write/flush/close 任一点失败均返回 `LOG_WRITE_FAILED`，且 Recovery File 未写；
10. 日志/stdout/stderr 不含路径、文件名、marker、秘密 raw/hex；ADR-0016 scanner 的正负注入路径都通过；
11. 全 Vault 不缓冲、无 plaintext prefetch、并发为 1、碰撞总尝试为 8；runtime-limits hash 不匹配时启动即失败；
12. plaintext、recovery root 与可控派生 key 的 best-effort 原位清零测试；
13. ObjectStore 已发布但失败的路径如实返回 orphan 清单，不调用不存在的 delete/list；
14. Windows Node 正式环境与后续真实 Windows/Android Obsidian 环境仍按现有证据规则分开，不用单元测试冒充环境证据。

## 11. 与 Phase 4-B、恢复、HTTP 和插件的隔离

- Phase 4-A 只允许创建 snapshot；不能实现 fresh-process restore、目标目录写入、atomic rename、restore journal 或 `INCOMPLETE_RESTORE` 流程。
- ObjectStore 仍是本地 Directory adapter；HTTP ObjectStore 被 DP-014 hard stop 阻挡。
- 不做 Obsidian plugin 命令、UI、Android binding 或真实 Vault 写回。
- 不引入 mutable latest/head、snapshot catalogue、GC、增量 snapshot 或跨 snapshot 去重。
- P0-R1 的 ACC 执行、状态修改、evidence 接纳与 release 判定都需要单独授权。

## 12. 确认记录与已完成的文档动作

开发者已于 2026-08-30 确认接受全部四项：

1. DP-012 拟议值：1 MiB read chunk、并发 1、预取队列 0、每类对象发布总尝试 8；
2. Recovery File 的 complete 定义：独占写、fsync/close、逐字节 read-back、函数成功返回与 exit 0，不宣称路径出现即原子提交；
3. 日志必须在 Recovery File 前 flush/close，成功后不再做会影响成败的持久化写入；
4. 注册 `SOURCE_FILE_READ_FAILED` 与 `RECOVERY_FILE_WRITE_FAILED` 两个公共码。

随接受提交完成的文档动作（不假装证据存在）：

- 本 ADR 状态改为已接受，runtime-limits 的 `contract_status` 改为 `accepted`；
- `p0-runtime-limits-v1` 已接入 `verify_phase0_contracts.py` 的 schema 与正反样例机器门；
- 精确修订 `P0_EXECUTION_PLAN.md` §8.4 的碰撞措辞（§6 的精确定义）；
- 两个新错误码已加入机器 registry（+2）；
- DP-012 在 registry 中保持 `open`，与已接受 limits 的绑定由 runtime-limits 文件的 `evidence_binding` 承载；
- ACC-01..37 全部维持现状，Phase 4-A/4-B 仍等待各自明确授权。

## 当前参数状态

`docs/contracts/p0-runtime-limits-v1.json#contract_status=accepted`，DP-012 仍为 `open`（关闭仍要求 §5 列出的性能证据）。本 ADR 没有产生实现文件、测试结果、性能报告或 ACC evidence；Phase 4-A/4-B 未获授权。
