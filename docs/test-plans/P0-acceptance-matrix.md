# P0 验收矩阵

> 文档版本：v0.3
> 状态：验收目录草案；37 项全部 untested，Phase 0 门禁重新打开
> 日期：2026-08-27
> 权威来源：执行计划 §19、§17、§11.3

## 1. 职责

定义 P0-R1 关闭所需的验收目录、状态语义和证据位置。当前 37 项均是自然语言测试合同；文中出现的 `pnpm` 命令、脚本名和证据路径是预期接口，不代表对应实现或报告已经存在。进入实现前仍须把要求、威胁/不变式、可自动判定 oracle、稳定错误码和副作用检查建立可追踪映射。

## 2. 验收矩阵 Schema

每条验收要求包含以下字段：

| 字段 | 说明 |
|---|---|
| ID | 唯一标识，如 ACC-01 |
| 要求 | 一句话描述验收内容 |
| 来源 | 引用 README/执行计划/安全不变式/ADR 的条款 |
| 测试类型 | 正面（happy path）或负面（fault injection） |
| 测试方法 | 具体测试步骤、脚本路径和输入 fixture |
| 错误判定 | 明确什么结果算失败（供测试自动判定） |
| 证据路径 | 测试报告输出文件的相对路径 |
| 状态 | passed/failed/untested/known-limitation/out-of-scope |
| 备注 | 已知限制或移出范围说明 |

全部 ACC 的初始状态为 untested。只有真实执行并绑定证据后才能更新状态；文档存在、命令名存在或人工说明都不能替代测试通过。

## 3. 验收要求清单

### 3.1 架构与端口

**ACC-01：共享核心无 Node/Electron/Obsidian 依赖**
- 来源：执行计划 §19.1、ADR-0003
- 测试类型：正面
- 测试方法：对 packages/core 和 packages/crypto 运行 ESLint import-restriction 规则，检查是否导入 fs、path、electron、obsidian 模块。脚本：`pnpm run check:imports`
- 错误判定：发现任何禁止导入即失败
- 证据路径：`artifacts/test-reports/acc-01-import-check.json`
- 状态：untested

**ACC-02：Windows CLI、Windows Obsidian、Android smoke test 调用同一核心**
- 来源：执行计划 §19.2
- 测试类型：正面
- 测试方法：在三个环境分别导入 packages/core 并执行同一快照往返 smoke test（tiny fixture）。脚本：`pnpm test:smoke:node`、Obsidian 插件内置测试按钮、Android 兼容性测试
- 错误判定：任一环境导入失败或结果不一致即失败
- 证据路径：`artifacts/test-reports/acc-02-cross-env.json`
- 状态：untested

**ACC-03：共享核心禁止导入检查在构建期执行**
- 来源：ADR-0003
- 测试类型：正面
- 测试方法：在 `pnpm run build` 和 `pnpm run typecheck` 中集成 import 检查，验证构建失败时报告禁止导入
- 错误判定：构建成功但未执行 import 检查即失败
- 证据路径：`artifacts/test-reports/acc-03-build-gate.json`
- 状态：untested

### 3.2 恢复文件与密钥

**ACC-04：恢复文件由 CSPRNG 生成并保存在 Vault 外**
- 来源：执行计划 §19.3
- 测试类型：正面
- 测试方法：使用 tiny fixture 创建快照，验证恢复文件路径不在 Vault 根目录内，且恢复根来源为 RandomSource 端口（非 Math.random）。脚本：`pnpm test:acc-04`
- 错误判定：恢复文件出现在 Vault 内或使用了非 CSPRNG 即失败
- 证据路径：`artifacts/test-reports/acc-04-recovery-generation.json`
- 状态：untested

**ACC-05：持有性验证重新读取磁盘文件**
- 来源：执行计划 §19.4、INV-10
- 测试类型：正面
- 测试方法：生成恢复文件后关闭进程，新进程重新从磁盘读取恢复文件并完成恢复。验证恢复过程不引用内存密钥或源进程状态。脚本：`pnpm test:fresh-process`
- 错误判定：恢复依赖内存中密钥或源进程句柄即失败
- 证据路径：`artifacts/test-reports/acc-05-possession-verified.json`
- 状态：untested

