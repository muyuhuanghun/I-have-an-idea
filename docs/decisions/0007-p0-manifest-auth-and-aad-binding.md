# ADR-0007：完整 Manifest 认证与 Object-ID/AAD Binding 字节级合同

- 状态：已接受（冻结 Phase 0 文档门禁项；少量长度参数待 smoke test）
- 日期：2026-08-27
- 决策者：开发者
- 相关文档：ADR-0002、ADR-0006、P0-recovery-and-object-format.md §3.2、§6.1

## 背景

P0-recovery-and-object-format.md §6.1 要求：明确完整 canonical Manifest 全部加密认证，以及 §3.2 所列 object-ID/AAD 绑定字段。§3.2 已冻结字段语义，本 ADR 冻结字节级编码、HKDF 用途标签、Manifest 加密合同和 AAD canonical 编码。

未冻结 AAD 编码时，wrong-ID substitution 攻击无协议依据：把完整合法密文复制到错误对象 ID 并改写引用，AEAD 验证仍可能通过（因旧 AAD 与新 ID 不匹配，但若 AAD 不含 object_id 则攻击可通过）。本 ADR 冻结的 AAD 绑定使这种攻击在协议层被拒绝。

## 决策

### 1. 完整 Canonical Manifest 明文结构

Manifest 在加密前序列化为以下字段顺序的二进制（不包含 AAD 自身和加密材料）：

```text
manifest_format_version   : 1 字节无符号整数（与对象格式版本独立）
domain_id                 : 32 字节
snapshot_id               : 32 字节（CSPRNG 生成；与 Manifest 定位符不同）
parent_snapshot_id        : 32 字节（000...0 表示无前驱；P0 单快照不引用）
content_policy_version    : 1 字节无符号整数
suite_id                  : 1 字节密码套件标识
entry_count               : 4 字节大端无符号整数
entry_count 重复条目：
    relative_path_utf8     : 变长（UTF-8 编码，NUL 终止）
    object_id              : 16 字节（128 位随机）
    plaintext_size         : 8 字节大端无符号整数（明文字节数）
    object_type            : 1 字节（0=文件，1=Manifest）
    wrapped_object_key     : 变长（被 Object Wrap Key 包装后的对象密钥，长度由 suite 决定）
```

entry 字段顺序在 Manifest 内部按 `relative_path_utf8` 的字节升序排序（确定性排序，保证 canonical serialization）。

### 2. Manifest 加密与认证合同

| 参数 | 值 | 来源 |
|---|---|---|
| 加密密钥 | Manifest Key | HKDF(domain_data_root, info=MANIFEST_HKDF_INFO, L=key_length) |
| AEAD | 由 suite_id 决定（候选：XChaCha20-Poly1305 或 AES-256-GCM） | smoke test 冻结 |
| nonce | CSPRNG 生成，每 Manifest 独立，位数由 AEAD 决定 | §6.2 |
| AAD | 见 §4 Manifest AAD | 本 ADR |
| 输出 | 密文 + 认证标签 | AEAD 标准输出 |
| 对象 ID | Manifest 自身的对象 ID，CSPRNG 独立生成，加密前确定 | §3.2 |
| 碰撞处理 | 加密前检查 ObjectStore，碰撞重新生成 ID 并重算 AAD 和密文 | §3.2 |

Manifest 密文作为 ObjectStore 中的不可变对象，结构与文件对象一致（§3.1）。Manifest 对象 ID 即恢复文件中的 Manifest 定位符（ADR-0006 §1）。

### 3. HKDF Canonical Info 标签

防止跨用途密钥复用。以下标签字符串作为 HKDF info 输入的字节序列（UTF-8 编码，无 NUL 终止）：

| 派生密钥 | Canonical Info 标签 | 用途 |
|---|---|---|
| Manifest Key | `ekd-v1/manifest-key` | Manifest 加密认证 |
| Object Wrap Key | `ekd-v1/object-wrap-key` | 包装/解包对象密钥 |
| 恢复文件完整性密钥 | `ekd-v1/recovery-file-integrity` | 恢复文件完整性（ADR-0006） |

