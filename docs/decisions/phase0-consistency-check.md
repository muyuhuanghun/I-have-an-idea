# 阶段 0 一致性复审与门禁状态

> 文档版本：v0.3
> 当前状态：**REOPENED — Phase 1 未授权**
> 日期：2026-08-27
> 权威来源：执行计划 §11.2-11.3、§22
> 独立复审基线：`b8f15fca1d7a1bb31bb6b2693103da73c85588fe`
>
> 历史说明：v0.2 曾在上述 commit 宣布 Phase 0 PASS。2026-08-27 独立复审发现该结论把“已写计划/已给字段名”误当成协议闭合与可执行证据，因此该 PASS 声明已撤回。下文 §2-§6 保留为历史自检记录，当前裁决只以 §7-§8 为准。

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

## 7. 2026-08-27 当前独立复审

| 复审面 | 当前结果 | 已确认事实 | 未关闭项 / 停止条件 |
|---|---|---|---|
| Git 与产物排除 | PASS（仅此项） | 基线 commit 已跟踪协议文档；`.gitignore` 排除 `artifacts/` 和恢复材料模式 | 本轮文档修改尚未提交，不能把当前工作树描述为 clean |
| README / 执行计划状态 | PASS（当前未提交 diff） | 已改为 Phase 0 REOPENED、Phase 1 未授权、P0-R1 未实现/未测试，并通过状态断言 | 当前树仍为 dirty；提交前不得写成 clean 或已发布 |
| P0 内容范围 | PASS（当前未提交 diff） | P0 仅做 whole-file snapshot/encrypt/restore/byte verification；本地链接与状态词检查通过 | P1 同步、协调和冲突语义不得重新混入 P0 验收 |
| Manifest 定位链 | PARTIAL | locator 解决 fresh-process “到哪里取 Manifest” | 恢复文件 canonical 完整性覆盖、完整 Manifest 认证、domain/snapshot/object-ID AAD 绑定及字节编码未冻结 |
| 恢复根/恢复材料 | REPAIRED — Repair 1 完成 | ADR-0005 已冻结 P0 = bearer secret，完整性密钥自派生，INV-11 不变，诚实边界已声明 | 算法参数（HKDF salt/输出长度/完整性方案/恢复根位数）仍待 smoke test 后按 §6 冻结 |
| 整体替换/回滚 | 边界已诚实降级，仍待合同核对 | P0 无 freshness anchor、可信计数器或 latest head | 必须始终声明“只验证给定快照内部一致性”，不得声称完整反回滚 |
| 密钥图与对象替换 | FAIL — blocker | Manifest Key 与 Object Wrap Key 需要用途隔离 | 必须冻结 canonical HKDF 标签、完整 Manifest 认证和 object-ID/AAD binding，并增加 wrong-ID substitution 测试 |
| 三环境 crypto smoke | PARTIAL — plan only | 已定义候选与 Windows CLI/Desktop/Android 三环境 | Phase 0 仍缺候选×套件×环境矩阵、KAT、RandomSource 失败路径及环境/报告 schema；精确版本、lockfile、产物 hash 与 Android 报告属于获授权后的 Phase 1 证据，在产生前不得选默认候选 |
| Fixture / 性能 | PARTIAL — plan only | 候选规模与暂定阈值已冻结；ADR-0009 冻结 Windows 路径规则；ADR-0010 冻结性能 schema 和采集方法 | 生成器、分布、种子和实测基线报告仍不存在（按设计不在 Phase 0 文档范围） |
| 验收矩阵 | PARTIAL — catalog only | 37 项均有自然语言方法/证据路径，全部 untested；THR→INV→ACC→oracle→evidence 追踪表已建立（threat-traceability.md，Repair 4） | 错误码 oracle 已建立但实施代码未写；所有 required/in-scope untested 必须阻止 P0-R1 关闭 |
| 实现与运行证据 | NOT STARTED | 仓库无 `packages/`、fixture、脚本、lockfile 或测试报告 | 文档不能升级为“实现完成”“测试通过”或“P0-R1 accepted” |

当前权威裁决：

```text
PHASE_0_REVIEW_REOPENED
PHASE_1_NOT_AUTHORIZED
P0_R1_NOT_IMPLEMENTED
P0_R1_NOT_TESTED
```

## 8. 重新关闭 Phase 0 的下一道门禁

1. ~~以补充 ADR 明确恢复文件是 bearer secret 还是引入外部解锁密钥，并同步 INV-11、范围和安全声明~~ **已完成（ADR-0005，Repair 1）**；算法参数仍待 smoke 后冻结
2. ~~冻结恢复文件 canonical serialization/完整性覆盖、完整 Manifest 认证、HKDF 用途标签和 object-ID/AAD binding~~ **已关闭（ADR-0006/0007，Repair 2+3）**
3. ~~把 crypto smoke 改造成 `candidate × algorithm suite × environment` 的可复现合同，Phase 0 冻结 KAT、环境清单/报告 schema、错误码及版本/lockfile/产物哈希的采集规则~~ **已关闭（ADR-0008，Repair 5）**：JSON schema v1、required 向量清单、Android 报告机器绑定、跨环境合并规则已冻结；精确运行版本和 lockfile 在 Phase 1 获授权执行时产生
4. ~~建立 `THR-* → INV-* → ACC-* → oracle → evidence` 追踪~~ **已关闭（threat-traceability.md，Repair 4）**：5 个 THR、16 个 ATR、22 个规范错误码、ACC oracle 全部建立
5. 统一复核 README、执行计划、ADR、协议、威胁模型和验收矩阵，无相互矛盾或 stale PASS 后，才能重新裁决 Phase 0；
6. 本轮仅授权文档更新；不得自动创建工程骨架、运行密码实现、进入 Phase 1、提交或推送。
