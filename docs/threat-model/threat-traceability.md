# P0 威胁-不变式-验收-Oracle-证据追踪

> 文档版本：v0.1
> 状态：阶段 0 gate repair 4
> 日期：2026-08-27
> 权威来源：P0-threat-model.md §4 §6、P0-security-invariants.md §2、P0-acceptance-matrix.md §3

## 1. 职责

为 P0 范围内每个安全要求提供从威胁（THR）到不变式（INV）到验收（ACC）到错误码 oracle 到证据路径的完整追踪链。任何 ACC 必须能向上追溯到至少一个 THR 和 INV；任何 THR 必须有至少一个对应 ACC；任何 ACC 必须有可机器判定的错误码 oracle 和固定证据路径。

## 2. 追踪表

| THR | ATR | INV | ACC | 错误码 oracle | 证据路径 |
|-----|-----|-----|-----|---------------|---------|
| THR-01 ObjectStore 读取到明文 | ATR-01, ATR-16 | INV-1, INV-3 | ACC-32, ACC-33 | 扫描器在 ObjectStore 字节和日志中找到 `LEAK_*` 标记时报告 found=true | artifacts/test-reports/acc-32-metadata-leak.json |
| THR-01 相同明文可关联 | ATR-02 | INV-2 | ACC-12 | 两次加密的 ciphertext 字节相同或 object_id 相同时报告 failed | artifacts/test-reports/acc-12-ciphertext-correlation.json |
| THR-03 对象字节篡改 | ATR-03 | INV-4 | ACC-14 | 解密返回 OBJECT_AEAD_FAILED 错误码而非部分明文 | artifacts/test-reports/acc-14-aead-tamper.json |
| THR-03 缺失/截断对象 | ATR-07 | INV-14, INV-15 | ACC-15 | 缺失对象返回 MISSING_OBJECT；截断返回 OBJECT_AEAD_FAILED；wrong-ID substitution 返回 OBJECT_AAD_MISMATCH | artifacts/test-reports/acc-15-object-corruption.json |
| THR-03 Manifest 篡改 | ATR-09 | INV-4 | ACC-16 | 解密返回 MANIFEST_AEAD_FAILED 错误码 | artifacts/test-reports/acc-16-manifest-tamper.json |
| THR-03 路径逃逸 | ATR-05 | INV-6, INV-7 | ACC-19, ACC-20 | 解析路径时返回 ENTRY_PATH_ESCAPE；扫描器返回 REPARSE_POINT_FOUND | artifacts/test-reports/acc-19-path-escape.json, acc-20-reparse-points.json |
| THR-03 非空目标覆盖 | ATR-06 | INV-8 | ACC-18 | 恢复前检查目标目录返回 NON_EMPTY_TARGET | artifacts/test-reports/acc-18-nonempty-target.json |
| THR-03 大小写折叠碰撞 | ATR-14 | INV-14 | ACC-21 | 恢复返回 CASE_COLLISION | artifacts/test-reports/acc-21-case-collision.json |
| THR-03 扫描中文件变化 | ATR-11 | INV-15 | ACC-23 | 扫描器返回 FILE_CHANGED_DURING_SCAN | artifacts/test-reports/acc-23-scan-mutation.json |
| THR-03 未支持文件被静默跳过 | ATR-12 | INV-16 | ACC-24 | 扫描器返回 UNSUPPORTED_FILES_FOUND 且快照未标记 complete | artifacts/test-reports/acc-24-unsupported-files.json |
| THR-03 部分写入被报告为成功 | ATR-13 | INV-13 | ACC-25 | 磁盘不足时恢复返回 INCOMPLETE_RESTORE | artifacts/test-reports/acc-25-partial-write.json |
| THR-03/04 错误恢复文件 | ATR-08 | INV-10, INV-11, INV-14 | ACC-08, ACC-09, ACC-10 | 错密钥 RECOVERY_INTEGRITY_FAILED；截断 RECOVERY_TRUNCATED；不支持版本 RECOVERY_VERSION_UNSUPPORTED | artifacts/test-reports/acc-08-wrong-recovery.json, acc-09-truncated-recovery.json, acc-10-version-mismatch.json |
| THR-05 源 Vault 写入污染 | ATR-10 | INV-9 | ACC-22 | 源 Vault 全部文件 SHA-256 列表在快照前后完全一致 | artifacts/test-reports/acc-22-source-zero-write.json |
| THR-05 日志写入失败 | ATR-15 | INV-13 | ACC-34 | 日志目录只读时进程返回 LOG_WRITE_FAILED 并退出 | artifacts/test-reports/acc-34-log-failure.json |
| THR-01/02 服务器可见性 | ATR-16 | INV-1, INV-3 | ACC-32, ACC-33 | 同 ATR-01 | 同 ATR-01 |
| THR-02 被动网络观察者 | ATR-16 | INV-1, INV-3 | ACC-32（阶段 7 适用） | 阶段 7 HTTP 抓包中无明文标记；P0-R1 仅本地 | artifacts/test-reports/acc-32-metadata-leak.json（阶段 7 扩展） |

## 3. 架构/恢复不变量追踪

以下 ACC 对应的不是攻击者，而是架构正确性和恢复不变量：

