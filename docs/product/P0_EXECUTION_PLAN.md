# P0 Execution Plan

> 计划版本：v0.3
>
> 当前状态：Phase 1 至 Phase 4-B 的合同和实现已纳管。2026-08-30 生成的 R1-A/B candidate artifacts 与 `b5fcecf` 关闭报告已于 2026-08-31 复审撤回；Phase 5 `841c26e` 同因不可构建与越界被移除出工作树。2026-09-02 修复后的 runner（含 Windows `.cmd` spawn、per-run raw 目录清理、环境漂移 fail-fast、ACC-37 扫描措辞四项阻塞修复）在 clean commit `9443cb1` 上重新生成 12 份 perf report（`PERF_RUNS_PASS`）与 37 份 acc-evidence（37/37），ACC-37 经开发者精确 token 裁决 ACCEPT；P0-R1 已按 ADR-0020 关闭。`p0-traceability-v1.json` 与验收矩阵 37 个 ACC 同步为 `passed`；DP-007/008/010/011/012 已关闭（closure_adr = ADR-0020），DP-014 保持 `deferred`。设计门同步修订为 closure 规则（全部 `untested` 或全部 `passed` + 收尾报告 `R1_EVIDENCE_CLOSED_AT_COMMIT` 绑定行，evidence 门交叉验证 commit 一致）。Phase 5 与 HTTP ObjectStore 未解锁。
>
> 日期：2026-08-30
>
> 适用仓库：`I_have_an_idea`

## 1. 文档职责和权威边界

本文件把 `README.md` 的产品定义转换为当前可执行的 P0 计划。两者职责不同：

- `README.md` 定义产品目标、长期信任承诺和 P1/P2/P3 边界；
- 本文件定义当前 P0 的子集、顺序、产物、工时、验收门槛和停止条件；
- 威胁模型、密钥生命周期、对象格式和测试计划已经分别进入对应文档；这些文档中的候选要求不等于算法参数、字节格式或测试证据已经冻结；
- 本计划不能把“拟实现”升级成“已实现”，也不能自动修改 README 中已经冻结的长期产品承诺；
- 如果实现证据与文档冲突，必须先停止并通过 ADR 修改相关文档，不能让代码静默改变协议。

当前 P0 是 README 长期设想的严格子集。P0 通过只证明本地加密快照闭环通过了已列测试，不证明完整同步产品、生产安全、零知识安全或合规状态。

## 2. 已确认的开发约束

### 2.1 目标优先级

```text
简历级技术原型
    >
小规模真实试用 ≈ 长期产品潜力
    >
密码协议研究本身
```

因此 P0 必须同时产生：

- 可演示的端到端闭环；
- 清晰、可解释的架构；
- 威胁模型和负面边界；
- 可重复自动测试；
- 10,000 文件、约 1 GiB 的规模证据；
- 失败结果和未测试项；
- 不夸大安全性的关闭报告。

### 2.2 人力和时间

- 独立开发；
- 平均每天约 1 小时、每周约 7 小时；
- 没有硬截止日期；
- 熟悉 C、Python、AI/深度学习和全栈工程；
- TypeScript 是新主语言，学习成本必须进入计划；
- 不允许以赶进度为理由跳过源数据保护、恢复演练和负面测试。

### 2.3 平台和运行方式

- Windows 是 P0 主开发与正式验收平台；
- P0 早期在真实 Android Obsidian 中做共享核心和密码候选的兼容性 smoke test；
- Android 正式同步属于 P1-alpha；
- iOS 后置；
- 移动端只承诺打开 Obsidian 后运行；
- 不要求 Obsidian 关闭后继续后台同步。

Obsidian 官方说明移动端不存在 Node.js 和 Electron API。因此共享核心及其依赖不能假设 Node/Electron 可用：<https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development>。

## 3. P0 术语

### 3.1 P0 快照恢复

“P0 快照恢复”指：在新的进程和新的本地工作状态下，只使用 Vault 外恢复文件和 ObjectStore 密文，把一个不可变快照恢复到新建空目录。

它不等于 README 的正式“域主恢复”。P0 不涉及：

- 丢失全部正式设备后的身份恢复；
- 旧设备吊销；
- 成员移除；
- 全域密钥换代；
- 历史授权迁移；
- 生产账号系统。

### 3.2 P0 Active

P0 复用：

```text
LocalPrepared
    ↓
RecoverySetupPending
    ↓
PossessionVerified
    ↓
Active
```

P0 的 `Active` 只表示当前本地域已经通过恢复文件持有性验证，可以创建加密快照。它不表示真实多设备同步已经启用，也不表示产品达到生产安全。

### 3.3 ObjectStore

ObjectStore 是只按不透明 ID 保存和读取密文对象的端口。P0 第一实现是本地目录；本地闭环关闭后，再实现 localhost HTTP 适配器。

