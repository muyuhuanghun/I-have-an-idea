# ADR-0006：恢复文件 Canonical Serialization 与完整性覆盖

- 状态：已接受（冻结 Phase 0 文档门禁项；算法参数待 smoke test）
- 日期：2026-08-27
- 决策者：开发者
- 相关文档：ADR-0005、ADR-0002、P0-recovery-and-object-format.md §2、§6.1

## 背景

P0-recovery-and-object-format.md §6.1 列出的 Phase 0 文档门禁项要求：明确恢复文件完整性要抵抗的攻击者、密钥来源和 canonical 字段覆盖。ADR-0005 已裁决 bearer secret 方案和完整性密钥来源（从恢复根自派生），本 ADR 冻结恢复文件的 canonical serialization 和完整性覆盖范围。

恢复文件是 bearer secret（ADR-0005），其完整性必须满足以下需求：

- 持有恢复根者可验证恢复文件未被字段级损坏或篡改；
- 不持有恢复根者无法伪造合法恢复文件；
- 恢复器的 fresh-process 读取可明确判定完整性通过或失败（可通过机器判定）；
- 完整性覆盖范围明确：哪些字段被保护，哪些字段不保护。

## 决策

### 1. Canonical Serialization

恢复文件采用确定性二进制序列化。所有字段以固定顺序、固定编码连接为一个字节序列，作为完整性保护的输入。不使用 JSON、文本或变长编码（避免编码歧义导致同一逻辑内容产生不同字节）。

字段顺序（完整性覆盖输入）：

```text
magic           : 4 字节固定魔数
format_version  : 1 字节无符号整数
protocol_version: 1 字节无符号整数
domain_id       : 32 字节（由 KDF 派生或 CSPRNG 生成，编码与对象 ID 一致）
suite_id        : 1 字节密码套件标识
recovery_material: 变长（恢复根的受保护表示，长度由 suite_id 决定）
manifest_locator: 与对象 ID 编码一致（URL-safe Base64，不含语义前缀）
```

完整性保护覆盖以上全部字段。非秘密指纹不进入完整性覆盖输入（它是指纹本身的输出，不能保护自己）。

### 2. 完整性密钥来源

依据 ADR-0005：

- 完整性密钥 = HKDF(recovery_root, salt = domain_id, info = "recovery-file-integrity", L = key_length)
- 这是自我引用完整性：持有恢复根者可派生密钥并验证；不持有者无法伪造标签；
- 无法检测合法旧恢复文件 + 匹配旧 ObjectStore 的整体替换（ADR-0005 诚实边界）。

### 3. 完整性方案

完整性方案在 Phase 0 文档门禁中冻结为以下两种之一，具体选择推迟到 smoke test（§6.2）：

| 方案 | 机制 | 待冻结原因 |
|---|---|---|
| HMAC-SHA256 | 对 canonical serialization 计算 HMAC，标签附在文件末尾 | 简单，但恢复材料需要独立加密保护 |
| AEAD 封装 | 用完整性密钥对 recovery_material 做 AEAD 加密，其他字段作为 AAD | 同时提供恢复材料的机密性和全字段完整性 |

无论选择哪种，以下不变：

- 完整性输入是 §1 的 canonical serialization（不含完整性标签自身和非秘密指纹）；
- 完整性密钥来源按 §2；
- 恢复器验证完整性失败时返回明确的错误码（见 §5），不返回部分解析结果。

### 4. 完整性覆盖范围

| 字段 | 是否受完整性保护 | 说明 |
|---|---|---|
| magic | 是 | 防止文件类型混淆 |
| format_version | 是 | 防止版本降级 |
| protocol_version | 是 | 防止协议代际混淆 |
| domain_id | 是 | 防止域 ID 替换 |
| suite_id | 是 | 防止密码套件替换 |
| recovery_material | 是 | 防止恢复根篡改 |
| manifest_locator | 是 | 防止 Manifest 指向被替换 |
| 完整性标签 | 否（自身） | 不能保护自己 |
| non_secret_fingerprint | 否 | 是指纹输出，不进入保护输入 |

### 5. 错误码（机器可判定）

恢复文件解析和完整性验证的失败返回以下规范错误码，供 ACC-08/09/10 的 oracle 自动判定：

| 错误码 | 触发条件 | 对应 ACC |
|---|---|---|
| RECOVERY_MAGIC_MISMATCH | magic 字节不匹配 | ACC-08 |
| RECOVERY_VERSION_UNSUPPORTED | format_version 不在支持列表 | ACC-10 |
| RECOVERY_INTEGRITY_FAILED | 完整性标签验证失败 | ACC-08, ACC-09 |
| RECOVERY_TRUNCATED | 文件长度不足，无法解析全部字段 | ACC-09 |
| RECOVERY_SUITE_UNKNOWN | suite_id 不在支持列表 | ACC-08 |

恢复器返回以上错误码之一时，ACC oracle 判定该负面测试通过（拒绝而非部分恢复）。

## 后果

- P0-recovery-and-object-format.md §6.1 第 2 项关闭；
- 恢复文件格式的字节布局在 Phase 0 文档门禁层面冻结，算法参数（HKDF 输出长度、完整性方案选择）推迟到 §6.2；
- 验收矩阵 ACC-08/09/10 现有错误判定可引用本 ADR 的错误码；
- 恢复器实现必须返回本 ADR 的错误码，不能用自定义异常替代。

## 与算法参数的关系

本 ADR 冻结：字段顺序、完整性覆盖范围、密钥来源公式、错误码。

未冻结（待 §6.2 smoke test）：

- HKDF 输出长度（key_length）；
- 完整性方案选择（HMAC vs AEAD 封装）；
- recovery_material 的具体编码长度；
- domain_id 的生成方式（CSPRNG 直接生成或从恢复根派生）。
