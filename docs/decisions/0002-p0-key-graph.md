# ADR-0002：P0 候选密钥图与最小密钥角色

- 状态：部分有效；字节级 KDF/wire contract 已由 ADR-0011 取代
- 日期：2026-08-27
- 决策者：开发者
- 相关文档：执行计划 §8.2、威胁模型 §3、安全不变式 INV-01~05、ADR-0011

> 当前解释：本 ADR 保留密钥角色和最小密钥图的设计理由。下文旧自然语言标签、salt/info 位置和“待裁决”列表属于历史设计记录；实现必须使用 ADR-0011 与 `p0-wire-contract-v1.json`。

## 背景

执行计划 §8.2 要求阶段 0 用 ADR 回答恢复秘密如何保护域数据根、Manifest 和对象密钥的派生或封装关系、不同用途如何避免密钥和 nonce 复用、P0 快照真实性使用 AEAD 还是签名，以及 fresh-process 恢复的唯一秘密输入和认证锚点是什么；该锚点不自动提供快照新鲜度。

README §8 要求恢复凭证由密码学安全随机数生成器产生，安全定义按随机熵和密钥角色描述。README §5.2 要求域根密钥只能在授权设备产生和使用，服务端不得生成。

默认倾向是只实现满足当前不变式的最小密钥图，设备身份签名和可变 Domain State 签名推迟到 P1-alpha。

## 决策

### 密钥角色（P0 最小集）

| 角色 | 产生方式 | 用途 | 存储位置 |
|---|---|---|---|
| 恢复根（Recovery Root） | CSPRNG 生成的高熵随机字节（不低于 256 位，最终长度见恢复格式文档） | 派生域数据根；是 fresh-process 恢复的 bearer secret | Vault 外恢复文件 |
| 域数据根（Domain Data Root Key） | HKDF-SHA256，salt=`domain_id`，info=`ekd-v1/domain-data-root` | 派生 Manifest 密钥和包装对象密钥 | 仅内存 |
| Manifest 密钥（Manifest Key） | HKDF，info=`ekd-v1/manifest-key` | Manifest 加密和认证 | 仅内存 |
| 对象包装密钥（Object Wrap Key） | HKDF，info=`ekd-v1/object-wrap-key` | 只用于包装/解包对象密钥，不直接加密文件或 Manifest | 仅内存 |
| 对象密钥（Object Key） | 每对象 CSPRNG 独立随机生成 | 单个密文对象的 AEAD 加密 | 被 Object Wrap Key 包装后存入 Manifest |

### 派生关系图

```text
恢复根（Recovery Root，256+ 位，CSPRNG）
  │  保存在 Vault 外恢复文件
  │  HKDF-SHA256(salt=domain_id, info="ekd-v1/domain-data-root")
  ▼
域数据根（Domain Data Root Key）
  │  仅内存
  ├─ HKDF(info="ekd-v1/manifest-key") ──► Manifest 密钥
  │                            └─ 加密并认证完整 canonical Manifest
  │
  └─ HKDF(info="ekd-v1/object-wrap-key") ──► 对象包装密钥
       └─ 包装（wrap）每个对象密钥
       │
       ▼
  对象密钥（Object Key，每对象独立随机）
  │  CSPRNG 生成
  └─ AEAD 加密单文件密文对象
       │  对象密钥被对象包装密钥封装后写入 Manifest
       ▼
  密文对象（ObjectStore 中不可变）
```

### 设计理由

1. 恢复根是唯一秘密输入：fresh-process 从恢复文件读取恢复根，即可派生域数据根，进而解包所有对象密钥。不依赖任何本地缓存或内存秘密（满足 INV-11）；这不代表恢复文件来源或快照新鲜度已由外部信任锚证明。

2. 域数据根不持久化：只在进程内存中存在，不写入 ObjectStore 或任何磁盘文件。恢复根失窃等价于获得域解密能力，因此恢复文件是高敏感秘密。

3. 每对象独立随机密钥：相同明文不会产生可直接关联的相同密文对象（满足 INV-02）。对象密钥不通过派生复用。

4. 标签隔离：Manifest Key 和 Object Wrap Key 必须由不同 canonical HKDF info 派生，Domain Data Root 不直接执行 AEAD 或包装。nonce 策略、info 编码和 salt 仍须在补充 ADR 中冻结，不能只用自然语言标签替代字节级合同。

### P0 真实性：AEAD 而非签名

P0 快照真实性使用 AEAD（认证加密）而非数字签名：

- AEAD 同时提供机密性和完整性，篡改必须被检测（满足 INV-04）；
- 恢复验证通过 AEAD 解密失败来检测篡改，不需要独立签名验证步骤；
- P0 不引入设备签名：单用户单设备场景下，设备签名没有当前验证价值，只是为 P1 预留；
- 设备身份签名和可变 Domain State 签名推迟到 P1-alpha（见 ADR-0004）。

### fresh-process 恢复的秘密输入与认证锚点

fresh-process 恢复的唯一秘密输入是恢复文件中的恢复根；其作为内部认证锚点的具体能力受补充 ADR 限制：

1. 新进程读取 Vault 外恢复文件；只有在补充 ADR 冻结 canonical 编码、完整性覆盖范围和密钥来源后，才可执行相应完整性校验；
2. 从恢复根派生域数据根；
3. 解密并认证完整 canonical Manifest，获取每对象密钥的包装材料；
4. 解包对象密钥，逐文件恢复密文到新建空目录；
5. 独立验证器逐文件核对相对路径和字节（满足 INV-12）。

该链只证明给定恢复文件和 ObjectStore 的内部恢复能力，不证明恢复文件受到独立静态保密保护，也不证明该输入是历史最新快照。合法旧恢复文件与匹配旧 ObjectStore 的整体替换不在 P0 反回滚保证内。

## 后果

- P0 需要 HKDF-SHA256 实现和 AEAD 实现（密码候选见 smoke test 方案）；
- Recovery File v1 的字段和 HMAC 已由 ADR-0011 冻结；
- 恢复根失窃等价于域被攻破，恢复文件必须在 Vault 外安全保存；
- P1-alpha 迁移时，设备签名引入需要扩展密钥图，但不能破坏当前恢复根→域数据根的派生链。

## 历史待裁决记录（当前由 ADR-0011/延期参数 registry 取代）

### 历史 Phase 0 门禁阻塞项

- 恢复文件采取 bearer-secret 语义，还是引入会改变 INV-11 的外部解锁秘密；当前范围倾向前者，但须补充 ADR 明确裁决；
- 恢复文件完整性要抵抗的攻击者、密钥来源、canonical 覆盖范围和整体替换诚实边界；
- Manifest Key / Object Wrap Key 的用途隔离，以及 Manifest/对象的 object-ID/AAD 绑定字段语义。

### 当前仍延期的实现参数

- HKDF 具体参数（salt 来源、输出长度）在密码候选 smoke test 后冻结；
- 对象密钥包装由 DP-003 关闭，不能在实现中无 ADR 自行确定；
- 恢复文件完整性已经由 ADR-0011 固定为 HMAC-SHA256；不再保留 recovery material AEAD 候选；
- 当前状态只以 `docs/contracts/p0-deferred-parameters.json` 为准：DP-001..005 已由 ADR-0013 关闭，DP-012 仍延期；禁止从本历史列表新增隐式参数。