**ACC-06：恢复文件含全部必填字段**
- 来源：恢复文件格式 §2.1
- 测试类型：正面
- 测试方法：解析恢复文件，验证 magic、格式版本、协议版本、域 ID、密码套件标识、恢复材料、完整性信息、非秘密指纹、Manifest 定位符全部存在且类型正确
- 错误判定：缺少任何必填字段即失败
- 证据路径：`artifacts/test-reports/acc-06-recovery-fields.json`
- 状态：untested

**ACC-07：恢复文件不含禁止信息**
- 来源：恢复文件格式 §2.2
- 测试类型：负面
- 测试方法：在 Vault 中植入已知明文标记（如 `LEAK_MARKER_001`），生成恢复文件后对恢复文件全文搜索该标记及 Vault 路径
- 错误判定：恢复文件中出现明文标记、Vault 路径、文件名或账号密码即失败
- 证据路径：`artifacts/test-reports/acc-07-recovery-leak-scan.json`
- 状态：untested

**ACC-08：错误恢复文件被拒绝**
- 来源：执行计划 §19.13、INV-14
- 测试类型：负面
- 测试方法：使用损坏的恢复材料（替换为随机字节）尝试恢复快照。脚本：`pnpm test:acc-08-wrong-recovery`
- 错误判定：恢复器返回错误而非部分恢复即通过；返回部分文件即失败
- 证据路径：`artifacts/test-reports/acc-08-wrong-recovery.json`
- 状态：untested

**ACC-09：恢复文件截断被拒绝**
- 来源：执行计划 §17、INV-14
- 测试类型：负面
- 测试方法：将恢复文件末尾截断 10% 字节后尝试恢复
- 错误判定：恢复器返回完整性错误而非部分恢复即通过
- 证据路径：`artifacts/test-reports/acc-09-truncated-recovery.json`
- 状态：untested

**ACC-10：不支持的恢复文件格式版本被拒绝**
- 来源：恢复文件格式 §4.1、INV-14
- 测试类型：负面
- 测试方法：将恢复文件格式版本改为 999，尝试恢复
- 错误判定：恢复器返回版本不支持错误即通过
- 证据路径：`artifacts/test-reports/acc-10-version-mismatch.json`
- 状态：untested

### 3.3 加密与对象

**ACC-11：新进程只凭恢复文件和 ObjectStore 恢复**
- 来源：执行计划 §19.5、INV-11
- 测试类型：正面
- 测试方法：进程 A 创建快照后退出，删除 P0 本地工作状态（内存密钥、进程缓存），进程 B 只读取恢复文件和 Directory ObjectStore 恢复到新建空目录
- 错误判定：进程 B 依赖任何未声明的本地缓存或内存秘密即失败
- 证据路径：`artifacts/test-reports/acc-11-fresh-process.json`
- 状态：untested

**ACC-12：相同明文重复加密不产生可直接关联的相同密文对象**
- 来源：INV-2
- 测试类型：负面
- 测试方法：对同一明文文件加密两次，比较两个密文对象的字节和对象 ID
- 错误判定：密文字节相同或对象 ID 相同即失败
- 证据路径：`artifacts/test-reports/acc-12-ciphertext-correlation.json`
- 状态：untested

**ACC-13：对象 ID 是随机不透明标识，非裸内容哈希**
- 来源：INV-3、对象格式 §3.3
- 测试类型：负面
- 测试方法：计算多个文件的内容哈希，与对应的对象 ID 比较；构造内容相同但路径不同的文件，验证对象 ID 不同
- 错误判定：对象 ID 等于内容哈希或内容相同导致对象 ID 相同即失败
- 证据路径：`artifacts/test-reports/acc-13-object-id-randomness.json`
- 状态：untested

**ACC-14：密文对象使用 AEAD，篡改被检测**
- 来源：INV-4
- 测试类型：负面
- 测试方法：翻转密文对象中 1 个字节，尝试解密恢复
- 错误判定：解密返回认证失败错误而非返回部分明文即通过
- 证据路径：`artifacts/test-reports/acc-14-aead-tamper.json`
- 状态：untested

