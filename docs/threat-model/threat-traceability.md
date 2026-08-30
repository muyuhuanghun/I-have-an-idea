# P0 威胁、不变式、验收与机器 Oracle 追踪

> 文档版本：v1.0
> 当前状态：37 ACC / 16 INV / 5 THR 的设计追踪已机器闭合；全部 ACC 仍为 `untested`
> 日期：2026-08-27
> 机器权威：`docs/contracts/p0-traceability-v1.json`
> 验证器：`python tools/verify_phase0_contracts.py`

## 1. 职责

本文件解释追踪规则。ID、双向链接、错误码、证据路径和每条 ACC 的 required check 以机器 registry 为准。Markdown 摘要不能覆盖 registry。

“机器追踪已闭合”只表示设计合同可静态检查，不表示测试已执行。默认验证器明确以 `design-only` 模式运行，不会升级任何 ACC；只有未来提供 37 份 schema-valid evidence 并执行 `--evidence-root`，才会逐项评估运行证据。

## 2. 稳定 ID 合同

- 威胁：`THR-01` 至 `THR-05`，恰好 5 个；
- 安全不变式：`INV-01` 至 `INV-16`，恰好 16 个；
- 验收：`ACC-01` 至 `ACC-37`，恰好 37 个；
- 延期参数：`DP-001` 至 `DP-026`；
- 既有 ID 不重编号、不复用。废止项保留 ID 并标记 disposition；新增项只能追加并提升 registry schema version。

旧文档中曾出现的 `INV-1` 至 `INV-9` 是同一不变式的历史非 canonical 拼写；当前引用一律使用零填充形式。

## 3. 追踪语义

并非每条 ACC 都来自攻击者。例如构建门禁、报告格式和性能治理属于架构/质量要求。为避免制造假的威胁关系，registry 按以下规则检查：

- 安全 ACC：关联实际适用的 THR/INV；
- 只来自不变式但没有直接攻击者的 ACC：允许 THR 为空，但 INV 必须存在；
- 架构、性能、报告或可重复性 ACC：若 THR/INV 都为空，必须提供 `nonsecurity_reason`；
- 每个 INV 必须至少被一个 ACC 覆盖，且 INV→ACC 和 ACC→INV 必须双向一致；
- 每个 THR 必须有明确 disposition 和 threat-level oracle。范围外/延期威胁不伪装成已缓解。

## 4. THR 当前处置

| THR | 当前处置 | P0-R1 oracle |
|---|---|---|
| THR-01 | P0-R1 内缓解 | ACC-12/13/32/33 全部有 passed evidence |
| THR-02 | 延期到 Stage 7 HTTP | P0-R1 明确标为 out-of-scope；Stage 7 必须先关闭 DP-014 |
| THR-03 | P0-R1 内缓解 | registry 列出的破坏性/失败关闭 ACC 全部有 passed evidence |
| THR-04 | 接受限制 | ACC-37 证明关闭报告明确“不提供 freshness/反回滚” |
| THR-05 | 明确范围外 | ACC-37 证明恶意终端、内存转储和未审计供应链未被宣称为已缓解 |

## 5. ACC 机器 Oracle

每条 ACC 在 registry 中固定以下字段：

- `evidence_path`：唯一证据路径；
- `required_checks`：该报告必须逐项给出 `expected`、`actual`、`passed=true`；
- `required_error_code_groups`：每组至少观察到一个允许的稳定错误码；
- `forbidden_side_effects`：对应标志必须显式为 `false`，缺字段不按 false 处理；
- `status`：提交到 Git 的设计 registry 固定为 `untested`。

所有 ACC evidence 必须满足 `docs/schemas/acc-evidence-v1.schema.json`。缺字段、额外字段、错误类型、缺 required check、缺 error code、缺 side-effect flag 或 `status != passed` 都失败关闭。不得用日志文本、截图或人工口头说明替代 JSON evidence。

未来运行证据的命令：

```powershell
python tools/verify_phase0_contracts.py --evidence-root artifacts
```

只有这条命令在 37 份报告齐备时返回 0，才表示 registry 的 ACC evidence oracle 全通过。它仍不等于独立安全审计。

## 6. 规范错误码

错误码唯一权威是 registry 的 `error_codes` 数组。当前包含恢复文件、Manifest、对象、路径、扫描、系统和报告 schema 错误。重要新增边界包括：

- 固定长度/非法格式/尾随字节：`RECOVERY_TRAILING_BYTES`、`MANIFEST_FORMAT_INVALID`、`MANIFEST_TRAILING_BYTES`、`OBJECT_TRAILING_BYTES`；
- object ID canonicalization：`OBJECT_ID_INVALID`；
- 对象截断和重复引用：`OBJECT_TRUNCATED`、`DUPLICATE_OBJECT_REFERENCE`；
- 恢复目标写入失败：`RESTORE_TARGET_WRITE_FAILED`（`INCOMPLETE_RESTORE` 继续保留给未来 journal/续传设计）；
- 报告缺项：`REPORT_SCHEMA_INVALID`；
- 越界声明：`HONEST_CLAIM_VIOLATION`。

实现不得自行创造错误字符串替代这些码。新增错误码必须同时更新 registry、相关 ACC oracle 和实现测试。

## 7. 静态完整性检查

默认命令检查：

1. 5/16/37/24 个 ID 连续、唯一、顺序稳定；
2. THR/INV/ACC 双向链接一致；
3. 37 个证据路径唯一，37 个 ACC 状态仍为 `untested`；
4. required checks、错误码和 side-effect flags 都引用合法 registry 值；
5. 验收矩阵恰有 ACC-01..37 标题和 37 个 `untested`；
6. wire contract 的 recovery offsets、167 字节总长、101 字节 AAD、16 字节 object ID 和 HKDF 标签不漂移；
7. 26 个延期项逐项具有 owner、阶段、关闭产物和硬停止条件；
8. 5 份 JSON Schema 顶层 required 和拒绝未知字段规则存在，并且 schema 只使用本验证器已强制实现的 draft 2020-12 关键字子集。

成功输出：

```text
PHASE0_CONTRACT_CHECK_PASS mode=design-only ACC=37 INV=16 THR=5 DP=26
P0_R1 remains NOT_IMPLEMENTED / NOT_TESTED; no ACC status was upgraded.
```

反身校验命令：

```text
PHASE0_CONTRACT_CHECK_PASS mode=design-only+samples ACC=37 INV=16 THR=5 DP=26
```

`tools/schema-samples/` 下为每份 schema 各放一对正/负样本；正样本必须被接受，负样本必须被拒，证明 schema 强制路径在 work。

未来 P0-R1 evidence gate 是：

```powershell
python tools/verify_phase0_contracts.py --evidence-root artifacts
```

`validate_evidence` 在加载每份 evidence 后用 `acc-evidence-v1` 真校验：缺字段、未知字段、错误类型、enum/pattern/format/uniqueItems/contains 违反都会立即被拒；`artifacts[].path` 必须位于 `evidence-root` 之下、文件存在、`sha256` 与文件实际内容匹配。

这段输出是文档合同静态门禁证据，不是 P0-R1 运行验收证据。
