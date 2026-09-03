# 阶段 0 一致性复审与门禁状态

> 文档版本：v1.0
> 当前状态：**DESIGN CONTRACT STATIC CHECK PASS；Phase 1 至 Phase 4-B 已实现。2026-08-31 撤回的 R1 evidence 已于 2026-09-02 在 clean commit `9443cb1` 上重做并通过嵌套证据门，ACC-37 经开发者 token 裁决；P0-R1 已按 ADR-0020 关闭，37 ACC 在 registry/矩阵中为 `passed`，DP-007/008/010/011/012 已关闭。Phase 5 仍未关闭。**
> 日期：2026-09-02
> 权威来源：执行计划 §11.2-11.3、§22
> 本轮修复前 Git 基线：`583a3a167258bbc223f5f2f78bf4ca04fd5fd847`
>
> 历史说明：v0.2 的 Phase 0 PASS 已撤回；v0.3 的 `PHASE_0_DOCUMENT_GATE_REPAIRED` 后续又被发现含 Manifest AAD 和 recovery material 两条循环依赖、伪 schema 和不完整 oracle，因此同样只保留为历史。下文 §2-§11 全部是历史记录；当前裁决只以 §12-§15 为准。

## 1. 职责

对阶段 0 文档执行独立一致性复审，区分“文档存在”“字段/命令被提及”“协议语义已冻结”“实现存在”和“测试已通过”。只有当前阻塞项关闭、交叉引用核对完成并再次获得明确 PASS，才允许阶段 1 开始。

## 2. 历史 v0.2 一致性自检记录（已被当前复审取代）

本节“通过”仅表示 v0.2 当时的自我判定，不是当前门禁状态，不得单独引用为 Phase 0 PASS 证据。

### 2.1 术语与范围（工作单元 1）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| P0 的 IN/OUT 无模糊项 | §11.3 | 通过 | docs/protocol/P0-scope-and-glossary.md §3-5 |
| 快照恢复和域主恢复已区分 | §11.3 | 通过 | P0-scope-and-glossary.md §2 术语表 |
| 内容范围与 README 一致 | §11.3 | 通过 | P0-content-policy.md §3 与 README §7.2 对照 |

### 2.2 内容策略（工作单元 2）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 内容允许列表冻结 | §11.3 | 通过 | P0-content-policy.md §3 |
| 未知文件行为明确为失败关闭 | §11.3 | 通过 | P0-content-policy.md §5 |
| Symlink/Junction 行为明确为拒绝 | §11.3 | 通过 | P0-content-policy.md §6 |

### 2.3 威胁模型（工作单元 3）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 资产、攻击者和信任边界已写 | §11.2.3 | 通过 | docs/threat-model/P0-threat-model.md §3-5 |
| 诚实安全边界已声明 | §11.2.3 | 通过 | P0-threat-model.md §7 |

### 2.4 安全不变式（工作单元 4）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 安全不变式已冻结 | §11.3 | 通过 | P0-security-invariants.md §2 |
| P0 元数据是 README 长期边界的严格子集 | §11.3 | 通过 | P0-security-invariants.md §3.1 |
| P0 运行时零 AI | §11.3 | 通过 | P0-security-invariants.md §4 |
| 硬停止条件已定义 | §11.2.4 | 通过 | P0-security-invariants.md §5 |

### 2.5 密钥图（工作单元 5）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 最小密钥图有书面理由 | §11.3 | 通过 | ADR-0002 |
| 恢复秘密保护域数据根 | §8.2 | 通过 | ADR-0002 §决策 |
| Manifest/对象密钥派生或封装关系明确 | §8.2 | 通过 | ADR-0002 §派生关系图 |
| nonce 和密钥不复用 | §8.2 | 通过 | ADR-0002 §设计理由 |
| 设备签名默认后置 | §8.2 | 通过 | ADR-0004 |

### 2.6 架构（工作单元 6）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 共享核心和适配器 ADR | §11.2.6 | 通过 | ADR-0003 |
| 核心禁止导入 Node/Electron/Obsidian | §7 | 通过 | ADR-0003 §共享核心禁止导入 |
| 依赖检查阻止禁止导入 | §7 | 通过 | ADR-0003 §依赖检查 |

