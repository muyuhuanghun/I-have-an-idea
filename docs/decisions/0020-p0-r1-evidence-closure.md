# ADR-0020：P0-R1 证据关闭与 DP 收尾

- 状态：已接受（2026-09-02 开发者以精确 token 裁决 ACC-37，并授权完成 R1 收尾提交）
- 日期：2026-09-02
- 草案阶段：Phase R1-C（重做）
- 决策者：开发者
- 相关文档：ADR-0012、ADR-0017、ADR-0018、ADR-0019、`docs/test-plans/p0-r1-closeout-report.md`、`docs/test-plans/post-684af1e-audit-report.md`、`docs/contracts/p0-traceability-v1.json`、`docs/contracts/p0-deferred-parameters.json`、`docs/test-plans/P0-acceptance-matrix.md`

## 1. 决策内容

1. **P0-R1 证据关闭成立**。37 份 `acc-evidence-v1` 与 12 份 `perf-report-v1` 全部在 clean commit `9443cb11903fa3c9608022d933980475225ad7cb` 上由修复后的 runner 重新生成：`node tools/perf-run.mjs` → `PERF_RUNS_PASS`（12/12，同一 Turbo 电源计划，`evidence_binding` 绑定 build tree/runtime-limits/worker hash）；`node tools/acc-evidence-run.mjs` → `EVIDENCE_RUN_DONE 37 reports at HEAD 9443cb1…`（37/37 全部 required check、错误码组与 side-effect oracle 通过）。
2. **ACC-37 开发者裁决**。机器扫描（10 份核心文档，`unsupported_claim_hits: []`，四项限制声明全部在位）产出确定性 token；开发者以精确 token `ACCEPT ACC-37 5dbc2a722e7622febbd23a35bc3afc82b79daceb3a7458daff1f216983e7acff` 作出 ACCEPT 裁决（machine-scan sha256 = `5dbc2a72…`）。
3. **registry 与矩阵同步**。`p0-traceability-v1.json` 37 个 ACC 状态由 `untested` 升级为 `passed`（顶层 status 同步翻转）；`P0-acceptance-matrix.md` 37 行状态同步为 `passed`。
4. **DP 关闭**。DP-007/008/010/012（ADR-0019 冻结参数）以本次正式证据关闭；DP-011（512 MiB 一次性调整，可选）以"无需调整"记录关闭——正式基线 peak RSS 139–190 MiB，远低于 512 MiB 门槛，不触发任何调整。以上五项 `closure_adr` 均绑定本 ADR。DP-014 保持 `deferred`（Stage 7 HTTP ObjectStore）。
5. **设计门同步修订**（`tools/verify_phase0_contracts.py`）。原第 425 行的"committed design registry must remain untested"硬检查替换为 closure 门控规则：37 个状态要么全部 `untested`，要么全部 `passed`，且收尾报告必须包含 `R1_EVIDENCE_CLOSED_AT_COMMIT: <40位十六进制>` 绑定行；`--evidence-root` 模式进一步要求 37 份 evidence 的 `git_commit` 与该绑定行一致。规则配 4 项单元测试。

## 2. 证据运行前的阻塞修复（均已先于证据运行提交）

- `9000d63`：evidence runner 在 Windows 上对 `.cmd` shim（pnpm）的 spawnSync 返回 EINVAL（Node ≥ 20.12 拒绝直接 spawn `.cmd`），`sh()` 对 `.cmd` 后缀命令改经 cmd.exe 路由。
- `d861e28`：perf runner 的 per-run raw artifact 目录先删后建；`Recovery File` 目标按 ports.ts 契约"永不覆盖已存在文件"，重跑必须提供全新目录。
- `62ad56f`：perf runner 增加矩阵中段环境漂移 fail-fast（首次重跑中途电源计划被外部从 Performance 切到 Turbo，触发冻结 schema 的 `same_environment: true` 硬门；守卫把违反点从 ACC-26 提前到采集时刻）。
- `9443cb1`：收尾报告历史章节改写，避免逐字引用 ACC-37 扫描模式短语导致扫描器自匹配。

## 3. 后果与边界

- 设计门与证据门的计数口径保持 ACC=37、INV=16、THR=5、DP=26；`design-only` 模式现在如实报告"registry 记录 37 passed"，它仍不重新验证运行时 artifacts——运行时验证专属 `--evidence-root` 模式。
- 2026-08-30 的 R1-A/B candidate artifacts 与 `b5fcecf` 关闭报告保持撤回状态（见 post-684af1e 审计报告）；本次关闭仅基于 `9443cb1` 上的重跑证据。
- Phase 5（插件产品接线）不在本 ADR 范围内：须在新的 Phase 5-0 合同冻结后按执行计划 §16 实施 snapshot-only 薄接线；DP-014/HTTP ObjectStore 解锁仍被 DP-014 hard_stop 阻止。
- 本 ADR 只关闭 P0-R1 证据阶段；不声明生产安全，不豁免后续阶段的独立审计。
