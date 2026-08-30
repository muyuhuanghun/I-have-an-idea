# ADR-0015：P0 Directory ObjectStore v1 合同

- 状态：已接受（2026-08-30 Phase 3C-0 单独授权冻结；Phase 3C-A 单独授权实现与测试）
- 日期：2026-08-30
- 决策者：开发者
- 相关文档：ADR-0003、ADR-0009、ADR-0011、ADR-0012、P0-recovery-and-object-format.md §4/§7/§8、P0_EXECUTION_PLAN.md §14、`docs/contracts/p0-traceability-v1.json`

## 背景

共享核心的 `ObjectStore` 端口自 Phase 0 起只声明 `put(key, value)` 与 `get(key)`，Phase 3B 的纯内存编解码不调用它。执行计划 §14 的第 6 步是 Directory ObjectStore；HTTP ObjectStore 属于 Phase 7，且被 DP-014 的 hard stop 阻挡。

2026-08-30 用户单独授权 Phase 3C 分两步：3C-0 只冻结本合同的八个语义面（不可变写入、原子发布、碰撞返回、路径 containment、Windows reparse point、部分写入清理、耐久性、错误归一化）；3C-A 实现并测试 Node Directory adapter。HTTP ObjectStore、snapshot pipeline、恢复流程、插件接线、Phase 4 仍然禁止；ACC 状态全部保持 `untested`，不关闭任何 DP。

## 决策

### 1. 范围与端口

Directory ObjectStore 是 `ObjectStore` 端口在文件系统目录上的实现：一个扁平目录，每个对象恰好一个文件，文件名是 §4.1 冻结的 ObjectStore key。P0 不提供 delete、list、rename、GC 或大小限制；端口签名不扩展。Obsidian/浏览器内 ObjectStore 不在本 ADR。

### 2. 键校验与路径 containment

1. 每次 `put`/`get` 的 key 必须先通过共享核心 `decodeObjectStoreKeyV1` 的 canonical 校验：恰好 22 字符 RFC 4648 base64url 无 padding，解码为 16 字节且重编码 canonical；任何失败返回 `OBJECT_ID_INVALID`。
2. 文件系统布局只有一种：`join(root, key)`。canonical base64url 字母表不含路径分隔符和 `..`，因此遍历逃逸在构造上不可能；store 永不创建子目录，永不拼接 canonical 校验以外的名字。
3. root 在每次操作前校验：必须存在、是真实目录、不是符号链接/重解析点（`lstat`）。root 是链接返回 `REPARSE_POINT_FOUND`；缺失或非目录返回 `OBJECT_STORE_IO_FAILED`。root 祖先链上的链接属于操作者配置，与本合同无关（与 `VaultSource` 一致）。
4. 目录中不是合法 key 的额外文件对 `get`/`put` 不可见；store 不扫描、不清理它们（临时文件除外，见 §6）。

### 3. 不可变写入与原子发布

`put(key, value)` 顺序：

1. 校验 key 与 root；
2. `lstat` 目标：存在且是重解析点返回 `REPARSE_POINT_FOUND`；存在任何其他条目视为碰撞（fast path，见 §4），绝不覆盖；
3. 写临时文件 `<key>.tmp` 于同一目录，先移除陈旧临时文件（仅容忍 `ENOENT`），再以独占创建打开；
4. 写入全部字节并 `fsync` 文件句柄（所有平台强制）；
5. 用硬链接 temp→target 发布：create-if-absent 原子生效，`EEXIST` 是碰撞的权威信号。禁止任何 rename/overwrite 路径，读者只会看到完整对象或缺失；
6. 删除临时文件；
7. 目录项耐久性：POSIX 强制 `fsync` root 目录句柄；Windows 上 Node 无法对目录句柄 fsync，冻结的平台边界是"文件 fsync + 原子硬链接发布"，依赖 NTFS 日志。这是已接受的 P0 限制，不得声称更强保证。

发布后清理临时文件或目录同步失败：返回 `OBJECT_STORE_IO_FAILED`，对象保持已发布且完整；同 key 重试得到碰撞，语义一致。