### 2.7 状态真实性（工作单元 7）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| P0 状态真实性 ADR | §11.2.7 | 通过 | ADR-0004 |
| ObjectStore 不含未定义 head | §11.3 | 通过 | ADR-0004 §ObjectStore 不含 head |
| P0 真实性使用 AEAD | §8.2 | 通过 | ADR-0004 §真实性通过 AEAD |

### 2.8 格式要求（工作单元 8）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 恢复文件格式要求已写 | §8.3 | 通过 | P0-recovery-and-object-format.md §2 |
| Manifest 定位符闭合 fresh-process 恢复链 | §8.3 | 通过 | P0-recovery-and-object-format.md §2.2 |
| 恢复根保护方式已定义 | §8.3 | 通过 | P0-recovery-and-object-format.md §2.4 |
| 重放边界已定义 | §8.3 | 通过 | P0-recovery-and-object-format.md §4 |
| 对象 ID 参数有待实现前关闭的门槛 | §11.3 | 通过 | P0-recovery-and-object-format.md §3.2 |
| 禁止裸内容哈希作为对象 ID | §8.4 | 通过 | P0-recovery-and-object-format.md §3.3 |

### 2.9 密码候选（工作单元 9）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 三环境 smoke test 方案明确 | §11.3 | 通过 | P0-crypto-smoke-test-plan.md |
| smoke test 具体执行条件已定义 | §8.1 | 通过 | P0-crypto-smoke-test-plan.md §4 |
| 至少比较两条候选路径 | §8.1 | 通过 | P0-crypto-smoke-test-plan.md §2 |

### 2.10 Fixture 与性能（工作单元 10）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| fixture 分布和性能基线方案已写 | §11.2.10 | 通过 | P0-fixture-and-performance-baseline.md |

### 2.11 验收矩阵（工作单元 11-12）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 验收矩阵 schema 已建立 | §11.2.11 | 通过 | P0-acceptance-matrix.md §2 |
| 每条 ACC 含测试方法、错误判定、证据路径和状态 | §11.2.11 | 通过 | P0-acceptance-matrix.md §3 全部 |
| 前 10 条关键要求已写 | §11.2.11 | 通过 | P0-acceptance-matrix.md §3.1-3.2 |
| 其余要求、负面测试和证据路径已写 | §11.2.12 | 通过 | P0-acceptance-matrix.md §3 全部、§4 |
| 每个安全要求至少一个负面测试 | §11.3 | 通过 | P0-acceptance-matrix.md §3 负面测试项 |
| 全部 ACC 初始状态为 untested | §11.3 | 通过 | P0-acceptance-matrix.md §3 |

## 3. 历史 v0.2 对 §11.3 的逐项核对（已被当前复审取代）

| # | 通过条件 | 状态 | 引用 |
|---|---|---|---|
| 1 | P0 的 IN/OUT 无模糊项 | 满足 | P0-scope-and-glossary.md |
| 2 | 快照恢复和域主恢复已区分 | 满足 | P0-scope-and-glossary.md §2 |
| 3 | 内容范围与 README 一致 | 满足 | P0-content-policy.md §3 |
| 4 | Symlink/Junction 明确为拒绝 | 满足 | P0-content-policy.md §6 |
| 5 | P0 元数据是 README 严格子集 | 满足 | P0-security-invariants.md §3.1 |
| 6 | P0 运行时零 AI | 满足 | P0-security-invariants.md §4 |
| 7 | 最小密钥图有书面理由 | 满足 | ADR-0002 |
| 8 | ObjectStore 不含未定义 head | 满足 | ADR-0004 |
| 9 | 对象 ID 参数有实现前关闭的门槛 | 满足 | P0-recovery-and-object-format.md §3.2、§6 |
| 10 | Android 真机 smoke test 方案明确 | 满足 | P0-crypto-smoke-test-plan.md §3、§4 |
| 11 | 验收矩阵每个安全要求至少一个负面测试 | 满足 | P0-acceptance-matrix.md §3 |
| 12 | 任何未关闭项有明确 owner、阶段和停止条件 | 满足 | 见 §4 待裁决项 |

## 4. 历史 v0.2 待裁决项描述（不再充分）

v0.2 曾把以下问题统一描述为“实现前冻结数值”。当前复审判定其中既有数值，也有必须先关闭的协议语义、认证绑定和证据设计问题：

