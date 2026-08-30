# ADR-0018：P0 Fresh-Process 恢复流水线 v1 合同

- 状态：已接受（2026-08-30 开发者确认全部四个合同点；Phase 4-B-A 已获授权）
- 日期：2026-08-30
- 草案阶段：Phase 4-B-0
- 决策者：开发者
- 相关文档：ADR-0009、ADR-0011、ADR-0012、ADR-0015、ADR-0016、ADR-0017、`P0-recovery-and-object-format.md`、`P0_EXECUTION_PLAN.md` §15、`docs/threat-model/P0-security-invariants.md`（INV-07/INV-08/INV-13/INV-14）、`docs/test-plans/P0-acceptance-matrix.md`（ACC-18/19/20/21/25）

> 本 ADR 已由开发者于 2026-08-30 确认接受。它不修改任何 ACC 状态，不关闭任何 DP，也不进入 HTTP ObjectStore 或插件接线；随接受完成的文档动作见 §9。

## 1. 背景与本阶段边界

Phase 4-A 已实现 snapshot 创建编排并由提交 `fbdf325` 纳管；执行计划 §15 冻结了 fresh-process 恢复的验收口径，INV-07/08/13/14 冻结了恢复侧不变式。恢复编排本身尚未存在。

Phase 4-B-0 只回答下面六个合同问题：

1. 恢复编排的输入、输出与成功点；
2. §15 六条拒绝规则到稳定错误码的精确映射；
3. 目标目录语义与失败后的诚实残留（INV-08/INV-13）；
4. `INCOMPLETE_RESTORE` 码在 v1 中的处置；
5. fresh-process 集成测试与独立 Python 验证器的形态与边界；
6. 恢复侧测试清单（4-B-A 若获批执行）。

本草案不实现任何端口、CLI、schema、测试或运行代码；不设计增量恢复、snapshot 链、GC 或并发恢复。

## 2. 术语与唯一成功定义

- **restore run**：一次恢复尝试。恢复编排无 `run_id`、无强制日志——恢复不产生 ACC-32/33 所扫描的进程日志面，证据由结果对象与外部 Python 验证器承担。
- **complete**：Recovery File 严格解码通过，Manifest 取出、解码并通过全部校验，目标目录确认为新建空目录，全部 Manifest 条目按 canonical 顺序解密并写出，恢复函数成功返回。缺任一条件即 `failed`。
- **incomplete 残留**：写入开始后失败的运行会在目标目录留下已写出的部分文件。这是诚实残留：恢复器不删除、不回滚已写文件，结果对象以 `restoredFileCount` 如实报告；重试的前提是调用方先清空目标（INV-08 在任何写入前强制校验空目录）。
- 逐文件不做 read-back、不做 fsync：恢复目录是普通目录拷贝，完整性与一致性由外部 Python 验证器独立承担（§5）；这与 Recovery File（恢复信任根，必须 fsync + read-back）的语义不同，不得混同。

## 3. 恢复编排的输入与输出

### 3.1 输入（全部显式注入）

| 输入 | 合同 |
|---|---|
| Recovery File 字节 | 调用方读取并传入恰好 167 字节；恢复编排不做文件 I/O |
| `ObjectStore` | ADR-0015 不可变端口，只调用 `get`；永不调用 `put`，恢复对存储零写入（ACC-22 对偶） |
| `RestoreTarget`（新端口） | 目标目录写入边界，见 §3.2 |
| `CryptoProvider` | 解密与 HKDF 派生；恢复不需要 `RandomSource`——解密路径无任何随机量 |

domain ID 不作为输入：它只能来自 Recovery File 严格解码，调用方无权注入身份。

### 3.2 新端口：`RestoreTarget`

```text
verifyEmptyTarget(): Promise<void>
  目标必须存在、是真实目录、非重解析点、且没有任何条目（INV-08）；
  违反 → NON_EMPTY_TARGET / REPARSE_POINT_FOUND。
writeRestoredFile(relativePath, bytes): Promise<void>
  relativePath 必须通过共享核心 canonical 校验（防御纵深，正常流程由 Manifest 解码保证）；
  按需创建父目录并写出字节；任何失败向上传播。
```