`get(key)` 顺序：校验 key 与 root；`lstat` 目标——缺失返回 `undefined`（幂等缺席；`MISSING_OBJECT` 仍是恢复层在协议违反时使用的码）、重解析点返回 `REPARSE_POINT_FOUND`、目录/特殊条目返回 `OBJECT_STORE_IO_FAILED`；随后读取文件，`ENOENT` 视为缺席，其余错误归一化。同一 key 多次 GET 返回相同不可变字节（§8），每次返回独立缓冲区。

### 4. 碰撞返回

发布时目标已存在 → `OBJECT_ID_COLLISION`，无状态变化：已发布对象不动、无临时文件残留。这是协议 §4.1 编排层"碰撞→重新生成 ID、nonce、密文"循环所消费的同一冻结错误码；store 层永不覆盖、永不重发布。同进程内同一实例对同一 key 的操作串行化：并发同 key put 首个成功，后续返回 `OBJECT_ID_COLLISION`。跨进程并发同 key put：至多一个对象被发布，失败方观察到 `OBJECT_ID_COLLISION` 或 `OBJECT_STORE_IO_FAILED`，任何 torn/partial 对象都不可见（原子发布不变量）。在大小写不敏感文件系统（Windows NTFS）上，仅大小写不同的两个 canonical key 共享同一目录项：后发布者得到 `OBJECT_ID_COLLISION` 并重新生成 ID，不可变性不被破坏。

### 5. Windows reparse point

按 ADR-0009 §4：root 与目标条目都做 `lstat` 检测；符号链接、junction 和其他重解析点返回 `REPARSE_POINT_FOUND`；不跟随、不读取目标内容、不替换。检测惯例与 `NodeVaultSource` 一致（`lstat` 的符号链接分类同时覆盖 symlink 与 junction）。

### 6. 部分写入清理

临时文件名恰为 `<key>.tmp`：含 `.`，永远不会是合法 key，因此对 `get`/`put` 不可见。清理义务：创建前移除陈旧临时文件（只可能来自崩溃进程）、创建后任何失败路径删除临时文件。崩溃遗留的孤儿临时文件由同 key 的下一次 put 移除；没有后台 GC，没有 list 操作。

### 7. 耐久性

发布前文件 `fsync`：所有平台强制。发布后目录 `fsync`：POSIX 强制，Windows 不可用（§3 的冻结边界）。发布后不再重写字节；不可变性保证已发布 inode 的内容不被修改。

### 8. 错误归一化

适配器只有一种公共错误类型 `ObjectStoreAdapterError`：稳定 `code`、涉事 `key`（root 级问题为 `.`）、消息与保留 `cause`。公共码恰好四个：

| code | 触发 |
|---|---|
| `OBJECT_ID_INVALID` | key 非 canonical |
| `OBJECT_ID_COLLISION` | 发布时目标已存在 |
| `REPARSE_POINT_FOUND` | root 或目标条目是重解析点 |
| `OBJECT_STORE_IO_FAILED` | 其余一切：ENOSPC/EACCES/EIO/ENOTDIR、fsync 失败、临时文件创建或清理失败、root 缺失或非目录等 |

`OBJECT_STORE_IO_FAILED` 按 ADR-0012 §5 的机制补入 `p0-traceability-v1.json#error_codes`（机器 registry 仅 +1）；不新增其他码，provider/OS 内部诊断不越过边界。所有失败关闭：put 不在没有完整已发布对象时报告成功，get 永不返回部分字节。

## 后果

- 实现位于 `packages/adapters`（Node adapter），只用 `node:fs/promises`，无 native 依赖；exFAT/FAT32/网络盘不支持硬链接时按 `OBJECT_STORE_IO_FAILED` 失败关闭。P0 正式矩阵仍只覆盖 Windows NTFS（执行计划 §5.4）。
- ACC-32/33 仍是 THR-01 的 oracle，状态保持 `untested`；本合同不产生任何 ACC evidence。DP-014 不变；不得把本合同外推为网络传输安全声明。
- 设计合同静态门禁（`python tools/verify_phase0_contracts.py`）必须在 registry 变更后保持通过。

## 当前参数状态

本 ADR 无待定参数。ID 碰撞重生成循环的重试上限由编排层作为运行限制固定并记录（关联 DP-012 的 runtime-limits 产物），不属于本合同。