- 恢复根位数、KDF 参数、对象密钥包装方案、恢复根保护方案、完整性方案（ADR-0002 + P0-recovery-and-object-format.md §6）；
- 对象 ID 随机位数、编码和 Manifest 定位符编码（P0-recovery-and-object-format.md §3.2）；
- AEAD 具体算法和 nonce 策略（P0-crypto-smoke-test-plan.md）；
- 性能阈值在阶段 2 取得基线后允许调整一次（P0-fixture-and-performance-baseline.md §5）。

原文把 owner 统一写成“开发者本人”、关闭阶段写成阶段 1-2、停止条件写成三环境 smoke 全通过，但未逐项绑定负责人、输入、产物和判定 oracle。该描述不能作为当前门禁关闭依据。

## 5. 历史 v0.2 通过声明（已撤回）

执行计划 §11.2.14 要求：只有所有 P0 阻塞项关闭后，才允许阶段 1 开始。

v0.2 自检曾声称：

- §11.3 的 12 条通过条件全部满足；
- §22 GLM 评审处置表的各项已在对应文档中落实；
- fresh-process 恢复链已闭合：恢复文件含 Manifest 定位符，新进程可凭恢复文件定位并解密 Manifest（P0-recovery-and-object-format.md §2.2）；
- 验收矩阵每条 ACC 含具体测试方法、错误判定、证据路径和初始状态（untested）；
- 重放边界、恢复根保护方式和 smoke test 执行条件已定义；
- .gitignore 已添加 artifacts/ 和恢复文件忽略规则，防止误提交测试数据或恢复材料；
- 剩余待裁决项均为"实现前冻结数值"类型，有明确 owner、阶段和停止条件，不构成阶段 1 开始的阻塞。

上述结论在 2026-08-27 独立复审后撤回。特别是，“Manifest 有定位符”只闭合寻址，不等于恢复文件/Manifest/对象引用的完整认证闭合；“所有 ACC 都有文字描述且为 untested”也不等于验收 oracle 完整或任何测试通过。

## 6. 历史 v0.2 阶段 1 前置确认（当前不适用）

进入阶段 1 前，开发者应确认：

1. 已阅读并理解全部阶段 0 文档；
2. 接受 ADR-0001 至 ADR-0004 的决策；
3. 理解待裁决项将在阶段 1-2 冻结；
4. 准备 Windows 开发环境和 Android Obsidian 真机测试条件。

当前 Phase 0 为 REOPENED，因此本节不能被用作启动清单。


## 7. 历史 v0.3：2026-08-27 独立复审与 gate repair 进展（结论已取代）