**ACC-15：对象篡改、截断、缺失和重复被拒绝**
- 来源：执行计划 §17、INV-14
- 测试类型：负面
- 测试方法：分别执行四种子测试：(a) 替换对象字节，(b) 截断对象 50%，(c) 删除一个对象引用但保留 Manifest 条目，(d) 复制一个对象到新 ID 并替换引用
- 错误判定：任一子测试恢复部分文件而非整体失败即失败
- 证据路径：`artifacts/test-reports/acc-15-object-corruption.json`
- 状态：untested

**ACC-16：Manifest 篡改被拒绝**
- 来源：执行计划 §17
- 测试类型：负面
- 测试方法：翻转 Manifest 密文 1 字节后尝试恢复
- 错误判定：恢复器返回认证失败而非接受篡改 Manifest 即通过
- 证据路径：`artifacts/test-reports/acc-16-manifest-tamper.json`
- 状态：untested

**ACC-17：错误密钥被当成失败**
- 来源：安全不变式 §5
- 测试类型：负面
- 测试方法：用域 A 的恢复文件尝试恢复域 B 的 ObjectStore
- 错误判定：恢复返回密钥不匹配错误而非部分恢复即通过
- 证据路径：`artifacts/test-reports/acc-17-wrong-key.json`
- 状态：untested

### 3.4 路径与完整性

**ACC-18：非空恢复目标目录被拒绝**
- 来源：执行计划 §19.11、INV-8
- 测试类型：负面
- 测试方法：在目标恢复目录放置一个 dummy 文件，尝试恢复
- 错误判定：恢复器拒绝并返回非空目标错误即通过；覆盖已有文件即失败
- 证据路径：`artifacts/test-reports/acc-18-nonempty-target.json`
- 状态：untested

**ACC-19：路径逃逸被拒绝**
- 来源：执行计划 §19.12、INV-6
- 测试类型：负面
- 测试方法：构造含 `../` 路径的合成 Manifest 条目，尝试恢复
- 错误判定：恢复器写出 Vault 根目录外即失败
- 证据路径：`artifacts/test-reports/acc-19-path-escape.json`
- 状态：untested

**ACC-20：Symlink/Junction 被拒绝**
- 来源：执行计划 §19.12、INV-7
- 测试类型：负面
- 测试方法：在 tiny fixture Vault 中创建指向 Vault 外的 Symlink 和 Junction，扫描后验证被拒绝
- 错误判定：扫描跟随重解析点或上传其目标即失败
- 证据路径：`artifacts/test-reports/acc-20-reparse-points.json`
- 状态：untested

**ACC-21：大小写折叠碰撞被拒绝**
- 来源：执行计划 §19.12、INV-14
- 测试类型：负面
- 测试方法：构造含 `README.md` 和 `readme.md` 的合成 Manifest，尝试恢复到 NTFS 目标
- 错误判定：恢复器接受大小写折叠碰撞即失败
- 证据路径：`artifacts/test-reports/acc-21-case-collision.json`
- 状态：untested

**ACC-22：源 Vault 零修改**
- 来源：执行计划 §19.10、INV-9
- 测试类型：正面
- 测试方法：创建快照前计算源 Vault 全部文件的 SHA-256 清单，快照后重新计算并比较
- 错误判定：任何文件哈希变化或新增文件即失败
- 证据路径：`artifacts/test-reports/acc-22-source-zero-write.json`
- 状态：untested

**ACC-23：扫描中文件变化不产生伪一致快照**
- 来源：INV-15
- 测试类型：负面
- 测试方法：扫描开始后修改一个文件内容，验证扫描器检测到变化并报告而非静默接受旧或新内容
- 错误判定：快照包含混合状态或未报告变化即失败
- 证据路径：`artifacts/test-reports/acc-23-scan-mutation.json`
- 状态：untested

**ACC-24：未支持文件不被静默跳过**
- 来源：执行计划 §19.9、INV-16
- 测试类型：负面
- 测试方法：在 tiny fixture 中加入 .exe 文件，扫描后验证返回 UnsupportedFilesFound 且快照未标记完成
- 错误判定：扫描静默跳过 .exe 或标记快照完成即失败
- 证据路径：`artifacts/test-reports/acc-24-unsupported-files.json`
- 状态：untested

