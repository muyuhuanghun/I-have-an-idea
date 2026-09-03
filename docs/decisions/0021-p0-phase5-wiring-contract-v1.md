# ADR-0021：Phase 5-0 CLI/极薄 Obsidian 插件接线合同 v1

- 状态：已接受（2026-09-02 开发者确认全部四个确认点：5-A CLI 先行/5-B 插件后行、端口拦截 core 零改动、新增报告 schema + 机器门、全部显式路径无默认）
- 日期：2026-09-02
- 草案阶段：Phase 5-0
- 决策者：开发者
- 相关文档：执行计划 §16、ADR-0017（snapshot 编排）、ADR-0018（restore 编排）、ADR-0019（runtime-limits）、ADR-0020（P0-R1 关闭）、`packages/core/src/ports.ts`、`packages/adapters/src/`、`docs/test-plans/post-684af1e-audit-report.md` F4

## 1. 背景与边界

P0-R1 已关闭（ADR-0020），执行计划 §23 指定的下一授权门槛为 Phase 5-0 合同冻结。前次 Phase 5 提交 `841c26e` 因四类问题被复审否决并从工作树移除：导入不存在的模块、伪造 runtime-limits hash（用 crypto vector manifest 的 hash 冒充）、向源 Vault 写入 `p0-domain-id.hex`、越界加入插件 restore 命令。本合同把这些失败逐一转化为冻结规则；实现（Phase 5-A/5-B）须另行授权，未获授权不得开工。

## 2. 冻结规则（§16 的直接展开）

1. **插件只做快照创建**：调用共享核心 `createSnapshotV1`（经 `@ekd/core`），展示 §16 要求的扫描/持有性/加密进度、文件数、原始/密文字节与服务器可见性摘要，并导出测试报告。插件**不得**实现任何 restore 命令、restore UI 或恢复编排入口；正式 fresh-process 恢复只能由 CLI 承担。
2. **禁止实现复制**：插件不得内联任何 HKDF/AEAD/Manifest/object-ID 实现；只允许经 `@ekd/core` 与 `@ekd/adapters` 的既有导出（`ObsidianVaultSource`、Node 目标适配器等）。密码提供方固定为 `@ekd/crypto/webcrypto`（ADR-0013 Suite 1）。
3. **源 Vault 零写入**：插件在快照运行期间对源 Vault 零写入——不写 domain-id 文件、不写缓存、不写任何 marker。domainId 由插件设置页提供（64 位 hex，经 Obsidian settings 持久化）；snapshot log、ObjectStore 目录、Recovery File 目标全部是用户显式配置的 Vault 外路径。运行前适配器必须校验三者不在 Vault 内。
4. **runtime-limits 绑定为真**：`runtimeLimits.sha256Hex` 必须是对 `docs/contracts/p0-runtime-limits-v1.json` 实际文件字节计算的 SHA-256（禁止任何其他文件冒充）；随代码内置副本与磁盘文件双侧校验，不一致即拒绝运行。
5. **进度模型（core 零改动）**：不给 core 增加 progress 端口。进度由端口拦截派生——`VaultSource` 迭代计数给出扫描进度；`SnapshotLogSink` 行拦截 `file_published` 事件的 `file_ordinal/file_count/plaintext_bytes_total` 给出加密进度；`RecoveryFileTarget.writeExclusiveAndReadBack` 完成即持有性完成。
6. **密文字节与可见性摘要**：密文字节由计数型 ObjectStore 装饰器在适配器侧累计（`put()` 字节数求和），不改 core、不回读对象。可见性摘要为最小 JSON：对象数、密文字节总数、对象键不含明文路径的断言、runtime-limits hash 绑定；插件摘要**不是** ACC-32/33 的正式可见性证据，报告中必须带此免责标注。
7. **测试报告导出**：新增第 10 份机器 schema `p0-plugin-snapshot-report-v1`（含 run_id、snapshot_id_hex、domain_id 的 SHA-256（非明文）、runtime_limits_sha256、file_count、total_plaintext_bytes、total_ciphertext_bytes、visibility_summary、snapshot-log sha256 绑定、时间戳与 verdict），配正/负样本接入 `--validate-samples`；实现切片交付时一并落地 schema + 样本 + 验证器接线与计数文档更新（9 对→10 对）。
8. **CLI 正式恢复路径**：CLI 新增 `restore` 命令，恢复在**新进程**中执行（CLI 以自身为入口再派生子进程，或等价的 fresh-process 边界）；目标目录必须不存在或为空，CLI 拒绝非空已存在路径并负责新建空目录与失败时的临时状态清理（INV-08 语义不变，ADR-0018 §3.1 的 caller-creates-empty 规则由 CLI 命令代表调用者履行）。CLI 同时新增 `snapshot` 命令（进程内调用 `createSnapshotV1`，参数与插件一致）。
9. **构建与门禁**：插件与 CLI 声明并构建全部依赖（`@ekd/core`、`@ekd/adapters`、`@ekd/crypto`）；`pnpm run test:all`（lint/typecheck/test/verifier/build）必须通过；shared-core import gate 继续禁止 core 引入 Node/Electron/Obsidian 依赖。

## 3. 确认点裁决记录（2026-09-02，开发者确认）

1. **切片划分**：采纳建议——5-A = CLI 接线（snapshot + fresh-process restore），5-B = 插件薄 UI（快照 + 进度 + 摘要 + 报告导出），各自单独授权、各自 feat+docs 对提交。
2. **进度与摘要模型**：采纳建议——端口拦截 + 计数装饰器 + 最小可见性摘要，core 零改动，不修订 ADR-0017。
3. **测试报告 schema**：采纳建议——新增第 10 份 schema `p0-plugin-snapshot-report-v1` 并接入 `--validate-samples` 机器门（样本 9 对→10 对）。
4. **路径策略**：采纳建议——log/store/recovery 全部显式路径、不提供任何默认值；domainId 仅来自设置页 64-hex，绝不写入源 Vault；CLI restore 拒绝非空目标并新建空目录。

## 4. 后果与边界

- 本合同接受后，机器状态新增 wire token `PHASE_5_0_WIRING_CONTRACT_ACCEPTED`（consistency-check §13 记录）；无错误码新增、无 DP 状态变化、无 ACC 状态变化。
- 实现切片（5-A/5-B）交付时各自绑定 clean commit、各自出测试报告（`docs/test-plans/phase5a-cli-report.md`、`phase5b-plugin-report.md`），并复跑统一门禁。
- 插件快照产生的 artifacts 仍属 git 忽略的运行时产物；它们不升级任何 ACC（37 个 ACC 的 P0-R1 证据已按 ADR-0020 关闭，不受本阶段影响）。
- DP-014（HTTP ObjectStore）继续被 hard_stop 阻止；本合同的 ObjectStore 边界仍是 Directory ObjectStore v1。
