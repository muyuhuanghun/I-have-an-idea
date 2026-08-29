# P0 Fixture 与性能基线合同

> 文档版本：v1.0
> 当前状态：schema、profile 范围和数值 oracle 已冻结；Tiny generator/fixture 已实现并通过 review validation，representative/performance fixture 与正式报告尚不存在
> 日期：2026-08-27
> 权威：ADR-0012、`fixture-manifest-v1.schema.json`、`perf-report-v1.schema.json`

## 1. 通用失败规则

每个 fixture 必须有 schema-valid `fixture-manifest-v1`，绑定 seed、generator path/commit/hash/version、全部 entry、entries hash、feature coverage 和约束裁决。生成内容可以位于 `artifacts/generated-fixtures/` 且不提交 Git，但 manifest 和 generator 不能缺失。

以下任一情况使 fixture 无效，不得运行或关闭对应 ACC：

- required 字段缺失、类型错误、未知字段或 schema 条件不满足；
- totals 与 entries 实算不一致；
- entry path/size/SHA-256 或 entries hash 不一致；
- 同 seed + generator commit 两次生成的 entries hash 不同；
- profile 的文件数、总字节或 feature coverage 不满足合同；
- `constraints.validation_errors` 非空或 verdict 不是 pass。

## 2. Tiny Fixture

- 20..50 个文件；
- 总字节不超过 5,242,880；
- 必须覆盖 Markdown、图片、PDF、Canvas、C、Python 和中文路径；
- Markdown 至少覆盖 frontmatter、标题、wikilink、中文段落和附件引用；
- 小型内容与 manifest 提交 Git，每次快速测试运行。

精确清单、seed 和 hash 由 DP-006 关闭。

## 3. Edge-case Fixture

至少覆盖并逐项绑定稳定错误/结果：

| 场景 | 必需 oracle |
|---|---|
| 空文件 | 字节往返一致 |
| 未支持扩展名 | `UNSUPPORTED_FILES_FOUND`，快照不 complete |
| Symlink/Junction/其他重解析点 | `REPARSE_POINT_FOUND`，目标不读取 |
| 路径逃逸/ADS/绝对路径 | `ENTRY_PATH_ESCAPE`，根外零写入 |
| 大小写碰撞 | `CASE_COLLISION`，写入前拒绝 |
| 扫描期间文件变化 | `FILE_CHANGED_DURING_SCAN` |
| 文件读取失败 | 稳定 IO 错误，快照不 complete |
| 非空恢复目标 | `NON_EMPTY_TARGET`，已有字节不变 |
| 空格/Emoji/中文/深层路径 | 严格 UTF-8 往返 |
| 异常或损坏 Canvas | 整文件字节策略，不做语义容错 |
| Recovery/Object/Manifest 缺项、截断和尾随 | registry 对应错误码，零部分输出 |

精确恶意字节和每个 expected error group 由 DP-007 关闭。缺一个场景就保持对应 ACC `untested`。

## 4. Representative Fixtures

性能增长必须用同一环境、同一文件数、不同总字节的配对 profile：

| Profile | 文件数 | 总字节范围 | 用途 |
|---|---:|---:|---|
| representative-small | 10,000 | 127,506,842..140,928,614（约 128 MiB ±5%） | 内存增长基准 |
| representative-large | 10,000 | 1,020,054,733..1,127,428,915（1 GiB ±5%） | P0-R1 规模与上限 |

两个 profile 必须由同一 generator 版本生成，内容类型/路径分布一致，仅扩大文件内容体量。两者都包含中文路径、`.c` 和 `.py`，不含未支持文件。精确分布、seed 和 hash 由 DP-008/009 关闭。

## 5. 性能采集合同

每份 `perf-report-v1` 必须记录：

- fixture ID/profile/count/bytes/manifest hash/generator hash；
- OS/build、CPU/核心/频率、RAM、storage model/type、NTFS、Node/V8/pnpm、lockfile hash 和 power plan；
- cold/warm cache；
- high-resolution clock、`process.memoryUsage().rss`、采样间隔（1..100 ms）、idle RSS；
- scan/encrypt/restore-fresh-process/restore-verify/total 五阶段的 duration、peak RSS、file/byte count 和 throughput；
- exit code、timeout、uncaught error；
- 阈值、调整记录、small/large 配对比较、最终布尔 verdict 和原始产物 hash。

字段缺失、未知字段、采样间隔 >100 ms、process 非正常退出或 cross-field 计算不一致都使报告无效。

## 6. 当前数值阈值

| 指标 | 当前门槛 | 失败条件 |
|---|---:|---|
| P0-R1 规模 | large profile 恰好 10,000 文件、1 GiB ±5% | count/bytes 超范围 |
| peak RSS | 536,870,912 字节 | large total peak RSS 超限 |
| fixture byte growth | ≥7.5× | large/small 总字节比不足 |
| peak RSS growth | ≤134,217,728 字节 | large peak - small peak 超限 |
| RSS 采样 | ≤100 ms | 采样更稀或来源不明 |
| 阈值调整 | ≤1 次 | 无 hash-bound 记录或超过一次 |

ACC-30 不再使用“远小于 Vault”“ratio 标准差 < 未定义阈值”等模糊判定。吞吐和耗时只记录，不设硬阈值。

## 7. 调整与延期参数

- DP-006/007/008/009：fixture 清单、恶意输入、分布和 generator；
- DP-010：实际测量主机与运行清单；
- DP-011：512 MiB 上限的可选一次性调整；
- DP-012：chunk、并发和队列上限。

每项 owner、阶段、关闭产物和硬停止条件见 `p0-deferred-parameters.json`。其他文档不得另建自由文本待定项。DP-011 没有合法关闭产物时默认上限继续为 512 MiB；不能把“尚未决定”解释为无限制。

## 8. 当前事实

当前仓库已有 `tools/fixture-generator.mjs` 和 20 文件 Tiny fixture。它在未提交实现上只取得 `review-only` 校验，不能关闭 DP-006/009；representative-small/large generator 产物和 performance report 均不存在，DP-008 与 ACC-26/29/30/31 继续为 open/`untested`。
