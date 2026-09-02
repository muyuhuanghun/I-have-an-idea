# ADR-0019：P0-R1 证据计划 v1

- 状态：已接受（2026-08-30 开发者确认全部四个确认点；DP-010 主机经裁决冻结为本地 Windows 工作机）
- 日期：2026-08-30
- 草案阶段：Phase R1-0
- 决策者：开发者
- 相关文档：ADR-0009、ADR-0013、ADR-0014、ADR-0015、ADR-0017、ADR-0018、`P0-fixture-and-performance-baseline.md`、`P0_EXECUTION_PLAN.md` §15/§17/§23、`docs/contracts/p0-deferred-parameters.json`（DP-007/008/010/012）、`docs/contracts/p0-runtime-limits-v1.json`、`docs/test-plans/P0-acceptance-matrix.md`

> 本 ADR 已由开发者于 2026-08-30 确认接受（含 DP-010 主机裁决）。它只冻结证据计划的参数与矩阵，不生成任何 evidence、不运行任何正式验收、不改变 ACC 状态；四个 DP 仍为 `open`，关闭以 R1-A/B 的正式产物为准。

## 1. 背景与本阶段边界

Phase 4-B 已落地（`a6cd59f` + `21fb2b0`）：引擎侧 snapshot 创建与 fresh-process 恢复全部实现并通过独立复审。P0 剩余工程是证据阶段——把 37 份 `acc-evidence-v1` 生成到 `artifacts/` 使 `--evidence-root artifacts` 机器门 PASS，然后 P0-R1 关闭报告。四个 open DP（007/008/010/012）的参数必须先冻结，否则证据跑了也无效（各 DP 的 hard_stop 条款）。

本草案只做三件事：冻结 DP-007/008/010 的参数提案、澄清 DP-012 的恢复侧映射、给出 37 份 ACC 的运行矩阵与环境规则。fixture 生成器扩展、perf harness、证据运行全部属于 R1-A/B，另行授权。

## 2. DP-008：representative fixture 参数提案

基线文档已冻结规模 oracle（§57-58、§60）：small 与 large 各 10,000 文件，small 字节范围 127,506,842..140,928,614（约 128 MiB ±5%），large 1,020,054,733..1,127,428,915（1 GiB ±5%）；两者由同一 generator 版本生成、内容类型与路径分布一致、仅扩大文件体量；都含中文路径、`.c`、`.py`，不含未支持文件。

提案冻结：

1. **profile 与 seed**：`tools/fixture-generator.mjs` 增加 `--profile representative-small|representative-large`；确定性 seed 提案为 `ekd-representative-v1`（与 tiny 的 `ekd-tiny-v1` 同惯例）；路径分布沿用 tiny 的内容类型配比按比例放大，文件大小按 profile 目标总量均匀分档后加确定性抖动。
2. **产物与落盘**：`fixtures/representative-small/`、`fixtures/representative-large/` 内容**不进 git**（体量原因），但 `fixture-manifest-v1` 报告（含全量 sha256、seed、generator 版本与 commit binding，沿用 tiny 的 provenance 惯例）提交入库；任何机器可由 seed + generator commit 重建并逐字节复核（ACC-36 可重复性）。
3. **验收**：两份 manifest 通过 schema、文件数恰为 10,000、总字节落在冻结范围内、hash 绑定 generator 实现提交。

## 3. DP-007：edge-case 恶意输入清单提案

`fixtures/edge-cases/`（内容进 git——体量小、必须可复审），每个场景一条期望稳定码，构成 case oracle manifest：

