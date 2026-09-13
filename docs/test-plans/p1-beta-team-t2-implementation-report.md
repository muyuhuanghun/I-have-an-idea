# P1-beta 团队协议 T2 实现报告（DP-018/025/019 实现切片）

- 切片：团队协议实现阶段 T2（ADR-0035 §6.2），feat 提交 `d79b45f`，工作树 clean
- 合同：ADR-0032/0033/0034（三设计）+ ADR-0035（T1 实现合同，§4.5 ET-9 细化随本切片生效）
- 状态：协议层实现与 RT/ET/GR 自动化测试完成；ACC-50..58 保持 `untested`（`evidence_scope: "p1-beta"`），正式证据属 T3 切片

## 1. 交付物

1. **core `team.ts`**（平台中立，WebCrypto subtle 同设备签名契约）：三份登记物（proposal-reviewers-v1 / group-state-v1 / group-epoch-keys-v1）的 canonical-JSON 编码（字段序冻结、闭合 canonical form 解析——多余/缺失字段拒绝、重排字段归一化后无法携带原签名）、审批记录签名与验证（绑定注册表状态哈希，INV-25）、epoch 状态机（成员变更必推代际、removed 追加不删）、`deviceIdBytes`（32-hex → 16B 原始字节，AAD 用）、13 个 `TeamProtocolError` 归一化错误码。
2. **crypto `key-agreement.ts`** + core `KeyAgreementPort`：ECIES pairwise 封装（临时 ECDH P-256 × 成员内容 DH 公钥 → HKDF-SHA-256（salt=domain_id，info="ekd-group-epoch-cek-v1"）→ AES-256-GCM；AAD = domain_id‖epoch u64BE‖device_id 原始字节）。成员内容 DH 密钥与 head 签名密钥分域。
3. **adapters `team-registry.ts`**（子入口 `./team-registry`）：
   - `ProposalReviewersRegistryFile` / `GroupStateRegistryFile`：签名文件 + **追加式 journal 防回滚**（高水位检查；epoch 密钥分布文件按 §4.5 设计持久保留、读取不设 journal 门、提交必须推进高水位——历史分布对在籍成员永远可读）；
   - `#advance`：新 epoch CEK 生成 + 对活跃成员逐一双边封装（被移除设备的封装条目从新分布消失 = ET-9 可验证擦除核心）；
   - `unwrapEpochCek`：成员侧解封，任何不匹配归一化为 `GRP_WRAP_DECRYPT_FAILED`；
   - 治理恢复：材料编解码（magic/版本/域绑定/integrity）、dry-run 解码、`performRecovery` 六步编排（锚签名承认 → 新设备按需加入（epoch 推进）或 rotateEpoch → **新权威重签** → 旧权威签名自此失效）。
4. **CLI `team-smoke`**：无参数沙箱全生命周期自测（9 步：初始化/承认审核者/加入/解封/旧 epoch 拒绝/审批签名/移除后分布/恢复/新权威推进）， verdict JSON 输出，退出码 0/1。
5. **机器门**：THR-12..16、INV-25..31、ACC-50..58（untested/p1-beta）+ 13 错误码 + 3 份 schema + 3 对正负样本 + acc_id 模式扩至 ACC-58 + 验证器计数/五路路由（R1/S7/P1-alpha/web-console/p1-beta）+ 矩阵 ACC-50..58。

## 2. 门禁（feat 提交时点）

- `pnpm run test:all` exit 0（lint + typecheck + test + verifier unittests + build）；
- 测试计数：core **67**（+6 team：canonical 确定性/闭合解析/状态机/AAD）、crypto 21、adapters **99**（+13 team：RT-1..8/ET-1..9/GR-1..10 场景化负正例）、smoke 5、cli 8、plugin 21；
- `PHASE0_CONTRACT_CHECK_PASS mode=design-only+samples ACC=58 INV=31 THR=16 DP=27`（九个 p1-beta ACC 待证据）；
- `node apps/cli/dist/main.js team-smoke` → `{"verdict":"pass", steps: 9/9 ok}`（初始化→承认审核者→加入推 epoch→成员解封→旧 epoch 拒绝→审批签名→移除后分布→恢复承认+epoch 延续→新权威推进）。

## 3. T2 过程中修复的实现缺陷（均已入测试）

1. 签名文件往返：文件 = 无签名 canonical 去尾 `}` 接签名字段；读取必须**补回 `}`** 再解析（首版直接解析带签名字段的残缺 JSON）。
2. epoch 密钥分布的 journal 语义：历史分布按 §4.5 永久保留，读取不得设高水位门；提交（新 epoch）才要求推进高水位——否则"旧 epoch 可读"被误判为回滚。
3. 恢复流程的验证权威切换：join/rotate 用**新权威签名**写入后，同流程内的读取必须切到新权威公钥验证（否则旧权威验证新签名失败）。
4. AAD 设备字节：device_id 是 32-hex 字符串，AAD 用**原始 16 字节**（首版误用 UTF-8 编码的 64 字节字符串）。
5. 候选样本卫生：正/负样本中的占位 base64 含空格/散文会被 pattern 拒绝；负样本 = 登记物携带明文 CEK 字段（additionalProperties:false 拒绝）。

## 4. 诚实边界

1. ET-9 擦除语义按 ADR-0035 §4.5 细化：可验证核心 = 被移除设备在新分布中无条目；配合离开设备的本地擦除与敌意保留（L2 诚实域）的区分随实现交付。
2. 传输层 L2 门控（ADR-0033 §5.2）属于共享传输形态的访问控制，本切片未含 HTTP 层改动；ACC-55 的门控断言在 T3 按适用形态取证。
3. 治理恢复材料泄露不可远程吊销（ADR-0034 §9.1）随实现交付文档。
4. 团队协作产品 UI（提交入口/审核队列）不在协议切片（ADR-0035 §6.4）。

## 5. 后续

- T3（未授权）：`tools/acc-team-evidence-run.mjs` 在 clean commit 上把 RT/ET/GR 场景产出为 acc-evidence-v1 报告（`evidence_scope: "p1-beta"`）+ closeout 第五绑定行 `P1_BETA_TEAM_EVIDENCE_CLOSED_AT_COMMIT` + 验证器同轮路由 + ACC-50..58 翻转 + DP-018/025/019 实现侧收尾。
