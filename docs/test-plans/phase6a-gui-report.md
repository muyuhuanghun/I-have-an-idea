# Phase 6-A 真实 Obsidian GUI 运行报告

> 日期：2026-09-05
>
> 状态：已纳管（修复提交 `b53865e` + 本报告 docs 提交）
>
> 合同：ADR-0022（Phase 6-0 范围裁决，开发者三点确认：接受 §17→R1 映射关闭压力矩阵、6-A GUI 运行优先、自动化驱动 + `artifacts/gui-test-vault/` 专用测试 Vault）
>
> 补齐面：Phase 5-B 报告 §3 声明的"真实 Obsidian GUI 运行证据"——P0 最后一个未验收面。本报告不升级任何 ACC。

## 1. 运行配置

- **构建来源**：clean commit `68cb52d`（`git status` 为空后 `pnpm --filter @ekd/obsidian-plugin run build`）；修复后最终证据来自 clean commit `b53865e` 的重建产物。
- **宿主**：本机 Windows 11（DP-010 冻结主机），Obsidian 1.13.7（`D:\Obsidian\Obsidian.exe`），用户真实 Vault `D:\Obsidian\muyu_note` 全程未触碰。
- **测试 Vault**：`artifacts/gui-test-vault/`（自动化新建；3 个内容文件——两份 note 含中文、一份 `.py`；插件经 `.obsidian/plugins/ekd-phase1/` 部署并在信任对话框后启用）。
- **插件设置**（经预写 `data.json`，全部显式无默认）：64-hex domainId（仅以 SHA-256 进入报告）、ObjectStore `artifacts/gui-test-p0/store/`（预建空目录）、snapshot log `snapshot.jsonl`（新文件）、Recovery File `snapshot.ekdr`（新文件）、runtime-limits 指向仓库契约文件、报告路径 `report/p0-plugin-snapshot-report.json`（新文件）。
- **执行方式**：GUI 自动化（ZCode computer-use）——信任 Vault → Ctrl+P 命令面板 → 执行 "EKD P0: Create P0 snapshot" → 捕获 Notice 与状态栏 → 机器产物核验 → 关闭 Obsidian。

## 2. 发现与修复（诚实记录）

第一次真实运行**失败**：Notice "P0 snapshot failed: Failed to fetch dynamically imported module: node:fs/promises"，状态栏 `EKD snapshot: failed`，磁盘零产物。根因：5-B 实现在渲染进程用 ESM 动态 `import("node:*")` 加载 Node 内置模块，Obsidian 1.13.7 的 `app://obsidian.md` 源对该类导入执行 CORS 拦截（DevTools 控制台可见 "Access to script at 'node:fs/promises' … blocked by CORS policy"）；dirty-source 集成测试无法暴露该差异。渲染进程内 CJS `require` 可用（DevTools 实测 `typeof require === "function"`），修复（`b53865e`）将两个 node 内置模块改为 `require` 加载（`import type` 保持类型、eslint 合规），插件 8/8 测试保持通过。**这正是 Phase 6-A 设置的目的：只有真实应用运行才能暴露的运行时差异。**

## 3. 最终运行结果（clean commit `b53865e` 产物）

- **UI 观察**：Notice "P0 snapshot complete. 4 object(s), 3 file(s). The plugin visibility summary is not formal ACC-32/33 evidence."；状态栏 "EKD snapshot complete: 3 file(s), 104 plaintext / 661 ciphertext byte(s)"。
- **产物**（`artifacts/gui-test-p0/`）：
  - ObjectStore 4 个对象（3 文件对象 + 1 Manifest），canonical base64url 键，字节总和 416+84+89+72 = 661；
  - `snapshot.jsonl`（snapshot-log-v1：preflight_complete + 3×file_published + manifest/log/recovery 事件，`runtime_limits_sha256 = e1971ab7…` 与冻结契约一致）；
  - `snapshot.ekdr` 恰 167 字节（Recovery File v1）；
  - 机器报告 `p0-plugin-snapshot-report-v1`：`run_id=8bfa54dd…`、`snapshot_id_hex=d68a5258…`、`domain_id_sha256` = domainId 原始字节的 SHA-256（`30a09f0a…`，**明文 domainId 未出现在报告中**）、`total_ciphertext_bytes=661`、可见性摘要带 `plugin-summary-not-formal-acc-32-or-33` 标注、`snapshot_log_sha256` 与实际日志字节一致、`verdict=pass`。
- **机器核验（全部 PASS）**：报告通过 `p0-plugin-snapshot-report-v1` schema 真校验；log sha256 绑定一致；对象字节总和 = 报告值；**源 Vault 零写入**（内容区仅有原 3 个文件，无任何快照产物或 marker）。

## 4. 边界与后续

- 本次运行不升级任何 ACC（P0-R1 证据仍专属 `9443cb1`）；插件可见性摘要不是 ACC-32/33 证据。
- 未测试项：restore 路径（按 ADR-0021 插件禁止 restore，正式恢复仍由 CLI 承担）；Android 顶层加载已在 5-B 报告覆盖，本轮未重复。
- 下一门槛：Phase 7-0（localhost HTTP ObjectStore，DP-014 解锁裁决）合同另行起草，需开发者单独授权。