**ACC-25：任何部分写入不被报告为完整成功**
- 来源：INV-13
- 测试类型：负面
- 测试方法：在恢复过程中模拟磁盘不足（填充目标盘），验证恢复器报告失败而非部分成功
- 错误判定：恢复器报告成功但目标目录文件不完整即失败
- 证据路径：`artifacts/test-reports/acc-25-partial-write.json`
- 状态：untested

### 3.5 规模与性能

**ACC-26：10,000 文件、约 1 GiB 完整往返**
- 来源：执行计划 §19.6
- 测试类型：正面
- 测试方法：使用 representative fixture（固定种子生成）执行完整扫描→加密→ObjectStore→恢复往返
- 错误判定：往返中断或报错即失败
- 证据路径：`artifacts/performance-reports/acc-26-10k-roundtrip.json`
- 状态：untested

**ACC-27：支持文件相对路径集合和字节完全一致**
- 来源：执行计划 §19.7
- 测试类型：正面
- 测试方法：Python 独立验证器比较源目录与恢复目录的全部支持文件相对路径集合和逐文件 SHA-256
- 错误判定：路径集合不同或任一文件哈希不一致即失败
- 证据路径：`artifacts/test-reports/acc-27-byte-equality.json`
- 状态：untested

**ACC-28：.c、.py 等代码文件完整往返**
- 来源：执行计划 §19.8
- 测试类型：正面
- 测试方法：验证 representative fixture 中的 .c 和 .py 文件在恢复后字节一致
- 错误判定：代码文件字节不一致即失败
- 证据路径：`artifacts/test-reports/acc-28-code-files.json`
- 状态：untested

**ACC-29：实测内存有界（峰值 RSS 不超冻结阈值）**
- 来源：执行计划 §19.15
- 测试类型：正面
- 测试方法：在 representative fixture 往返期间监控进程峰值 RSS
- 错误判定：峰值 RSS 超过冻结阈值（暂定 512 MiB）即失败
- 证据路径：`artifacts/performance-reports/acc-29-memory.json`
- 状态：untested

**ACC-30：10,000 文件不按 Vault 总大小无界占用内存**
- 来源：安全不变式 §5
- 测试类型：负面
- 测试方法：使用 representative fixture（约 1 GiB）执行扫描，验证峰值 RSS 与文件数量相关而非与总字节线性增长
- 错误判定：峰值 RSS 接近 Vault 总大小（线性占用）即失败
- 证据路径：`artifacts/performance-reports/acc-30-bounded-memory.json`
- 状态：untested

**ACC-31：性能目标按冻结规则评估**
- 来源：执行计划 §19.15
- 测试类型：正面
- 测试方法：验证性能报告记录实际环境、耗时、吞吐和峰值内存，且阈值调整不超过一次（检查调整记录）
- 错误判定：性能报告缺失必填字段或阈值调整超一次即失败
- 证据路径：`artifacts/performance-reports/acc-31-perf-evaluation.json`
- 状态：untested

### 3.6 服务器可见性与日志

**ACC-32：Directory ObjectStore 和 P0-R1 进程日志不含禁止的明文信息**
- 来源：执行计划 §19.14
- 测试类型：负面
- 测试方法：在 Vault 中植入多个已知明文标记（文件名标记 `FILENAME_MARK_`、正文标记 `CONTENT_MARK_`、路径标记 `PATH_MARK_`），生成快照后扫描 Directory ObjectStore 和该次 P0-R1 进程产生的全部日志。localhost HTTP ObjectStore 的服务器日志只在阶段 7 获授权并实现后另行验收
- 错误判定：ObjectStore 或日志中出现任何明文标记即失败
- 证据路径：`artifacts/test-reports/acc-32-metadata-leak.json`
- 状态：untested

**ACC-33：P0-R1 存储可见性扫描报告无明文标记**
- 来源：执行计划 §17
- 测试类型：负面
- 测试方法：运行专用存储可见性扫描脚本，输出 Directory ObjectStore/进程日志允许观察的元数据清单和禁止信息扫描结果；阶段 7 HTTP 服务若实现，必须生成独立服务器视角报告
- 错误判定：扫描报告标记任何禁止信息为 found 即失败
- 证据路径：`artifacts/test-reports/acc-33-visibility-report.json`
- 状态：untested

