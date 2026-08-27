# P0 范围与术语表

> 文档版本：v0.1
> 状态：阶段 0 工作单元 1
> 日期：2026-08-27
> 权威来源：README.md、docs/product/P0_EXECUTION_PLAN.md

## 1. 职责

本文件冻结 P0 的术语边界和 IN/OUT 范围。术语定义与 README 和执行计划一致；本文件不修改已冻结的产品承诺，只把长期定义转换为可测试的 P0 子集边界。

## 2. 术语表

| 术语 | P0 含义 | 与正式产品的差异 |
|---|---|---|
| 域（Domain） | 单用户绑定一个本地 Vault 文件夹的同步、加密和历史边界 | P0 只有单用户、单设备，不涉及团队域、多成员或正式 Domain State |
| Domain ID | 不透明域标识，由本地生成 | 不涉及服务端正式串行化或跨域去重 |
| Vault | 磁盘上的普通文件夹，通过 Obsidian 编辑 | README §5.1 已冻结；P0 不依赖 Obsidian API 运行 |
| 内容策略（Content Policy） | 版本化的允许列表，决定哪些扩展名可进入正式快照 | P0 默认列表见 §4 |
| Manifest | 版本化的加密清单，记录文件逻辑标识、相对路径、大小、密文对象引用和完整性承诺 | P0 不含团队 Proposal、Candidate Revision 或 Domain State 字段 |
| 恢复文件（Recovery File） | Vault 外的高熵恢复材料，含 magic、格式版本、协议版本、域 ID、密码套件标识、恢复材料、完整性和非秘密指纹 | P0 不等于正式域主恢复，不涉及旧设备吊销或全域换代 |
| 持有性验证（Possession Verified） | 新进程重新从磁盘读取恢复文件，证明可凭 Vault 外材料恢复 | 不接受内存中密钥或勾选框 |
| P0 Active | 本地域已通过恢复文件持有性验证，可创建加密快照 | 不代表多设备同步启用或生产安全达标 |
| ObjectStore | 按不透明 ID 保存和读取密文对象的端口 | P0 第一实现为 Directory ObjectStore；不引入 mutable head |
| 对象 ID（Object ID） | 随机、不透明的密文对象标识 | 禁止裸内容哈希作为对象 ID |
| P0 快照恢复 | 新进程只凭恢复文件和 ObjectStore，把不可变快照恢复到新建空目录 | 不等于正式域主恢复；P0 只有单用户、单快照 |
| Source of Truth | P0 中由开发者在 CLI/插件中显式指定的只读源 Vault | 不验证 README §9.1 的设备绑定流程 |
| 独立验证器 | Python 脚本，逐文件比较恢复目录与源目录的相对路径和字节 | 不参与加密或恢复判定 |

## 3. P0 IN（纳入范围）

1. P0 合同、威胁模型、安全不变式和关键 ADR；
2. TypeScript 共享核心；
3. Node/CLI 适配器；
4. Python 独立验证器；
5. 极薄的 Windows Obsidian 插件；
6. Android Obsidian 兼容性 smoke test；
7. 只读 Vault 扫描；
8. 版本化内容允许列表；
9. 版本化加密 Manifest；
10. Vault 外单个高熵恢复文件；
11. 恢复文件持有性验证；
12. 本地认证加密和版本化密文对象；
13. 随机、不透明对象 ID；
14. Directory ObjectStore；
15. 新进程向新建空目录执行快照恢复；
16. 源目录与恢复目录的独立逐文件验证；
17. 服务器可见性扫描；
18. 10,000 文件、约 1 GiB 的代表性 fixture；
19. 篡改、缺失对象、错误恢复文件、路径逃逸、非空目标和中断测试；
20. 本地闭环关闭后实现 localhost HTTP ObjectStore；
21. P0 关闭报告。

## 4. P0 默认内容允许列表

P0 默认至少允许以下扩展名进入正式快照：

- .md
- .canvas
- .pdf
- .png、.jpg、.jpeg、.gif、.webp
- .c、.h、.cpp、.hpp、.py

其他代码类型必须通过版本化内容策略显式加入。"主流语言"不是允许列表，不能用模糊分类自动扩大支持范围。

## 5. P0 OUT（排除范围）

以下能力在 P0 中明确不实现。任何 OUT 项进入实现都需要先修改执行计划并说明替换了哪个已排期工作。

- 文件监听；
- 增量同步；
- Base / Working / Incoming；
- 三方协调与冲突 UI；
- 第二台真实设备；
- Android 正式同步；
- iOS；
- 账号、密码、2FA、Passkey；
- 团队域、成员和角色；
- Proposal 和 Candidate Revision；
- Named Release；
- 配额和计费；
- 历史保留后台清除；
- 跨发布清除；
- AI 运行时组件；
- 自托管迁移；
- 生产服务器；
- 生产安全、零知识安全或合规声明。

## 6. 术语区分检查项

- "P0 快照恢复"与正式"域主恢复"已在术语表中区分；
- P0 Active 不表示生产就绪，仅表示可创建加密快照；
- ObjectStore 不含未定义的 mutable head；
- P0 的 ObjectStore 元数据是 README §5.2 长期元数据边界的严格子集。