标签中 `ekd-v1` 是 EKD（Encrypted Knowledge Domain）协议版本前缀。任何标签变更必须配合协议版本递增。

禁止使用自然语言标签（如 "manifest"）替代 canonical 编码；本表为唯一权威。

### 4. Object AAD Canonical 编码

对象加密时，AEAD 的 AAD 由以下字段顺序连接为字节序列：

```text
aad_format_version : 1 字节（当前固定 0x01）
domain_id          : 32 字节
suite_id           : 1 字节
object_type        : 1 字节（0=文件，1=Manifest）
object_id          : 16 字节（与本对象在 ObjectStore 中的 ID 相同）
format_version     : 1 字节（对象格式版本）
protocol_version   : 1 字节
snapshot_id        : 32 字节（Manifest 对象的 snapshot_id 来自 §1；文件对象的 snapshot_id 来自其 Manifest）
```

总长度 85 字节，固定不变。

### 4.1 Wrong-ID Substitution 拒绝协议依据

由于 AAD 包含 `object_id`，把完整合法密文复制到错误对象 ID 并改写引用时：

- 接收方用新对象 ID 派生 AAD（因 §1 §3.2 要求加密前确定 ID）；
- 实际 AAD 来自旧加密操作，包含旧 object_id；
- AEAD 解密因 AAD 不匹配而失败；
- 返回 §4.2 错误码。

这是 ACC-15 中 wrong-ID substitution 负面测试的协议依据。该测试在 AAD 字节编码冻结前不能声称已通过。

### 4.2 错误码（机器可判定）

Manifest 和对象解析/验证的失败返回以下规范错误码：

| 错误码 | 触发条件 | 对应 ACC |
|---|---|---|
| MANIFEST_AEAD_FAILED | Manifest 密文 AEAD 验证失败（篡改、错密钥、错 nonce） | ACC-16 |
| OBJECT_AEAD_FAILED | 对象密文 AEAD 验证失败 | ACC-14, ACC-15 |
| OBJECT_AAD_MISMATCH | 实际 AAD 字节与从 object_id 派生的预期 AAD 字节不一致 | ACC-15 |
| OBJECT_ID_COLLISION | 对象 ID 已存在且重新生成仍碰撞（极低概率，需记录） | §3.2 |
| MANIFEST_VERSION_UNSUPPORTED | manifest_format_version 不支持 | INV-14 |
| MANIFEST_SUITE_UNKNOWN | suite_id 不支持 | INV-14 |
| ENTRY_PATH_DUPLICATE | entry 排序后出现相同 relative_path | INV-14 |
| ENTRY_PATH_ESCAPE | relative_path 含 `..`、绝对路径前缀或重解析点字符 | ACC-19, ACC-20 |
| ENTRY_SIZE_MISMATCH | 解密后明文大小与 entry 的 plaintext_size 不一致 | ACC-14 |

## 后果

- P0-recovery-and-object-format.md §6.1 第 3 项关闭；
- 完整 Manifest、对象 AAD 和 HKDF 标签的字节编码在 Phase 0 文档门禁层面冻结；
- ACC-15 的 wrong-ID substitution 负面测试获得协议依据；
- ACC-16 的 Manifest 篡改测试可基于 MANIFEST_AEAD_FAILED 错误码自动判定；
- 实施时必须按本 ADR 编码 AAD 和 Manifest 序列化，任何偏差需要新 ADR。

## 与算法参数的关系

本 ADR 冻结：Manifest 字段顺序、entry 排序规则、HKDF 标签、AEAD 加密合同、对象 AAD 字节布局、错误码。

未冻结（待 §6.2 smoke test）：

- AEAD 具体算法（XChaCha20-Poly1305 vs AES-256-GCM）；
- key_length（HKDF 输出长度，对应 AEAD 密钥长度）；
- nonce 位数；
- object_id 字节数（暂定 16 字节 = 128 位）。