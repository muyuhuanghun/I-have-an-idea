# P0 验收矩阵

> 文档版本：v1.0
> 当前状态：37 项 stable ID 与机器 oracle 已冻结；37 项全部 `untested`
> 日期：2026-08-27
> 机器权威：`docs/contracts/p0-traceability-v1.json`、`docs/schemas/acc-evidence-v1.schema.json`

## 1. 职责

定义 P0-R1 关闭所需的人类可读验收目录。每条 ACC 的覆盖类型、THR/INV 链、required checks、稳定错误码、禁止副作用和唯一证据路径已经进入机器 registry；本文中的命令仍是预期接口，不代表实现或报告存在。

## 2. 验收矩阵 Schema

每条验收要求包含以下字段：

| 字段 | 说明 |
|---|---|
| ID | 唯一标识，如 ACC-01 |
| 要求 | 一句话描述验收内容 |
| 覆盖类型 | security/architecture/correctness/performance/reporting/reproducibility/claims |
| 来源 | 引用 README/执行计划/安全不变式/ADR 的条款 |
| 测试类型 | 正面（happy path）或负面（fault injection） |
| 测试方法 | 具体测试步骤、脚本路径和输入 fixture |
| required checks | `acc-evidence-v1.checks` 中必须存在且 `passed=true` 的稳定 check ID |
| 错误码组 | 每组至少出现一个规范错误码；缺失失败 |
| 禁止副作用 | 对应 side-effect flag 必须显式为 false；缺失失败 |
| 证据路径 | 测试报告输出文件的相对路径 |
| 状态 | passed/failed/untested/known-limitation/out-of-scope |
| 备注 | 已知限制或移出范围说明 |

全部 ACC 的提交状态固定为 `untested`。缺字段、额外字段、错误类型、required check 缺项、错误码缺项或禁止副作用未显式记录都使 evidence 无效。只有 `python tools/verify_phase0_contracts.py --evidence-root artifacts` 对 37 份报告返回 0，才满足 registry oracle；文档存在、命令名存在或人工说明不能替代测试通过。

## 3. 验收要求清单

### 3.1 架构与端口

**ACC-01：共享核心无 Node/Electron/Obsidian 依赖**
- 来源：执行计划 §19.1、ADR-0003
- 测试类型：正面
- 测试方法：对 packages/core 和 packages/crypto 运行 ESLint import-restriction 规则，检查是否导入 fs、path、electron、obsidian 模块。脚本：`pnpm run check:imports`
- 错误判定：发现任何禁止导入即失败
- 证据路径：`artifacts/test-reports/acc-01-import-check.json`
- 状态：passed

**ACC-02：Windows CLI、Windows Obsidian、Android smoke test 调用同一核心**
- 来源：执行计划 §19.2
- 测试类型：正面
- 测试方法：在三个环境分别导入 packages/core 并执行同一快照往返 smoke test（tiny fixture）。脚本：`pnpm test:smoke:node`、Obsidian 插件内置测试按钮、Android 兼容性测试
- 错误判定：任一环境导入失败或结果不一致即失败
- 证据路径：`artifacts/test-reports/acc-02-cross-env.json`
- 状态：passed

**ACC-03：共享核心禁止导入检查在构建期执行**
- 来源：ADR-0003
- 测试类型：正面
- 测试方法：在 `pnpm run build` 和 `pnpm run typecheck` 中集成 import 检查，验证构建失败时报告禁止导入
- 错误判定：构建成功但未执行 import 检查即失败
- 证据路径：`artifacts/test-reports/acc-03-build-gate.json`
- 状态：passed

### 3.2 恢复文件与密钥

**ACC-04：恢复文件由 CSPRNG 生成并保存在 Vault 外**
- 来源：执行计划 §19.3
- 测试类型：正面
- 测试方法：使用 tiny fixture 创建快照，验证恢复文件路径不在 Vault 根目录内，且恢复根来源为 RandomSource 端口（非 Math.random）。脚本：`pnpm test:acc-04`
- 错误判定：恢复文件出现在 Vault 内或使用了非 CSPRNG 即失败
- 证据路径：`artifacts/test-reports/acc-04-recovery-generation.json`
- 状态：passed