| 复审面 | v0.2 状态 | 当前状态（v0.3） | 已确认事实 | 剩余 / 停止条件 |
|---|---|---|---|---|
| Git 与产物排除 | PASS | **PASS** | 基线 commit 跟踪全部协议文档；`.gitignore` 排除 `artifacts/`、恢复材料模式 | 实施时持续验证 |
| README / 执行计划状态 | PASS（未提交 diff） | **PASS（已提交）** | b03ff66/b980a0b/499731f/1471572/ac2000f/98643a7/e6d996d 7 个 commit 提交并推送；状态词保持 REOPENED | 实施时持续验证 |
| P0 内容范围 | PASS | **PASS** | P0 仅做 whole-file snapshot/encrypt/restore/byte verification；本地链接与状态词检查通过；同步/协调/合并等 P1 语义已从 content-policy 删除 | 不得将 P1 语义重新混入 |
| Manifest 定位链 | PARTIAL | **REPAIRED — Repair 2+3 完成** | locator 闭合寻址；ADR-0006 冻结恢复文件 canonical serialization 和完整性覆盖；ADR-0007 冻结完整 Manifest 字段顺序、HKDF 标签、对象 AAD 字节布局和错误码 | 实施时按 ADR 编码 |
| 恢复根/恢复材料 | FAIL | **REPAIRED — Repair 1 完成** | ADR-0005 冻结 P0 = bearer secret；完整性密钥 = HKDF(recovery_root, info=ekd-v1/recovery-file-integrity)；INV-11 不变；诚实边界已声明 | 算法参数（HKDF salt/输出长度/完整性方案选择/恢复根位数）待 §6.2 smoke test 后冻结 |
| 整体替换/回滚 | 边界已诚实降级 | **REPAIRED — Repair 1 确认诚实边界** | ADR-0005 明确 P0 不提供完整反回滚、快照新鲜度或可信 latest 指针 | 关闭报告 known-limitation 记录 |
| 密钥图与对象替换 | FAIL | **REPAIRED — Repair 3 完成** | ADR-0002 加入 Object Wrap Key 用途隔离；ADR-0007 §3 冻结 `ekd-v1/manifest-key`、`ekd-v1/object-wrap-key`、`ekd-v1/recovery-file-integrity` 三个 canonical HKDF 标签；§4 冻结对象 AAD 85 字节布局（绑定 object_id） | ACC-15 wrong-ID substitution 负面测试获得协议依据 |
| 三环境 crypto smoke | PARTIAL | **REPAIRED — Repair 5 完成** | ADR-0008 冻结 JSON schema v1、required 向量清单（KAT/tamper/HKDF/wrap/random 11 类）、Android 报告机器绑定、跨环境合并规则 | 实际三环境运行需 Phase 1 授权 |
| Fixture / 性能 | PARTIAL | **REPAIRED — Repair 6 完成** | ADR-0009 冻结 Windows NTFS 路径规则（10 类不合法路径、Unicode、重解析点、保留名）；ADR-0010 冻结性能 schema v1（5 阶段采集、9 项指标、ACC oracle 字段映射、阈值调整规则） | 实际生成器与基线报告需 Phase 1 实施 |
| 验收矩阵 | PARTIAL | **REPAIRED — Repair 4 完成** | threat-traceability.md 建立 5 THR + 16 ATR + 22 错误码 + ACC oracle 完整映射；THR→INV→ACC→oracle→evidence 链可机器审计 | 实施代码未写；所有 ACC 仍为 untested（必须保持） |
| 实现与运行证据 | NOT STARTED | **NOT STARTED（按设计）** | 仓库无 `packages/`、fixture、脚本、lockfile 或测试报告 | Phase 0 文档门禁关闭后，需独立授权进入 Phase 1 |

## 8. 历史 v0.3：Gate Repair 关门声明（已撤回）

执行计划 §11.2 + 复审列出的 7 项 gate repair 中，6 项已通过 ADR 关闭：

1. **~~bearer secret vs 外部解锁秘密~~ — 已关闭（ADR-0005）**
2. **~~恢复文件 canonical serialization/完整性覆盖~~ — 已关闭（ADR-0006）**
3. **~~完整 Manifest 认证与 object-ID/AAD binding 字节级合同~~ — 已关闭（ADR-0007）**
4. **~~THR→INV→ACC→oracle→evidence 追踪~~ — 已关闭（threat-traceability.md）**
5. **~~Smoke KAT、环境/报告 schema、错误 oracle~~ — 已关闭（ADR-0008）**
6. **~~Windows 路径、fixture 分布、性能采集 schema~~ — 已关闭（ADR-0009、ADR-0010）**

第 7 项（独立复审后重新判断）即本节自我审计结论。

## 9. 历史 v0.3：独立复审自检（不再是当前证据）

### 9.1 引用一致性

- ADR 编号 ADR-0001 至 ADR-0010 全部存在；交叉引用无悬挂；
- threat-traceability.md §4 定义 22 个规范错误码，ACC oracle 表全部引用其中之一或 `null`；
- 4 个 gate repair 相关 ADR（0006/0007/0008/0010）的错误码与 threat-traceability 完全一致。

### 9.2 状态词一致性

- "PASS" 词仅出现在 v0.2 历史自检表（§2-§6）、§7 表格单元和已撤回声明位置；
- 当前状态词统一为 `REPAIRED`（已修复但需实施）、`PASS`（已验证）、`NOT STARTED`（未开始）。

### 9.3 文档层级一致性

- 协议文档（P0-recovery-and-object-format.md）引用 ADR-0005/0006/0007 解决 §6.1 阻塞项；
- 一致性检查文档（本文档）跟踪 gate repair 进展；
- 威胁模型引用 ADR-0005/0007 提供缓解不变式；
- 验收矩阵保留 37 项 untested，与 P0-R1 未实现/未测试事实一致。

### 9.4 诚实边界保持

- 整体替换旧恢复文件 + 旧 ObjectStore 仍标记为 P0 不提供的能力（ADR-0005 + threat-model §4.3）；
- 关闭报告应记录为 known-limitation，不是已知失败；
- 实施代码尚未编写，不得声称任何 ACC 已通过。

