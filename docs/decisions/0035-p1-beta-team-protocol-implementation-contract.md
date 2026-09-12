# ADR-0035：P1-beta 团队协议实现合同 v1（T1 切片）

- 状态：**已接受（2026-09-12）——开发者委托裁决（"开工 T1"），本合同采纳推荐选项并经四视角两轮自检；任何裁决可被开发者事后否决，否决即回滚本合同**
- 日期：2026-09-12
- 阶段：团队协议实现阶段 T1 合同冻结（上游：ADR-0032/0033/0034 三设计；本合同冻结字节与原语，不含实现）
- 实现范围声明：T2 协议层实现（core/adapters/CLI 冒烟）与 T3 正式证据各自单独授权；团队协作的产品 UI（提交入口/审核队列）不在协议切片范围
- 决策者：开发者（OWNER-SECURITY 归属；本轮委托按推荐路径裁决）

## 1. 输入与范围

本合同把 ADR-0032（审批凭证）、ADR-0033（epoch 生命周期）、ADR-0034（治理恢复）的语义冻结为可实现/可测试的字节与原语决策：三份域内登记物的格式与签名规则、epoch 内容密钥的封装体系、治理恢复材料的载体格式、归一化错误码、registry 扩张映射与 T2/T3 切片计划。**显式深水区修正见 §4.5（对 ADR-0033 ET-9 的细化，已标注供否决）。**

## 2. 裁决一：三份域内登记物（格式与签名规则）

统一签名规则（先例：head 指针/设备注册）：**canonical JSON 字节**——字段按本文档冻结的顺序、UTF-8、无空白（`JSON.stringify` 的紧凑输出，键序即文档声明序，序号为十进制整数），签名算法 ECDSA P-256/SHA-256（raw r||s，base64url，与 head 签名同代际），签名者为各登记物的授权方。文件布局：与 `devices.json` 同域（head 目录旁），同生命周期，一律"签名验证失败关闭 + 序号防回滚"。

### 2.1 `proposal-reviewers-v1`（ADR-0032）

```
{ "schema_version": "proposal-reviewers-v1",
  "domain_id_sha256": <64hex>,
  "sequence": <单调递增整数>,
  "reviewers": [ { "reviewer_id": <32hex>, "proposal_public_key_spki_base64url": <base64url>,
                   "device_id": <32hex>, "registered_at": <ISO-8601> } ],
  "signature_base64url": <对前述 canonical 字节（不含本字段）的 ECDSA 签名> }
```

授权签名者：当前所有者设备（devices.json 已注册且未被 supersede）；治理锚（§4，恢复事件中）。

### 2.2 `group-state-v1`（ADR-0033）

```
{ "schema_version": "group-state-v1",
  "domain_id_sha256": <64hex>,
  "epoch": <单调递增整数，从 1 起>,
  "members": [ { "device_id": <32hex>, "member_content_dh_spki_base64url": <base64url>,
                 "joined_epoch": <整数> } ],
  "removed": [ { "device_id": <32hex>, "removed_epoch": <整数> } ],
  "signature_base64url": <同上> }
```

1. `members[].member_content_dh_spki` 是成员设备的**内容 DH 公钥**（ECDH P-256，设备本地生成、与 head 签名密钥分域——签名密钥不能做密钥协商）；加入时随承认流程注册。
2. `removed` 只追加不删除（L2 传输门控与审计的依据）；`members` 中被移除者移出但保留在 `removed`。
3. 群内容密钥**不出现在本文件**（登记物只有公钥事实；密钥分发见 §3）。

### 2.3 `group-epoch-keys-<epoch>-v1`（每 epoch 一份的密钥分发物，ADR-0033 §3）

```
{ "schema_version": "group-epoch-keys-v1",
  "domain_id_sha256": <64hex>, "epoch": <整数>,
  "wrapped": [ { "device_id": <32hex>,
                 "ephemeral_dh_spki_base64url": <base64url>,
                 "nonce_b64": <96-bit 随机数 base64>,
                 "wrapped_cek_b64": <AES-256-GCM 密文 base64url> } ],
  "signature_base64url": <授权方对 canonical 字节的签名> }
```

旧 epoch 的分发物在新 epoch 被活跃成员确认后按 §4.4 的保留策略处理；被移除成员的条目在移除 epoch 起不再出现。