P0 单快照阶段不引入未定义的 mutable `head`。只有在 localhost HTTP 或 P1-alpha 需要表达最新状态、前驱和条件更新时，才通过正式状态协议定义 head。

## 4. P0 范围

### 4.1 P0 IN

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

### 4.2 P0 OUT

- 文件监听；
- 增量同步；
- Base / Working / Incoming；
- 三方协调；
- 冲突 UI；
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

任何 OUT 项进入当前实现都需要先修改本计划并说明它替换了哪个已排期工作，不能作为“顺手加入”的附加功能。

## 5. 内容和路径策略

### 5.1 两层文件模型

共享核心把普通文件处理为：

```text
relative_path + byte_stream + encrypted_metadata
```

加密和快照恢复不依赖文件语义；产品层使用版本化允许列表控制正式支持范围。

P0 默认至少允许：

- `.md`；
- `.canvas`；
- `.pdf`；
- `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`；
- `.c`、`.h`、`.cpp`、`.hpp`、`.py`。

其他代码类型必须显式加入策略。“主流语言”不是允许列表。

### 5.2 不支持文件

发现未支持的普通文件时：

1. 收集相对路径和原因；
2. 在本地报告中展示；
3. 返回 `UnsupportedFilesFound`；
4. 不把快照标记为完成；
5. 不静默跳过。

### 5.3 Symlink、Junction 和重解析点

P0 统一失败关闭：

- 不跟随；
- 不读取目标内容；
- 不上传；
- 不恢复；
- 显式报告路径；
- 阻止快照正式完成。

### 5.4 P0 路径承诺

- P0 正式往返验收限定为源 Vault 与目标目录均位于 Windows NTFS 默认行为下；
- 路径必须始终保持在指定根目录内；
- 代表性 fixture 包含中文路径；
- 当前代表性 fixture 不要求空格或 Emoji，但 edge-case fixture 可以测试它们；
- 大小写碰撞通过合成 Manifest 或恶意输入测试，不要求在默认 Windows 目录中实际创建两个冲突文件；
- Windows 与 Android 的跨文件系统路径语义属于 P1-alpha 裁决。

## 6. 元数据与 AI 边界

### 6.1 P0 允许 ObjectStore 观察

- 不透明域 ID；
- 不透明对象 ID；
- 对象数量；
- 每个密文对象大小；
- 总密文字节数；
- 上传和下载时间；
- Object/协议/suite 版本；
- nonce/ciphertext/tag 的公开长度。

P0 不定义 mutable `head`、状态序号或加密代际；这些字段留待后续状态协议另行定义和验收。

### 6.2 P0 不允许 ObjectStore 观察

- 正文；
- 原始文件名；
- 扩展名；
- 相对路径；
- Markdown 铃接；
- Canvas 内容；
- 裸内容哈希；
- 密钥和恢复秘密；
- 账号 ID、成员 ID、权限事件和配额事件。P0 不产生这些控制面字段。

P0 不做大小填充、对象数量隐藏或流量隐藏，必须在关闭报告中记录该限制。

### 6.3 AI

P0 运行时零 AI。AI 只允许用于开发辅助、生成合成测试数据或离线分析报告，不能参与：

- 随机数或密钥生成；
- 加密或完整性判断；
- 路径验证；
- 域激活；
- 恢复成功判定；
- 权限和安全不变式。

## 7. 推荐架构

```text
CLI ───────────────┐
                   ├── Application Core ── Domain Core
Obsidian Plugin ───┘            │
                                ├── VaultSource port
                                ├── CryptoProvider port
                                ├── ObjectStore port
                                ├── RandomSource port
                                └── Clock port

Adapters:
  Node read-only Vault
  Obsidian Vault
  Directory ObjectStore
  HTTP ObjectStore
```

共享核心不得直接导入：

- Node `fs` 或 `path`；
- Electron；
- Obsidian API；
- Windows 专属 API；
- Android 专属 API；
- localhost HTTP 的具体实现。

推荐仓库结构：

```text
docs/
  product/
  threat-model/
  protocol/
  decisions/
  test-plans/

packages/
  core/
  crypto/
  adapters/
    node-vault/
    obsidian-vault/
    directory-object-store/
    http-object-store/

apps/
  cli/
  obsidian-plugin/
  mock-server/

tools/
  fixture-generator/
  python-verifier/

fixtures/
  tiny/
  edge-cases/

artifacts/
  generated-fixtures/
  test-reports/
  performance-reports/
```

大型 fixture 和运行报告不得提交到 Git；Git 只保存生成器、固定种子、配置、摘要和小型 fixture。

## 8. 密码与密钥设计门槛

### 8.1 不提前冻结算法

阶段 0 先冻结威胁、密钥角色、格式版本和测试要求，阶段 1 再通过真实三环境 smoke test选择实现。不得因为某个库在 Node 中运行就认定它适合 Android Obsidian。