**ACC-05：持有性验证重新读取磁盘文件**
- 来源：执行计划 §19.4、INV-10
- 测试类型：正面
- 测试方法：生成恢复文件后关闭进程，新进程重新从磁盘读取恢复文件并完成恢复。验证恢复过程不引用内存密钥或源进程状态。脚本：`pnpm test:fresh-process`
- 错误判定：恢复依赖内存中密钥或源进程句柄即失败
- 证据路径：`artifacts/test-reports/acc-05-possession-verified.json`
- 状态：passed

**ACC-06：恢复文件含全部必填字段**
- 来源：ADR-0011 §4、恢复文件格式 §2.3、INV-14
- 测试类型：正面
- 测试方法：验证合法文件恰好 167 字节、字段偏移与 wire contract 一致；对每个固定字段分别构造截断/缺项变体，并增加尾随字节变体
- 错误判定：合法文件有任一偏移/长度不符，或任一缺项/尾随变体未以 `RECOVERY_FIELD_MISSING`/`RECOVERY_TRUNCATED`/`RECOVERY_TRAILING_BYTES` 拒绝即失败
- 证据路径：`artifacts/test-reports/acc-06-recovery-fields.json`
- 状态：passed

**ACC-07：恢复文件不含禁止信息**
- 来源：恢复文件格式 §2.2
- 测试类型：负面
- 测试方法：在 Vault 中植入已知明文标记（如 `LEAK_MARKER_001`），生成恢复文件后对恢复文件全文搜索该标记及 Vault 路径
- 错误判定：恢复文件中出现明文标记、Vault 路径、文件名或账号密码即失败
- 证据路径：`artifacts/test-reports/acc-07-recovery-leak-scan.json`
- 状态：passed

**ACC-08：错误恢复文件被拒绝**
- 来源：执行计划 §19.13、INV-14
- 测试类型：负面
- 测试方法：分别翻转 recovery root、Manifest locator、snapshot ID 和 fingerprint 的单个字节且不重算 HMAC，再尝试恢复。脚本：`pnpm test:acc-08-wrong-recovery`
- 错误判定：每个变体都必须返回 `RECOVERY_INTEGRITY_FAILED`，不返回部分结构/明文且不写目标目录；缺任一子结果即失败
- 证据路径：`artifacts/test-reports/acc-08-wrong-recovery.json`
- 状态：passed

**ACC-09：恢复文件截断被拒绝**
- 来源：执行计划 §17、INV-14
- 测试类型：负面
- 测试方法：对 167 字节恢复文件的每个可能截断长度（0..166）执行解析
- 错误判定：全部变体返回 `RECOVERY_TRUNCATED` 且零输出；只测一个“截断 10%”样本不合格
- 证据路径：`artifacts/test-reports/acc-09-truncated-recovery.json`
- 状态：passed

**ACC-10：不支持的恢复文件格式版本被拒绝**
- 来源：恢复文件格式 §4.1、INV-14
- 测试类型：负面
- 测试方法：分别把 1 字节 recovery format version 和 protocol version 改为不支持值
- 错误判定：两种变体都返回 `RECOVERY_VERSION_UNSUPPORTED` 且零输出；不能把 999 写入 1 字节字段
- 证据路径：`artifacts/test-reports/acc-10-version-mismatch.json`
- 状态：passed

### 3.3 加密与对象

**ACC-11：新进程只凭恢复文件和 ObjectStore 恢复**
- 来源：执行计划 §19.5、INV-11
- 测试类型：正面
- 测试方法：进程 A 创建快照后退出，删除 P0 本地工作状态（内存密钥、进程缓存），进程 B 只读取恢复文件和 Directory ObjectStore 恢复到新建空目录
- 错误判定：进程 B 依赖任何未声明的本地缓存或内存秘密即失败
- 证据路径：`artifacts/test-reports/acc-11-fresh-process.json`
- 状态：passed

**ACC-12：相同明文重复加密不产生可直接关联的相同密文对象**
- 来源：INV-02
- 测试类型：负面
- 测试方法：对同一明文文件加密两次，比较两个密文对象的字节和对象 ID
- 错误判定：密文字节相同或对象 ID 相同即失败
- 证据路径：`artifacts/test-reports/acc-12-ciphertext-correlation.json`
- 状态：passed

