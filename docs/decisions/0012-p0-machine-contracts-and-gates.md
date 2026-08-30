# ADR-0012：P0 Schema、追踪 Registry 与缺项失败门禁

- 状态：已接受；当前机器合同权威
- 日期：2026-08-27
- 决策者：开发者
- 相关文件：`docs/schemas/*.schema.json`、`docs/contracts/p0-traceability-v1.json`、`docs/contracts/p0-deferred-parameters.json`、`tools/verify_phase0_contracts.py`

## 背景

ADR-0008/0010 曾用示例 JSON 和字段清单宣称 schema 已冻结，但它们不能验证缺字段、未知字段、required vector 数量、退出状态、原始产物 hash 或性能增长阈值。旧 threat trace 表也没有逐条覆盖 37 个 ACC，且使用“远小于”“结果一致”等不可直接执行的 oracle。

## 决策

### 1. JSON Schema 是报告结构权威

采用 JSON Schema draft 2020-12：

- `smoke-report-v1.schema.json`；
- `smoke-aggregate-v1.schema.json`；
- `fixture-manifest-v1.schema.json`；
- `perf-report-v1.schema.json`；
- `acc-evidence-v1.schema.json`。

所有 schema 顶层 `additionalProperties=false`，列出完整 `required`。缺字段、错误类型、未知字段、null 越权或条件字段不满足都使报告无效。无效报告不能降级为 pass，也不能作为“仅缺信息”的有效 incomplete；它的裁决是 `REPORT_SCHEMA_INVALID`。

### 2. Smoke 必填和裁决

每个 candidate × suite × environment 恰有 14 个 required 向量：3 AEAD KAT、4 类 AEAD tamper、2 HKDF KAT、1 HKDF label isolation、1 random roundtrip、1 random-source-errors、1 wrap KAT、1 bad-wrap-material。required 向量 skipped 产生 `incomplete`；failed/error 产生 `fail`；schema 无效产生 invalid，不进入 aggregate。

`random-source-errors` 冻结的三个公共错误码是 `RANDOM_SOURCE_SHORT_READ`、`RANDOM_SOURCE_FAILED` 和 `RANDOM_SOURCE_ALL_ZERO`。它们分别表示随机源返回字节数不符、随机源调用失败和返回全零哨兵值；适用于 provider、Recovery File 生成和 object ID/key/nonce 生成边界。2026-08-30 的 registry 对账把这三个既有 Phase 1 向量错误码补入 `p0-traceability-v1.json#error_codes`，没有新增错误语义或改变正式向量。

三环境 source report 必须各一份且 schema valid。只有三个 verdict 都是 pass、candidate/suite/vector/bundle/commit 绑定一致、Android device binding 已验证时才产生 `cross_env_pass`。

### 3. Fixture 必填和阈值

fixture manifest 绑定 seed、generator path/commit/hash/version、全部 entry path/size/SHA-256、entries hash、feature coverage 和约束裁决。

- tiny：20..50 文件，最多 5 MiB；
- representative-small：恰好 10,000 文件，约 128 MiB ±5%；
- representative-large：恰好 10,000 文件，1 GiB ±5%；
- edge-case：必需场景及错误 oracle 由 DP-007 关闭。

生成内容未提交不等于 manifest 可缺失。任何 profile、计数、总字节、hash 或 feature coverage 缺项都失败。

### 4. Performance 必填和数值 oracle

perf report 必须绑定 fixture、环境、缓存状态、测量工具、idle RSS、五阶段指标、进程退出、阈值、bounded-memory comparison 和原始产物。

当前阈值：

- peak RSS 上限 536,870,912 字节（512 MiB），只可按 DP-011 调整一次；
- RSS 采样间隔不超过 100 ms；
- large/small fixture 字节比至少 7.5；
- 同环境同 10,000 文件时，large peak RSS - small peak RSS 不超过 134,217,728 字节；
- large peak RSS 同时不得超过冻结总上限。

吞吐和总耗时只记录，不设伪精确门槛。

### 5. 37/16/THR 稳定追踪

`p0-traceability-v1.json` 固定 37 ACC、16 INV 和 5 THR，也是公共规范错误码的机器 registry。每个 ACC 有唯一 evidence path、required checks、error-code groups 和 forbidden side effects。安全映射必须双向一致；非安全 ACC 必须说明 THR/INV 不适用原因。THR-02/04/05 用明确 deferred/accepted-limitation/out-of-scope disposition，不伪装成已测试缓解。provider 内部诊断若不在 registry 中，不得越过核心边界成为 ACC oracle 或公共 codec 错误；例如 `OBJECT_KEY_UNWRAP_FAILED` 必须在核心边界收敛为 `OBJECT_AEAD_FAILED`。

### 6. 延期项

`p0-deferred-parameters.json` 是唯一延期参数 registry，固定为 DP-001..026。每项必须包含 owner、phase、close artifact、hard stop 和 status；`closed` 项还必须绑定存在的 closure ADR。其他文档不得新增未注册的“待定/实现时再说”参数。

## 机器门禁

设计合同命令：

```powershell
python tools/verify_phase0_contracts.py
```

返回 0 只证明 design contract 静态一致。运行：

```powershell
python tools/verify_phase0_contracts.py --validate-samples
```

把每份 schema 与它的合法/非法样本配对跑一次；正样本必须被接受，负样本必须被拒。该模式本身证明 schema 强制路径在 work，而不是只检查 `additionalProperties` 和顶层 `required`。

```powershell
python tools/verify_phase0_contracts.py --evidence-root artifacts
```

需要 37 份 ACC evidence 全部通过；在它们不存在时必须失败，不能把 design-only PASS 解释成 P0-R1 PASS。`validate_evidence` 在加载每份 evidence 后用 `acc-evidence-v1` 真校验 enum/pattern/format/required/additionalProperties/uniqueItems/contains 等约束；任何缺字段、未知字段、错误类型或非法 uuid/date-time 都会使该 evidence 立即被拒，而不再等 `required_checks` 检查才被发现。`artifacts[].path` 必须位于 `evidence_root` 之下、文件存在、`sha256` 与文件实际内容匹配。

## 后果

- ADR-0008/0010 的示例字段清单保留为历史背景，不能再作为 schema 权威；
- threat-traceability.md 的旧摘要表由 registry 取代；
- Phase 1 正式 `random-source-errors` 向量已经冻结并验证的 `RANDOM_SOURCE_SHORT_READ`、`RANDOM_SOURCE_FAILED`、`RANDOM_SOURCE_ALL_ZERO` 是共享公共错误码；2026-08-30 的 registry 对账只补齐机器权威，不重跑或改写既有正式报告；
- 任何必填缺项、未知字段、未定义阈值或人工模糊判定都是硬停止条件；
- 本 ADR 建立时实现、fixture 和运行报告尚未开始；截至 2026-08-30，Phase 1 正式矩阵与 ADR-0013 选型已完成，DP-001..005 已关闭。后续窄范围 Phase 2 已实现 Tiny fixture、Node 只读扫描器和 Manifest plaintext codec；Tiny fixture 已取得 commit-bound formal provenance，ADR-0014 关闭 DP-006/009。Phase 3A/3B 分别实现 Recovery File v1 和冻结的纯内存 Object/Manifest crypto codec，但 P0-R1、representative/performance fixture 和 37 份正式 ACC evidence 仍未实现，全部 ACC 保持 `untested`。2026-08-30 的 Phase 3C-0 冻结 Directory ObjectStore v1 合同（ADR-0015），registry 仅新增归一化错误码 `OBJECT_STORE_IO_FAILED`。