本轮 Phase 1 正式矩阵需要比较两条候选路径：

1. 平台 Web Crypto `SubtleCrypto`，由项目 wrapper `0.1.0` 统一接口；
2. `@noble/ciphers@2.3.0` 与 `@noble/hashes@2.3.0`。

`libsodium-wrappers` 不属于本轮矩阵。若后续要加入，必须先显式修改 smoke 合同并实现对应适配器，不能把未运行候选写成已比较。

官方资料：

- Web Crypto 提供低层密码操作，部分算法支持可能不同，调用者必须正确组合：<https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto>；
- `@noble/ciphers` 是无运行时依赖的 TypeScript/JavaScript 实现，但其官方文档也明确说明 JavaScript/JIT 环境存在常数时间限制：<https://github.com/paulmillr/noble-ciphers>。

候选比较必须覆盖：

- Windows Node/CLI；
- Windows Obsidian；
- 真实 Android Obsidian；
- 随机数来源；
- AEAD；
- 二进制分块或流式策略；
- 包体积和初始化；
- 测试向量；
- 维护、审计和供应链信息；
- 错误处理；
- 升级和协议版本固定。

一次只选择一个生产实现。比较候选不意味着组合多个库拼装自创协议。

### 8.2 P0 最小密钥角色原则

P0 不默认实现为 P1 预留但当前没有验证价值的全部设备签名体系。ADR-0002/0005/0011 已回答：

- 恢复秘密如何保护域数据根；
- Manifest 和对象密钥是独立随机密钥、带标签派生，还是封装的数据密钥；
- 不同用途如何避免密钥和 nonce 复用；
- P0 快照真实性使用 AEAD、MAC 还是签名；
- fresh-process 恢复的唯一秘密输入和内部认证锚点是什么，以及为什么它不等于快照新鲜度锚点；
- 设备签名若推迟，P1-alpha 如何迁移。

当前冻结结论是：只实现满足当前不变式的最小密钥图；设备身份签名和可变 Domain State 签名推迟到 P1-alpha（DP-015）。HKDF 标签、salt、固定长度和 wire bytes 以 ADR-0011/机器合同为准，旧自然语言别名无效。

### 8.3 恢复文件

恢复文件必须：

- 由密码学安全随机源生成秘密；
- 保存在 Vault 外；
- 恰好 167 字节，具有 `EKDR`、格式/协议版本、32 字节 domain ID、suite ID、32 字节 recovery root、32 字节 snapshot ID、16 字节 Manifest object ID、16 字节指纹和 32 字节 HMAC；
- 不包含原 Vault 绝对路径、正文、文件名或账号密码；
- 生成后关闭写入句柄并重新从磁盘读取；
- 由新进程完成正式恢复演练；
- 被视为足以恢复域的高敏感秘密。

Recovery File 是 bearer file；recovery root 不再以“用其自身派生密钥 AEAD 加密自己”的方式保存。自派生 HMAC 只提供内部自洽/损坏检测，不提供针对可读取该文件者的独立防伪或静态保密。

### 8.4 对象 ID

ADR-0011 已冻结：object ID = 16 个 CSPRNG 原始字节；ObjectStore key = 22 字符无 padding base64url；AAD = 101 字节 canonical 结构；禁止裸内容哈希。每个对象先用新 ID/key/nonce 完整 seal，再调用不可变 ObjectStore 的原子 put；只有 put 返回 `OBJECT_ID_COLLISION` 才整对象重新生成。不得覆盖、不得只换文件名、不得复用 key/nonce/ciphertext，且不得把其他 I/O 错误当碰撞重试（ADR-0017 §6）。Suite 1 与 wrap 参数已由 ADR-0013 冻结；Phase 3A/3B 已分别实现 Recovery File v1、Manifest plaintext、Object AAD/Envelope 及文件/Manifest 纯内存 crypto codec。Directory ObjectStore v1 合同已由 ADR-0015 冻结，Node adapter 已实现并由提交 `684af1e` 纳管；Phase 4 已获单独授权并实现共享核心 snapshot/restore 编排与 fresh-process harness，其中恢复侧已由提交 `a6cd59f` 纳管。HTTP ObjectStore、CLI/插件产品接线和 P0-R1 正式证据仍未实现或未获授权。

## 9. Fixture 与性能基线

### 9.1 Tiny fixture

- 20–50 个文件；
- 小于约 5 MiB；
- 包含 Markdown、图片、PDF、Canvas、C 和 Python；
- 包含中文目录和中文文件名；
- 提交到 Git；
- 每次快速测试运行。

### 9.2 Edge-case fixture

至少覆盖：

- 空文件；
- 未支持扩展名；
- Symlink/Junction；
- 路径逃逸；
- 大小写碰撞；
- 扫描期间文件变化；
- 文件读取失败；
- 非空恢复目标；
- 空格和 Emoji；
- 异常或损坏 Canvas。

