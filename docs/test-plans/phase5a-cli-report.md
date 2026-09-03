# Phase 5-A CLI 接线报告

> 日期：2026-09-02
>
> 状态：已纳管（实现提交 `3489871`；实现经门禁验证后由开发者授权提交）
>
> 合同：ADR-0021（Phase 5-0 接线合同 v1，开发者四点确认）
>
> 范围：`apps/cli` 的 `snapshot` 与 `restore` 命令接线 + crypto 边界缺陷修复；**不含任何插件改动**（插件属 Phase 5-B）

## 1. 交付内容

1. **`ekd-p0 snapshot`**（`apps/cli/src/main.ts`）：进程内调用共享核心 `createSnapshotV1`。参数全部显式且无默认：`--vault`、`--store`、`--log`、`--recovery`、`--domain-id`（64 小写 hex）、`--runtime-limits`。CLI 侧校验 store/log/recovery 与 vault 两两互不包含；`--runtime-limits` 文件字节的 SHA-256 必须等于内置常量 `ACCEPTED_RUNTIME_LIMITS_SHA256`（即 `docs/contracts/p0-runtime-limits-v1.json` 的哈希，ADR-0021 §2.4），且 `schema_version` 匹配，否则拒绝运行。编排语义（Vault 零写入、log/recovery 排他创建、对象不可变、碰撞返回）全部留在适配器与核心。
2. **`ekd-p0 restore`**：父进程校验目标策略（ADR-0021 §2.8——不存在则新建空目录；存在则必须是真实空目录；非空拒绝且原文件保留），然后以自身 dist 为入口派生**新进程**执行 `__restore-worker`（fresh-process 边界，ADR-0018 §3.1 的 caller-creates-empty 由 CLI 代表调用者履行）。子进程失败时，若目标目录由 CLI 新建且仍为空则删除（leave-no-trace）；非空则保留并如实上报 `partialOutputInventory`。
3. **`ekd-p0 __restore-worker`**（内部命令）：读取 Recovery File 字节，调用 `restoreSnapshotV1`（`DirectoryObjectStoreV1` + `NodeRestoreTarget` + WebCrypto Suite 1），输出机器 JSON，exit 0/1。
4. **crypto 边界缺陷修复（`packages/crypto/src/shared.ts`）**：`asArrayBuffer` 原实现 `bytes.slice().buffer` 依赖 `Uint8Array.prototype.slice` 的拷贝语义，但 Node `Buffer.prototype.slice` 返回共享池的**视图**——池化 Buffer（`byteOffset > 0`）作输入时，WebCrypto 实际收到整个底层内存池，Recovery File HMAC 校验必然失败（`RECOVERY_INTEGRITY_FAILED`）。修复为 `bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)`（`ArrayBuffer.prototype.slice` 恒拷贝、视图语义正确）。该缺陷由本阶段 CLI 测试发现（worker 用 `new Uint8Array(...)` 拷贝掩盖了它）；回归测试两处：crypto `bytes-views.test.ts`（视图范围精确拷贝）+ core `restore.test.ts`（pooled Buffer view 的 Recovery File 端到端恢复）。
5. **验证器静态门（ADR-0021 §2.4 机器化）**：`verify_phase0_contracts.py` 新增 `validate_cli_runtime_limits_binding`——校验 `apps/cli/src/main.ts` 内置常量存在、为 64 位小写 hex、且与 `docs/contracts/p0-runtime-limits-v1.json` 实际字节哈希一致；契约文件与 CLI 任一方漂移即 FAIL。配 1 项单元测试。
6. **依赖与测试脚本**：`@ekd/cli` 新增 `@ekd/adapters` workspace 依赖（lockfile 同步）与 `vitest` 测试脚本。

## 2. 验证结果

- `pnpm run test:all` → **exit 0**（lint、typecheck、新增 CLI 5 项 + crypto 2 项 + core 1 项回归测试、Python 验证器 5 项、shared-core import gate、全部 workspace 构建）。
- `python -B tools/verify_phase0_contracts.py --validate-samples` → PASS（含新 CLI 绑定门）。
- `python -B tools/verify_phase0_contracts.py --validate-samples --evidence-root artifacts` → PASS（既有 R1 证据不受 crypto 修复影响：独立精确数组输入的输出逐字节不变）。
- **构建产物 fresh-process 端到端**（`node apps/cli/dist/main.js`，真实子进程派生）：
  - snapshot（2 文件 vault）→ `status: complete`；restore 到不存在路径 → 父进程创建空目录、子进程恢复 `complete`（2 文件、25 字节），`cmp` 逐字节一致；
  - restore 到非空已存在目录 → 拒绝（"--target exists and is not empty"），原文件保留，非零退出；
  - 损坏 Recovery File → 子进程 `RECOVERY_TRUNCATED`，CLI 新建的空目标目录已被清理（leave-no-trace 验证通过）。
- CLI vitest 覆盖：快照产物存在性、store-inside-vault 拒绝、非 hex domain-id 拒绝、runtime-limits 哈希不匹配拒绝、`__restore-worker` 字节一致恢复、`prepareRestoreTarget` 三分支（新建/空/非空）。

## 3. 边界与后续

- 本报告不升级任何 ACC（P0-R1 已按 ADR-0020 关闭）；本阶段产物为 git 忽略的运行时 artifacts。
- §16 的插件职责（进度展示、密文字节/可见性摘要、`p0-plugin-snapshot-report-v1` 测试报告导出）属 Phase 5-B，未在本阶段实现。
- 已知限制：CLI 不创建 store/log/recovery 的父目录（沿用适配器显式路径语义，帮助文本已说明）；restore 的 fresh-process 边界依赖构建产物入口（源码直跑无 dist 时报 usage 错误）。
