# Phase 4B Fresh-Process 恢复流水线实现与复审报告

> 日期：2026-08-30
>
> 状态：授权切片实现完成，独立复审 R1 REQUEST CHANGES（3 P1 + 2 P2）→ 补丁 → R2 追加 1 P2 → 补丁 → R2 边界内 PASS；F7 语义细化项经开发者裁决按方案 A 修复；未提交、未推送
>
> 基线：`ce22ca2`（Phase 4-B-0 接受提交之后）

## 1. 授权范围

2026-08-30 用户授权 Phase 4-B-0（ADR-0018 四点确认后接受，提交 `ce22ca2`）并随即授权 Phase 4-B-A：实现 fresh-process 恢复编排（ADR-0018 §3/§4）、`RestoreTarget` 端口、worker CLI 与纯 stdlib Python 验证器、恢复侧测试。明确不含：CLI 产品接线、HTTP ObjectStore、插件、任何 ACC/DP 状态升级。

## 2. 实现内容

### 2.1 恢复编排

`packages/core/src/restore.ts` 新增 `restoreSnapshotV1`，严格按 ADR-0018 §4 顺序：严格 Recovery File 解码（任何 `RECOVERY_*` 失败零写入）→ 取 Manifest 对象（`MISSING_OBJECT` 首次落地为恢复层协议违反码）→ Manifest 全量校验（canonical/重复路径/object ID 由解码器拒绝；ASCII+Windows 一对一大写折叠碰撞 `CASE_COLLISION`；全部校验先于任何写入）→ 目标校验（INV-08：空/真实目录/非重解析点）→ 按 canonical 顺序逐条 `get`→解密→写出。只调 `ObjectStore.get` 永不 `put`（ACC-22 对偶）；失败残留以 `restoredFileCount` 与 path-free `partialOutputInventory`（0-based Manifest index + `possibly_partial`，ADR-0018 §6）如实报告；`INCOMPLETE_RESTORE` 按开发者确认在 v1 不使用；明文与派生密钥 `finally` 原位清零；allowlist 之外的异常收敛为 `HONEST_CLAIM_VIOLATION`。domain ID 只能来自 Recovery File 解码，调用方无权注入。

### 2.2 Node 适配与 harness

`packages/adapters/src/node-restore-io.ts`：`NodeRestoreTarget` —— 空目录校验（缺失/非目录/非空 → `NON_EMPTY_TARGET`）、`lstat().isSymbolicLink()` 与 Windows `FILE_ATTRIBUTE_REPARSE_POINT` PowerShell 探针双重 reparse 检查（探针不可用按 ADR-0009 当前参数状态视为 reparse 风险，`REPARSE_POINT_FOUND` 失败关闭；`reparsePointProbe` 测试 seam）、防御性 canonical 路径校验（`ENTRY_PATH_ESCAPE`）、按需创建父目录；目标写失败 → registry 新增的 `RESTORE_TARGET_WRITE_FAILED`。`tools/snapshot-worker.mjs` / `tools/restore-worker.mjs`：fresh-process 双进程薄 CLI（进程 B 仅凭 Recovery File/ObjectStore 根/目标根三个路径参数启动）。`tools/verify_restore.py`：纯 stdlib 独立验证器——源↔恢复逐路径逐字节对比 + Recovery File 结构/HMAC 复验（RFC 5869 HKDF 手写），不解密对象（stdlib 无 AES-GCM，显式非声明）；missing-root 假 PASS 与 fingerprint 漏检两个验证器缺口已按复审 finding 修复。`tools/test_verify_restore.py`（5 项 unittest）已并入 `pnpm run test:all`（ADR-0018 §5.3 的落位决定）。

### 2.3 扫描与路径规则强化

复审驱动下 `paths.ts` 补齐 ADR-0009 §1 全部十类规则（隐藏段、保留设备名、保留字符、段尾点/空格、32,767 UTF-16 code unit 等）并新增 §2 冻结的确定性 Windows 一对一大写折叠键 `windowsCaseFoldV1`（Å/å 必碰撞，k/Kelvin 与 ss/ß 保持不同）；`scanVault` 的 `.obsidian/` 排除改为占位根全量 canonical 校验（`.obsidian/../escape.md` 与双斜杠 → `ENTRY_PATH_ESCAPE`）；大小写折叠碰撞检查在扫描与恢复双侧使用同一折叠键。

