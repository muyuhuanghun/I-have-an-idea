# P0 恢复文件、Manifest 与密文对象格式

> 文档版本：v0.5
> 当前状态：wire contract v1、Suite 1、Directory ObjectStore、存储可见性扫描及 Phase 4 snapshot/restore 编排均已实现并纳管。后续虽然生成了 37 份 candidate evidence，但 2026-08-31 复审发现其内层 perf/schema/provenance 与多个 required oracle 不成立，不能算正式 ACC evidence；关闭报告已撤回，37 ACC 继续 `untested`。协议实现状态不因此回退，但 P0-R1、插件产品接线和 HTTP ObjectStore 解锁均未成立。
> 日期：2026-08-30
> 当前权威：ADR-0011、ADR-0012、ADR-0013、ADR-0015、ADR-0016、ADR-0017、ADR-0018、`docs/contracts/p0-wire-contract-v1.json`、`docs/contracts/p0-traceability-v1.json`、`docs/contracts/p0-deferred-parameters.json`、`docs/contracts/p0-runtime-limits-v1.json`、`docs/schemas/storage-visibility-scan-v1.schema.json`、`docs/schemas/p0-runtime-limits-v1.schema.json`

## 1. 职责和权威顺序

本文件解释 P0 fresh-process 恢复链和 wire format。出现冲突时按以下顺序裁决：

1. `docs/contracts/p0-wire-contract-v1.json`：字段顺序、字节长度、端序、HKDF 标签；
2. ADR-0011：语义、安全边界和取代关系；
3. 本协议：流程、错误和版本策略；
4. ADR-0002/0005/0006/0007：历史决策背景。被 ADR-0011 取代的部分不得用于实现。

当前文档闭合的是可实现的设计合同，不是实现或测试通过证据。所有 37 项 ACC 仍为 `untested`。

## 2. 无循环依赖的 fresh-process 恢复链

### 2.1 输入

唯一声明的恢复输入是：

- Vault 外的 Recovery File v1；
- 与它对应的 ObjectStore。

没有口令、keystore、第二秘密、本地缓存或源进程内存。Recovery File 是 32 字节高熵 `recovery_root` 的 bearer file；文件失窃等价于域解密能力失窃。

### 2.2 流程

```text
1. 要求恢复文件恰好 167 字节；检查 magic、版本和 suite
2. 读取 recovery_root，按 ADR-0011 派生 Recovery File Integrity Key
3. 常数时间验证 HMAC-SHA256(file[0:135])；失败时不返回部分结构
4. 从已验证恢复文件取得 domain_id、snapshot_id、manifest_object_id
5. GET manifest_object_id，解析 Object Envelope 的 19 字节 header
6. 用恢复文件字段 + envelope header 构造完整 101 字节 Manifest AAD
7. 派生 Manifest Key，AEAD 解密并认证 Manifest
8. 验证 Manifest 内 domain_id/snapshot_id/suite 与 AAD 输入逐字节一致
9. 对每个 entry 解包对象密钥；用 Manifest 字段 + 对象 envelope 构造文件 AAD
10. GET、AEAD 解密文件对象，先恢复到新建空目录的受控临时位置
11. Python 独立验证器比较全部受支持文件的相对路径集合和 SHA-256
12. 只有验证全部通过才报告成功；任何部分写入不得报告为成功
```

`snapshot_id` 在恢复文件中先于 Manifest 解密可得，因此 Manifest AAD 不再依赖待解密明文。`recovery_root` 直接存在于 bearer file 中，因此恢复文件 HMAC 不再依赖“先解密自己才能取得的密钥”。

### 2.3 恢复文件字段

Recovery File v1 是固定 167 字节：

| 字段 | 字节数 | HMAC 覆盖 | 说明 |
|---|---:|---|---|
| magic (`EKDR`) | 4 | 是 | 固定 ASCII |
| recovery_format_version | 1 | 是 | v1 = `0x01` |
| protocol_version | 1 | 是 | v1 = `0x01` |
| domain_id | 32 | 是 | 随机不透明标识 |
| suite_id | 1 | 是 | DP-002 关闭后取得有效值 |
| recovery_root | 32 | 是 | bearer secret；无独立静态加密 |
| snapshot_id | 32 | 是 | 构造 Manifest AAD 所需 |
| manifest_object_id | 16 | 是 | 原始 object ID 字节，不是文本 |
| non_secret_fingerprint | 16 | 是 | 按 ADR-0011 公式由 domain ID 计算 |
| integrity_tag | 32 | 否（自身） | HMAC-SHA256 |

指纹不是自哈希：它是 domain ID 的显示辅助，也被 HMAC 覆盖。解析器拒绝任何缺项、长度不符或尾随字节。