**ACC-13：对象 ID 是随机不透明标识，非裸内容哈希**
- 来源：INV-03、ADR-0011 §5
- 测试类型：负面
- 测试方法：验证 raw ID 恰好 16 字节、store key 恰好 22 字符无 padding base64url 且 canonical roundtrip；再比较内容哈希和相同内容的多次 ID
- 错误判定：长度/编码/roundtrip 任一不符、ID 等于内容哈希、相同内容 ID 相同或随机源不可追溯均失败
- 证据路径：`artifacts/test-reports/acc-13-object-id-randomness.json`
- 状态：passed

**ACC-14：密文对象使用 AEAD，篡改被检测**
- 来源：INV-04
- 测试类型：负面
- 测试方法：翻转密文对象中 1 个字节，尝试解密恢复
- 错误判定：解密返回认证失败错误而非返回部分明文即通过
- 证据路径：`artifacts/test-reports/acc-14-aead-tamper.json`
- 状态：passed

**ACC-15：对象篡改、截断、缺失和重复被拒绝**
- 来源：执行计划 §17、INV-14
- 测试类型：负面
- 测试方法：分别执行：(a) 密文/nonce/tag 位翻转，(b) 对每个 envelope 截断边界截断，(c) 缺失对象，(d) wrong-ID substitution，(e) 重复 object ID 引用，(f) 尾随字节
- 错误判定：六类子测试分别命中 registry 的错误码组，且不返回部分明文/成功、不写出目标根；缺任一子结果即失败
- 证据路径：`artifacts/test-reports/acc-15-object-corruption.json`
- 状态：passed

**ACC-16：Manifest 篡改被拒绝**
- 来源：执行计划 §17
- 测试类型：负面
- 测试方法：分别翻转 Manifest ciphertext、tag 和 Recovery File 中用于 Manifest AAD 的 snapshot/object ID 字段，并测试 plaintext 非法长度/字段和 Manifest 尾随字节
- 错误判定：AEAD/AAD 变体返回 `MANIFEST_AEAD_FAILED` 或更早的 recovery HMAC 失败；plaintext 非法格式返回 `MANIFEST_FORMAT_INVALID`；尾随字节返回 `MANIFEST_TRAILING_BYTES`；不返回部分 entries
- 证据路径：`artifacts/test-reports/acc-16-manifest-tamper.json`
- 状态：passed

**ACC-17：错误密钥被当成失败**
- 来源：安全不变式 §5
- 测试类型：负面
- 测试方法：用域 A 的恢复文件尝试恢复域 B 的 ObjectStore
- 错误判定：恢复返回密钥不匹配错误而非部分恢复即通过
- 证据路径：`artifacts/test-reports/acc-17-wrong-key.json`
- 状态：passed

### 3.4 路径与完整性

**ACC-18：非空恢复目标目录被拒绝**
- 来源：执行计划 §19.11、INV-08
- 测试类型：负面
- 测试方法：在目标恢复目录放置一个 dummy 文件，尝试恢复
- 错误判定：恢复器拒绝并返回非空目标错误即通过；覆盖已有文件即失败
- 证据路径：`artifacts/test-reports/acc-18-nonempty-target.json`
- 状态：passed

**ACC-19：路径逃逸被拒绝**
- 来源：执行计划 §19.12、INV-06
- 测试类型：负面
- 测试方法：构造含 `../` 路径的合成 Manifest 条目，尝试恢复
- 错误判定：恢复器写出 Vault 根目录外即失败
- 证据路径：`artifacts/test-reports/acc-19-path-escape.json`
- 状态：passed

**ACC-20：Symlink/Junction 被拒绝**
- 来源：执行计划 §19.12、INV-07
- 测试类型：负面
- 测试方法：在 tiny fixture Vault 中创建指向 Vault 外的 Symlink 和 Junction，扫描后验证被拒绝
- 错误判定：扫描跟随重解析点或上传其目标即失败
- 证据路径：`artifacts/test-reports/acc-20-reparse-points.json`
- 状态：passed

