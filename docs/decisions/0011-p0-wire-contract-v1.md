# ADR-0011：P0 可实现的恢复链与 Canonical Wire Contract v1

- 状态：已接受；本 ADR 是 P0 wire contract 的当前权威
- 日期：2026-08-27
- 决策者：开发者
- 机器合同：`docs/contracts/p0-wire-contract-v1.json`
- 取代范围：ADR-0002 的自然语言 HKDF 标签、ADR-0005/0006 的恢复材料 AEAD 候选、ADR-0006 的恢复文件字节布局、ADR-0007 的 Manifest/AAD 字节布局和 object ID 待定状态

## 1. 问题

此前合同存在两条循环依赖，不能由 fresh process 实现：

1. Manifest AAD 含 `snapshot_id`，但 `snapshot_id` 只存在于待解密的 Manifest 明文中；解密前无法构造 AAD。
2. “AEAD 封装 recovery material”的候选用从 `recovery_root` 派生的密钥解密 `recovery_root` 自身；解密前无法取得密钥。

同时，恢复文件、Manifest、对象 AAD 对 object ID 的原始字节与文本编码、变长字段边界、整数端序和 HKDF 标签存在多种说法。它们必须收敛为一个可逐字节实现的合同。

## 2. 决策摘要

1. P0 继续采用 ADR-0005 的 bearer-secret 语义。`recovery_root` 固定为 32 个原始字节，直接存入 Vault 外恢复文件；P0 不提供独立静态保密保护。
2. 恢复文件完整性固定为 HMAC-SHA256，不再保留 recovery material AEAD 候选。HMAC key 从文件内的 `recovery_root` 派生，因此它只提供内部自洽/损坏检测，不提供针对“可读取该 bearer file 的写入者”的独立真实性。
3. 恢复文件新增 `snapshot_id`，并把它纳入 HMAC 覆盖。fresh process 从恢复文件获得 Manifest 的 `domain_id`、`snapshot_id`、`manifest_object_id`、suite 和版本，先构造 AAD，再解密 Manifest。
4. object ID 固定为 16 个原始字节。协议字节结构一律使用这 16 字节；ObjectStore API/目录名使用 RFC 4648 base64url、无 `=` padding 的 22 字符文本编码。
5. 所有整数使用无符号大端；所有变长字段显式带长度；字符串为严格 UTF-8；不使用 NUL 终止、隐式长度、平台原生端序或 JSON 文本作为 wire bytes。
6. `docs/contracts/p0-wire-contract-v1.json` 是机器可读常量和字段顺序权威。本 ADR 解释语义；两者不一致是硬停止条件。

## 3. HKDF-SHA256 合同

所有标签是下表 ASCII 字节，不带 NUL、BOM、长度前缀或换行。任何字节变化都必须提升 `protocol_version`。

| 派生结果 | IKM | salt | info（逐字节） | L |
|---|---|---|---|---:|
| Domain Data Root | `recovery_root` | `domain_id`（32 字节） | `ekd-v1/domain-data-root` | 32 |
| Recovery File Integrity Key | `recovery_root` | `domain_id` | `ekd-v1/recovery-file-integrity` | 32 |
| Manifest Key | Domain Data Root | `domain_id` | `ekd-v1/manifest-key` | suite 的 AEAD key length |
| Object Wrap Key | Domain Data Root | `domain_id` | `ekd-v1/object-wrap-key` | suite 的 wrap key length |

不得再使用 `"manifest"`、`"object-wrap-v1"`、把 `domain_id` 放入 info、空 salt，或其他本地别名。

## 4. Recovery File v1

固定长度 167 字节。偏移和常量以机器合同为准：

```text
magic                    4   ASCII "EKDR"
recovery_format_version  1   0x01
protocol_version         1   0x01
domain_id               32
suite_id                 1
recovery_root           32
snapshot_id             32
manifest_object_id      16
non_secret_fingerprint  16
integrity_tag           32   HMAC-SHA256
```

`non_secret_fingerprint = Trunc16(SHA-256(ASCII("ekd-v1/recovery-fingerprint") || domain_id))`。

