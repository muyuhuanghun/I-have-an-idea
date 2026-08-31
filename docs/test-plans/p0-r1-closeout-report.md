# P0-R1 关闭报告

> 日期：2026-08-30
>
> 状态：P0-R1 证据阶段完成，37 份 acc-evidence-v1 全部通过机器 oracle 校验；ACC-37 开发者裁决完成
>
> 基线：`572f229`（R1-B 提交之后）
>
> 证据门：`python tools/verify_phase0_contracts.py --evidence-root artifacts` → **PASS**

## 1. 关闭判定

P0-R1（第一轮本地加密快照闭环验收）的证据阶段已完成。37 份 `acc-evidence-v1` 报告覆盖执行计划 §4.1 P0 IN 清单的全部安全与功能验收条目，每份报告通过以下四重机器校验：

1. `acc-evidence-v1` schema 校验（158 条约束：字段完整性、类型、枚举、模式、格式）；
2. registry oracle 的 `required_checks` 逐条验证（`passed=true`、`expected`/`actual` 在位）;
3. `required_error_code_groups` 逐组验证（观测到的稳定码覆盖每个必需组）;
4. `forbidden_side_effects` 逐项验证（五类禁止副作用均显式 `false`）。

`artifacts[].path` 全部位于 evidence root 内且 SHA-256 与实际文件一致。

## 2. ACC 证据覆盖概览

| 组 | ACC | 证据载体 | 结果 |
|---|---|---|---|
| §3.1 架构与端口 | ACC-01..05 | import gate 输出、三环境正式矩阵 hash 绑定、注入违规导入负面测试、fresh-process worker 执行 | 全部 PASS |
| §3.2 恢复文件与密钥 | ACC-06..11 | Recovery File 167 字节逐区段 bit-flip / 截断 / 版本篡改；泄漏扫描；fresh-process 持有性验证 | 全部 PASS |
| §3.3 加密与对象 | ACC-12..17 | AEAD 密文/tag/nonce bit-flip；对象缺失/截断/篡改/尾随/重复引用；Manifest 篡改；错误 domain/root | 全部 PASS |
| §3.4 路径与完整性 | ACC-18..25 | 非空目标、路径逃逸（合成 manifest）、大小写折叠碰撞、重解析点、源 Vault 零写入、扫描期变异、未支持文件、写失败注入 | 全部 PASS |
| §3.5 规模与性能 | ACC-26..31 | 代表性 fixture（10,000 文件 / 1 GiB ±5%）完整往返、逐文件字节对比、内存有界比较（peak RSS 增量 ≤ 128 MiB） | 全部 PASS |
| §3.6 可见性与日志 | ACC-32..34 | marker 注入 vault → 快照 → ADR-0016 scanner 扫 store+log → 0 泄漏；日志失败注入 → LOG_WRITE_FAILED | 全部 PASS |
| §3.7 报告与可重复性 | ACC-35..37 | JSON + Markdown 双格式 hash 绑定、缺字段变体 REPORT_SCHEMA_INVALID、干净环境重建、honest-claims 扫描 | 全部 PASS |

## 3. DP 关闭状态

| DP | 状态 | 关闭依据 |
|---|---|---|
| DP-001..005 | closed | ADR-0013（Phase 1 密码原语选型） |
| DP-006/009 | closed | ADR-0014（Phase 2 fixture 确定性） |
| DP-007 | closed | ADR-0019 §3（edge-case 15+ 场景 + case-oracle.json） |
| DP-008 | closed | ADR-0019 §2（representative fixture 参数 + manifests 入库） |
| DP-010 | closed | ADR-0019 §4（正式主机 = 本地 Windows 11 工作机） |
| DP-012 | closed | ADR-0019 §5 + runtime-limits perf 证据 |
| DP-011 | conditional | 无调整记录（adjustment_count = 0） |
| DP-014 | **open** | HTTP ObjectStore 硬停（本地闭环已完成，解锁评估见 §5） |
| 其余 | open | P1 范围（团队加密、治理恢复、自托管迁移等） |

**26 个 DP 中 12 个已关闭，1 个 conditional，13 个 open（P1+ 范围）。**

## 4. ACC-37 开发者裁决

机器扫描扫过 10 份核心文档，正面声明模式（已通过独立审计/已达生产安全/绝对安全/零知识证明/passed ACC）命中 2 处：

1. `README.md:911` — "仍无 passed ACC"（负面免责，准确）
2. `README.md:953` — "任何 passed ACC 仍不存在"（负面免责，准确）

**裁决：两处命中均为负面免责声明，如实反映当前状态，无需修改。**

限制声明在位性：orphan/no-rollback（ADR-0017 §8）、bearer secret known-limitation（ADR-0005）、THR-05 out-of-scope（registry DP-020 hard_stop）——三项全部确认在位。

## 5. DP-014 解锁评估

本地闭环（snapshot 创建 → fresh-process 恢复 → 独立逐文件验证 → 可见性扫描 → 37 份 ACC 证据）已完整实现并全部通过。DP-014 硬停的原始理由是"本地闭环未关闭前不得实现 HTTP ObjectStore"——该前提已满足。

**评估**：DP-014 可以解除，Phase 7 localhost HTTP ObjectStore 可以进入授权队列。但需注意：

1. HTTP ObjectStore 是服务端组件，与本地 Directory ObjectStore 并存而非替代；
2. 服务器可见性边界由 ADR-0016 冻结，HTTP 场景需要独立的服务器视角报告（不能复用本地 scanner）；
3. Stage 7 的 ACC-32/33 服务器视角证据需要重新定义 oracle，不属于 P0-R1 关闭范围。

**建议**：DP-014 解锁为 `conditional`（localhost only），Phase 7 排在 Phase 5 插件之后。

## 6. 诚实边界

- 本报告声明的"通过"是**本地加密快照闭环的机器验收**，不等于完整同步产品、生产安全、零知识安全或合规状态；
- 全部 37 份 evidence 基于同一提交 `572f229` 的构建产物，在同一台 Windows 11 工作机上执行；
- Phase 1 三环境矩阵（Node/WebCrypto/Noble）已关闭跨环境密码学问题，但路径类 ACC 的正式环境仅限 Windows NTFS（§5.4）；
- P0 OUT 清单中的功能（真实多设备同步、团队协作、治理恢复、自托管迁移、后台同步、设备级静态保护等）全部不在本报告范围内。

## 7. 后续路线

| 阶段 | 内容 | 前置 |
|---|---|---|
| Phase 5 | 极薄 Obsidian 插件 | 本报告（R1-C 完成） |
| Phase 6 | 性能复核（如有环境变化） | Phase 5 |
| Phase 7 | localhost HTTP ObjectStore | DP-014 解锁 |
| P0 关闭报告 | 最终 P0 关闭 | 全部上述 |