| 场景类 | 具体输入（≥） | 期望码 |
|---|---|---|
| 保留设备名 | `CON.md`、`con.md`、`PRN`、`AUX`、`NUL`、`COM1.md`、`LPT9.md` | `ENTRY_PATH_ESCAPE` |
| 保留字符 | 文件名含 `<`、`>`、`:`、`"`、`\|`、`?`、`*` | `ENTRY_PATH_ESCAPE` |
| 尾随点/空格 | `name .md`、`name .txt`、段尾 `.` | `ENTRY_PATH_ESCAPE` |
| 隐藏段 | `.hidden.md`、`.obsidian`（文件形态）、`.git/config` | `ENTRY_PATH_ESCAPE` |
| 逃逸 | `../x`、`a/../../x`、`/abs`、`a\b`、`C:x` | `ENTRY_PATH_ESCAPE` |
| 大小写折叠 | `Å.md`+`å.md`、`README.md`+`readme.md`（合成 Manifest） | `CASE_COLLISION` |
| 重解析点 | Vault 内 symlink、junction（Windows 实建） | `REPARSE_POINT_FOUND` |
| 未支持文件 | `x.exe`、无扩展名文件 | `UNSUPPORTED_FILES_FOUND` |
| 扫描期变化 | 读取窗口内修改/删除文件 | `FILE_CHANGED_DURING_SCAN` |
| 对象缺失 | Manifest 引用不存在的 object | `MISSING_OBJECT` |
| 对象篡改/截断 | 翻转密文字节、截断 envelope、追加尾随字节 | `OBJECT_AEAD_FAILED` / `OBJECT_TRUNCATED` / `OBJECT_TRAILING_BYTES` |
| 恢复文件错误 | 翻转 HMAC、截断、追加、改版本字节 | `RECOVERY_INTEGRITY_FAILED` / `RECOVERY_TRUNCATED` / `RECOVERY_TRAILING_BYTES` / `RECOVERY_VERSION_UNSUPPORTED` |
| 非空目标 | 目标内预置 dummy 文件 | `NON_EMPTY_TARGET` |
| 写失败 | 模拟磁盘满/只读目标 | `RESTORE_TARGET_WRITE_FAILED` |
| 日志失败 | 只读日志目录 | `LOG_WRITE_FAILED` |

ASCII 折叠时代的补充锚点（Å/å、k/Kelvin、ss/ß）已由 ADR-0009 §2.5 与 scan/restore 测试覆盖，edge-case fixture 中以目录对形式物化。

## 4. DP-010：性能测量环境（已冻结：本地 Windows 工作机）

1. 主机（实测于 2026-08-30）：AMD Ryzen 9 9955HX 16 核 32 线程、15.2 GB RAM、系统盘 NTFS（约 170 GB 可用）、Windows 11 build 10.0.26200。开发者确认的 Azure VPS（2 vCPU / 1 GB RAM / 100 GB / Ubuntu 22.04, kernel 6.8, 日本东部）**不作为 P0-R1 正式证据主机**——Ubuntu ext4 与 §5.4 冻结的 Windows NTFS 环境矛盾（ext4 无大小写不敏感、无 junction/reparse），且 1 GB RAM 不足以支撑 1 GiB fixture 的可靠对比基线；
2. VPS 定位与迁移就绪策略：该 VPS 是未来 Phase 7 HTTP ObjectStore 的候选服务端（Ubuntu 做服务端合理），迁入前建议 ≥4 vCPU / 8 GB RAM；全部 fixture 可由 seed + generator commit 重建、evidence 可重跑、报告绑定主机规格与 build hash，因此**主机迁移 = 换机重跑，而非历史证据失效**；若未来把性能运行迁到任何新主机，路径类 ACC（ACC-18/19/20/21/25 与 ADR-0009 全部规则）仍必须在 Windows NTFS 上执行，其余 ACC 在新主机重跑并以新报告取代；
3. 工具：Node `process.memoryUsage().rss`，采样间隔 50 ms（基线允许 1..100 ms）；
4. 电源计划：高性能/最佳性能；后台同步、索引、杀毒实时扫描在运行窗口内停用并记录；
5. 运行清单：small/large × create/restore × (cold 1 次 + warm 2 次) = 8 次正式运行，每份产出 schema-valid `perf-report-v1`（环境字段、idle RSS、cache_state 必填，缺任一即无效）；
6. 判定门（已冻结于 runtime-limits `evidence_binding`）：peak RSS ≤ 512 MiB、large−small peak RSS 增量 ≤ 128 MiB、采样间隔 ≤ 100 ms；通过后关闭 DP-012 并升级 ACC-29/30。

