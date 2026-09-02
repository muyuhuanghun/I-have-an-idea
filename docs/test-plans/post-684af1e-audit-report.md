# `684af1e` 后续工作复审与修正报告

> 日期：2026-08-31
>
> 审查范围：`a51ff8f..841c26e`，重点覆盖 Phase 3D、Phase 4-A/B、R1-A/B/C 与 Phase 5
>
> 当前结论：Phase 3D 与 Phase 4 的实现/单元测试未发现新的阻断回归；R1-C 关闭结论和 Phase 5 实现不成立，已按原计划失败关闭。当前只恢复到“R1 工具修复完成、等待 clean commit 后重跑”的边界，不升级任何 ACC/DP，不授权 Phase 5 或 HTTP ObjectStore。

## 1. 现场基线

审查开始时：

- `HEAD == origin/main == 841c26e4943805d1b067ecf2d674086fcb4227ca`；
- 工作树为空；
- `684af1e` 之后共 16 个提交；
- design-only+samples 与旧 evidence gate 均能输出 PASS。

但统一门禁立即在 Obsidian 插件 typecheck 失败：`src/main.ts` 导入不存在的 `./p0.js`，并出现隐式 `any`。这证明“Git clean”不等于“当前 HEAD 可验证”。

## 2. 阻断 finding

### F1：R1 evidence 只验证外层包装，没有验证真实 oracle

`acc-evidence-run.mjs` 的旧实现把多项 required check 直接写成 `true`。代表性问题：

- ACC-12 的 object ID 与 nonce 实际检查了同一段 envelope bytes；
- ACC-16 用同一次 ciphertext 篡改同时充当 AAD 篡改，plaintext-format 结果也未从实际 worker 结果导出；
- ACC-26/27/28 的 1 GiB 往返、路径/字节相等和 `.c`/`.py` 对比直接写真；
- ACC-35 没有调用 `p0-roundtrip-report-v1` schema validator；
- ACC-36 没检查 `git status`，没做两次独立生成，只把同一个 manifest 读两次；
- ACC-37 只扫 4 份文档和 5 个短语，却声称扫 10 份文档并已绑定开发者裁决。

旧 `verify_phase0_contracts.py --evidence-root` 只校验 `acc-evidence-v1` 外层、required check 的 `passed=true`、错误码组、side effect 与一级 artifact hash；它不验证 perf/visibility/roundtrip 等内层 artifact schema，因此上述自述能通过。

### F2：12 份 perf report 本身 schema-invalid，且缺少冻结的 provenance

旧报告的 `raw_artifacts` 均为空，而 `perf-report-v1.schema.json` 要求 `minItems: 1`。ADR-0017 与 runtime-limits contract 还要求 report-to-build 和 report-to-runtime-limits hash binding，但旧 schema/runner 没有这些字段。

此外，报告记录 `git_commit=3a0c2bb`，实际运行依赖的 label/path/pnpm 修正在后续 `79481a7` 才提交；这属于 dirty-source 运行。37 份 ACC evidence 绑定 `afd5ca4`，而使统一 lint 门通过的修正在 `572f229`。因此关闭报告“全部基于 `572f229` 构建产物”的说法不成立。

### F3：关闭报告与机器权威状态冲突

`p0-r1-closeout-report.md` 声称 37 ACC 全部 PASS、DP-007/008/010/012 已关闭，但：

- `p0-traceability-v1.json` 与验收矩阵仍是 37 个 `untested`；
- `p0-deferred-parameters.json` 中 DP-007/008/010/012 仍为 `open`；
- README、执行计划、协议和 consistency 文件仍声明 P0-R1 未实现/未测试。

原验收矩阵明确规定任何 `untested` 都阻止关闭。这不是单纯漏改文档，而是关闭结论和权威机器状态互相否定。

### F4：Phase 5 不可构建并越过原计划边界

`841c26e` 只修改 `main.ts`，却导入未提交的 `p0.ts`，也没有声明/构建 `@ekd/adapters`。即使补齐缺文件，现有实现仍有以下合同问题：

