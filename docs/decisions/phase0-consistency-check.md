# 阶段 0 一致性检查与通过条件

> 文档版本：v0.1
> 状态：阶段 0 工作单元 13-14
> 日期：2026-08-27
> 权威来源：执行计划 §11.2-11.3、§22

## 1. 职责

对阶段 0 的全部文档执行逐项一致性检查，确认执行计划 §11.3 的通过条件全部满足。只有全部通过条件满足后，才允许阶段 1 开始。

## 2. 一致性检查记录

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
| 对象 ID 参数有待实现前关闭的门槛 | §11.3 | 通过 | P0-recovery-and-object-format.md §3.2 |
| 禁止裸内容哈希作为对象 ID | §8.4 | 通过 | P0-recovery-and-object-format.md §3.3 |

### 2.9 密码候选（工作单元 9）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 三环境 smoke test 方案明确 | §11.3 | 通过 | P0-crypto-smoke-test-plan.md |
| 至少比较两条候选路径 | §8.1 | 通过 | P0-crypto-smoke-test-plan.md §2 |

### 2.10 Fixture 与性能（工作单元 10）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| fixture 分布和性能基线方案已写 | §11.2.10 | 通过 | P0-fixture-and-performance-baseline.md |

### 2.11 验收矩阵（工作单元 11-12）

| 检查项 | 来源 | 结果 | 证据 |
|---|---|---|---|
| 验收矩阵 schema 已建立 | §11.2.11 | 通过 | P0-acceptance-matrix.md §2 |
| 前 10 条关键要求已写 | §11.2.11 | 通过 | P0-acceptance-matrix.md §3.1-3.2 |
| 其余要求、负面测试和证据路径已写 | §11.2.12 | 通过 | P0-acceptance-matrix.md §3 全部、§4 |
| 每个安全要求至少一个负面测试 | §11.3 | 通过 | P0-acceptance-matrix.md §3 负面测试项 |

## 3. 执行计划 §11.3 通过条件逐项核对

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
| 9 | 对象 ID 参数有实现前关闭的门槛 | 满足 | P0-recovery-and-object-format.md §5 |
| 10 | Android 真机 smoke test 方案明确 | 满足 | P0-crypto-smoke-test-plan.md §3 |
| 11 | 验收矩阵每个安全要求至少一个负面测试 | 满足 | P0-acceptance-matrix.md §3 |
| 12 | 任何未关闭项有明确 owner、阶段和停止条件 | 满足 | 见 §4 待裁决项 |

## 4. 仍在实现前关闭的待裁决项

以下项已在文档中定义门槛，但不冻结具体数值，推迟到阶段 1 smoke test 后冻结：

- 恢复根位数、KDF 参数、对象密钥包装方案、完整性方案（ADR-0002 + P0-recovery-and-object-format.md §5）；
- 对象 ID 随机位数和编码（P0-recovery-and-object-format.md §3.2）；
- AEAD 具体算法和 nonce 策略（P0-crypto-smoke-test-plan.md）；
- 性能阈值在阶段 2 取得基线后允许调整一次（P0-fixture-and-performance-baseline.md §5）。

这些项的 owner 是开发者本人，关闭阶段是阶段 1-2，停止条件是 smoke test 三环境全部通过。

## 5. 阶段 0 通过声明

执行计划 §11.2.14 要求：只有所有 P0 阻塞项关闭后，才允许阶段 1 开始。

本检查确认：

- §11.3 的 12 条通过条件全部满足；
- §22 GLM 评审处置表的各项已在对应文档中落实；
- 剩余待裁决项均为"实现前冻结数值"类型，有明确 owner、阶段和停止条件，不构成阶段 1 开始的阻塞。

因此，阶段 0 文档硬门槛通过，允许进入阶段 1（工程骨架和三环境密码 smoke test）。

## 6. 阶段 1 启动前置确认

进入阶段 1 前，开发者应确认：

1. 已阅读并理解全部阶段 0 文档；
2. 接受 ADR-0001 至 ADR-0004 的决策；
3. 理解待裁决项将在阶段 1-2 冻结；
4. 准备 Windows 开发环境和 Android Obsidian 真机测试条件。