## 5. DP-012：恢复侧映射澄清

snapshot 侧参数已在 `p0-runtime-limits-v1` 冻结（1 MiB chunk、并发 1、预取 0、8 次总尝试）并经 perf 证据门关闭。恢复侧无随机量、无发布重试；并发 1 与"同时在途 1"由 ADR-0018 §4 的顺序遍历结构保证，无独立队列参数。DP-012 的关闭证据 = 本 ADR §4 的 8 份 perf-report-v1 全部达标；无需新的 limits 文件。

## 6. 37 份 ACC 证据运行矩阵（按组）

| 组 | ACC | 证据载体 |
|---|---|---|
| §3.1 架构与端口 | ACC-1..5 | 静态：verifier + import gate + 端口实现产物 |
| §3.2 恢复文件与密钥 | ACC-6..11 | Phase 1 三环境正式矩阵 + KAT 向量复算（已有产物 hash 绑定进 evidence） |
| §3.3 加密与对象 | ACC-12..17 | codec 单元测试 + 篡改/截断/尾随注入（R1-B 运行） |
| §3.4 路径与完整性 | ACC-18..25 | edge-case fixture + 恢复器注入（R1-B） |
| §3.5 规模与性能 | ACC-26..31 | representative fixture + perf harness（R1-A） |
| §3.6 可见性与日志 | ACC-32..34 | ADR-0016 scanner + 快照日志字节 + 注入（R1-B） |
| §3.7 报告与可重复性 | ACC-35..37 | schema/hash 双格式报告、干净环境重复运行、honest-claims 扫描（R1-B/C） |

每份 evidence 为 `artifacts/test-reports/acc-<nn>-<slug>.json`（`acc-evidence-v1` schema），`artifacts[].path` 必须位于 evidence-root 下且 sha256 与实际文件一致；`artifacts/` 保持 gitignore（ACC-36：可由 seed + generator + 测试套件重建）。R1-B 的 PASS 判据即 `python tools/verify_phase0_contracts.py --evidence-root artifacts` 输出 PASS。

## 7. 环境规则

1. 正式往返与路径类 ACC 的唯一正式环境是开发者 Windows 11 + NTFS（执行计划 §5.4，不变）；
2. Phase 1 三环境 crypto 矩阵已关闭跨环境问题，R1 不重复；
3. Web/Android/Obsidian 运行时属于后续阶段，不在 P0-R1 范围；
4. 所有正式运行使用 `a6cd59f` 构建产物之上的 worker/scanner/verifier，evidence 记录 build hash（runtime-limits 与 build 的绑定沿用 ADR-0017 §3.1）。

## 8. 确认记录

开发者已于 2026-08-30 确认接受全部四项：

1. **DP-008**：seed `ekd-representative-v1`、两 profile 各 10,000 文件、字节范围按基线冻结、manifest 入库/内容 gitignore；
2. **DP-007**：§3 清单 15 类场景及期望码全部确认；
3. **DP-010**：主机经裁决冻结为本地 Windows 工作机（Azure VPS 因 §5.4 环境矛盾排除出正式证据，定位为 Phase 7 服务端候选），采样 50 ms、8 次运行清单、迁移就绪策略同 §4；
4. **矩阵与落盘**：§6 分组载体与 `artifacts/` gitignore + 可重建策略确认。

随接受提交完成的文档动作：本 ADR 翻为已接受；四个 DP 条目加"参数已由 ADR-0019 冻结"注记（状态仍 `open` 待证据）。R1-A（fixture 生成器扩展 + perf harness）为独立授权切片，未获授权不得开工。

## 当前参数状态（2026-08-31 复审纠正）