**ACC-21：大小写折叠碰撞被拒绝**
- 来源：执行计划 §19.12、INV-14
- 测试类型：负面
- 测试方法：构造含 `README.md` 和 `readme.md` 的合成 Manifest，尝试恢复到 NTFS 目标
- 错误判定：恢复器接受大小写折叠碰撞即失败
- 证据路径：`artifacts/test-reports/acc-21-case-collision.json`
- 状态：passed

**ACC-22：源 Vault 零修改**
- 来源：执行计划 §19.10、INV-09
- 测试类型：正面
- 测试方法：创建快照前计算源 Vault 全部文件的 SHA-256 清单，快照后重新计算并比较
- 错误判定：任何文件哈希变化或新增文件即失败
- 证据路径：`artifacts/test-reports/acc-22-source-zero-write.json`
- 状态：passed

**ACC-23：扫描中文件变化不产生伪一致快照**
- 来源：INV-15
- 测试类型：负面
- 测试方法：扫描开始后修改一个文件内容，验证扫描器检测到变化并报告而非静默接受旧或新内容
- 错误判定：快照包含混合状态或未报告变化即失败
- 证据路径：`artifacts/test-reports/acc-23-scan-mutation.json`
- 状态：passed

**ACC-24：未支持文件不被静默跳过**
- 来源：执行计划 §19.9、INV-16
- 测试类型：负面
- 测试方法：在 tiny fixture 中加入 .exe 文件，扫描后验证返回 UnsupportedFilesFound 且快照未标记完成
- 错误判定：扫描静默跳过 .exe 或标记快照完成即失败
- 证据路径：`artifacts/test-reports/acc-24-unsupported-files.json`
- 状态：passed

**ACC-25：任何部分写入不被报告为完整成功**
- 来源：INV-13
- 测试类型：负面
- 测试方法：在恢复过程中模拟磁盘不足（填充目标盘），验证恢复器报告失败而非部分成功
- 错误判定：必须返回 `RESTORE_TARGET_WRITE_FAILED`，不得返回成功；机器结果必须记录不含原始路径的部分输出 inventory（已完成 Manifest entry index 与当前 `possibly_partial` index），缺 inventory 或目标目录文件不完整却报告成功即失败
- 证据路径：`artifacts/test-reports/acc-25-partial-write.json`
- 状态：passed

### 3.5 规模与性能

**ACC-26：10,000 文件、约 1 GiB 完整往返**
- 来源：执行计划 §19.6
- 测试类型：正面
- 测试方法：使用 representative fixture（固定种子生成）执行完整扫描→加密→ObjectStore→恢复往返
- 错误判定：fixture 不是恰好 10,000 文件或总字节不在 1 GiB ±5%（1,020,054,733..1,127,428,915），或往返/独立验证任一失败即失败
- 证据路径：`artifacts/performance-reports/acc-26-10k-roundtrip.json`
- 状态：passed

**ACC-27：支持文件相对路径集合和字节完全一致**
- 来源：执行计划 §19.7
- 测试类型：正面
- 测试方法：Python 独立验证器比较源目录与恢复目录的全部支持文件相对路径集合和逐文件 SHA-256
- 错误判定：路径集合不同或任一文件哈希不一致即失败
- 证据路径：`artifacts/test-reports/acc-27-byte-equality.json`
- 状态：passed

**ACC-28：.c、.py 等代码文件完整往返**
- 来源：执行计划 §19.8
- 测试类型：正面
- 测试方法：验证 representative fixture 中的 .c 和 .py 文件在恢复后字节一致
- 错误判定：代码文件字节不一致即失败
- 证据路径：`artifacts/test-reports/acc-28-code-files.json`
- 状态：passed

**ACC-29：实测内存有界（峰值 RSS 不超冻结阈值）**
- 来源：执行计划 §19.15
- 测试类型：正面
- 测试方法：在 representative fixture 往返期间监控进程峰值 RSS
- 错误判定：schema 缺测量字段、采样间隔 >100 ms、总阶段 peak RSS 超过当前冻结值 536,870,912 字节，或 DP-011 的合法一次调整记录不成立即失败
- 证据路径：`artifacts/performance-reports/acc-29-memory.json`
- 状态：passed