## 3. 复审全史与判定

独立复审（2026-08-30，同日三轮）：

1. **R1：REQUEST CHANGES**——P1 Unicode 大小写碰撞（Å/å 在 NTFS 静默覆盖）、P1 ADR-0009 路径规则未实现、P1 reparse attribute 覆盖不全；P2 recovery integrity key/Manifest 明文未清零、P2 README/执行计划底部陈旧状态。
2. **补丁后 R2**：追加 P2 —— `.obsidian/` 排除先于完整 canonical 校验导致 `.obsidian/../escape.md` 被静默跳过；补丁后 core/typecheck/lint/diff-check 通过。
3. **R2 结论（边界内 PASS）**：按用户划定的边界（`.obsidian` 占位根补丁、Unicode fold 假碰撞面、已闭合 6+1 finding 复核），`.obsidian` 补丁 PASS、fold 假碰撞面 PASS（最低锚点全部实测满足：A/a、Å/å 碰撞；k/Kelvin、ss/ß 保持不同）、6+1 finding 全部闭合且回归测试在位。
4. **F7（边界外单点，开发者裁决）**：`NodeRestoreTarget.verifyEmptyTarget` 探针失败原映射 `NON_EMPTY_TARGET` 语义错位。开发者裁决按方案 A 修复：改映射 `REPARSE_POINT_FOUND`（探针不可用视为 reparse 风险）、测试断言同步、ADR-0009 当前参数状态补"探针不可用视为 reparse 风险按 reparse 处理"。

registry 变化：+1 `RESTORE_TARGET_WRITE_FAILED`（独立复审经 ACC-25 oracle 分析发现原 oracle 要求 `INCOMPLETE_RESTORE` 与开发者已确认的"v1 不使用"决策矛盾，纠错后新增该码并同步 ADR-0018 §4/§6/§7、协议 §1.6、threat-traceability 与验收矩阵）。判定流程遵守"复审与关闭报告严格分离"：R1/R2 期间零提交、零报告。

## 4. 测试与门禁证据

39 个新增测试覆盖 ADR-0018 §8 与复审 finding 回归：core 18（端到端恢复、六条拒绝规则、部分写入诚实计数与清单、case-collision 合成 Manifest、清零、零存储写入、runtime-limits 绑定）、adapters 5（空目录/非空/缺失/重解析点含探针 seam、父目录创建、路径逃逸防御）、scan/manifest/recovery/object 12（ADR-0009 十三类路径拒绝、fold 锚点、清零时序）、Python 验证器 5（missing-root 假 PASS、fingerprint 漏检、字节一致、recovery HMAC）。

统一门禁：lint、typecheck（6 项目）、test 137/137（core 58 / crypto 19 / adapters 55 / smoke 5）、`test:restore-verifier` 5/5、shared-core import gate、build 全绿。fresh-process 真实双进程冒烟：worker A `complete`（3 文件，含中文与 marker 内容，快照日志无路径/marker/秘密）→ worker B `complete`（restoredFileCount=3）→ `RESTORE_VERIFY_PASS`。合同校验器 `--validate-samples` PASS：ACC=37 INV=16 THR=5 DP=26（registry +1 后静态门保持闭合），P0-R1 保持 NOT_IMPLEMENTED / NOT_TESTED。staged 与工作树空白检查通过。

## 5. 证据边界与停止点

全部结果是 dirty-source implementation review evidence，不是正式 ACC evidence。DP 状态：DP-001..006/009 closed、DP-011 conditional、DP-007/008/010/012 open（等 R1 性能证据）、DP-014 hard stop 不变；37 个 ACC 全部保持 `untested`；P0-R1 未实现、未测试。

Phase 4-B-A 按开发者预授权在独立复审边界内 PASS 且 F7 修复落地后进入落库序列：`ce22ca2`（4-B-0）+ 本切片 feat + reconcile 三笔一起提交并推送。此后进入 P0-R1 证据阶段（R1-0 证据计划冻结 → 代表性 fixture 与性能门 → 37 份 acc-evidence-v1 生成至 `--evidence-root artifacts` 门禁 PASS → P0-R1 关闭报告）。CLI 产品接线、HTTP ObjectStore（DP-014）、插件与 P0-R1 证据门之外的状态升级仍需各自明确授权。