| INV | ACC | oracle | 证据路径 |
|-----|-----|--------|---------|
| 共享核心无平台依赖 | ACC-01 | import 检查器扫描到禁止导入即失败 | artifacts/test-reports/acc-01-import-check.json |
| 三环境调用同一核心 | ACC-02 | 三环境执行同一 smoke test 并结果一致 | artifacts/test-reports/acc-02-cross-env.json |
| 依赖检查在构建期执行 | ACC-03 | 移除依赖检查后构建仍成功即失败 | artifacts/test-reports/acc-03-build-gate.json |
| 恢复文件由 CSPRNG 生成且在 Vault 外 | ACC-04 | 恢复文件路径不在 Vault 根内且来源为 RandomSource 端口 | artifacts/test-reports/acc-04-recovery-generation.json |
| 持有性验证重新读取 | ACC-05 | fresh-process 恢复不引用内存密钥或源进程状态 | artifacts/test-reports/acc-05-possession-verified.json |
| 恢复文件含全部字段 | ACC-06 | 解析恢复文件后所有必填字段非空 | artifacts/test-reports/acc-06-recovery-fields.json |
| 恢复文件不含禁止信息 | ACC-07 | 在恢复文件中搜索植入标记返回 0 | artifacts/test-reports/acc-07-recovery-leak-scan.json |
| fresh-process 只凭恢复文件+ObjectStore | ACC-11 | 删除 P0 本地工作状态后新进程可恢复 | artifacts/test-reports/acc-11-fresh-process.json |
| 10,000 文件往返 | ACC-26 | 完整往返无错误 | artifacts/performance-reports/acc-26-10k-roundtrip.json |
| 字节一致 | ACC-27 | Python 验证器逐文件 SHA-256 全部匹配 | artifacts/test-reports/acc-27-byte-equality.json |
| 代码文件往返 | ACC-28 | .c/.py 字节一致 | artifacts/test-reports/acc-28-code-files.json |
| 内存有界 | ACC-29 | 峰值 RSS ≤ 512 MiB | artifacts/performance-reports/acc-29-memory.json |
| 内存不随 Vault 线性增长 | ACC-30 | 峰值 RSS ≪ Vault 总大小 | artifacts/performance-reports/acc-30-bounded-memory.json |
| 性能冻结规则 | ACC-31 | 阈值调整次数 ≤ 1 | artifacts/performance-reports/acc-31-perf-evaluation.json |
| 有报告输出 | ACC-35 | JSON + Markdown 报告均生成 | artifacts/test-reports/acc-35-report-formats.json |
| 干净环境可重复 | ACC-36 | 删除 artifacts/ 后完整测试可重跑 | artifacts/test-reports/acc-36-repeatability.json |
| 不宣称生产安全 | ACC-37 | 关键词扫描无禁止声明（人工裁决关键词命中） | artifacts/test-reports/acc-37-honest-claims.json |

## 4. 错误码完整清单

以下错误码是 P0 范围内恢复器和扫描器必须返回的规范错误码，供所有 ACC oracle 使用：

| 错误码 | 类别 | 触发 |
|--------|------|------|
| RECOVERY_MAGIC_MISMATCH | 恢复文件 | magic 字节不匹配 |
| RECOVERY_VERSION_UNSUPPORTED | 恢复文件 | format_version 不支持 |
| RECOVERY_INTEGRITY_FAILED | 恢复文件 | 完整性标签验证失败 |
| RECOVERY_TRUNCATED | 恢复文件 | 文件长度不足 |
| RECOVERY_SUITE_UNKNOWN | 恢复文件 | suite_id 不支持 |
| MANIFEST_AEAD_FAILED | Manifest | Manifest 密文 AEAD 验证失败 |
| MANIFEST_VERSION_UNSUPPORTED | Manifest | manifest_format_version 不支持 |
| MANIFEST_SUITE_UNKNOWN | Manifest | suite_id 不支持 |
| OBJECT_AEAD_FAILED | 对象 | 对象密文 AEAD 验证失败 |
| OBJECT_AAD_MISMATCH | 对象 | 实际 AAD 与从 object_id 派生的预期 AAD 不一致 |
| OBJECT_ID_COLLISION | 对象 | 对象 ID 碰撞重试后仍冲突 |
| MISSING_OBJECT | 对象 | Manifest 引用对象在 ObjectStore 缺失 |
| ENTRY_PATH_ESCAPE | entry | relative_path 包含 `..`、绝对前缀或重解析点字符 |
| ENTRY_PATH_DUPLICATE | entry | 排序后出现相同 relative_path |
| ENTRY_SIZE_MISMATCH | entry | 解密后大小与 plaintext_size 不一致 |
| CASE_COLLISION | 恢复 | 目标目录已有大小写折叠后同路径 |
| NON_EMPTY_TARGET | 恢复 | 目标目录非空 |
| FILE_CHANGED_DURING_SCAN | 扫描 | 文件读取前后哈希不一致 |
| UNSUPPORTED_FILES_FOUND | 扫描 | 发现未支持扩展名 |
| REPARSE_POINT_FOUND | 扫描 | 发现 Symlink/Junction |
| INCOMPLETE_RESTORE | 恢复 | 磁盘不足导致部分写入 |
| LOG_WRITE_FAILED | 系统 | 日志目录不可写 |

实施时必须使用本表错误码，不使用自定义异常文本。Oracle 自动判定依赖规范错误码。

## 5. 追踪完整性检查

以下检查确保追踪链无断裂：

1. 每个 ACC 至少有一个 THR 引用（通过 ATR 关联）；
2. 每个 ACC 至少有一个对应错误码 oracle；
3. 每个 ACC 有固定证据路径；
4. 每个 INV 至少被一个 ACC 引用；
5. 每个 THR 至少被一个 ACC 通过 ATR 关联覆盖（P0 明确不防御的攻击者 THR-05 部分不要求 ACC）。

完整追踪审计脚本在阶段 6 实施时编写，扫描所有 ADR/协议/威胁/验收/不变式文档的交叉引用。