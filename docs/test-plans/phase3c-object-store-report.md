# Phase 3C Directory ObjectStore 合同冻结与 Adapter 复审报告

> 日期：2026-08-30
>
> 状态：实现提交 `684af1e` 已由开发者显式授权纳管；本文保留提交前 dirty-source 历史并附提交后复核
> 基线：`39922c76d884eaa1ab6acdfaa4a243ea5e7fa038`（推送 `696e199` + `39922c7` 之后）

## 1. 授权范围

2026-08-30 用户授权分三段执行：

1. 推送已验收的 `696e199` 与 `39922c7`（已完成：`454afdd..39922c7`，本地与远端对齐）；
2. Phase 3C-0 只冻结 Directory ObjectStore 的八项合同：不可变写入、原子发布、碰撞返回、路径 containment、Windows reparse point、部分写入清理、耐久性和错误归一化；
3. 合同落地后进入 Phase 3C-A，实现并测试 Directory ObjectStore adapter。

明确禁止：HTTP ObjectStore、snapshot pipeline、恢复流程、插件接线、Phase 4；禁止修改 ACC 状态；禁止自动提交或推送 Phase 3C 的新变更。完成统一门禁后停止并报告。

## 2. Phase 3C-0 冻结内容

合同权威是 [ADR-0015](../decisions/0015-p0-directory-object-store-v1.md)，协议文档新增 §4.3 摘要。关键冻结决策：

- **不可变写入 + 原子发布**：put 走"写 `<key>.tmp` → 文件 fsync → 原子硬链接发布 → 删临时文件"。不用 rename，因为 rename 在两个平台都会覆盖已存在目标；硬链接 create-if-absent 原子失败，`EEXIST` 是碰撞权威信号，读者只见完整对象或缺失。
- **碰撞返回**：复用冻结码 `OBJECT_ID_COLLISION`（协议 §4.1 编排层"碰撞→重新生成 ID/nonce/密文"循环的同一信号），store 永不覆盖。Windows NTFS 大小写折叠：仅大小写不同的 canonical key 共享目录项，后发布者得碰撞，不可变性不破坏。
- **路径 containment**：key 先过共享核心 `decodeObjectStoreKeyV1` canonical 校验；布局只有 `join(root, key)` 一种；root 每次 `lstat` 校验。
- **重解析点**：按 ADR-0009 §4 拒绝一切 symlink/junction（`REPARSE_POINT_FOUND`），检测惯例与 `NodeVaultSource` 一致。
- **部分写入清理**：`<key>.tmp` 含 `.` 永非合法 key；崩溃遗留临时文件由同 key 下一次 put 移除。
- **耐久性**：文件 fsync 全平台强制；POSIX 目录 fsync 强制；Windows 无法对目录句柄 fsync——如实冻结为平台边界（文件 fsync + 原子发布 + NTFS 日志），不声称更强保证。
- **错误归一化**：公共码恰四个，机器 registry 仅新增 `OBJECT_STORE_IO_FAILED`（按 ADR-0012 §5 机制），其余复用冻结码；未注册诊断不越过边界。

不关闭任何 DP（DP-007 实为 Phase 2 edge-case fixture；HTTP 挂在 DP-014 保持 deferred 阻挡），不改任何 ACC 状态。文档同步：协议 §4.3/§7 与状态行、wire contract 状态串、README、执行计划状态行与 §14 授权段、consistency-check 两个新 token、ADR-0012 一句 registry 对账。

## 3. Phase 3C-A 实现与测试

[DirectoryObjectStoreV1](../../packages/adapters/src/node-object-store.ts) 实现 `ObjectStore` 端口（签名未扩展），只用 `node:fs/promises`，无 native 依赖。同 key 操作在实例内经 `#enqueue` 串行化（失败不毒化链）；fast-path lstat 与 link `EEXIST` 双路碰撞；get 返回独立缓冲区；发布后清理失败升级 `OBJECT_STORE_IO_FAILED` 而对象保持已发布完整。

