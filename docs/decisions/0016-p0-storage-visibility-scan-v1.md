# ADR-0016：P0 存储可见性扫描合同 v1

- 状态：已接受（2026-08-30 Phase 3D-0 单独授权冻结；Phase 3D-A 单独授权实现与测试）
- 日期：2026-08-30
- 决策者：开发者
- 相关文档：ADR-0015、ADR-0012、`docs/threat-model/P0-security-invariants.md` §3、`docs/test-plans/P0-acceptance-matrix.md` §3.6（ACC-32/33）、`P0_EXECUTION_PLAN.md` §14、`docs/contracts/p0-traceability-v1.json`（THR-01、INV-01、INV-03、ATR-16）、`docs/schemas/storage-visibility-scan-v1.schema.json`

## 背景

执行计划 §14 的第 7 步是服务器可见性报告；ACC-32/33 是 THR-01 的机器验证 oracle（安全不变式 §3.3）。两个 ACC 的正式测试方法都要求先有完整快照 pipeline（Vault 植入 marker → 生成快照 → 扫描 ObjectStore 与进程日志），而 pipeline 属于尚未授权的 Phase 4 范围。

2026-08-30 用户单独授权 Phase 3D 分两步：3D-0 只冻结本扫描合同；3D-A 实现扫描器、CLI 与测试，用 Phase 3B codec 加密播种的 ObjectStore 产生 dirty-source 复审证据，不需要 pipeline。HTTP 服务器视角报告仍属 Stage 7，被 DP-014 阻挡；ACC 状态零变化。

## 决策

### 1. 范围与定位

扫描器是实现 ACC-32/33 机器验证（安全不变式 §3.3）的测试工具，不是运行时组件：不扩展 `ObjectStore` 端口签名，不进入共享核心，不新增公共错误码——工具级失败以 fail-closed 的 `scanner_error` 与非零退出码表达，`p0-traceability-v1.json#error_codes` 零变化。正式 ACC-32 的"Vault 植入 → 快照"流程不在本合同内。

### 2. 扫描输入

两个面：

1. Directory ObjectStore 目录，按纯不可信存储视角扫描——只做目录枚举与字节级内容检查，不使用实现内部状态，不解密、不解析 envelope；
2. 产生该 store 的进程完整 stdout/stderr 捕获原始字节。CLI 不先做 UTF-8 解码，避免非法字节替换改变被扫描输入；扫描器只对 ASCII marker/hex 执行 ASCII case folding，其他字节保持不变。

### 3. 目录结构白名单

条目名必须恰为 canonical 22 字符 base64url key（共享核心 `decodeObjectStoreKeyV1` 校验）或恰为 `<key>.tmp`；其余一律 violation（含子目录）。名字合法但不是常规文件（重解析点、目录、特殊条目）也记 violation，不读取、不跟随。报告允许呈现的元数据仅限不变式 §3.1 清单：canonical key/tmp 名、单文件字节数、mtime、条目计数、总字节数。非法条目名可能本身就是待禁止的原始文件名或 marker，因此报告只记 violation 类型和字节偏移，绝不回显非法名字。

### 4. 禁止内容黑名单（大小写不敏感，字节级）

- marker 族冻结为三个前缀：`FILENAME_MARK_`、`CONTENT_MARK_`、`PATH_MARK_`；每次运行必须为三族各提供至少一个带非空后缀的唯一实例。实例不得在 ASCII case folding 后重复或互为子串，扫描器拒绝前缀之外或三族覆盖不全的输入（fail-closed）；
- 已知秘密至少包含本次运行可获得的 recovery root、Domain Data Root、Manifest Key、Object Wrap Key，并在编排存在后包含每对象随机 key；每项必须是安全 label 加恰好 32 字节 hex。扫描同时检查原始 32 字节和大小写不敏感 ASCII hex 两种表示；发现项只记安全 label 与 `raw`/`hex`，不回显秘密字节；
- 文件名中的冻结扩展名 token：`.md`、`.markdown`、`.canvas`、`.pdf`、`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.svg`；
- store 条目 offset 0 的冻结 content-type magic：`%PDF`、`\x89PNG`、`\xff\xd8\xff`、`GIF8`、`RIFF`、`PK\x03\x04`——对密文是弱负面测试，如实标注强度。

