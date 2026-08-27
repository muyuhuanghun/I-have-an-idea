# ADR-0010：P0 性能采集方法与报告 Schema

- 状态：部分取代；当前 schema 和阈值权威是 `perf-report-v1.schema.json`
- 日期：2026-08-27
- 决策者：开发者
- 相关文档：P0-fixture-and-performance-baseline.md §5、ADR-0008

> 历史边界：下文字段清单不是可验证 JSON Schema，ACC-30 的“ratio 标准差 < 阈值”也没有给出阈值且不能检验随总字节增长。当前合同改为同环境/同 10,000 文件的约 128 MiB 与约 1 GiB 配对运行：字节比至少 7.5，peak RSS 增量最多 134,217,728 字节，且大 fixture 不超过当前冻结 RSS 上限。

## 历史背景

P0-fixture-and-performance-baseline.md §5 给出暂定性能门槛（10,000 文件、约 1 GiB、512 MiB 峰值 RSS），但未冻结采集方法、采样工具、报告 schema。

无冻结 schema 时，不同运行产出的 RSS/耗时数据无法对比，ACC-29/30/31 的 oracle 难以自动判定。本 ADR 冻结性能采集方法、报告 schema 和阈值调整规则。

## 历史决策（当前由 ADR-0012 和 JSON Schema 取代）

### 1. 测量阶段

性能采集覆盖以下阶段，每个阶段记录独立指标：

| 阶段 | 范围 |
|---|---|
| scan | 只读扫描源 Vault |
| encrypt | 加密并写入 ObjectStore |
| restore-fresh-process | 新进程 fresh-process 恢复 |
| restore-verify | Python 独立验证器逐文件字节核对 |
| total | 端到端总耗时（不含 setup） |

### 2. 采集指标

每个阶段必须采集以下指标：

| 指标 | 单位 | 采集方式 |
|---|---|---|
| duration | 毫秒 | 高精度计时（performance.now 或 process.hrtime） |
| peak_rss | 字节 | process.memoryUsage().rss 最大值，采样间隔 ≤ 100ms |
| bytes_processed | 字节 | 该阶段读/写的总字节数（明文 + 密文） |
| files_processed | 整数 | 该阶段处理的文件数 |
| throughput | 字节/秒 | bytes_processed / duration × 1000 |

### 3. 测量环境清单

每次性能采集必须记录环境清单：

| 字段 | 说明 |
|---|---|
| os | OS 名称、版本、补丁级别 |
| cpu | 型号、物理核心、逻辑核心、基础频率 |
| ram_total | 物理内存总量 |
| storage | 存储类型（SSD/HDD/NVMe）、文件系统（NTFS） |
| node_version | 精确版本（V8 版本） |
| pnpm_version | 精确版本 |
| git_commit | 仓库 commit |
| lockfile_hash | 依赖锁文件 SHA-256 |
| fixture_hash | 使用的 fixture 根清单 SHA-256 |
| cold_or_warm | 冷/热缓存：cold = 重启后首次运行，warm = 第二次运行 |
| run_id | 性能运行唯一标识（与 smoke 报告 run_id 体系一致） |

### 4. 性能报告 JSON Schema（v1）

字段定义：

- schema_version: string，固定为 perf-report-v1
- run_id: UUID v4
- timestamp_utc: ISO-8601 字符串
- git_commit: 仓库 commit SHA
- fixture: 包含 name, total_files, total_bytes, fixture_hash
- environment: 包含 os, cpu_model, cpu_cores_physical, cpu_cores_logical, cpu_base_freq_mhz, ram_total_bytes, storage_type, filesystem, node_version, pnpm_version, lockfile_hash
- cache_state: cold 或 warm
- phases.scan / encrypt / restore_fresh_process / restore_verify / total: 每项含 duration_ms, peak_rss_bytes, files_processed, bytes_processed, throughput_bytes_per_sec（total 阶段只含 duration_ms 和 peak_rss_bytes）
- thresholds: peak_rss_limit_bytes, rss_threshold_adjustments, rss_threshold_adjustment_reason
- verdict: peak_rss_within_limit, rss_not_linear_in_vault_size, adjustments_within_policy, overall (pass | fail | incomplete)

### 5. ACC oracle 与报告字段映射

| ACC | oracle | 报告字段 |
|-----|--------|---------|
| ACC-26 10,000 文件往返 | 端到端往返无错误 | phases.total.duration_ms 和 verdict.overall=pass |
| ACC-29 峰值 RSS 不超阈值 | peak_rss ≤ peak_rss_limit_bytes | phases.total.peak_rss_bytes vs thresholds.peak_rss_limit_bytes |
| ACC-30 内存不线性增长 | 用 1,000 文件 fixture 跑两次，验证 peak_rss 与 file_count 比值稳定 | 需两次报告，ratio 标准差 < 阈值 |
| ACC-31 性能冻结规则 | rss_threshold_adjustments ≤ 1 | thresholds.rss_threshold_adjustments |

### 6. 阈值调整规则

- 默认 peak_rss_limit_bytes = 512 * 1024 * 1024（512 MiB）
- 首次取得基线后允许调整一次，调整必须记录：
  - 调整前基线数据
  - 调整理由
  - rss_threshold_adjustments 字段递增
- 调整只允许一次（rss_threshold_adjustments ≤ 1）
- 关闭报告中需说明最终冻结值

## 后果

- 性能报告格式冻结为 v1
- ACC-26/29/30/31 的 oracle 字段固定
- 阈值调整规则可机器判定
- 关闭报告中的性能达标声明必须引用本 schema 报告

## 与算法参数的关系

本 ADR 冻结：测量阶段、采集指标、报告 schema、ACC oracle 映射、阈值调整规则。

未冻结：

- 具体的 RSS 限制数值（默认 512 MiB，可一次调整）
- 吞吐/延迟期望值（不设硬阈值，只记录实际值）