### 2.4 恢复文件禁止包含

- 原 Vault 绝对路径；
- 笔记正文、文件名、扩展名或内部链接；
- 账号密码；
- 未定义的口令、账号秘密或 keystore 引用；
- recovery root 的重复副本；
- JSON、平台原生结构体或其他可能产生多种字节表示的替代编码。

### 2.5 HMAC 的诚实边界

HMAC key 由文件内的 bearer secret 派生。它可以让解析器拒绝非自洽的损坏/位翻转，但任何能读取 Recovery File 的人已经取得 recovery root，也能重新计算标签。P0 不得据此声称：

- 恢复文件具有独立防篡改锚；
- 恢复文件静态加密；
- 给定快照是最新快照；
- 可检测合法旧恢复文件 + 匹配旧 ObjectStore 的整体替换。

Manifest/Object AEAD 认证给定快照的内部自洽，不提供外部新鲜度。

## 3. Canonical 字节规则

所有 v1 编码统一遵守：

- `u8/u16/u32/u64` 都是无符号大端；
- 固定字段必须恰好满足固定长度；
- 变长字段必须使用合同指定的 `u16be/u32be/u64be` 长度；
- 字符串是严格 UTF-8，不接受替换字符式容错；
- 路径不用 NUL 终止，不含 NUL；
- 不允许尾随字节；
- canonical 编码中不使用 JSON、locale、平台路径分隔符或原生端序；
- Manifest entry 按 `relative_path_utf8` 原始字节严格升序；重复或逆序拒绝。

## 4. Object ID 和 ObjectStore key

### 4.1 固定长度与编码

- object ID：CSPRNG 生成的 16 个原始字节（128 位）；
- Manifest 和文件对象使用相同长度；
- wire contract 和 AAD 中始终使用 16 个原始字节；
- ObjectStore key：这 16 字节的 RFC 4648 base64url 无 padding 编码，恰好 22 字符；
- Hex、带 `=` 的 base64url、普通 base64、大小写改写、语义前缀和非 canonical 别名全部拒绝。

object ID 不得是内容哈希或带域前缀。10,000 对象规模下 128 位随机 ID 的碰撞概率可忽略，但实现仍须在加密前做存在性检查；碰撞时重新生成 ID、nonce 和密文。重试上限由实现固定并作为运行限制记录，耗尽返回 `OBJECT_ID_COLLISION`。

### 4.2 wrong-ID substitution

调用方先把 ObjectStore 文本键 canonical 解码为 16 字节，并与 Manifest/Recovery File 中期望 ID 比较；随后该 ID 进入 101 字节 AAD。把合法对象复制到新 ID 并改写未认证引用时，ID 比较或 AEAD 必须失败，返回 `OBJECT_ID_INVALID`、`OBJECT_AAD_MISMATCH` 或 `MANIFEST_AEAD_FAILED`，不得返回部分明文。

### 4.3 Directory ObjectStore（ADR-0015）

Directory ObjectStore 是 `ObjectStore` 端口的文件系统目录实现：一个扁平目录，文件名恰为 canonical ObjectStore key，任何 key 先过共享核心 canonical 校验（失败 `OBJECT_ID_INVALID`）。put 以"写 `<key>.tmp` + 文件 fsync + 原子硬链接发布 + 删除临时文件"实现不可变发布：目标已存在返回 `OBJECT_ID_COLLISION`（§4.1 编排循环消费的同一信号），永不覆盖；get 缺失返回"未定义"（`MISSING_OBJECT` 仍是恢复层的协议违反码），同 key 幂等读取。root 与目标条目按 ADR-0009 §4 拒绝所有重解析点（`REPARSE_POINT_FOUND`）。耐久性为文件 fsync 强制加 POSIX 目录 fsync；Windows 上 Node 无法对目录句柄 fsync，冻结边界是"文件 fsync + 原子发布 + NTFS 日志"。其余文件系统错误归一化为 registry 新增的 `OBJECT_STORE_IO_FAILED`。完整语义权威是 ADR-0015；HTTP ObjectStore 属 Phase 7，受 DP-014 阻挡。

## 5. Object Envelope 与 AAD

Object Envelope v1 的 header 固定 19 字节，后接 nonce/ciphertext/tag。总文件长度必须严格等于三段声明长度与 19 之和。suite registry 是 nonce/tag 长度的外部权威；对象自报长度不能扩大或改变 suite 参数。

AAD 固定 101 字节，字段为：`EKDA`、AAD/对象/协议版本、suite、object type、domain ID、object ID、snapshot ID、nonce/ciphertext/tag 长度。精确顺序见 ADR-0011 和机器合同。