### 9.3 Representative fixture

- 两个同为 10,000 文件的 profile；
- small = 127,506,842..140,928,614 字节；large = 1,020,054,733..1,127,428,915 字节；
- 图片单个小于约 0.1 MiB；
- PDF 单个约 1–2 MiB；
- 不含特别大的 Canvas；
- 包含中文路径；
- 包含 `.c` 和 `.py`；
- 固定种子生成；
- 不提交生成内容。

生成器应产生结构合理的合成 Markdown，包括 frontmatter、标题、wikilink、中文段落和附件引用，便于演示并为后续冲突实验复用。但 P0 默认不做压缩，因此不能把“更像真实 Markdown”错误描述为密码正确性或加密性能成立的必要证据。

### 9.4 暂定性能门槛

- 完成 10,000 文件、约 1 GiB 的扫描、加密和恢复；
- 不把整个 Vault 读入内存；
- 使用有界并发；
- 暂定峰值 RSS 不超过 512 MiB；
- 阶段 2 取得第一份可靠基线后允许调整一次；
- 调整必须记录理由，阶段 6 关闭时冻结；
- large/small 字节比至少 7.5，large peak RSS - small peak RSS 不超过 128 MiB；
- RSS 采样间隔不超过 100 ms；
- P0 不提前承诺固定运行秒数，只记录实际环境、耗时、吞吐和峰值内存。

## 10. 阶段与工作量

工时是低置信度时间盒，不是交付承诺。按每周约 7 小时估算。

| 阶段 | 主要产物 | 预计工时 | 约合日历时间 |
|---|---|---:|---:|
| 0 | P0 合同、威胁模型、ADR、验收矩阵 | 8–12 小时 | 1–2 周 |
| 1 | TypeScript 基础、工程骨架、三环境密码 spike | 10–16 小时 | 1.5–3 周 |
| 2 | fixture、只读扫描器、Manifest | 14–20 小时 | 2–3 周 |
| 3 | 恢复文件、密钥图、加密对象、Directory ObjectStore | 22–30 小时 | 3–5 周 |
| 4 | fresh-process 恢复、Python 独立验证 | 14–20 小时 | 2–3 周 |
| 5 | 极薄 Windows Obsidian 插件 | 8–14 小时 | 1–2 周 |
| 6 | 10,000 文件压力、破坏性测试、P0-R1 关闭 | 14–20 小时 | 2–3 周 |
| 7 | localhost HTTP ObjectStore、网络失败测试 | 12–24 小时 | 2–4 周 |

P0-R1（本地目录闭环）约 90–132 小时，即约 13–19 个满额投入周；考虑学习、返工和现实中断，合理日历窗口是 13–24 周。阶段 7 完成后才规划 P1-alpha。

## 11. 阶段 0：文档硬门槛

GLM 评审指出原“七个一小时工作单元”不足以容纳完整一致性审查。阶段 0 改为 10–14 个一小时工作单元，不再强求一周完成。

### 11.1 Git 基线历史记录（已完成）

本节原先描述建立初始 Git 基线前的操作顺序。实际历史已经发生，当前事实以 Git 和 ADR-0001 为准：

- `949afcc` 一次性提交 `.gitattributes`、`.gitignore`、README 和本计划，未把 v0.1/v0.2 分成两个提交；
- `0d5f4cb` 通过 ADR-0001 记录该偏差，不回写或改写已推送历史；
- `af4a64a` 提交范围、内容策略、威胁模型和安全不变式；
- `3b9f8d3` 提交其余 Phase 0 文档；
- `b8f15fc` 补充验收项草案、Manifest 定位符、smoke 条件和 Git 忽略规则。

`b8f15fc` 是历史 v0.2 复审基线，不是当前 Git 基线，也不是 Phase 0 已通过的证据。随后 gate-repair commits 到 `583a3a1` 已提交；本轮 v1.0 修复前基线是 `583a3a167258bbc223f5f2f78bf4ca04fd5fd847`。本轮设计合同与验证器升级已通过三个语义清晰的 commit `c59d865` / `6856c47` / `fcbc873` 提交并推送到 `origin/main`；在 `fcbc873` 提交并推送完成时，`main...origin/main` 为 `0 0` 且工作树 clean。“未提交 diff”只属于该历史提交前的中间状态，不再适用。

### 11.2 工作单元

1. 完成 P0 术语表和 IN/OUT；
2. 冻结内容允许列表、未知文件和重解析点行为；
3. 写威胁模型的资产、攻击者和信任边界；
4. 写安全不变式和服务器元数据边界；
5. 画恢复秘密、域根、Manifest/对象密钥的候选密钥图；
6. 写共享核心和适配器 ADR；
7. 写 P0 状态真实性、是否需要签名以及为何不提前引入 head 的 ADR；
8. 写恢复文件和对象 ID 格式要求；
9. 写密码候选三环境 smoke test 方案；
10. 写 fixture 分布和性能基线方案；
11. 建立验收矩阵 schema 和前 10 条关键要求；
12. 补齐其余要求、负面测试和证据路径；
13. 使用本文件的评审处置表逐项检查 README、计划和 ADR；
14. 只有所有 P0 阻塞项关闭后，才允许阶段 1 开始。

