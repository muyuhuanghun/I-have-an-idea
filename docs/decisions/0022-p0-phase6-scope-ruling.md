# ADR-0022：Phase 6-0 验收范围裁决

- 状态：已接受（2026-09-05 开发者确认全部三个确认点：接受 §17→R1 映射并关闭压力矩阵、Phase 6-A GUI 运行优先、GUI 自动化驱动 + artifacts/gui-test-vault 测试 Vault）
- 日期：2026-09-05
- 草案阶段：Phase 6-0
- 决策者：开发者
- 相关文档：执行计划 §17/§18/§23、ADR-0020（P0-R1 关闭）、ADR-0021（Phase 5 接线合同）、`docs/test-plans/p0-r1-closeout-report.md`、`docs/test-plans/phase5a-cli-report.md`、`docs/test-plans/phase5b-plugin-report.md`

## 1. 背景

Phase 5-A/5-B 已纳管并推送（`3489871`/`eb9a2db`/`10666cd`/`18c9b77`/`66354bd`，远端核对一致）。计划 §23 声明 push 完成后可进入 Phase 6。P0-R1 已于 `9443cb1` 关闭，本 ADR 裁决 §17"压力和破坏性验收"与已完成证据的关系，并确定 P0 剩余的真正开放项。

## 2. §17 压力/破坏性清单 → 正式证据映射

| §17 条目 | 正式证据（clean commit `9443cb1`） |
| --- | --- |
| 10,000 文件、约 1 GiB 完整往返 | ACC-26（12 份 perf report 支撑） |
| 错误恢复文件 | ACC-08 |
| 恢复文件截断 | ACC-09（+ACC-10 版本拒绝） |
| 对象缺失、重复、截断和篡改 | ACC-15（+ACC-14 AEAD 篡改） |
| Manifest 篡改 | ACC-16 |
| 扫描中文件变化 | ACC-23（`FILE_CHANGED_DURING_SCAN`，正式） |
| 扫描中文件消失 | 适配器 `SOURCE_FILE_READ_FAILED` 语义（Node/Obsidian 双适配器实现 + 单元测试）；失败诚实收敛由 ACC-25 不变量覆盖 |
| 非空目标 | ACC-18 |
| 路径逃逸和大小写碰撞 | ACC-19 / ACC-21 |
| Symlink/Junction | ACC-20（5-A/5-B 又分别修复了别名包含绕过并加测） |
| 写入中断和模拟磁盘不足 | ACC-25（`RESTORE_TARGET_WRITE_FAILED` 收敛） |
| 日志写入失败 | ACC-34 |
| 未支持文件 | ACC-24 |
| 服务器明文标记扫描 | ACC-32/33 |
| 源 Vault 零修改 | ACC-22（5-A/5-B 以互斥物理身份检查延续该不变量） |
| 峰值 RSS 和处理耗时 | ACC-29/30/31 + 12 份 perf report |

## 3. 裁决内容（待确认）

1. **Phase 6 压力矩阵不另开重跑**：§17 全部条目已由 R1 正式证据覆盖（§2 映射），且执行计划 §17 本身要求"P0-R1 关闭报告区分已通过/失败/未测试/已知限制/移出范围"——该区分已由 ADR-0020 关闭报告完成。Phase 6 的"至少测试"清单裁决为已满足，不重复消耗 1 GiB × 12 轮机器时间。
2. **真正开放的 P0 验收残留只有一项**：真实 Obsidian GUI 运行证据（5-B 报告 §3 明确声明 dirty-source 测试不能替代）。提议为 **Phase 6-A**：从 clean commit `66354bd` 构建插件产物 → 在专用测试 Vault（位于本仓库 `artifacts/` 之外或之内由开发者指定，**绝不触碰 `D:\Obsidian\muyu_note`**）加载插件 → 开发者或经开发者逐项授权的 GUI 自动化执行"Create P0 snapshot" → 导出 `p0-plugin-snapshot-report-v1` 机器报告与产物哈希 → 记录 `docs/test-plans/phase6a-gui-report.md`。GUI 运行不升级任何 ACC，只补齐 Phase 5 的真实 UI 验收面。
3. **Stage 7（HTTP ObjectStore，DP-014）**：§18 的前置条件"P0-R1 关闭后才开始"已满足，但 DP-014 的 hard_stop 仍要求另立合同裁决。Phase 7-0 合同（localhost HTTP 边界、威胁模型 delta、ACC 扩展）在 Phase 6-A 纳管后另行起草，本 ADR 不解锁 DP-014。

## 4. 确认点裁决记录（2026-09-05，开发者确认）

1. **§17 映射裁决**：采纳——接受 §2 映射，Phase 6 压力/破坏性矩阵以 `9443cb1` 的 R1 正式证据关闭，不重跑。
2. **下一实现切片**：采纳——Phase 6-A 真实 Obsidian GUI 运行证据优先；Phase 7-0（HTTP ObjectStore）合同在 6-A 纳管后起草。
3. **GUI 运行方式**：采纳——GUI 自动化驱动，测试 Vault 由自动化在 `artifacts/gui-test-vault/` 新建（绝不使用 `D:\Obsidian\muyu_note`），开发者全程可中断，产物与报告由机器校验。

## 5. 后果与边界

- 本 ADR 不升级任何 ACC、不产生新的 formal evidence；GUI 运行证据属于 Phase 5-A/5-B 接线的验收补充，归属 Phase 5 报告链。
- 接受后机器状态新增 wire token `PHASE_6_0_SCOPE_RULING_ACCEPTED`（consistency-check §13）；DP 状态零变化；DP-014 保持 `deferred`。
- 若开发者选择全新重跑（确认点 1 备选），则须先冻结重跑矩阵与机器时间预算，另出合同。