参数提案仍由本 ADR 冻结，但关闭状态以 `p0-deferred-parameters.json` 为准：DP-007/008/010/012 均为 `open`。2026-08-30 的 R1-A/B artifacts 已在 2026-08-31 复审中降级为历史 candidate：perf report 缺 raw artifacts 与 build/runtime-limits binding，且 commit provenance 不成立；它们不能关闭 DP-010/012，也不能支撑 ACC-26/29/30/31。37 ACC 继续 `untested`。

## R1-A 历史 candidate 记录（2026-08-30；不构成关闭）

R1-A（开发者同日授权）曾生成下列产物；以下数值和 hash 只描述当时文件，不代表复审后仍有效：

1. **DP-008**：`tools/fixture-generator.mjs` 扩展 `--profile representative-small|representative-large`（generator v1.1.0，seed `ekd-representative-v1`，绑定提交 `3a0c2bb`）。两份 `fixture-manifest-v1` 已入库：
   - representative-small：10,000 文件 / 134,217,679 字节（范围内），manifest sha256 `655d3bc4d639148bc40a059b2466a61cd7d87d1f3616d9aa804ab33f4c071fe4`；
   - representative-large：10,000 文件 / 1,073,741,847 字节（范围内），manifest sha256 `f8e3dcfa920bd02e5f93fd2e57bf28681b6ec8c3352fa606a2b0da6e23b86dea`。
2. **DP-007**：`fixtures/edge-cases/case-oracle.json`（15+ 场景 → 稳定码）+ 物化 vault 文件入库，oracle 完整性由 `edge-case-oracle.test.ts` 机器验证。
3. **DP-010**：12 次正式运行（勘误：§4 原写 8 次系算术错误，实际 2 fixture × 2 方向 × cold1+warm2 = 12 次）全部 `pass`，主机为 §4 冻结的本地 Windows 工作机。报告位于 `artifacts/perf-reports/`（gitignore，可重建），SHA-256：
   - small-create-cold-1（baseline）`8e043a55cb81f8b9fb0de11ab3688f42665b652c0336e61566fa594de28a0cf5`；
   - small-create-warm-1 `091bef967993336553a3b373abcac38971c92550a6913abb6371f4a777eb073c`；small-create-warm-2 `f996c1c7e544f35864b8569ae9a449522ff2db797920fd2ebbfb9a5a8cab8aa8`；
   - small-restore-cold-1 `761a4ce8f1eeec655ae83be788cb65969ed7f92d79b9f5dd0e1129a70fda668e`；small-restore-warm-1 `930421887e0df063633ea0783330d1c4b4a5560e01a84053f96bd150e322e5ec`；small-restore-warm-2 `edba996a26862345a1a66a5aaede7c045ccac8df44e9814036f8f40d4a35f73d`；
   - large-create-cold-1 `d30cbb4dac3ffd1cf1d1636f4bd3e7045c64215fac10558ed8f583ed188a1495`；large-create-warm-1 `19f42c9898ba5382be55b3a97b62856059133aefe32f95823424c215cee35d3f`；large-create-warm-2 `57b74c501e07cb2df133204cc2bea456de451207327935a7e7c714b3d9749fe5`；
   - large-restore-cold-1 `34dfe3016a9f1ba34b72868f02e018f3151b43bd8925cfc67e123eedc7ebcfb0`；large-restore-warm-1 `c4c3f9b70b5879104ef356a402ec27a820c2f2b472e5a9b54589a2162ead69ce`；large-restore-warm-2 `e37773378b48dc8ba3a24d3966430c7fccafb41c29c656c703d28bff09e3974d`。
4. **DP-012 candidate**：旧报告中的数值显示 peak RSS ≤ 169.4 MiB、large−small 增量 17.9–28.2 MiB、fixture 增长比 8.0；但因报告 schema/provenance/binding 不合格，不能据此关闭 DP-012。
5. **当前边界**：这些文件可以帮助定位和重跑，不能升级 DP 或 ACC 状态。