## 10. 历史 v0.3 门禁裁决（已撤回）

```text
PHASE_0_DOCUMENT_GATE_REPAIRED
PHASE_0_PHASE_0_NOT_TESTED
PHASE_1_PENDING_AUTHORIZATION
P0_R1_NOT_IMPLEMENTED
P0_R1_NOT_TESTED
```

含义：

- **PHASE_0_DOCUMENT_GATE_REPAIRED**：6 项文档门禁已通过 ADR 关闭；
- **PHASE_0_PHASE_0_NOT_TESTED**：文档门禁通过不等于 Phase 0 已通过；需在实施后由 P0-R1 关闭报告确认；
- **PHASE_1_PENDING_AUTHORIZATION**：Phase 1 仍需单独授权；当前无代码、无测试、无 fixture 证明实施可行；
- **P0_R1_NOT_IMPLEMENTED**：仓库无 packages/、fixture、脚本、lockfile 或测试报告；
- **P0_R1_NOT_TESTED**：全部 37 项 ACC 仍为 untested。

## 11. 历史 v0.3 Phase 1 启动前置（不再适用）

Phase 1 启动仍需开发者单独授权，且授权前必须确认：

1. 已阅读并理解全部 10 份 ADR、7 份协议文档、2 份威胁文档、1 份追踪表、1 份验收矩阵；
2. 接受 ADR-0005 至 ADR-0010 的决策；
3. 接受 §10 的当前门禁状态（文档已 repair，实施未开始）；
4. 接受 Phase 1 仅授权工程骨架和 smoke test 实施；
5. 准备 Windows 开发环境、Android Obsidian 真机和 fixture 生成器；
6. 实施过程中严格执行 ADR 冻结的合同，任何偏差需新 ADR。

## 12. 当前 v1.0 修复事实

| 修复面 | 当前合同 | 静态状态 | 运行状态 |
|---|---|---|---|
| Manifest AAD 循环 | Recovery File v1 先提供受 HMAC 覆盖的 snapshot ID；Manifest AAD 全部字段解密前可得 | 已关闭（ADR-0011） | Recovery File v1 与 Manifest 纯内存 AEAD 已分别由 `454afdd` / `696e199` 纳管并通过实现级复审；尚无正式 ACC evidence |
| recovery material AEAD 循环 | bearer file 直接携带 32 字节 root，固定 HMAC-SHA256；明确无独立静态保护 | 已关闭（ADR-0011） | Phase 3A codec/HMAC 已由 `454afdd` 纳管并通过实现级测试；尚无正式 ACC evidence |
| Canonical bytes | 167 字节 recovery、19 字节 envelope、101 字节 AAD、长度前缀 Manifest、统一大端/UTF-8/no-NUL/no-trailing | 机器 registry 闭合 | Recovery/Manifest plaintext、Object Envelope/AAD 与纯内存 AEAD 已实现并纳管，全部 ACC 仍 `untested` |
| HKDF/object ID | 4 个 byte-exact info；salt=domain ID；object ID=16 raw bytes；store key=22 base64url chars | 机器 registry 闭合 | 4 条 HKDF、随机 raw ID/canonical 文本、对象密钥包装、碰撞后整对象重试与 Directory ObjectStore 编排已有实现；正式 ACC evidence 尚未生成 |
| 37/16/THR 追踪 | 37 ACC、16 INV、5 THR 双向 registry；非安全 ACC 不伪造威胁链接 | 静态检查通过 | 37 ACC 全 untested |
| smoke schema | draft 2020-12 schema、14 required vectors、缺项 invalid、三环境 aggregate | 真校验（含 enum/pattern/format/contains/uniqueItems） | 正式两候选六单元矩阵已完成，两个 aggregate 均为 `cross_env_pass`；ADR-0013 已选择 Web Crypto |
| fixture schema | tiny/small/large profile、generator/hash/entry/coverage required | 真校验（含 allOf if/then profile 边界） | Tiny fixture/generator 已 formal 并由 ADR-0014 关闭 DP-006/009；small/large 不存在 |
| performance schema | 512 MiB、100 ms、7.5× bytes、128 MiB RSS growth 的数值 oracle | 真校验（含 bounded_memory_comparison 的 oneOf 与 allOf 触发条件） | baseline/report 不存在 |
| 延期参数 | DP-001..026 均有 owner/phase/status/close artifact/hard stop | 静态检查通过 | DP-001..005 绑定 ADR-0013，DP-006/009 绑定 ADR-0014；DP-007/008/010/011/012 已于 2026-09-02 关闭（closure_adr = ADR-0020），DP-014 保持 `deferred` |
| Schema 强制门禁 | `validate_evidence` 校验 ACC 外层并递归校验 perf/visibility/roundtrip artifact 与 raw hash；`--validate-samples` 用 9 对正/负样本反身校验 9 份 schema | design+samples PASS | 9 份正样本通过、9 份负样本被拒 |