### 11.3 阶段 0 通过条件

- P0 的 IN/OUT 无模糊项；
- “快照恢复”和“域主恢复”已经区分；
- 内容范围与 README 一致；
- Symlink/Junction 行为明确为拒绝；
- P0 元数据是 README 长期边界的严格子集；
- P0 运行时零 AI；
- 最小密钥图有书面理由；
- ObjectStore 不含未定义 head；
- object ID、AAD、Recovery/Manifest canonical bytes 已由 ADR-0011 和 wire registry 冻结；
- Android 真机 smoke test 方案明确；
- 37 ACC / 16 INV / 5 THR 有稳定 ID、双向追踪和机器 oracle；
- smoke/fixture/performance/ACC evidence 有 JSON Schema 且缺项失败；
- 任何未关闭项都有明确 owner、阶段和停止条件。

### 11.4 当前复审状态

截至 2026-08-29 的当前状态：

- ADR-0011 消除 Manifest AAD/recovery material 循环依赖，冻结 wire bytes/HKDF/object ID；
- ADR-0012 冻结 5 份 JSON Schema、缺项失败规则和数值 oracle；
- registry 机器闭合 37 ACC / 16 INV / 5 THR，并登记 26 个逐项负责的延期参数；
- `python tools/verify_phase0_contracts.py` 可检查设计合同，但不会自动升级 ACC；`--validate-samples` 模式用 9 对正/负样本反身校验当前 9 份 schema；`--evidence-root` 模式同时校验 ACC 外层与 perf/visibility/roundtrip 内层 schema、raw artifact hash、同一 evidence commit 及 registry/matrix 的 `passed` 状态；
- Phase 0 修复已通过 commit `c59d865` / `6856c47` / `fcbc873` 提交并推送到 `origin/main`；Phase 1 实现与 dev-only 复审已由用户手动提交并推送，实施提交为 `927eb4efc5c33117df72e95256a9ffe7120a8902`；
- Phase 1 已按用户单独授权完成工程骨架、共享核心/适配器骨架、统一门禁、最小 Obsidian 插件和正式三环境 smoke；六份 source report 绑定 clean commit `63db4eeb71a3ddab527000453a389a53cabe0db1`，Android 两份 verified binding 已独立验签，两个候选均取得 `cross_env_pass`；ADR-0013 已选择 Web Crypto 并关闭 DP-001..005。
- Phase 2 实现提交为 `dc41fe435b7df95208ffb334dae9a90080bbbb3a`；fixture 绑定修正提交 `d170d97bce59f991dc180319c12a7127cc3dc1bd` 后取得 `mode=formal`，ADR-0014 关闭 DP-006/009。

因此当前裁决是 Phase 0 design-only/design-only+samples 门通过，Phase 1 正式矩阵与选型关闭完成，Phase 2 的 Tiny fixture 参数已正式关闭。随后已实现 Manifest/Object 加密、Recovery、Directory ObjectStore 与共享核心 snapshot/restore，但这些实现/单元测试和本轮 dirty-source fresh-process 冒烟仍不升级任何 ACC。正式 ACC evidence、representative/performance fixture 与压力报告尚不存在，当前仍不是 P0-R1 PASS。

## 12. 阶段 1：工程骨架和移动兼容性

### 12.1 TypeScript 学习前置

至少安排以下短练习并保留小测试：

- `strict` 类型检查；
- interface 与 discriminated union；
- Promise、`async`/`await` 和错误传播；
- `Uint8Array`、`ArrayBuffer` 和避免无界复制；
- ESM/CJS 边界；
- 依赖打包；
- Web/Node 随机数接口差异。

学习练习不进入协议包，不用练习代码污染正式实现。

### 12.2 工程骨架

- 建立 workspace；
- 建立 core、crypto、adapters、CLI 和插件包；
- 建立统一 lint/typecheck/test 命令；
- 建立最小 Obsidian 插件；
- 用依赖检查阻止共享核心导入 Node/Electron/Obsidian。

### 12.3 三环境 smoke test

每个候选至少在以下环境执行相同小测试向量：

1. Windows Node/CLI；
2. Windows Obsidian；
3. 真实 Android Obsidian。

测试内容：随机数、AEAD 往返、篡改拒绝、二进制输入、初始化耗时和内存。任何候选只在前两种环境通过，都不能成为 P0 默认实现。

## 13. 阶段 2：扫描、Manifest 和 fixture