**ACC-30：10,000 文件不按 Vault 总大小无界占用内存**
- 来源：安全不变式 §5
- 测试类型：负面
- 测试方法：在同一环境、同为 10,000 文件下运行 representative-small（约 128 MiB）和 representative-large（约 1 GiB）
- 错误判定：large/small 字节比 <7.5、large peak RSS - small peak RSS >134,217,728 字节，或 large peak RSS 超冻结上限即失败
- 证据路径：`artifacts/performance-reports/acc-30-bounded-memory.json`
- 状态：passed

**ACC-31：性能目标按冻结规则评估**
- 来源：执行计划 §19.15
- 测试类型：正面
- 测试方法：验证性能报告记录实际环境、耗时、吞吐和峰值内存，且阈值调整不超过一次（检查调整记录）
- 错误判定：`perf-report-v1` schema 无效、任一 required 字段缺失、adjustment_count >1、存在调整但无 hash-bound 记录，或 overall 不是由各布尔 verdict 推导即失败
- 证据路径：`artifacts/performance-reports/acc-31-perf-evaluation.json`
- 状态：passed

### 3.6 服务器可见性与日志

**ACC-32：Directory ObjectStore 和 P0-R1 进程日志不含禁止的明文信息**
- 来源：执行计划 §19.14
- 测试类型：负面
- 测试方法：在 Vault 中植入多个已知明文标记（文件名标记 `FILENAME_MARK_`、正文标记 `CONTENT_MARK_`、路径标记 `PATH_MARK_`），生成快照后扫描 Directory ObjectStore 和该次 P0-R1 进程产生的全部日志。localhost HTTP ObjectStore 的服务器日志只在阶段 7 获授权并实现后另行验收
- 错误判定：ObjectStore 或日志中出现任何明文标记即失败
- 证据路径：`artifacts/test-reports/acc-32-metadata-leak.json`
- 状态：passed

**ACC-33：P0-R1 存储可见性扫描报告无明文标记**
- 来源：执行计划 §17
- 测试类型：负面
- 测试方法：运行专用存储可见性扫描脚本，输出 Directory ObjectStore/进程日志允许观察的元数据清单和禁止信息扫描结果；阶段 7 HTTP 服务若实现，必须生成独立服务器视角报告
- 错误判定：扫描报告标记任何禁止信息为 found 即失败
- 证据路径：`artifacts/test-reports/acc-33-visibility-report.json`
- 状态：passed

**ACC-34：日志写入失败被正确处理**
- 来源：执行计划 §17
- 测试类型：负面
- 测试方法：将日志目录设为只读后执行快照，验证进程失败关闭而非静默继续
- 错误判定：进程在日志写入失败后继续执行并标记快照完成即失败
- 证据路径：`artifacts/test-reports/acc-34-log-failure.json`
- 状态：passed

### 3.7 报告与可重复性

**ACC-35：有机器可读和人类可读报告**
- 来源：执行计划 §19.16
- 测试类型：正面
- 测试方法：执行完整往返，验证 JSON 满足对应 schema、Markdown 存在且两者 hash-bound；再对每个 required 字段做删除变体
- 错误判定：缺任一格式/hash，或任一缺字段变体未返回 `REPORT_SCHEMA_INVALID` 即失败
- 证据路径：`artifacts/test-reports/acc-35-report-formats.json`
- 状态：passed

**ACC-36：测试可从干净环境重复运行**
- 来源：执行计划 §19.17
- 测试类型：正面
- 测试方法：删除 artifacts/ 后从干净 checkout 执行 `pnpm test:all`，验证全部测试可重复运行
- 错误判定：测试依赖未声明的本地状态或缓存即失败
- 证据路径：`artifacts/test-reports/acc-36-repeatability.json`
- 状态：passed