## 13. 当前机器门禁

设计合同命令：

```powershell
python tools/verify_phase0_contracts.py
```

预期成功签名：

```text
PHASE0_CONTRACT_CHECK_PASS mode=design-only ACC=37 INV=16 THR=5 DP=26
P0_R1 remains NOT_IMPLEMENTED / NOT_TESTED; no ACC status was upgraded.
```

该命令检查 ID、双向链接、oracle、wire offsets/lengths/HKDF、schema required、schema 关键字子集、延期参数和验收矩阵数量。它不读取运行 evidence 也不把 ACC 改为 passed。

反身校验命令：

```powershell
python tools/verify_phase0_contracts.py --validate-samples
```

预期成功签名：

```text
PHASE0_CONTRACT_CHECK_PASS mode=design-only+samples ACC=37 INV=16 THR=5 DP=26
```

`tools/schema-samples/` 下为每份 schema 各放一对正/负样本；正样本必须被接受，负样本必须被拒。该模式证明 schema 强制路径本身在工作，而不是只检查 `additionalProperties` 和顶层 `required`。

未来 P0-R1 evidence gate 是：

```powershell
python tools/verify_phase0_contracts.py --evidence-root artifacts
```

`validate_evidence` 在加载每份 evidence 后用 `acc-evidence-v1` 真校验：缺字段、未知字段、错误类型、enum/pattern/format/uniqueItems/contains 违反都会立即被拒；`artifacts[].path` 必须位于 `evidence-root` 之下、文件存在、`sha256` 与文件实际内容匹配。当前缺少 37 份 evidence，因而不能运行通过。这是预期的未实现状态，不得伪装成 incomplete/pass。

## 14. 当前门禁裁决

```text
PHASE0_CONTRACT_CHECK_PASS_DESIGN_ONLY
PHASE0_CONTRACT_CHECK_PASS_DESIGN_ONLY_AND_SAMPLES
PHASE_1_ENGINEERING_SCAFFOLD_COMPLETE
PHASE_1_FORMAL_SMOKE_CROSS_ENV_PASS
PHASE_1_CRYPTO_SUITE_SELECTED
PHASE_2_SCANNER_MANIFEST_IMPLEMENTED_NOT_ACC_VERIFIED
PHASE_2_TINY_FIXTURE_FORMAL_PROVENANCE_PASS
DP_006_009_CLOSED_BY_ADR_0014
PHASE_3A_RECOVERY_FILE_REVIEW_IMPLEMENTED
PHASE_3B_OBJECT_CRYPTO_REVIEW_IMPLEMENTED
PHASE_3C0_OBJECT_STORE_DIRECTORY_CONTRACT_FROZEN
PHASE_3C_A_DIRECTORY_OBJECT_STORE_ADAPTER_IMPLEMENTED
PHASE_3D0_STORAGE_VISIBILITY_SCAN_CONTRACT_FROZEN
PHASE_3D_A_STORAGE_VISIBILITY_SCANNER_IMPLEMENTED
PHASE_4_0_SNAPSHOT_PIPELINE_CONTRACT_ACCEPTED
RUNTIME_LIMITS_V1_ACCEPTED_AND_MACHINE_GATED
PHASE_4_A_SNAPSHOT_CREATE_ORCHESTRATION_IMPLEMENTED
PHASE_4_B0_RESTORE_PIPELINE_CONTRACT_ACCEPTED
PHASE_4_B_A_RESTORE_ORCHESTRATION_IMPLEMENTED
R1_CANDIDATE_EVIDENCE_REJECTED_2026_08_31
PHASE_5_WIRING_REJECTED_AND_REMOVED_FROM_WORKTREE
R1_EVIDENCE_REGENERATED_ON_CLEAN_COMMIT_9443CB1_2026_09_02
ACC_37_DEVELOPER_RULING_ACCEPTED_2026_09_02
P0_R1_CLOSED_PER_ADR_0020
ACC_37_OF_37_PASSED
PHASE_5_0_WIRING_CONTRACT_ACCEPTED
PHASE_5_A_5_B_IMPLEMENTATION_NOT_AUTHORIZED
```