2026-08-29 用户单独授权的实施切片只包含 deterministic Tiny fixture、只读扫描器和 Manifest plaintext codec。为保持精简，本切片不生成 10,000 文件 representative/performance fixture；DP-008、性能基线和 ACC-26/29/30/31 继续保持 open/untested。

扫描器必须：

- 只读源 Vault；
- 不在源 Vault 创建缓存、数据库、锁或临时文件；
- 排除 `.obsidian`；
- 拒绝 Symlink/Junction；
- 对未知文件失败关闭；
- 文件读取前后检查变化；
- 使用有界并发；
- 通过端口读取文件，不在核心中调用 Node API。

Manifest 必须严格实现 ADR-0011 的 canonical plaintext，并把完整明文作为 AEAD payload。当前字段是：

- 域和快照标识；
- 内容策略版本；
- domain/snapshot/parent snapshot、内容策略版本和 suite；
- 每个文件的严格 UTF-8 相对路径、16 字节 object ID、明文字节数和 wrapped object key；
- entry 按路径原始 UTF-8 bytes 严格升序，无 NUL、无尾随字节。

P0 不保存本地修改时间；因此不会把它以明文泄漏，也不在 v1 Manifest 中发明未冻结字段。

本次授权切片的通过条件：Tiny fixture 稳定；源 Vault 零写入；未知文件和重解析点失败关闭；扫描中变化的文件不会产生扫描结果；Manifest plaintext 严格闭合。原计划的 Representative fixture 条件延期到另行授权的性能工作，不得由 Tiny 结果替代。

## 14. 阶段 3：恢复文件、加密对象和目录存储

2026-08-30 用户单独授权的 Phase 3A 只包含 SHA-256/HMAC-SHA-256、Recovery File v1 和 Node 侧 Vault 外落盘回读；该切片已由提交 `454afddaa9f4d76ac05a2c8fd38f9c9ebd3a45c8` 纳管。随后单独授权的 Phase 3B 只包含冻结的 HKDF、object ID/base64url、Object AAD/Envelope、对象密钥包装及文件/Manifest 纯内存 AEAD；该切片已由提交 `696e199908e865f296e9e0fb822d431d98caae93` 纳管并获开发者追认。再随后单独授权的 Phase 3C 分两步：Phase 3C-0 冻结 Directory ObjectStore v1 合同（ADR-0015，机器 registry 仅新增 `OBJECT_STORE_IO_FAILED`），Phase 3C-A 实现并测试 Directory ObjectStore Node adapter；该切片已由提交 `684af1eef4dc5122b0140c43ed24009c2f651e21` 纳管。服务器可见性报告按 Phase 3D 分两步执行：3D-0 冻结扫描合同（ADR-0016），3D-A 实现扫描器、CLI 与机器 Schema；直接修正后的实现已通过独立复审并由提交 `1f5e27473336b150165889106a6562653dd49a89` 纳管。其正式 ACC-32/33 证据仍要求 snapshot pipeline 存在后按 P0-R1 证据门执行。Phase 4-0 已完成：ADR-0017 已由开发者四点确认接受（含 `SOURCE_FILE_READ_FAILED`/`RECOVERY_FILE_WRITE_FAILED` 注册与 §8.4 碰撞措辞修订）。Phase 4-A 已单独授权并实现 snapshot 创建编排与 ADR-0017 §10 测试边界；该切片已由提交 `fbdf3250859030c433e44376a75340458ee13da1` 纳管。Phase 4-B-0 已完成并经独立复审纠错：保持 `INCOMPLETE_RESTORE` v1 不使用，新增 `RESTORE_TARGET_WRITE_FAILED`、修正 ACC-25 oracle 并冻结 path-free partial-output inventory。Phase 4-B-A 已单独授权并实现恢复编排与 fresh-process harness，复审错误已修正，仍在未提交复审边界。CLI 接线、HTTP ObjectStore、插件接线与 P0-R1 证据门继续禁止。

实现顺序：

1. 确认 DP-001..005 已由 suite 选择 ADR/KAT/真机报告关闭；
2. 严格按 ADR-0011/wire registry 实现 CSPRNG 和 key/nonce 生命周期封装；
3. 实现恢复文件生成；
4. 关闭写入并重新读取恢复文件；
5. 实现 Manifest 和文件对象认证加密；
6. 实现 Directory ObjectStore；
7. 实现服务器可见性报告；
8. 加入错误密钥和篡改测试。

相同明文重复加密不得产生可直接关联的相同密文对象。ObjectStore 和日志中不得出现测试预置的明文正文、文件名、扩展名和路径。

## 15. 阶段 4：fresh-process 恢复

正式集成测试：

```text
进程 A 创建快照
    ↓
进程 A 退出
    ↓
删除 P0 本地工作状态
    ↓
进程 B 只读取恢复文件和 ObjectStore
    ↓
恢复到新建空目录
    ↓
Python 独立验证器比较路径集合和文件字节
```

恢复器必须拒绝：