Manifest 的 AAD 输入来自 Recovery File + envelope；文件的 AAD 输入来自已认证 Manifest + envelope。AAD 不从待解密明文取值。

## 6. Canonical Manifest

Manifest 明文由固定 header 和 `entry_count` 个 entry 组成。固定 header 含 `EKDM`、Manifest 版本、domain/snapshot/parent snapshot、内容策略版本、suite 和 entry count。

每个 entry 使用：

- `u32be relative_path_length` + 严格 UTF-8 路径字节；
- 16 字节 object ID；
- `u64be plaintext_size`；
- `u16be wrapped_key_length` + wrapped object key。

P0 Manifest 只列文件对象，因此 entry 不重复携带 object type。若未来允许嵌套 Manifest，必须提升 Manifest format version。路径排序、重复路径、重复 object ID、大小不符和未消费尾随字节都有稳定错误码和 ACC oracle。

## 7. 规范错误

当前错误码权威是 `docs/contracts/p0-traceability-v1.json#error_codes`。与本格式直接相关的错误至少包括：

- `RANDOM_SOURCE_SHORT_READ`、`RANDOM_SOURCE_FAILED`、`RANDOM_SOURCE_ALL_ZERO`；
- `RECOVERY_FIELD_MISSING`、`RECOVERY_TRUNCATED`、`RECOVERY_TRAILING_BYTES`、`RECOVERY_INTEGRITY_FAILED`；
- `RECOVERY_VERSION_UNSUPPORTED`、`RECOVERY_SUITE_UNKNOWN`；
- `MANIFEST_AEAD_FAILED`、`MANIFEST_VERSION_UNSUPPORTED`、`MANIFEST_SUITE_UNKNOWN`、`MANIFEST_FORMAT_INVALID`、`MANIFEST_TRAILING_BYTES`；
- `OBJECT_ID_INVALID`、`OBJECT_AAD_MISMATCH`、`OBJECT_AEAD_FAILED`、`OBJECT_TRUNCATED`、`OBJECT_TRAILING_BYTES`；
- `OBJECT_ID_COLLISION`、`OBJECT_STORE_IO_FAILED`；
- `MISSING_OBJECT`、`DUPLICATE_OBJECT_REFERENCE`、`ENTRY_PATH_DUPLICATE`、`ENTRY_SIZE_MISMATCH`。
- `RESTORE_TARGET_WRITE_FAILED`：恢复目标创建父目录或写文件失败；失败结果必须带不含原始路径的部分输出 inventory。

三个 `RANDOM_SOURCE_*` 是共享公共错误码：请求字节数不符、随机源调用失败或返回全零哨兵值时，Recovery File、object ID、object key 和 nonce 生成都必须失败关闭并保留对应码。它们在 Phase 1 `random-source-errors` 冻结向量和正式三环境报告中已经使用；2026-08-30 只把既有语义补入机器 registry。provider 内部 `OBJECT_KEY_UNWRAP_FAILED` 不属于公共 codec 合同，必须在核心边界收敛为 `OBJECT_AEAD_FAILED`。

解析/认证失败时不得用异常文本代替稳定错误码；不得返回部分解析结构或部分明文。

## 8. 重放与回滚边界

同一 object ID 多次 GET 相同不可变字节是幂等读取。单快照内的篡改、截断、缺失、wrong-ID substitution 和重复引用必须失败关闭。

P0 没有 latest pointer、可信计数器或外部 freshness anchor。合法旧 Recovery File 与匹配旧 ObjectStore 的整体替换可以内部验证通过；这是 THR-04 的已接受限制，必须由 ACC-37 检查关闭报告是否诚实声明。

## 9. 版本策略

Recovery File、Object Envelope、AAD 和 Manifest 各自有格式版本。任何字段增删、字段顺序、端序、HKDF info、object ID 长度、文本编码或认证覆盖变化，都必须提升对应格式或 protocol version，并通过新 ADR 与新 KAT。

不得把按旧 85 字节 AAD、NUL 终止路径、可变 object ID 或 recovery material AEAD 候选生成的字节标成 v1。

## 10. 延期参数和硬停止

唯一延期参数 registry 是 `docs/contracts/p0-deferred-parameters.json`。与本协议直接相关的是 DP-001 至 DP-005、DP-012 和 DP-013；其中 DP-001..005 已由 ADR-0013 和正式三环境矩阵关闭，DP-012/013 仍延期。

DP-001..005 的关闭只解除密码选型前置门，不代表生产 codec 已实现、验证或获得 Phase 2/3 授权。当前仍不得实现或发布生产 Recovery/Manifest/Object codec，也不得生成可被误认为正式恢复凭证的文件。
