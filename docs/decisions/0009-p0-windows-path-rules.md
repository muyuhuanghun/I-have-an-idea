# ADR-0009：P0 Windows NTFS 路径与文件名规则

- 状态：已接受（冻结 Phase 0 文档门禁项；执行环境细节随实施冻结）
- 日期：2026-08-27
- 决策者：开发者
- 相关文档：P0-content-policy.md §7、P0-fixture-and-performance-baseline.md §7

## 背景

P0 正式往返验收限定为源 Vault 与目标目录均位于 Windows NTFS 默认行为下（执行计划 §5.4）。当前文档列出了中文路径、Symlink/Junction、大小写碰撞等场景作为 edge-case fixture 必覆盖项，但未冻结具体判定规则。

无冻结规则时，扫描器和恢复器对同一输入可能产生不同行为（路径转义、保留名、大小写折叠），ACC-19/20/21 的 oracle 难以自动判定。本 ADR 冻结 Windows 路径规则，作为路径类 ACC 的唯一判定依据。

## 决策

### 1. 路径有效性判定

Vault 内文件的 `relative_path` 在以下任一情况下视为不合法，扫描器返回 `UNSUPPORTED_FILES_FOUND` 或 `ENTRY_PATH_ESCAPE`（恢复器返回后者）：

1. 路径为空字符串；
2. 路径以 `/` 或 `\` 开头（绝对路径）；
3. 路径以 Windows 盘符前缀开头（如 `C:`）；
4. 路径中含 `..` 段（不论位置）；
5. 路径中含 NUL 字节（0x00）；
6. 路径段以 `.` 开头（隐藏目录/文件）除非用户明确配置允许（默认拒绝）；
7. 路径段匹配 Windows 保留名（CON、PRN、AUX、NUL、COM1-COM9、LPT1-LPT9，大小写不敏感）；
8. 路径段含 Windows 保留字符 `<>:"|?*`（NUL 已包含在第 5 项）；
9. 路径段尾随空格或句点（NTFS 静默裁剪）；
10. 路径超过 32,767 字符（Windows MAX_PATH 限制；P0 不启用长路径支持）。

### 2. 大小写处理

Windows NTFS 默认行为是大小写不敏感但大小写保留。P0 规则：

1. 扫描器以 UTF-8 字节比较路径段，不做大小写折叠（保留原始大小写）；
2. 恢复器在写入目标前对所有 entry 路径段做 Windows 风格大小写折叠比较，碰撞返回 `CASE_COLLISION`（ACC-21）；
3. 合成 Manifest（恶意输入）测试中包含 `README.md` 和 `readme.md`，验证恢复器拒绝；
4. 实际 Windows 目录中不要求物理创建两个冲突文件，合成输入即足以验证（执行计划 §5.4）。
5. v1 的确定性折叠键按 Unicode scalar value 逐个计算：使用无 locale 的一对一大写映射；若大写映射会扩展成多个 scalar value，则保留原 scalar value，不做多字符合并，也不做 NFC/NFD 规范化。最低锚点为 `A/a` 与 `Å/å` 必须碰撞，`k/K` 与 `ss/ß` 必须保持不同。该规则用于共享核心的扫描预检和恢复全量 Manifest 预检，取代只覆盖 ASCII 的实现。

### 3. Unicode 处理

P0 仅处理 UTF-8 编码路径名：

1. 路径段以 UTF-8 解码后存储；
2. 内部比较用字节级，避免 Unicode 规范化差异（NFC/NFD）；
3. 代表性 fixture 包含中文目录和中文文件名；
4. edge-case fixture 包含至少一个含 Emoji 路径段和至少一个含空格路径段；
5. 路径段含未配对代理或无效 UTF-8 时视为不合法（`ENTRY_PATH_ESCAPE`）。

### 4. Symlink 与重解析点

P0 默认拒绝所有重解析点（执行计划 §5.3）：

1. 扫描器检测 Symlink、Junction 和其他重解析点时返回 `REPARSE_POINT_FOUND`；
2. 扫描器不跟随、不读取目标内容；
3. 恢复器在目标目录不接受 Symlink/Junction 作为恢复目标；
4. 路径本身不能是重解析点；
5. 重解析点逃出根目录场景必须返回 `ENTRY_PATH_ESCAPE` 或 `REPARSE_POINT_FOUND`。

### 5. 路径长度与深度

P0 不做路径长度或深度的特殊处理（除 §1.10 的 MAX_PATH 限制）：

1. 实际 fixture 包含至少一个深度 ≥ 5 层的目录；
2. 不测超长路径的边界（受 §1.10 约束，路径已被拒绝）。

### 6. 路径编码（写入 ObjectStore）

Manifest 中 entry 的 `relative_path_utf8` 是 `u32be` 长度前缀后的严格 UTF-8 字节序列（ADR-0011 §6），不使用 NUL 终止，也不含 NUL。恢复器在写入目标前按严格 UTF-8 解码并应用本 ADR 的路径规则。

## 后果

- P0-content-policy.md §7 的路径规则统一到本 ADR；
- ACC-19/20/21 的 oracle 可基于本 ADR 的判定规则自动实现；
- edge-case fixture 必覆盖项明确：路径逃逸、Symlink/Junction、大小写碰撞、空格、Emoji、保留名、隐藏目录；
- 代表性 fixture 必覆盖：中文路径；
- 实施时按本 ADR 实现路径判定，任何偏差需新 ADR。

## 当前参数状态

本 ADR 已冻结路径有效性、大小写、Unicode、重解析点和路径编码；没有本地自由文本待定参数。P0 无论 OS long-path 开关如何都按 §1.10 拒绝超过 32,767 个 UTF-16 code unit 的逻辑路径，隐藏路径按 §1.6 默认拒绝。Node Windows 恢复适配器除 `lstat().isSymbolicLink()` 外还必须检查 `FILE_ATTRIBUTE_REPARSE_POINT`；属性探针不可用或结果不可判定时失败关闭，不得继续写入——探针不可用视为 reparse 风险，按 `REPARSE_POINT_FOUND` 处理，不得报为目标非空。若未来改变，必须新建 ADR 和 DP 项，不能在实现中自行探测后静默改变合同。
