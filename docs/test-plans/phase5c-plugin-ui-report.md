# Phase 5-C 插件快照 UI 报告

> 日期：2026-09-05
>
> 状态：dirty-source implementation evidence（实现已门禁验证与真实 GUI 验证，提交待开发者授权）
>
> 合同：ADR-0023（Phase 5-C 插件快照 UI 合同 v1，开发者三点确认：停靠侧边栏视图、执行+进度+摘要卡三段式、设置页文本字段+校验反馈）
>
> 范围：纯表现层——不修改 core/adapters、不新增协议状态、ADR-0021 §2 全部禁令延续

## 1. 交付内容

1. **可停靠视图**（`src/snapshot-view.ts`，`VIEW_TYPE_EKD_P0_SNAPSHOT = "ekd-p0-snapshot-view"`）：三段式——执行区（Create snapshot 按钮，运行期禁用）、进度区（端口派生事件滚动列表，上限 50 行）、结果区（最近一次运行的摘要卡 + `plugin-summary-not-formal-acc-32-or-33` 免责标注 + "Open report file" 动作经 Electron `shell.openPath` 打开报告文件；失败时显示错误与设置指引）。
2. **纯状态机**（`src/snapshot-panel-model.ts`）：`SnapshotPanelModel` 把 `PluginSnapshotProgress` 六种事件映射为派生进度行、聚合格结果与错误；`complete/failed` 后不再回退为 running；`reset()` 回 idle。零 Obsidian 依赖，单元可测。
3. **插件接线**（`src/main.ts`）：`registerView` + `addRibbonIcon("lock")` 入口；命令面板命令改为"打开视图并触发快照"（ADR-0023 §2.1）；进度回调同时喂状态栏（既有）与面板模型；成功路径 `onResult` + 记录报告路径；失败路径 `onError`。设置页保持不变（文本字段 + 即时校验，确认点 3）。
4. **构建**：`external` 增加 `electron`（`shell.openPath` 保持运行时 require）；新增 `styles.css`（muted/error/摘要表样式）并随构建拷贝到 dist；bundle restore-surface 扫描继续生效。

## 2. 验证结果

- `pnpm run test:all` → **exit 0**（插件 11/11 tests：8 既有 + 3 新增面板状态机测试；全部 workspace 构建 + restore-surface 扫描通过）。
- **真实 Obsidian 1.13.7 GUI 验证**（`artifacts/gui-test-vault/`，复用 Phase 6-A 流程）：ribbon 锁图标打开面板 → 三段式渲染正确（idle 态）→ 点击面板内 "Create snapshot" → 进度区实时滚动（Scanning 1/2/3、Scan complete、Encrypting 1/3、2/3…、Recovery File possession verified）→ 结果卡填充（Run ID/Files 3/Plaintext 104/Ciphertext 661/Objects 4）→ 状态栏 "EKD snapshot complete"。
- **机器核验**：报告 schema-valid、`snapshot_log_sha256` 与实际日志一致、4 对象/661 密文字节与 ObjectStore 内容吻合、**源 Vault 零写入**（内容区仅原 3 文件）。`run_id=64c6ef53…`、`verdict=pass`。

## 3. 边界

- 面板摘要仍非 ACC-32/33 证据；不升级任何 ACC。
- 无历史报告列表（合同 §2.5 留待后续合同）；"Open report file" 依赖 Electron shell（Windows desktop 行为）。
- 插件 restore 入口仍然不存在（bundle 扫描与源码均无）。