含义：

- 这轮用户要求的协议/追踪/schema/延期项/状态一致性已经形成机器可检查设计合同；
- Phase 1 工程骨架和 smoke harness 已按单独授权完成，正式 clean-source 六单元矩阵中两个候选均取得 `cross_env_pass`；
- ADR-0013 选择 Web Crypto wrapper `0.1.0` 和 Suite 1，DP-001..005 已关闭；
- Phase 1 正式 `random-source-errors` 向量既有的 `RANDOM_SOURCE_SHORT_READ` / `RANDOM_SOURCE_FAILED` / `RANDOM_SOURCE_ALL_ZERO` 已补入规范错误码机器 registry；没有新增错误语义或重写正式报告；
- Phase 2 已单独授权；deterministic Tiny fixture、Node 只读扫描器和 Manifest plaintext codec 已实现，Tiny fixture 已取得 commit-bound formal provenance，ADR-0014 只关闭 DP-006/009；
- DP-007/008/010/012 保持 `open`，DP-011 保持 `conditional`；scanner/Manifest 单元测试不升级任何 ACC；
- Phase 3A 已单独授权并由提交 `454afdd` 落库：只实现 SHA-256/HMAC-SHA-256、Recovery File v1 codec 和 Vault 外 Node 落盘回读，不含对象加密、ObjectStore 或恢复流程，也不升级任何 ACC；
- Phase 3B 已单独授权并由提交 `696e199` 纳管、获开发者追认：只实现冻结的纯内存 HKDF、object ID、AAD/Envelope、对象密钥包装及文件/Manifest AEAD；ObjectStore、pipeline、快照、恢复和所有 ACC 状态均未实施；
- Phase 3C-0 已单独授权并冻结 Directory ObjectStore v1 合同（ADR-0015）：不可变写入、原子发布、碰撞返回、路径 containment、Windows reparse point、部分写入清理、耐久性平台边界与错误归一化；机器 registry 仅新增 `OBJECT_STORE_IO_FAILED`；DP-014 与 HTTP ObjectStore 边界不变；
- Phase 3C-A 已单独授权：Directory ObjectStore Node adapter 已实现并测试，已由提交 `684af1e` 纳管；HTTP ObjectStore、snapshot pipeline、恢复流程、插件接线与 Phase 4 仍被禁止；
- Phase 3D-0 已单独授权并冻结存储可见性扫描合同（ADR-0016）：原始字节扫描、目录结构白名单、三族 marker 逐项自测、已知秘密 raw+hex、扩展名 token、offset 0 magic、报告脱敏、`storage-visibility-scan-v1` JSON Schema 与失败关闭；不新增错误码、不改 DP；
- Phase 3D-A 已单独授权：扫描器、CLI、机器 Schema 与测试经直接修正后通过独立复审，已由提交 `1f5e274` 纳管；ACC-32/33 保持 `untested`，正式证据仍要求 snapshot pipeline 存在后按 P0-R1 证据门执行；
- Phase 4-0 已完成：ADR-0017 经开发者四点确认接受（DP-012 拟议值、Recovery File complete 定义、日志封口顺序、注册两个新错误码）；runtime-limits v1（`contract_status=accepted`）已接入 `verify_phase0_contracts.py` schema/样例机器门；机器 registry 新增 `SOURCE_FILE_READ_FAILED`、`RECOVERY_FILE_WRITE_FAILED`（+2）；`P0_EXECUTION_PLAN.md` §8.4 碰撞措辞已按 ADR-0017 §6 修订；DP-012 保持 `open`，DP 状态零变化；
- Phase 4-A 已单独授权：snapshot 创建编排（core `createSnapshotV1`，严格按 ADR-0017 §4 顺序、§6 碰撞循环、§7 日志绑定、§8 orphan 语义、§9 错误收敛）与 Node 日志 sink/Recovery File 目标适配器、1 MiB 分块稳定读取、`snapshot-log-v1` schema 机器门及 ADR-0017 §10 测试边界已实现，已由提交 `fbdf325` 纳管；CLI 接线、HTTP ObjectStore、插件接线与 P0-R1 证据门仍被禁止；
- Phase 4-B-0 已完成并经独立复审纠错：保持 `INCOMPLETE_RESTORE` v1 不使用，机器 registry 新增 `RESTORE_TARGET_WRITE_FAILED`（+1），ACC-25 oracle 同步到该码，并冻结不含原始路径的 `partialOutputInventory`；
- Phase 4-B-A 已单独授权：恢复编排（core `restoreSnapshotV1`，ADR-0018 §4 顺序与拒绝规则映射、全量校验先于任何写入）与 `NodeRestoreTarget`、fresh-process worker CLI、纯 stdlib Python 验证器已实现；独立复审指出的错误码闭包、验证器 missing-root 假 PASS/fingerprint 漏检、ASCII fold、清零时序和负面测试缺口已修正；第二轮独立复审边界内 PASS，F7（探针失败错误码语义）经开发者裁决按方案 A 修复（→ `REPARSE_POINT_FOUND`），已由提交 `a6cd59f` 纳管；CLI 接线、HTTP ObjectStore、插件接线与 P0-R1 证据门仍被禁止；
- 2026-08-31 复审曾确认当时的 candidate evidence 不能通过修复后的嵌套 schema/provenance/oracle 门；2026-09-02 修复后的 runner 在 clean commit `9443cb1` 上重新生成 12 份 perf report 与 37 份 acc-evidence，全部通过嵌套证据门，ACC-37 经开发者精确 token 裁决 ACCEPT（machine-scan sha256 `5dbc2a72…`）；
- P0-R1 已按 ADR-0020 关闭：registry 与矩阵 37 个 ACC 同步为 `passed`（closure 门控规则 + `R1_EVIDENCE_CLOSED_AT_COMMIT` 绑定行交叉验证），DP-007/008/010/011/012 以本次证据关闭；这不等同于生产安全声明，Phase 5 与 HTTP ObjectStore 仍未解锁。
- Phase 5-0 已完成：ADR-0021 经开发者四点确认接受（5-A CLI 先行/5-B 插件后行、端口拦截 core 零改动、新增 `p0-plugin-snapshot-report-v1` schema + 机器门、log/store/recovery 全部显式路径无默认、domainId 仅设置页 64-hex 且源 Vault 零写入、runtime-limits hash 必须对真实文件字节计算）。无错误码新增、无 DP/ACC 状态变化；5-A/5-B 实现未获授权不得开工。