- 执行计划 §16 规定插件只创建 snapshot，正式 fresh-process restore 继续由 CLI 负责；提交却新增插件 restore 命令；
- 用 crypto vector manifest 的 hash 冒充 runtime-limits hash；core 只检查 64 位 hex 形状，导致错误 binding 被接受；
- snapshot 命令在源 Vault 的插件目录写 `p0-domain-id.hex`，违反 snapshot 运行的源 Vault 零写入边界；
- 没有实现 §16 要求的进度、密文字节/可见性摘要和测试报告导出；
- 没有 Phase 5-0 接线合同、测试或验收报告。

## 3. 本轮修正

1. 移除 `841c26e` 加入的 Phase 5 接线，使插件恢复到先前可 typecheck/build 的 Phase 1 smoke shell；没有尝试用临时桩补齐一个尚未冻结的 Phase 5 设计。
2. `acc-evidence-run.mjs` 改为 required check 任一不通过即停止；关键检查从实际 worker、decoder、文件 hash、schema validator、Git 状态、两次 fixture 生成和 12 份 perf report 导出。
3. ACC-16 增加独立的 authenticated snapshot-ID AAD mismatch；ACC-15 对每个 envelope 截断 offset 运行真实 decoder；ACC-22 绑定成功 snapshot 自身的源 Vault 前后内容与 metadata inventory。
4. ACC-35 调用真实 roundtrip schema validator；ACC-36 要求 clean tree、当前 lockfile binding、warm 双跑一致与两次独立 representative-small 生成；ACC-37 生成确定性 machine-scan hash，只有显式 `EKD_ACC37_RULING="ACCEPT ACC-37 <sha256>"` 才能通过人工裁决项。
5. `perf-report-v1` 新增 required `evidence_binding`：clean source tree、build tree hash、runtime-limits hash、snapshot/restore worker hash；perf runner 把 RSS、worker stdout、日志、Recovery File 与 verifier output 作为 hash-bound raw artifacts，并在 dirty tree 上拒绝正式运行。
6. evidence verifier 现在递归验证 perf、storage-visibility 和 roundtrip artifact schema及 perf raw artifact hash，要求 37 份 evidence 来自同一 commit，并要求 registry/验收矩阵已同步为 `passed`。
7. 撤回旧 R1-C 与 DP-014 解锁措辞；机器 registry 保持 DP-007/008/010/012=`open`、DP-011=`conditional`、37 ACC=`untested`。

## 4. 当前验证与停止点

最终实跑结果：

- `pnpm run test:all` PASS：TypeScript 共 141 项测试通过，Python verifier 共 7 项测试通过，lint、typecheck、shared-core import gate 和全部 workspace build 通过；
- `python -B tools/verify_phase0_contracts.py --validate-samples` PASS，计数保持 ACC=37、INV=16、THR=5、DP=26，未升级任何 ACC 状态；
- `python -B tools/verify_phase0_contracts.py --validate-samples --evidence-root artifacts` 按预期 FAIL：`ACC-01: registry status is not passed`，旧 evidence 不再能绕过 `untested` 权威状态；
- 旧 large perf report 按新 schema 校验 FAIL：缺少 required `evidence_binding`；
- 在当前 dirty tree 直接运行 `node tools/perf-run.mjs` 与 `node tools/acc-evidence-run.mjs` 均按预期在写 evidence 前 FAIL：正式性能/ACC 证据要求 clean source tree；
- `git diff --check` PASS，Phase 5 `main.ts` 与 `b5fcecf` 版本逐字节一致。

正式 P0-R1 尚不能在本工作树关闭。ACC-36 和 perf contract 都要求 clean commit；当前用户没有授权自动 commit/push。本轮到此只交付修复后的 source/docs 与可复核门禁，下一会话必须先审查并提交本轮 diff，再在该 clean commit 上重跑 12 份 perf report 和 37 份 evidence，最后等待 ACC-37 的精确开发者 token。Phase 5 必须在新的 R1 closeout 之后另开 Phase 5-0 合同，只实现 §16 的 snapshot-only 薄接线。