内容扫描覆盖 key/tmp 常规文件字节与日志原始字节；violation 名字条目不读内容（名字本身已违规）。发现项只记录 surface、kind、安全 pattern 标识与字节 offset：marker 只记录 `filename`/`content`/`path` 族名，非法名字不进入 `entry`，秘密只记录经过词汇校验的 label。报告不得包含 marker 实例、秘密值、非法文件名或明文上下文摘录，避免扫描报告自身成为 ACC-33 泄漏源。

### 5. 扫描器自测（防伪通过）

每次扫描必须先对 control artifact 复用同一 marker 检测路径。`plantedMarkers` 必须等于配置 marker 数，每个配置 marker 在 control 中必须恰好出现一次；报告以不透明 `marker-NNN` 加族名逐项记录 occurrence。不能只比较总数——“漏一个、另一个重复一次”也必须失败。任一逐项计数不等于 1 即自测失败，verdict 必须为 fail，不得给出 store/log 的 pass。

### 6. 输出 schema

`storage-visibility-scan-v1` JSON：`verdict`（fail 当且仅当 scanner_error、自测失败或任一 forbidden finding 存在）、`scanner_error`、`entries_total`、`entries_by_kind{key,tmp,violation}`、`total_bytes`、`allowed_metadata[]`、`forbidden_findings[]`（上限 10000，超出置 `findings_truncated`）、`forbidden_counts{store,log}`、逐 marker 的 `scanner_selftest`、以及不含实例值的 `inputs{marker_count,marker_families_covered,known_secret_labels,log_bytes_scanned}`。正式机器结构由 `docs/schemas/storage-visibility-scan-v1.schema.json` 冻结，并接入 `verify_phase0_contracts.py --validate-samples` 的正反样例门；本阶段输出是 dirty-source 复审材料，不是 `acc-32-metadata-leak.json` 或 `acc-33-visibility-report.json` 正式 evidence。

### 7. 失败关闭

root 缺失/非目录/重解析点、目录不可列、条目状态不可检查或不可读、marker 越出冻结前缀或含非 ASCII、marker 三族不全/重复/互为子串、secret label 不安全、secret 不是 32 字节、control 逐项自测失败、日志字节缺失等一律 fail。输入或 I/O 失败带 `scanner_error`；纯自测不一致由 `scanner_selftest.pass=false` 表达。扫描器不抛出适配器错误类型，不静默降级为 pass，不返回部分结果冒充成功。CLI 的参数语法/报告输出失败为 exit 2；已经进入扫描但输入文件不可读则仍产出 fail JSON 并 exit 1。`--output` 必须是 ObjectStore root 外尚不存在的新文件：先做词法 containment，再解析输出父目录以拒绝 junction/symlink alias，最后用独占创建，防止扫描后写回 store 或借现有 hardlink/symlink 改写对象。

### 8. 实现落位

核心扫描器位于 `packages/adapters/src/storage-visibility-scanner.ts`（受 lint/typecheck/build 门禁），CLI 薄封装 `tools/storage-visibility-scan.mjs`（依赖 `@ekd/adapters` 构建产物，`pnpm build` 后可用）。key 校验复用共享核心 `decodeObjectStoreKeyV1`。测试必须覆盖：逐 marker 自测防伪与总数替换攻击、三族覆盖、白名单与非法名字脱敏、marker/秘密 raw+hex/扩展名/magic 检出、报告自身不含禁止实例、真实 seal→put 播种端到端、失败关闭路径、CLI 输出路径 containment，以及 JSON Schema 正反样例。

## 后果

- ACC-32/33 保持 `untested`；正式证据仍要求快照 pipeline（Vault 植入 → 快照 → 扫描）并按 P0-R1 证据门执行，本合同不产生任何 ACC evidence。
- DP 状态零变化；DP-014 与 HTTP 服务器视角报告边界不变。representative 规模（约 10k 文件）下的扫描性能与内存属于运行限制，关联 DP-012 的 runtime-limits 产物，不在本合同冻结。
- 机器 registry 无新增错误码；`python tools/verify_phase0_contracts.py` 必须保持 PASS。

## 当前参数状态

扩展名与 magic 清单在本 ADR §4 冻结；marker 具体实例、已知秘密值与 control artifact 是运行时敏感输入，报告只记录数量、覆盖族和安全 label，不记录值。正式 ACC harness 还必须证明其提供了本次运行全部可获得的秘密角色，并把完整 stdout/stderr 捕获与对应进程运行 hash-bind；扫描器能验证每个已提供值和字节，却不能独立证明调用方没有漏传秘密或截短日志。无待定 wire 参数。