路径 containment：canonical 相对路径在构造上不含 `\0`、`\`、前导 `/`、盘符、空段/`.`/`..`/冒号段（`paths.ts` 冻结），target join 后逃逸不可能；合成 Manifest 的 `../` 条目在 Manifest 解码即被 `ENTRY_PATH_ESCAPE` 拒绝（ACC-19）。

### 3.3 输出：`RestoreResultV1`

- `status`: `complete` 或 `failed`；
- `recoveryFileValid`（严格解码是否通过，失败时也为 false 但解码错误码优先）；
- `manifestEntryCount`、`restoredFileCount`、`totalBytesWritten`；
- 失败时的稳定 `error_code` 与 `failedPhase`（`validate_recovery` / `fetch_manifest` / `validate_target` / `write_files`）；
- 禁止返回或记录：明文、原始路径、密钥材料、nonce、OS/provider 原始错误消息。

## 4. 恢复顺序与拒绝规则映射

严格按下列顺序；除循环内逐文件处理外不允许调换。

1. **validate_recovery**：`decodeRecoveryFileV1` 严格解码（167 字节、magic、version、suite、HMAC）。任何失败按既有码返回（`RECOVERY_TRUNCATED` / `RECOVERY_TRAILING_BYTES` / `RECOVERY_MAGIC_MISMATCH` / `RECOVERY_VERSION_UNSUPPORTED` / `RECOVERY_SUITE_UNKNOWN` / `RECOVERY_INTEGRITY_FAILED`）。
2. **fetch_manifest**：`get(encodeObjectStoreKeyV1(manifestObjectId))`；缺席 → `MISSING_OBJECT`（恢复层协议违反码在此首次使用）；`openManifestObjectV1` 校验上下文与 AEAD（`OBJECT_AEAD_FAILED` / `MANIFEST_*`）。
3. **Manifest 全量校验（任何写入之前）**：解码器已拒绝非 canonical 路径（`ENTRY_PATH_ESCAPE`）、重复路径（`ENTRY_PATH_DUPLICATE`）、重复 object ID（`DUPLICATE_OBJECT_REFERENCE`）；本编排新增 ASCII 大小写折叠碰撞检查 → `CASE_COLLISION`（ACC-21）；父 snapshot ID 必须全零（`MANIFEST_FORMAT_INVALID`）。
4. **validate_target**：`verifyEmptyTarget()`（`NON_EMPTY_TARGET` / `REPARSE_POINT_FOUND`，INV-08：任何写入前拒绝）。
5. **write_files**：按 Manifest canonical 顺序逐条：`get(objectKey)`（缺席 → `MISSING_OBJECT`）；`openFileObjectV1`（`OBJECT_AEAD_FAILED` / `ENTRY_SIZE_MISMATCH` / `OBJECT_TRUNCATED` / `OBJECT_TRAILING_BYTES`）；`writeRestoredFile`；明文 buffer 在 `finally` 中原位清零。任何失败即 `failed`，已写文件保留（§2），`restoredFileCount` 如实报告（INV-13：部分写入永不报告为完整成功，ACC-25）。

对象截断/篡改由 AEAD 认证失败或 envelope 结构校验拒绝（`OBJECT_TRUNCATED` / `OBJECT_TRAILING_BYTES` / `OBJECT_AEAD_FAILED`）；错误恢复文件由第 1 步拒绝；派生密钥全程来自 Recovery File 内的 recovery root，使用的 root 与创建侧一致这一事实由 HMAC 与 AEAD 认证闭合（错误 root 解不出 Manifest）。

## 5. fresh-process 集成测试与独立 Python 验证器

### 5.1 进程编排

§15 流程以真实多进程执行：进程 A（snapshot worker）创建快照并退出 → 进程 B（restore worker）仅以 Recovery File 路径、ObjectStore 根、目标根三个路径参数启动 → 恢复到新建空目录。两个 worker 是构建产物之上的薄 CLI（与 `storage-visibility-scan.mjs` 同惯例，`pnpm build` 后可用），P0 无本地状态可删，"删除 P0 本地工作状态"由进程边界本身体现：进程 B 的全部输入仅为三个路径。

### 5.2 独立 Python 验证器（纯 stdlib）

`tools/verify_restore.py`：递归比较源 Vault 目录与恢复目录——路径集合逐项相等、逐文件字节相等（`--source` / `--restored`），并可选对 Recovery File 做结构 + HMAC 校验（`--recovery`；HKDF-SHA256 与 HMAC-SHA256 均为 stdlib `hmac`/`hashlib` 可表达）。**非声明**：验证器不解密任何对象（Python 标准库无 AES-GCM），独立解密比对不属于本合同；密文侧正确性由 AEAD 认证与 TS 侧测试承担。退出码 0=一致，1=不一致，2=用法错误。

### 5.3 测试落位

vitest 单元/集成测试直接测编排（fake 端口注入）；fresh-process 集成以 worker 子进程 + Python 验证器实现为可独立运行的 harness（构建后可执行），作为未来 P0-R1 正式证据的执行载体；是否并入 `pnpm run test:all` 门禁在 4-B-A 获批时单独决定（涉及构建顺序）。

## 6. `INCOMPLETE_RESTORE` 码的处置（已确认：v1 不使用）

registry 既有 `INCOMPLETE_RESTORE`，但在既有文档中没有使用定义（ADR-0017 §11 明确推迟"restore journal 或 INCOMPLETE_RESTORE 流程"）。本草案提议：**v1 不使用该码**。写入开始后的失败返回具体稳定原因码（`OBJECT_AEAD_FAILED` / `MISSING_OBJECT` / `OBJECT_STORE_IO_FAILED` 等），"不完整"这一事实由 `status=failed` + `restoredFileCount > 0` 机器可读表达（满足 INV-13 的"稳定错误码 + 部分输出清单"）。该码保留给未来恢复日志/续传设计，registry 不动。替代方案（写入期失败一律改报 `INCOMPLETE_RESTORE`、具体原因降级为次要字段）会导致原因丢失，不建议。

## 7. 拒绝规则 → 验收锚点对照

| §15 拒绝规则 | 稳定码 | 验收 |
|---|---|---|
| 非空目标目录 | `NON_EMPTY_TARGET` | ACC-18 |
| 路径逃逸 | `ENTRY_PATH_ESCAPE` | ACC-19 |
| 大小写折叠碰撞 | `CASE_COLLISION` | ACC-21 |
| 缺失对象 | `MISSING_OBJECT` | §15 负面 |
| 截断/篡改/尾随对象 | `OBJECT_TRUNCATED` / `OBJECT_TRAILING_BYTES` / `OBJECT_AEAD_FAILED` | §15 负面 |
| 错误恢复文件 | `RECOVERY_MAGIC_MISMATCH` / `RECOVERY_INTEGRITY_FAILED` 等 | §15 负面 |
| 不支持版本 | `RECOVERY_VERSION_UNSUPPORTED` | §15 负面 |
| 部分写入不报成功 | 状态 + `restoredFileCount` | ACC-25 / INV-13 |
| 重解析点 | `REPARSE_POINT_FOUND` | ACC-20 / INV-07 |

预计不需要新增任何错误码。

## 8. 恢复侧测试清单（4-B-A 若获批执行）

1. tiny 快照恢复：源↔恢复路径集合与字节逐项一致（Python 验证器验证）；
2. 非空目标在任何写入前拒绝（目标内 dummy 文件保留原样）；
3. 合成 `../` Manifest 条目在解码被拒，目标零写入；
4. 合成大小写碰撞 Manifest 在写入前被拒（`CASE_COLLISION`）；
5. 缺失对象 → `MISSING_OBJECT`，已写文件如实计数，不报成功；
6. 截断/篡改对象 → AEAD/结构码，部分写入如实报告；
7. 错误 recovery file / 不支持版本 → 对应 `RECOVERY_*` 码，零写入；
8. 恢复对 ObjectStore 零写入（fake store 记录 put 调用为 0）；
9. 写入期明文与派生密钥 best-effort 清零；结果对象无路径/明文/密钥；
10. fresh-process harness：进程 B 仅凭三个路径参数完成恢复，Python 验证器 PASS；
11. 磁盘满/写失败 → `failed` + 已写计数，不报完整成功（ACC-25 形态）；
12. Windows 正式环境与后续真实环境证据仍按既有证据规则分开。

## 9. 确认记录与已完成的文档动作

开发者已于 2026-08-30 确认接受全部四项：

1. 目标目录语义：调用方预建空目录，恢复器在任何写入前校验空/真实目录/非重解析点（INV-08）；失败残留保留在目标目录，`restoredFileCount` 如实报告，重试前须清空目标；
2. 逐文件不做 read-back、不做 fsync：独立完整性由 Python 验证器（源↔恢复逐字节对比）承担；
3. `INCOMPLETE_RESTORE` 在 v1 不使用，失败返回具体原因码 + `restoredFileCount`；
4. fresh-process harness 与 Python 验证器按 §5 形态实现为构建后可独立运行的工具，是否并入 `pnpm run test:all` 在 4-B-A 获批时单独决定。

随接受提交完成的文档动作（不假装证据存在）：

- 本 ADR 状态改为已接受；
- 拒绝规则映射与 Python 验证器范围按 §5/§7 冻结，无改动；
- registry 零变化（§7）；ACC-01..37 全部维持现状；
- Phase 4-B-A 已由开发者同日授权，实现结果与测试以 4-B-A 复审报告为准；P0-R1 证据门仍等待明确授权。

## 当前参数状态

`docs/contracts/p0-runtime-limits-v1` 不适用于恢复侧（解密路径无随机量、并发为 1 由顺序遍历结构保证）。本 ADR 没有产生实现文件、测试结果或 ACC evidence 之外的状态变化；Phase 4-B-A 实现由开发者同日授权。