- 非空目标目录；
- 路径逃逸；
- 大小写折叠后碰撞；
- 缺失、截断或篡改对象；
- 错误恢复文件；
- 不支持的格式版本。

任何部分写入不能被报告为完整成功。

## 16. 阶段 5：极薄 Obsidian 插件

插件只负责：

- 调用共享核心创建 P0 快照；
- 展示扫描、恢复持有性和加密进度；
- 展示文件数、原始/密文字节和服务器可见性摘要；
- 导出测试报告。

CLI 继续负责正式 fresh-process 恢复，以便安全选择新建空目录和清理本地状态。插件不得复制密码或 Manifest 实现。

## 17. 阶段 6：压力和破坏性验收

至少测试：

- 10,000 文件、约 1 GiB 完整往返；
- 错误恢复文件；
- 恢复文件截断；
- 对象缺失、重复、截断和篡改；
- Manifest 篡改；
- 扫描中文件变化或消失；
- 非空目标；
- 路径逃逸和大小写碰撞；
- Symlink/Junction；
- 写入中断和模拟磁盘不足；
- 日志写入失败；
- 未支持文件；
- 服务器明文标记扫描；
- 源 Vault 零修改；
- 峰值 RSS 和处理耗时。

P0-R1 关闭报告必须区分：已通过、失败、未测试、已知限制和移出范围。

## 18. 阶段 7：localhost HTTP ObjectStore

只有 P0-R1 关闭后才开始。

最小能力：

- PUT/GET/存在性检查不透明对象；
- 幂等重试；
- 大小限制；
- 超时、断线、重复请求和部分失败模拟；
- 目录后端复用；
- 不引入账号、团队、计费或生产部署。

若加入 HTTP 后必须修改共享加密核心或恢复语义，说明前面的端口边界失败，必须回到架构修复，不能复制一套网络版本。

## 19. P0-R1 完成定义

只有以下条件全部成立，P0-R1 才能关闭：

1. 共享核心无 Node/Electron/Obsidian 依赖；
2. Windows CLI、Windows Obsidian 和 Android smoke test 调用同一核心；
3. 恢复文件由 CSPRNG 生成并保存在 Vault 外；
4. 持有性验证重新读取磁盘文件；
5. 新进程只凭恢复文件和 ObjectStore 恢复；
6. 10,000 文件、约 1 GiB 完整往返；
7. 支持文件相对路径集合和字节完全一致；
8. `.c`、`.py` 等明确支持的代码文件完整往返；
9. 未支持文件不被静默跳过；
10. 源 Vault 零写入；
11. 非空恢复目标被拒绝；
12. 路径逃逸、重解析点和大小写碰撞被拒绝；
13. 错误密钥、篡改、缺失对象和不支持版本失败关闭；
14. ObjectStore 和服务器日志不含禁止的明文信息；
15. 实测内存有界，性能目标按冻结规则评估；
16. 有机器可读和人类可读报告；
17. 测试可从干净环境重复运行；
18. 文档没有宣称生产安全或独立审计完成。

## 20. 硬停止条件

发生以下任一情况必须停止当前阶段，不得带病进入下一阶段：

- 任何测试修改了源 Vault；
- fresh-process 恢复依赖未声明的本地缓存或内存秘密；
- ObjectStore 或日志出现禁止的明文；
- Android Obsidian 不能运行已选密码实现；
- 共享核心必须导入 Node/Electron 才能工作；
- 10,000 文件处理仍按 Vault 总大小无界占用内存；
- 未支持文件被静默遗漏；
- 路径验证允许写出目标根目录；
- 篡改或错误密钥被当成成功；
- README、协议文档、ADR 和实现出现无法解释的冲突。

停止后只做问题定位、范围修订和负面证据记录，不继续后续功能。

## 21. 推荐提交序列

```text
docs: establish product definition v0.1
docs: align product definition with P0 decisions
docs: add initial P0 execution plan
docs: freeze P0 scope content policy and terminology
docs: add P0 threat model and security invariants
docs: record architecture recovery metadata and state decisions
test: define P0 acceptance matrix and fixture profiles
build: scaffold TypeScript workspace and shared core
test: add cross-runtime crypto smoke harness
test: add deterministic tiny Vault fixtures
feat: implement read-only Vault inventory
feat: implement versioned manifest generation
test: add representative Vault generator
feat: implement versioned recovery file
feat: implement encrypted object format
feat: add directory ObjectStore adapter
feat: implement fresh-process snapshot restore
test: add independent Python round-trip verifier
feat: add thin Obsidian snapshot interface
test: add 10000-file one-gibibyte acceptance profile
test: add corruption crash and metadata-leak checks
docs: publish P0-R1 closeout report
feat: add localhost HTTP ObjectStore adapter
```

提交信息只是建议；未经单独授权，不自动提交。

## 22. GLM 评审处置记录