## 3. 裁决二：epoch 内容密钥封装体系（pairwise，ADR-0013 套件内）

1. **原语全部取自 ADR-0013 已选套件**（无新依赖）：ECDH P-256 + HKDF-SHA-256 + AES-256-GCM + ECDSA P-256。
2. **epoch CEK**：权威方（所有者设备）在每个 epoch 用 CSPRNG 生成 256-bit 内容密钥；对 `group-state-v1` 中每个活跃成员的 content DH 公钥做 **ECIES 式 pairwise 封装**：临时 ECDH(P-256) × 成员 DH 公钥 → HKDF-SHA-256（salt = domain_id 原始 32 字节，info = `"ekd-group-epoch-cek-v1"`）→ AES-256-GCM 封装 CEK；**AAD = domain_id(32B) || epoch(u64BE) || device_id(32B)**（绑死用途/域/成员，防跨域跨成员重放）。
3. **内容加密**：AES-256-GCM，密钥 = epoch CEK，96-bit 随机 nonce，AAD 按内容类型在 T2 schema 冻结时逐类型细化（Proposal 对象的 AAD 至少含 domain_id || epoch || 对象引用）。
4. **v1 规模假设**：pairwise 封装 O(成员数)，团队 ≤ 数十人成立；MLS 树式（ removes 前向安全更强）留作规模扩大后的独立裁决。

### 4.5 显式深水区修正（对 ADR-0033 ET-9 的细化——**重点标注，供否决**）

起草时发现 ADR-0033 ET-9（"活跃成员设备上旧内容密钥已不存在"）与备份产品语义冲突：若活跃成员也擦除旧 epoch 密钥，则所有人都读不到共享存储中的历史快照——这毁掉备份产品的历史价值。**T1 修正裁决**：

1. **活跃成员保留历史 epoch 密钥**（备份语义：历史快照对现存成员永远可读；这正是 Signal Sender Keys 的现实形态——在籍者保留旧链知识，前向安全只约束被移除者的未来访问）；
2. **擦除义务收敛到两处**：(a) 被移除成员的**分发条目**从新 epoch 起消失（权威侧可验证，ET-3/ET-9 的可测试核心）；(b) 退出/被移除流程在**配合的离开设备**上执行本地 epoch 密钥擦除（自愿退出可验证；敌意保留密钥的设备落入 ADR-0033 §5 L2 的诚实声明，非实现缺陷）；
3. 代价如实声明：活跃设备的泄露暴露其可见的全部历史 epoch 内容（无逐 epoch 前向安全）；MLS 树式逐 epoch 前向安全列为未来独立裁决。
4. 本细化与 ADR-0033 §5 三级边界（L1/L2/L3）无冲突；ET-9 的断言对象由"活跃成员"改为"被移除成员的分发状态 + 配合离开设备的本地擦除"。

## 4. 裁决三：治理恢复材料与恢复锚（ADR-0034）

1. **恢复锚**：团队域创建时生成专用的 **governance anchor P-256 密钥对**；公钥作为恢复权威锚登记进 `group-state-v1`（`recovery_anchor_spki_base64url` 字段，创建事件签名）；私钥进入离线 bearer 材料。恢复事件 = anchor 签名的"恢复承认记录"（承认新所有者设备 + 标记旧设备 superseded + epoch 延续），各注册表验证器接受 anchor 为替代权威根。
2. **载体格式 `governance-recovery-material-v1`**（Recovery File 同型纪律）：

```
magic(8B "EKDGOV\x01\x00") || version(1B) || domain_id(32B) ||
pkcs8_len(u16BE) || anchor_private_pkcs8(变长) || SHA-256(前述全部字节)(32B)
```

离线保存纪律与 Recovery File 同级；dry-run 校验 = 读入后验证 magic/version/域绑定/私钥-公钥配对（GR-10），不产生任何登记效果。材料与 Recovery File 分域由 GR-9 字节扫描防守。

## 5. 裁决四：归一化错误码（v1 冻结清单）