[11 个新测试](../../packages/adapters/test/object-store.test.ts) 一次通过：六类非法 key 双操作拒绝、win32/posix 大小写分支、roundtrip/幂等/独立缓冲区/缺席 undefined、碰撞不覆盖且目录无残留、同 key 并发串行化首写胜出、跨实例关闭句柄回读、陈旧临时文件清理、目录占用 key 的 put=碰撞/get=IO_FAILED 不对称、root 缺失/是文件归一化、root 与 key 位 junction/symlink 拒绝不跟随。

## 4. 真实失败与修正历史

1. 首次统一门禁在 lint 阶段停止：`node-object-store.ts` 的 `finally` 内 `throw` 触发 `no-unsafe-finally`——清理失败异常会掩盖进行中的碰撞信号。重构为"捕获发布异常 → 清理 → 重抛"：清理失败仍按 ADR §8 升级为 `OBJECT_STORE_IO_FAILED`，碰撞 + 清理失败时碰撞信号被 IO_FAILED 掩盖，这正是冻结的失败关闭语义。修正后只重跑统一门禁一次，完整通过。
2. 11 项 adapter 测试首跑即通过，含 Windows junction 检测实测（libuv lstat 分类同时覆盖 symlink 与 junction）。

## 5. 验证结果

```text
lint PASS（no-unsafe-finally 修正后）
typecheck PASS（6 workspace projects）
test PASS 68/68：core 25、crypto 18、adapters 20（+11）、smoke 5
Shared-core import gate PASS
build PASS（6 workspace projects）
python tools/verify_phase0_contracts.py PASS
  PHASE0_CONTRACT_CHECK_PASS mode=design-only ACC=37 INV=16 THR=5 DP=26
git diff --check PASS（仅 autocrlf 提示，无 whitespace error）
```

## 6. GLM 复审判定与非阻塞观察

GLM 独立复跑全部门禁并逐项核对合同/实现/文档后判定：**验收通过，无阻塞问题**。以下三条非阻塞观察如实保留：

1. **重解析点检测边界**：ADR-0015 §5 的"和其他重解析点"措辞宽于实际检测能力——`lstat().isSymbolicLink()` 只覆盖 libuv 分类的 symlink/junction，OneDrive 云占位符类 reparse tag 不会被识别。ADR 括注已把检测惯例锚定到 lstat 分类且与 `NodeVaultSource` 先例一致，如实；未来如需覆盖云占位符，必须在 ADR 中显式声明为平台边界。处置：保持现状，不修改已验收工件。
2. **`EEXIST` 慢路径无确定性测试**：fast-path lstat 与 link 之间的竞态窗口不可稳定注入；该分支仅数行且被 fast-path 兜底，语义由跨进程并发合同覆盖。
3. **write+close 双失败时 close 错误掩盖 write 错误**：两者归一化到同一 `OBJECT_STORE_IO_FAILED` 且 cause 保留，无可观察差异。

## 7. 证据边界与停止点

本报告在 GLM 验收之后补写，不属于验收时的 12 文件集合；验收对象是本报告之外的 9 个修改 + 3 个新文件。全部结果是 dirty-source implementation review evidence，不是正式 ACC evidence；DP-001..026 状态零变化，37 个 ACC 全部保持 `untested`，P0-R1 未实现、未测试。

开发者已于 2026-08-30 显式授权两笔提交与推送。提交前 staged 检查（`git diff --cached --check`）发现并修正了本报告 blockquote 的行尾空格，实现提交 `684af1e`（13 文件 = 验收时 9 修改 + 3 新增 + 本报告）已包含该修正。提交后在 clean HEAD 复跑统一门禁 68/68（core 25 / crypto 18 / adapters 20 / smoke 5）、shared-core import gate、build 与 design-only 合同校验（ACC=37 INV=16 THR=5 DP=26）全部 PASS，随后按 3B 惯例以 reconcile 提交回写状态措辞。这些仍不是正式 ACC evidence；Phase 3 剩余项（服务器可见性报告等）与 Phase 4 及以后仍需各自明确授权。
