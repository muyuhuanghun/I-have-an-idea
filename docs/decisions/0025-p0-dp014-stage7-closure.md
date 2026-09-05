# ADR-0025：DP-014 关闭与 Stage 7 验收完成

- 状态：已接受（2026-09-05 开发者授权 Phase 7-B 正式证据与 DP-014 收尾）
- 日期：2026-09-05
- 草案阶段：Phase 7-B
- 决策者：开发者
- 相关文档：ADR-0015、ADR-0020、ADR-0022、ADR-0024、`docs/contracts/p0-deferred-parameters.json`（DP-014）、`docs/schemas/s7-http-session-v1.schema.json`、`docs/test-plans/phase7a-http-object-store-report.md`、`docs/test-plans/p0-r1-closeout-report.md`

## 1. 决策内容

1. **DP-014 关闭**。其冻结 close_artifact 三要素全部落地：HTTP 威胁模型 delta（ADR-0024 §2.4——网络观察者仅见不透明对象键/大小/时序/数量，明文/路径/domainId/token 不可见）、THR-02 ACC 扩展（registry 37→40：ACC-38/39/40 挂靠 THR-02）、抓包/日志 evidence schema（`s7-http-session-v1` 第 11 份机器 schema，token 字段强制脱敏）。
2. **正式证据成立**。`tools/acc-s7-evidence-run.mjs` 在 clean commit `cd0999465022cafc6094153db84471abe1119315` 上生成三份 `acc-evidence-v1`（`S7_EVIDENCE_RUN_DONE 3 reports`），全部通过 oracle 校验——
   - ACC-38：Directory 后端快照 → localhost HTTP store 恢复逐字节一致，core 零改动；
   - ACC-39：会话捕获与服务器日志经 `s7-http-session-v1` schema 校验，无明文/路径/domainId/token，对象键全部规范 base64url；
   - ACC-40：重复 PUT 幂等、异内容 409、缺失→`MISSING_OBJECT`、超时/断线收敛 `OBJECT_STORE_IO_FAILED`、无部分写入伪成功。
3. **registry/矩阵翻转**。ACC-38/39/40 翻转为 `passed`（`evidence_scope: "stage-7"` 保留），验收矩阵同步；`p0-traceability-v1.json` 40/40 passed。
4. **机器门演化生效**。证据门现在按 `evidence_scope` 双绑定：37 份 R1 evidence 绑定 `R1_EVIDENCE_CLOSED_AT_COMMIT`（`9443cb1`），3 份 stage-7 evidence 绑定本 ADR 记录的 `S7_EVIDENCE_CLOSED_AT_COMMIT`；设计门要求两者同时存在。

## 2. 边界

- HTTP ObjectStore 仅 localhost、带每运行随机 token、2 MiB 对象上限；不引入账号/团队/计费/生产部署（§18）。目录后端仍是默认后端；HTTP 后端仅在显式选择时使用。
- ACC-32/33 的 Directory 存储证据不外推为网络传输安全证据——网络面的安全声明专属 ACC-39 的会话捕获证据。
- 插件不打包 HTTP ObjectStore（bundle 扫描继续拒绝 restore 表面与适配器总入口）。

S7_EVIDENCE_CLOSED_AT_COMMIT: cd0999465022cafc6094153db84471abe1119315
