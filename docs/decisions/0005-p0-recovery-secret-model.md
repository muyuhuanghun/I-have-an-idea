# ADR-0005：恢复文件 bearer secret 与外部解锁秘密二选一

- 状态：语义仍有效；恢复文件 HMAC/wire 细节由 ADR-0011 取代
- 日期：2026-08-27
- 决策者：开发者
- 相关文档：ADR-0002、ADR-0004、P0-recovery-and-object-format.md §2.4、P0-security-invariants.md、P0-scope-and-glossary.md §5

## 背景

P0-recovery-and-object-format.md §2.4 指出：P0 当前没有用户口令、第二把本地保护密钥、OS keystore 或远程托管密钥，恢复文件实际是足以恢复域的 bearer secret（失窃等价于域解密能力失窃）。该问题被列为 Phase 0 语义阻塞项，要求在本 ADR 中先行裁决 bearer-secret 与外部解锁秘密二选一。

选择影响以下承诺的语义边界：

- INV-11：fresh-process 恢复只凭恢复文件和 ObjectStore；
- 恢复文件完整性方案：完整性密钥来源是外部独立锚点还是恢复文件自身秘密；
- 整体替换边界：能否检测合法旧恢复文件与匹配旧 ObjectStore 的整体替换；
- 关闭报告诚实声明：P0 是否声称反回滚或快照新鲜度。

## 备选方案

### 方案 A：bearer secret（恢复文件自身即为完整秘密）

- 恢复根是 CSPRNG 高熵随机字节，直接以受保护形式存入恢复文件；
- 无口令、无 keystore、无第二秘密、无远程托管；
- 恢复文件完整性密钥从恢复根自身派生（HKDF，info 标签隔离）；
- fresh-process 只需恢复文件 + ObjectStore（满足 INV-11）；
- 失窃恢复文件 = 域解密能力失窃，无二次保护；
- 无法检测合法旧恢复文件 + 匹配旧 ObjectStore 的整体替换。

### 方案 B：外部解锁秘密（口令/keystore/第二秘密保护恢复根）

- 恢复根不直接存入恢复文件，而是被外部解锁秘密派生的密钥包装；
- 外部秘密提供独立锚点：即使攻击者替换恢复文件 + ObjectStore，无外部秘密仍无法解包恢复根；
- 需要口令 KDF（Argon2/scrypt）、口令 UX、或平台 keystore 依赖；
- INV-11 需要修订：fresh-process 需恢复文件 + ObjectStore + 外部秘密；
- 引入口令弱密码、keystore 不可用、平台差异等新风险。

## 决策

### P0 选择方案 A（bearer secret）

理由：

1. P0 是单用户、单快照、无服务端认证的本地闭环验证。没有多设备、多成员或服务端身份需要独立解锁层。
2. 执行计划 §8.2 要求只实现满足当前不变式的最小密钥图。方案 B 引入口令 KDF 和 keystore 依赖，超出 P0 最小范围，且口令弱密码引入新风险。
3. 方案 A 与 INV-11（只凭恢复文件 + ObjectStore 恢复）一致，不需要修订不变式。方案 B 需要修订 INV-11，扩大恢复输入集合。
4. P0 的目标是验证加密闭环的完整性和字节一致性，不验证反回滚、快照新鲜度或多版本治理。方案 A 的诚实边界与 P0 范围匹配。

### 恢复文件完整性密钥来源

完整性密钥按 ADR-0011 从恢复根派生，canonical info 为 `ekd-v1/recovery-file-integrity`。Recovery File v1 直接携带 32 字节 recovery root，并固定使用 HMAC-SHA256；不再保留 recovery material AEAD 候选。

- 解析器可验证恢复文件内部自洽并检测未重算标签的损坏；
- 任何能读取 bearer file 的人已经持有恢复根，也能派生 HMAC key，因此不能声称对这类读写者有独立防伪能力；
- 但无法证明攻击者没有整体替换恢复文件 + 匹配 ObjectStore（因为旧对在内部自洽）。

### INV-11 不变

INV-11（fresh-process 恢复只凭恢复文件和 ObjectStore）在方案 A 下不变。恢复文件是完整秘密输入，不引入外部解锁秘密。如果未来切换到方案 B，必须同时修订 INV-11 和 fresh-process 恢复的输入定义。

### 诚实边界（必须在关闭报告中声明）

P0 选择方案 A 意味着以下能力明确不可用，须在 P0-R1 关闭报告中记录为 known-limitation：

- 不检测合法旧恢复文件 + 匹配旧 ObjectStore 的整体替换；
- 不提供快照新鲜度或可信最新指针；
- 不提供完整反回滚保证；
- 恢复文件失窃等价于域解密能力失窃，无二次保护。

这些限制已在 P0-scope-and-glossary.md §5 中放入 P0 OUT，在 P0-security-invariants.md 中作为诚实边界声明。

### 方案 B 的推迟条件

方案 B 推迟到 P1-alpha 或以后，当存在真实账号系统和多设备绑定时引入。引入时必须：

- 通过新 ADR 修订本决策；
- 同步修订 INV-11（恢复输入集合扩大）；
- 同步修订恢复文件格式（加入外部解锁引用字段）；
- 在 P0-R1 关闭报告或 P1-alpha 计划中记录从方案 A 到方案 B 的迁移路径。

## 后果

### 对其他文档的影响

- P0-recovery-and-object-format.md §2.4 的 bearer-secret/外部解锁二选一阻塞项关闭，本 ADR 为其裁决依据；
- P0-recovery-and-object-format.md 的当前参数以 ADR-0011 和延期参数 registry 为准；
- P0-security-invariants.md 的整体替换边界与本决策的诚实边界一致；
- 验收矩阵无需新增 ACC：整体替换作为 known-limitation 记录，不设负面测试（P0 无法检测的设计限制不应伪装成可测验收）。

### 对验收的影响

- P0-R1 关闭报告在 known-limitation 部分记录本决策的四个诚实边界；
- ACC-08（错误恢复文件被拒绝）和 ACC-09（截断被拒绝）仍然有效：它们测试字段损坏和截断，不是整体替换；
- 不新增 ACC 测试整体替换检测（P0 设计上不检测，测试它会得到预期失败，不构成有意义的验收）。

### 安全声明约束

基于本决策，P0 文档和关闭报告不得声称：

- 恢复根已获得独立静态保密保护（方案 A 无外部锚点）；
- 已提供反回滚或快照新鲜度（P0 OUT）；
- 恢复文件失窃后域仍安全（bearer secret 失窃 = 域失守）。

## 与算法参数的关系

本 ADR 冻结 bearer-secret 语义。2026-08-27 后续 ADR-0011 已关闭 recovery root 长度、HMAC、salt/info、字段布局和 object ID 长度。当前仍延期的 suite/wrap/KAT 参数只以 `p0-deferred-parameters.json` 为准。

- AEAD suite 及 key/nonce/tag 参数（DP-002）；
- object-key wrap 方案（DP-003）；
- 精确 KAT 与候选实现（DP-001/004/005）。

这些参数冻结后写入选择 ADR，不修改 bearer-secret 语义；未来引入外部解锁秘密必须按 DP-013 新建迁移 ADR。