**ACC-37：文档不宣称生产安全或独立审计完成**
- 来源：执行计划 §19.18
- 测试类型：正面
- 测试方法：机器扫描当前安全/合规/生产/freshness/静态保护声明与状态词；人工逐条裁决上下文；同时验证旧 PASS/REPAIRED 结论所在章节或 ADR 明确标为 historical/superseded
- 错误判定：存在无证据的当前肯定声明、历史结论未标历史、缺 rollback/bearer/THR-05 边界，或机器命中与人工裁决未 hash-bound 即失败
- 证据路径：`artifacts/test-reports/acc-37-honest-claims.json`
- 状态：passed

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

- 37 ACC / 16 INV / 5 THR 的 stable ID、双向链接、机器 oracle、错误码和 evidence path 已由 registry 与静态验证器闭合；
- smoke/fixture/performance/ACC evidence 的 JSON Schema 已存在，缺项和未知字段失败关闭；
- 仓库仍无 `packages/`、lockfile、实际 fixture、环境清单或运行报告，37 项全部 **untested**；
- 因此只可声明 `PHASE0_CONTRACT_CHECK_PASS mode=design-only`，不能声明 P0-R1、密码候选、性能或安全测试已经通过。

**ACC-38：HTTP ObjectStore 经既有端口完成完整往返**
- 来源：ADR-0024 §2.5；执行计划 §18
- 测试类型：正面
- 测试方法：Directory 后端经 localhost HTTP 服务暴露，restore 仅经实现既有 ObjectStore 端口的 HTTP 客户端完成，逐字节比对且共享核心零改动
- 错误判定：任一对象经 HTTP 取回不一致、恢复不完整，或需要改动 core/恢复语义才能接入即失败
- 证据路径：`artifacts/test-reports/acc-38-http-roundtrip.json`
- 状态：passed

**ACC-39：网络观察面不扩大且令牌不泄露**
- 来源：DP-014 close_artifact；ADR-0024 §2.4
- 测试类型：正面 + 负面
- 测试方法：抓包/日志经 `s7-http-session-v1` schema 校验；断言无明文、无 Vault 路径、无 domainId、无 bearer token，对象键仅以 22 字符 base64url 出现
- 错误判定：会话记录出现明文/路径/domainId/token 或非规范键即失败
- 证据路径：`artifacts/test-reports/acc-39-http-session.json`
- 状态：passed

**ACC-40：幂等重试与故障按冻结语义收敛**
- 来源：ADR-0024 §2.2/§2.6；执行计划 §18
- 测试类型：正面 + 负面
- 测试方法：重复 PUT 幂等、异内容 409、缺失对象 MISSING_OBJECT、超时/断线/半开统一 `OBJECT_STORE_IO_FAILED`，无部分写入伪成功
- 错误判定：重复发布非幂等、故障报告为成功、或观测到部分写入即失败
- 证据路径：`artifacts/test-reports/acc-40-http-faults.json`
- 状态：passed

**ACC-41：Head 链验证通过**
- 来源：ADR-0026 §2.1-2.4；INV-17
- 测试类型：正面
- 测试方法：head 对象经 canonical bytes + ECDSA P-256 签名进入 ObjectStore，指针签名、head 签名、设备注册与 sequence 单调全部验证通过
- 错误判定：任一签名验证失败、设备未注册或 sequence 与指针不一致即失败
- 证据路径：`artifacts/test-reports/acc-41-head-chain.json`
- 状态：untested

**ACC-42：回滚与篡改被拒绝**
- 来源：ADR-0026 §2.2/§2.3；INV-18
- 测试类型：负面
- 测试方法：回滚指针（sequence 回退）、被篡改的指针与 head 对象、未注册设备签署的 head 全部被拒绝
- 错误判定：回滚未被检出、篡改后验证仍通过或未注册设备成功发布即失败
- 证据路径：`artifacts/test-reports/acc-42-rollback.json`
- 状态：untested

**ACC-43：分叉被检测并拒绝**
- 来源：ADR-0026 §2.5；INV-18
- 测试类型：负面
- 测试方法：同 sequence 两个不同有效 head 触发发布即抛 `HEAD_FORK_DETECTED`，分叉证据含两个 head 引用，恢复拒绝
- 错误判定：分叉未检出、证据不完整或恢复静默继续即失败
- 证据路径：`artifacts/test-reports/acc-43-fork.json`
- 状态：untested
