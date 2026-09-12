# P1 网页控制台插件宿主接线 GUI 验证报告（ADR-0031 §13）

- 切片：插件宿主接线（DP-027 关闭后的增量小切片，开发者 2026-09-12 授权）
- 提交：合同增补 `4fc105e`、实现 `e63c063`、按钮修复与本报告（见最新提交）
- 结果：**通过** —— 插件宿主内嵌只读状态服务在真实 Obsidian 1.13.7（Windows 桌面）完整可用，任务 ring 接入真实快照数据源

## 1. 验证环境

- Obsidian 1.13.7（`D:\Obsidian\Obsidian.exe`），测试 Vault `artifacts/gui-test-vault`（经 `obsidian.json` 切换，验证后已恢复原配置备份 `obsidian.json.bak-console-test`）
- 插件 bundle = `pnpm build` 产物（main.js + build-meta.json + manifest.json），`data.json` 预写 `consoleEnabled: true`

## 2. 验证路径与观察

1. **随插件自动启动**：Obsidian 加载后服务即监听 `127.0.0.1:<临时端口>`；面板出现"打开状态页"按钮与说明文案（`consoleAvailable()` 生效）。首次启动失败路径也被覆盖：Vault 插件目录缺 `build-meta.json` 时启动失败 → Notice 提示且开关如实回滚为关（部署需要完整拷贝 dist 产物，已记入报告教训）。
2. **面板按钮**：点击"打开状态页"经 `shell.openExternal` 打开系统浏览器（URL 无凭据），页面完整渲染。
3. **任务 ring 喂养（真实数据源）**：通过面板触发三次快照——
   - 第 1 次：preflight 失败 `UNSUPPORTED_FILES_FOUND`（Vault 含 `.base` 文件）→ 任务区红色条目"快照·失败(UNSUPPORTED_FILES_FOUND)·48ms·对象0·密文0 B"；
   - 第 2 次：目标未清理失败 `LOG_WRITE_FAILED`（独占创建语义，前次失败已写日志文件）→ 红色条目"4ms·对象0"；
   - 第 3 次：清理后**完成**——绿色条目"快照·完成·83ms·对象4·密文661 B"，状态栏与结果卡同步"3 file(s), 104 plaintext / 661 ciphertext byte(s)"。
4. **报告摘要**：完成后状态页"报告摘要（本会话）"显示 `p0-plugin-snapshot-report-v1 / pass / created_at=completed_at / 对象4 / 密文总字节661`（内存摘要，符合 §7.0）。
5. **存储聚合**：状态页实时显示 ObjectStore 密文侧统计（两次运行后 8 对象 / 1322 字节）。
6. **诚实语义**：head 恒"未检查/无有效 head"（插件不使用 P1 状态协议）；失败条目计数为 0 且仅 status+error_code 表达事实；checked_at 脚注在场。
7. **安全面**：服务本体零改动——Web 安全结论由 DP-027 的 WEB-ACC-44..49 正式证据继续覆盖（gate 顺序、token 自举、白名单 DTO、只读 surface）；本切片单元测试（5 项）覆盖包装层启停/数据源/白名单扫描。

## 3. 发现并修复的缺陷

1. **面板按钮陈旧渲染（已修复）**：失败路径的 catch 在 `#running` 仍为 true 时渲染面板，`finally` 重置后未再同步——按钮停留在"Snapshot running…"禁用态。修复：`finally` 中补 `#syncSnapshotView()`。
2. **部署完整性教训**：Vault 内插件目录必须包含 `build-meta.json`（`#loadBuildMeta` 校验 bundle sha 用）；仅拷 main.js 会导致 console 启动失败（如设计回滚）。

## 4. 门禁

- `pnpm run test:all` exit 0（插件测试 16 项，其中 console-host 包装层 5 项）
- 机器门不受影响：本切片无 registry/schema/错误码变化，`PHASE0_CONTRACT_CHECK_PASS mode=design-only+samples ACC=49 INV=24 THR=11 DP=27`

## 5. 边界声明

- 本报告为实机 GUI 功能验证，不新增/升级任何 ACC；Web 安全证据以 `9c160ce` 的 WEB-ACC-44..49 为准。
- 服务默认关闭；开启行为、诚实语义与停止点以 ADR-0030/0031（含 §13）为准。
