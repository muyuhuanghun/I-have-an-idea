# ADR-0027：P1-alpha 状态协议验收完成与 DP-015 关闭

- 状态：已接受（2026-09-05 开发者授权 P1-alpha-B 正式证据与 DP-015 收尾）
- 日期：2026-09-05
- 草案阶段：P1-alpha-B
- 决策者：开发者
- 相关文档：ADR-0026（P1-alpha-0 状态协议合同）、`docs/contracts/p0-deferred-parameters.json`（DP-015）、`docs/contracts/p0-traceability-v1.json`（INV-17/18、ACC-41/42/43）、`docs/test-plans/p1-alpha-a-state-protocol-report.md`、`docs/test-plans/p0-r1-closeout-report.md`

## 1. 决策内容

1. **正式证据成立**。`tools/acc-p1-evidence-run.mjs` 在 clean commit `bbb5a7e0f46b4f1506eb32374bf041b7cd288296` 上生成三份 `acc-evidence-v1`（`P1_EVIDENCE_RUN_DONE 3 reports`），全部通过 oracle 校验——
   - ACC-41（INV-17）：双链 head 对象发布、指针签名/head 签名/设备注册/sequence 单调全部验证通过；
   - ACC-42（INV-18）：sequence 回退（`HEAD_ROLLBACK_DETECTED`）、篡改指针与篡改 head（`HEAD_SIGNATURE_INVALID`）、未注册设备（`HEAD_DEVICE_UNREGISTERED`）全部拒绝；
   - ACC-43（INV-18）：同序号分叉（`HEAD_FORK_DETECTED`）携带完整证据（incumbent/challenger 两个 head 对象键），被拒分叉后指针仍解析到既有已验证 head。
2. **registry/矩阵翻转**。ACC-41/42/43 翻转为 `passed`（`evidence_scope: "p1-alpha"` 保留），验收矩阵同步；`p0-traceability-v1.json` 43/43 passed、18/18 INV。
3. **机器门三重绑定生效**。证据门按 `evidence_scope` 路由：37 份 R1 evidence 绑定 `R1_EVIDENCE_CLOSED_AT_COMMIT`（`9443cb1`）、3 份 stage-7 绑定 `S7_EVIDENCE_CLOSED_AT_COMMIT`（`cd09994`）、3 份 p1-alpha 绑定本 ADR 的 `P1_ALPHA_EVIDENCE_CLOSED_AT_COMMIT`（`bbb5a7e`）；设计门在全部 passed 时要求三行同时存在。
4. **DP-015 关闭**。state-protocol ADR（ADR-0026）+ threat/invariant/ACC delta（INV-17/18 + ACC-41/42/43）+ 本 closeout 齐备，hard_stop 解除：latest pointer、状态连续性、反回滚与设备签名的宣称自本 ADR 起必须有 head 链证据支撑。

## 2. 边界

- head 目录（指针/设备注册/history journal）是唯一可变状态，其完整性依赖所在环境的访问控制；`devices.json` 自身未签名（ADR-0026 已知限制，多设备注册治理属后续合同）。
- CLI/插件当前不在快照流程中自动发布 head；head 发布是显式操作。自动发布与多设备治理属后续 P1 阶段合同。
- 不承诺跨设备并发写一致性（分叉显式检测）；ACC-32/33 与 ACC-39 的存储可见性证据不外推到本协议。

P1_ALPHA_EVIDENCE_CLOSED_AT_COMMIT: bbb5a7e0f46b4f1506eb32374bf041b7cd288296