`PRO_REGISTRY_SIGNATURE_INVALID`、`PRO_REGISTRY_ROLLBACK`、`PRO_REVIEWER_UNREGISTERED`、`PRO_REVIEWER_REVOKED`、`PRO_APPROVAL_SIGNATURE_INVALID`、`GRP_EPOCH_ROLLBACK`、`GRP_MEMBER_NOT_ACTIVE`、`GRP_NOT_A_MEMBER`、`GRP_WRAP_DECRYPT_FAILED`、`GRP_STATE_SIGNATURE_INVALID`、`GOV_MATERIAL_INVALID`、`GOV_MATERIAL_DOMAIN_MISMATCH`、`GOV_RECOVERY_ANCHOR_INVALID`。新增错误码随实现合同 T2 同 commit 走"错误码 registry + 静态门"纪律。

## 6. 裁决五：registry 扩张映射与 T2/T3 计划

1. **映射（预计，落库时按尾号连续分配）**：团队威胁 THR-12..16（GRP/PRO/GOV 候选合并取重）、不变式 INV-25..31（PRO-INV-01..04、GRP-INV-01..05 精简合并）、验收 ACC-50..58（RT-1..8、ET-1..9、GR-1..10 去重合并为机器可断言项）；`evidence_scope: "p1-beta"`，验证器五路路由（R1/S7/P1-alpha/web-console/p1-beta）。**落库随 T2 实现 commit**（INV/ACC 与实现同 commit 先例）。
2. **T2**：core（审批/epoch 状态机纯逻辑）+ adapters（三份登记物 I/O、封装、恢复流程）+ 错误码 + schema 文件与正负样本 + INV/ACC/THR 落库 + 验证器扩展 + CLI 冒烟命令；RT-1..8/ET-1..9/GR-1..10 落为自动化测试。**T2 第一任务 = 按本合同冻结的字段表产出三份登记物的 JSON Schema + canonical 字节生成器**。
3. **T3**：clean commit 正式证据（p1-beta scope）+ ACC 翻转 + closeout 第五绑定行 `P1_BETA_TEAM_EVIDENCE_CLOSED_AT_COMMIT`（验证器同轮加路由）+ DP-018/025/019 实现侧收尾。
4. **产品 UI 边界**：团队提交入口/审核队列是协议切片后的独立产品课题，不在 T1-T3。

## 7. 自检记录（开发者委托的多轮多角度检查，2026-09-12）

**第一轮（四视角）**

- **管理者视角**：三份登记物全是签名+单调序号文件，恢复/撤销/变更可审计；§4.5 的"活跃成员保留历史密钥"意味着管理员审查时要知道"历史对在籍者永远可读"——已在 §4.5.3 要求实现合同的 UI 文案如实。**修订：§2.2.3 强调密钥不入登记物。
- **用户（审核者/成员）视角**：加入 = 所有者承认 + 本地生成 DH 密钥 + 领当期封装 CEK——无文件搬运；审批 = 本地签名。被移除 = 新内容不可读 + 传输门控 + 文档如实（L2）。**修订：无。
- **部署视角**：三份登记物 + 分发物都在域状态区，设备本地与自托管同构；封装文件经共享传输同步（自托管）或本地直接可达（设备本地）。**修订：无。
- **安全视角**：跨域/跨成员重放由 ECIES AAD 绑死；canonical JSON 的确定性由冻结字段序保证（T2 负样本测试必须含"字段序扰动被拒"）；§4.5 是本合同最大语义决策，已显著标注。**修订：§6.2 补"T2 第一任务"。

**第二轮（修订后复核）**

- 三份上游设计的每条裁决都有落点：ADR-0032 §4（公钥签名承认）→ §2.1；ADR-0033 §3/§4/§5 → §2.2/§2.3/§3/§4.5；ADR-0034 §3/§4/§5/§6 → §4/§6；错误码覆盖 RT/ET/GR 的拒绝分支 ✓；hard stop（不实现）遵守——本合同零代码 ✓；§4.5 与 ADR-0033 三级边界无矛盾 ✓。结论：T1 可提交，T2/T3 待授权。

## 8. 后果与停止点

- T1 提交后，T2/T3 各自单独授权；本合同不授权任何代码、schema 文件、registry 翻转或依赖安装。
- §4.5 若被开发者否决，回退方案 = ADR-0033 原字面（全员擦除）+ 备份历史访问降级声明，DP-025/本合同同轮回滚修订。
- 本合同不改变 head 协议、设备注册、账号边界、localhost 边界的既有裁决。