## 15. 当前状态一致性

README、执行计划、协议、ADR、验收矩阵和本文统一使用以下含义：

- `frozen design contract`：字节、schema、oracle 或门禁已经明确，可静态检查；
- `untested/not implemented`：没有运行证据；
- `historical/superseded/withdrawn`：仅保留决策演进，不是当前权威；
- `deferred/open/conditional/closed`：只在延期 registry 中使用；`closed` 还必须绑定存在的 closure ADR；
- `PASS design-only`：只指静态合同检查；registry 全部 `untested` 时期它绝不构成 P0-R1 PASS，registry 全部 `passed` 时期它也不重新验证运行时 artifacts（运行时验证专属 `--evidence-root` 模式）；
- `PASS design-only+samples`：design-only 加上 9 份 schema 的 9 对正/负样本反身校验通过，证明 schema 强制路径在 work；运行时证据仍以 `--evidence-root` 为准。

本轮修复前基线为 `583a3a1`。本轮设计合同、验证器升级和状态文档已通过三个语义清晰的 commit `c59d865` / `6856c47` / `fcbc873` 提交并推送到 `origin/main`；在 `fcbc873` 提交并推送完成时，`main...origin/main` 为 `0 0`、工作树 clean。门禁结果为 `PHASE0_CONTRACT_CHECK_PASS (design-only)` 与 `PHASE0_CONTRACT_CHECK_PASS (design-only+samples)`。2026-09-02 的 R1 关闭轮（验证器 closure 规则、registry/矩阵/DP 同步、ADR-0020 与状态文档对账）见 ADR-0020 与收尾报告 §-1；证据门结果为 `PHASE0_CONTRACT_CHECK_PASS mode=design+evidence+samples ACC=37 INV=16 THR=5 DP=26`。