`integrity_tag = HMAC-SHA256(recovery_file_integrity_key, file[0:135])`。HMAC 覆盖 magic 至 fingerprint 的每个字节；标签自身不覆盖自身。解析器必须要求文件长度恰好为 167，拒绝截断和尾随字节。解析顺序是：检查固定长度和 magic/version/suite，读取 recovery root，派生 HMAC key，常数时间比较标签；失败时不返回任何可供恢复使用的部分结构。

这不是外部真实性锚。能读取恢复文件的人已经得到 bearer secret，并可派生 HMAC key；P0 的安全声明只能是“检测非自洽输入并通过 Manifest AEAD 验证给定快照”，不能声称恢复文件防篡改、最新或抗整体替换。

## 5. Object Envelope 与 AAD v1

对象 envelope 的 19 字节公开 header：

```text
magic                   4   ASCII "EKDO"
object_format_version   1   0x01
protocol_version        1   0x01
suite_id                1
nonce_length            2   u16be
ciphertext_length       8   u64be
tag_length              2   u16be
nonce                   nonce_length bytes
ciphertext              ciphertext_length bytes
tag                     tag_length bytes
```

文件总长度必须恰好等于 `19 + nonce_length + ciphertext_length + tag_length`。nonce 和 tag 长度必须等于 suite registry 的冻结值；不得只相信对象自报长度。

AEAD AAD 是固定 101 字节：

```text
magic                   4   ASCII "EKDA"
aad_format_version      1   0x01
object_format_version   1
protocol_version        1
suite_id                1
object_type             1   0=file, 1=manifest
domain_id              32
object_id              16
snapshot_id            32
nonce_length            2   u16be
ciphertext_length       8   u64be
tag_length              2   u16be
```

Manifest 解密所需字段来自已验证的 Recovery File v1 加上对象 envelope header；文件对象解密所需字段来自已认证的 Manifest 加上对象 envelope header。不存在从待解密明文反向取得 AAD 字段的步骤。

ObjectStore GET 使用的文本键必须先 base64url 解码为恰好 16 字节，并与调用方期望的 object ID 相等；非 canonical 文本、padding、错误长度或错误 ID 返回 `OBJECT_ID_INVALID` / `OBJECT_AAD_MISMATCH`。

## 6. Canonical Manifest Plaintext v1

Manifest 全部作为 object type 1 的 AEAD 明文：

```text
magic                    4   ASCII "EKDM"
manifest_format_version  1   0x01
domain_id               32
snapshot_id             32
parent_snapshot_id      32   P0 无父快照时全零
content_policy_version   1
suite_id                 1
entry_count              4   u32be
entries                  entry_count entries
```

每个 entry：

```text
relative_path_length     4   u32be
relative_path_utf8       relative_path_length bytes
object_id               16
plaintext_size           8   u64be
wrapped_key_length       2   u16be
wrapped_object_key       wrapped_key_length bytes
```

路径必须是严格 UTF-8，不含 NUL，使用 `/` 作为逻辑分隔符。entry 按 `relative_path_utf8` 原始字节严格升序；相等或逆序都拒绝。解析后必须验证 Manifest 内的 domain/snapshot/suite 与调用方已经用于 AAD 的值逐字节相等。`entry_count`、所有长度和文件结尾必须完全闭合，不允许未消费尾随字节。

## 7. 当前仍延期的参数

本 ADR 已冻结 recovery root、object ID、HMAC、字段顺序、端序、标签和覆盖字节。AEAD suite、suite 对应的 key/nonce/tag 长度、对象密钥 wrap 算法和 wrapped bytes 仍需实测选择。它们的唯一当前清单是 `docs/contracts/p0-deferred-parameters.json`；每项必须有 owner、关闭阶段、关闭产物和硬停止条件。

在这些参数关闭前，可以实现 schema、KAT harness 和候选适配器，不得写生产 Recovery/Manifest/Object 编解码器或生成可被误认为正式格式的恢复文件。

## 8. 后果与迁移

- ADR-0006 的“恢复材料 HMAC 或 AEAD 二选一”和旧字段布局不再是当前合同。
- ADR-0007 的 85 字节 AAD、16 字节 object ID“暂定”状态和 NUL 终止路径不再是当前合同。
- 任何已有 fixture 或实现若按旧合同生成，只能标记为 historical/invalid-v0，不得静默迁移为 v1 证据。
- ACC-06、08、09、10、15、16 的 oracle 必须引用本 ADR 和机器合同。