**ACC-34：日志写入失败被正确处理**
- 来源：执行计划 §17
- 测试类型：负面
- 测试方法：将日志目录设为只读后执行快照，验证进程失败关闭而非静默继续
- 错误判定：进程在日志写入失败后继续执行并标记快照完成即失败
- 证据路径：`artifacts/test-reports/acc-34-log-failure.json`
- 状态：untested

### 3.7 报告与可重复性

**ACC-35：有机器可读和人类可读报告**
- 来源：执行计划 §19.16
- 测试类型：正面
- 测试方法：执行一次完整往返，验证输出 JSON（机器可读）和 Markdown（人类可读）报告均存在且含必填字段
- 错误判定：缺少任一格式或必填字段即失败
- 证据路径：`artifacts/test-reports/acc-35-report-formats.json`
- 状态：untested

**ACC-36：测试可从干净环境重复运行**
- 来源：执行计划 §19.17
- 测试类型：正面
- 测试方法：删除 artifacts/ 后从干净 checkout 执行 `pnpm test:all`，验证全部测试可重复运行
- 错误判定：测试依赖未声明的本地状态或缓存即失败
- 证据路径：`artifacts/test-reports/acc-36-repeatability.json`
- 状态：untested

**ACC-37：文档不宣称生产安全或独立审计完成**
- 来源：执行计划 §19.18
- 测试类型：正面
- 测试方法：先扫描关闭报告和 README 中的高风险声明词汇（"零知识安全"、"已合规"、"已通过独立审计"、"生产可用"），再由人工逐处判断该文字是在禁止/否定/引用语境中，还是无证据的肯定性声明；报告保存命中位置、上下文和裁决理由
- 错误判定：存在没有实现、测试和独立证据支持的肯定性安全/合规/生产声明即失败；仅在禁止、否定或历史引用语境出现关键词不自动失败
- 证据路径：`artifacts/test-reports/acc-37-honest-claims.json`
- 状态：untested

## 4. 证据路径约定

测试报告存放在以下目录，均被 .gitignore 忽略：

- `artifacts/test-reports/` — 功能和负面测试报告
- `artifacts/performance-reports/` — 性能和内存报告

每条 ACC 的证据文件名与 ACC ID 一致（如 `acc-01-import-check.json`），便于自动匹配。验收矩阵的最终状态以机器可读 JSON 和人类可读 Markdown 两种格式保存。

## 5. 状态定义

- passed：测试通过，证据已附；
- failed：测试失败，必须停止并记录负面证据；
- untested：尚未执行（当前全部 ACC 的初始状态）；
- known-limitation：已知不满足但在关闭报告中记录的限制（如不做大小填充）；
- out-of-scope：移出 P0 范围的能力。

## 6. 关闭条件

P0-R1 关闭报告必须区分上述五种状态。所有 P0-R1 范围内且必需的 ACC 必须是 **passed** 并绑定可复核证据；任何 **failed** 或 **untested** 项都阻止关闭，解释“为何未测”不能替代通过。**known-limitation** 只能用于执行计划明确允许、且不违反任何安全不变式或必需验收条件的限制，并须记录风险、范围、owner 和明确接受决定。**out-of-scope** 必须能追溯到已冻结的 P0 OUT 条目，不能用于绕开失败项。

## 7. 当前复审结论

截至 2026-08-27：

- 仓库中尚无 `packages/`、测试脚本、fixture、环境清单或测试报告，37 项均为 **untested**；
- 多数测试仍缺稳定的结构化错误码、超时/退出码、禁止副作用和“不得产生部分输出”等机器 oracle；
- 当前尚无逐条 `THR-* → INV-* → ACC-* → evidence` 追踪表，不能证明每个安全要求都已由正面与负面路径覆盖；
- 因此本矩阵不能支持 P0-R1 或任何安全实现已经通过的结论。37 项为 untested 本身符合“尚未实现”的当前阶段；阻止 Phase 0 文档门禁关闭的是追踪、oracle 和关闭语义仍不完整，而不是要求在 Phase 0 提前跑完 P0-R1 测试。