| 编号 | 处置 | 结论 |
|---|---|---|
| C1 内容范围 | 采纳 | README 显式改为核心字节模型 + 版本化允许列表，并加入代码文件 |
| C2 P0 范围 | 采纳 | Base/Working/Incoming 和三方协调移入 P1-alpha |
| C3 恢复术语 | 采纳 | 增加“P0 快照恢复”，与正式域主恢复分离 |
| C4 元数据 | 采纳并澄清 | P0 是长期元数据边界的严格子集，不产生账号/成员字段 |
| C5 AI | 采纳并澄清 | P0 运行时零 AI，开发辅助不进入安全判断 |
| C6 激活状态 | 采纳并限定 | 复用状态名，但 P0 Active 不代表生产就绪 |
| C7 性能 | 采纳 | 10,000/1 GiB 和 512 MiB 为暂定目标，基线后只允许调整一次 |
| C8 Git 基线 | 历史偏差已记录 | 初始提交实际合并 v0.1/v0.2；不改写历史，以 ADR-0001 和当前 Git SHA 为准 |
| I1 密钥角色 | 调整 | 不默认实现六类密钥；阶段 0 论证最小密钥图，设备签名默认后置 |
| I2 ObjectStore head | 采纳 | 单快照 P0 删除 head；增量/HTTP 状态协议再定义 |
| I3 重解析点 | 采纳 | P0 默认拒绝 Symlink/Junction |
| I4 对象 ID | 采纳 | 位数、CSPRNG、编码和碰撞策略在实现前冻结 |
| I5 fixture 代表性 | 部分采纳 | 生成结构合理 Markdown，但不把它误写成无压缩加密性能的必要证据 |
| R6 TypeScript 学习 | 采纳 | 学习成本纳入阶段 1，不假设 1–2 小时即可掌握完整工程边界 |
| R7 密码候选 | 采纳并核实 | 从 Web Crypto、libsodium.js、noble 中比较至少两条路径；本轮矩阵已明确为 Web Crypto + Noble，依正式三环境实测选择 |
| R8 Android 环境 | 采纳原则 | 不依赖“应该可用”或未核实运行时标签，直接在真实 Android Obsidian 测试 |
| R9 Windows 大小写 | 采纳 | P0 正式往返限定 NTFS 默认行为，恶意大小写碰撞用合成输入拒绝 |
| R10 一小时矩阵 | 采纳 | 阶段 0 扩为 10–14 个工作单元，不把完整矩阵挤进一小时 |

## 23. 下一授权门槛

Phase 1 至 Phase 4-B 已完成各自获授权的合同与实现切片。2026-08-31 复审撤回的 R1 证据已于 2026-09-02 重做：clean commit `9443cb1` 上重跑 12 份 perf report 与 37 份 ACC evidence，ACC-37 经 machine-scan hash 的显式开发者 token 裁决 ACCEPT，registry/矩阵同步为 `passed`，嵌套 `--evidence-root artifacts` 门通过，新关闭报告与 ADR-0020 成立（P0-R1 关闭）。Phase 5-0 合同已冻结：ADR-0021 经开发者四点确认接受（snapshot-only 插件边界、端口拦截 core 零改动、`p0-plugin-snapshot-report-v1` schema + 机器门、全部显式路径无默认）。下一授权门槛为 **Phase 5-A**：按 ADR-0021 §2 实现 CLI 接线（`snapshot` 进程内创建 + `restore` 新进程恢复，拒绝非空目标并新建空目录），绑定 clean commit 并交付 `docs/test-plans/phase5a-cli-report.md`；5-B 插件薄 UI 在 5-A 纳管后另行授权。DP-014（HTTP ObjectStore）解锁评估仍被其 hard_stop 阻止，除非另立合同裁决。

1. 本轮 R1 重做中的全部修复（`9000d63`、`d861e28`、`62ad56f`、`9443cb1`）与收尾提交均经用户显式授权后提交并推送；
2. ACC-37 的裁决 token 只对生成它的 machine-scan（即提交 `9443cb1` 时的 10 份扫描目标）有效；任何被扫描文档的后续变更都会使既有 token 失效，重跑证据需要新的开发者裁决；
3. Phase 5-A 实现未获明确授权前不得开工；5-A 交付物不得包含任何插件改动（插件属 5-B）；
4. 任何偏离 ADR-0009 路径规则、ADR-0011 bytes、ADR-0012 schema、ADR-0013 Suite 1、ADR-0017/0018 编排语义、ADR-0021 接线边界的修改都必须先停下并形成明确合同裁决；
5. 本计划不授权自动提交、推送或把未授权的 dirty diff 描述为已提交。

本计划不授权自动提交或推送。本轮修改已经由用户显式授权后通过 commit `c59d865` / `6856c47` / `fcbc873` 提交并推送到 `origin/main`；之后的 README/一致性/执行计划 stale 措辞修订也属于用户显式授权下的小补丁提交。
