# Phase 5-B Obsidian 插件接线报告

> 日期：2026-09-04；独立复审裁决：2026-09-05
>
> 状态：开发者确认独立复审 PASS 并授权进入本地纳管步骤；代码已由 `18c9b77` 纳管，状态文档随后的 docs 提交纳管，尚未推送
>
> 基线：`10666cd3edb0e8b20fbfb18b8e3e5044c32005e0`（当时 `HEAD = origin/main`）
>
> 合同：ADR-0021 §2；只实现插件快照创建，不加入 restore 入口，不改变 core 协议

## 1. 本轮实现

1. **极薄快照入口**：Obsidian 新增 `Create P0 snapshot` 命令，只调用共享 `createSnapshotV1`。密码提供方固定为 `@ekd/crypto/webcrypto`，没有复制 HKDF、AEAD、Manifest、object ID 或 Recovery File 编码。
2. **Windows 桌面边界**：当前 Directory ObjectStore、snapshot log 与 Recovery File 都是 Node 文件系统适配器，因此快照命令仅在 Windows desktop Obsidian 开放；现有 Windows/Android Phase 1 smoke 命令继续保留。插件仍可在 Android 顶层加载，但 Android 调用快照命令会明确拒绝。
3. **全部显式配置**：设置页持久化 64 位小写 hex `domainId`，并要求用户分别提供 ObjectStore、snapshot log、Recovery File、runtime-limits 合同与插件报告的绝对路径，不提供默认路径。活动操作期间拒绝设置变更；快照运行本身不调用 `saveData`，不向源 Vault 写 domain 文件、缓存或 marker。
4. **源 Vault 只读适配器**：`ObsidianVaultSource` 已从占位实现变为公共 Obsidian Vault API 的只读绑定；按 UTF-8 原始字节顺序列举文件，每次读取都核对列举戳、读前戳、读后戳和字节长度。Windows 插件另注入逐路径段 `lstat` 检查，拒绝 symlink/junction、特殊条目、路径逃逸和扫描中消失的文件。
5. **真实路径隔离**：运行前对 Vault、ObjectStore、log、Recovery File 与插件报告做两两物理身份比较。已存在路径使用 `realpath`；尚不存在的输出使用“真实父目录 + basename”。因此祖先 Junction 与 Windows 路径别名不能把输出绕回源 Vault或 ObjectStore。报告目标还要求真实父目录、预先不存在并以 `wx` 排他创建。
6. **runtime-limits 三方绑定**：构建脚本内嵌 `docs/contracts/p0-runtime-limits-v1.json` 的实际字节；插件同时检查内嵌字节、用户指定磁盘文件与 `PLUGIN_ACCEPTED_RUNTIME_LIMITS_SHA256`，并核对两侧 `schema_version`。Python 静态门把该常量再次绑定到仓库合同实际字节。
7. **端口派生进度**：没有修改 core，也没有新增 progress port。VaultSource 装饰器显示扫描数；SnapshotLogSink 拦截 `preflight_complete`、`file_published`、`snapshot_prepared` 显示文件数、累计明文字节和加密序号；RecoveryFileTarget 在排他写入并逐字节回读完成后显示持有性完成。UI 回调异常被隔离，不改变协议结果。
8. **密文字节与可见性摘要**：ObjectStore 装饰器只在底层 `put()` 成功后累计对象数、对象键和密文字节，不回读对象。完成后要求对象计数与 core 结果一致、键均为 22 位 canonical base64url 且不包含完整明文路径。报告明确标注 `plugin-summary-not-formal-acc-32-or-33`。
9. **第 10 份机器报告 schema**：新增 `p0-plugin-snapshot-report-v1.schema.json`，包含 run/snapshot ID、domainId 的 SHA-256（不含 domainId 明文）、runtime-limits hash、文件数、明文/密文字节、可见性摘要、snapshot-log 实际字节 SHA-256、起止时间与 `verdict=pass`。只有完整快照才生成报告；schema-invalid 报告在写入前拒绝；目标文件不覆盖。
10. **bundle 边界收窄**：`@ekd/adapters` 声明 Obsidian source、Node ObjectStore、Node snapshot I/O 与 errors 四个子入口。插件只动态加载这些子入口；Python 静态门拒绝 restore surface 与适配器总入口，插件构建脚本再次扫描最终 bundle，发现 `NodeRestoreTarget`、`restoreSnapshotV1` 或 `p0-restore` 即失败。Node 模块只在 Windows 快照命令实际执行后加载，保留 Android smoke 的顶层加载能力。

## 2. 验证结果

- `pnpm run test:all` → **exit 0**：ESLint、六个 workspace typecheck、164 个 TypeScript tests、12 个 Python tests、shared-core import gate 与全部 workspace build均通过。
- `packages/adapters` → **61/61 tests PASS**；其中 Obsidian 适配器新增正常只读、扫描中变化、读取失败归一化和注入式路径检查覆盖。
- `apps/obsidian-plugin` → **8/8 tests PASS**；覆盖共享核心真实快照、进度事件、密文字节/对象计数、domainId 不以明文进入报告、失败快照不出 pass 报告、schema-invalid 报告不写入、真实 Obsidian source + Node 输出适配器端到端、源 Vault 字节不变、Junction 输出别名拒绝、Vault 内链接段拒绝、跨检查的文件身份/元数据变化拒绝、报告排他写。
- `python -B tools/verify_phase0_contracts.py --validate-samples --evidence-root artifacts` → **PASS**，当前为 10 份 schema 的 10 对正/负样本；历史 P0-R1 artifacts 仍绑定 clean commit `9443cb1`，该通过不把提交前的 dirty Phase 5-B 验证升级为正式 ACC evidence。
- 构建产物静态检查：`p0-create-snapshot` 存在；`p0-restore`、`NodeRestoreTarget` 和 restore adapter 文本均不存在。
- 模拟 Android 顶层加载：用最小 Obsidian API stub 加载 `dist/main.js` → `PLUGIN_BUNDLE_TOP_LEVEL_LOAD_PASS`，加载期间 Node 模块列表为空。
- `git diff --check` → **PASS**（仅有 Git 的 LF→CRLF 工作区提示，无 whitespace error）。

## 3. 未声称的内容

- 本轮没有在真实 Obsidian GUI 中手工点击命令，也没有形成物理设备/真实 UI 证据；现有结论来自 TypeScript 集成测试、真实 Windows 文件系统 I/O、bundle 审计与统一门禁。
- 插件可见性摘要不是 ACC-32/33 扫描器输出，不重新打开或替代 `9443cb1` 的正式 R1 evidence。
- 没有插件 restore 命令、restore UI 或恢复编排；正式恢复仍只由 CLI fresh process 承担。
- 没有 HTTP ObjectStore；DP-014 继续保持 `deferred`。
- 上述实现测试在提交前的 dirty source 上执行，属于实现级验证，不是 clean-build Obsidian UI 运行证据。开发者随后给出的独立复审 PASS 关闭评审门，但不升级 ACC，也不授权推送。

## 4. 当前门槛

开发者于 2026-09-05 确认独立复审 PASS，并以“授权进入下一步”授权 ADR-0021 约定的本地 feat + docs 两提交：代码提交为 `18c9b77`，本报告与状态对账随后的 docs 提交纳管。该授权不包含 push；下一门槛是明确的推送授权与远端核对，在此之前不得进入 Phase 6。任何正式 Obsidian UI/设备运行证据仍应在 clean commit 构建后单独产生，不能用本轮 dirty-source 测试替代。
