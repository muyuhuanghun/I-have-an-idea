# Phase 5-A CLI 接线报告

> 日期：2026-09-02
>
> 状态：原实现已纳管（提交 `3489871`）；2026-09-04 初审为 `REQUEST CHANGES`。真实路径身份修复已在未提交工作区通过本地门禁，开发者已确认独立复审 PASS，等待明确 commit/push 授权
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
- `python -B tools/verify_phase0_contracts.py --validate-samples --evidence-root artifacts` → PASS。该结果只验证绑定 clean commit `9443cb1` 的历史 P0-R1 evidence 包及其嵌套 artifacts；它不绑定、也不证明提交 `3489871` 或后续 dirty Phase 5-A/crypto 修改。当前修改只由本报告列出的实现级测试支持。
- **构建产物 fresh-process 端到端**（`node apps/cli/dist/main.js`，真实子进程派生）：
  - snapshot（2 文件 vault）→ `status: complete`；restore 到不存在路径 → 父进程创建空目录、子进程恢复 `complete`（2 文件、25 字节），`cmp` 逐字节一致；
  - restore 到非空已存在目录 → 拒绝（"--target exists and is not empty"），原文件保留，非零退出；
  - 损坏 Recovery File → 子进程 `RECOVERY_TRUNCATED`，CLI 新建的空目标目录已被清理（leave-no-trace 验证通过）。
- CLI vitest 覆盖：快照产物存在性、store-inside-vault 拒绝、非 hex domain-id 拒绝、runtime-limits 哈希不匹配拒绝、`__restore-worker` 字节一致恢复、`prepareRestoreTarget` 三分支（新建/空/非空）。

## 3. 边界与后续

- 本报告不升级任何 ACC（P0-R1 已按 ADR-0020 关闭）；本阶段产物为 git 忽略的运行时 artifacts。
- §16 的插件职责（进度展示、密文字节/可见性摘要、`p0-plugin-snapshot-report-v1` 测试报告导出）属 Phase 5-B，未在本阶段实现。
- 已知限制：CLI 不创建 store/log/recovery 的父目录（沿用适配器显式路径语义，帮助文本已说明）；restore 的 fresh-process 边界依赖构建产物入口（源码直跑无 dist 时报 usage 错误）。

## 4. 2026-09-04 独立核验与修复状态

### 4.1 原提交结论：REQUEST CHANGES

原 CLI 的 `requireDisjoint` 与 Node snapshot I/O 的 `outsideRoot` 只比较 `resolve()` 后的路径字符串，没有比较真实文件系统身份。在 Windows 上，同一目录可同时由长路径和 8.3 短路径表示。定向复现把 `--vault` 指向长路径，把 `--recovery` 指向同一 Vault 子目录的短路径：提交 `3489871` 的构建产物返回 `status: complete`，Recovery File 实际出现在物理源 Vault 内。现有 unit tests、`test:all` 和 runtime-limits 静态门都没有覆盖该别名面。

这直接违反 ADR-0021 §2.3 的源 Vault 零写入规则，因此不能用原报告的绿测把 Phase 5-A 判为通过。

### 4.2 当前未提交修复

- CLI 保留词法快速拒绝，并新增真实文件系统身份比较：已存在路径用 `realpath`；尚不存在的 log/recovery/restore target 用“真实父目录 + 最终 basename”构造身份。Windows 8.3 短名和祖先 Junction 因而会归一到同一物理位置。
- snapshot 对 vault/store/log/recovery 的原有五组 containment 全部增加物理身份检查；restore 的 store/target 同样增加物理身份检查，且发生在创建目标目录之前。
- `NodeSnapshotLogSink` 与 `NodeRecoveryFileTarget` 的 preflight 同步使用物理身份检查，避免未来插件或其他调用方绕过 CLI 直接实例化适配器时重新出现相同缺陷。
- 新增 CLI 别名回归（Vault 内的 store/log/recovery 三种写目标、ObjectStore 内 restore target）和 adapter Recovery File preflight 别名回归。

### 4.3 修复后验证

- `pnpm run test:all` → exit 0：153 个 TypeScript tests、10 个 Python tests、shared-core import gate、六个 workspace typecheck 与全部构建通过。
- 原 8.3 短路径攻击对新构建产物重放 → exit 2；Vault 内无 Recovery File、无 log，ObjectStore 保持空。
- 构建产物正常 fresh-process 往返 → snapshot/restore 均 exit 0，两文件 SHA-256 逐一相等。
- 非空 restore target → exit 2，原 sentinel 保留；损坏 Recovery File → exit 1，由 CLI 新建且仍为空的 target 被删除。
- `git diff --check` 与定向 ESLint/typecheck 均通过。

### 4.4 当前门槛

上述结果证明已知短路径缺陷在当前 dirty diff 中得到定向修复。开发者已于 2026-09-04 明确确认独立复审 PASS；该裁决关闭“待复审”门，但不自动授权 Git 状态变化，也不把未提交实现写成已纳管。Phase 5-A 当前状态是“原提交已纳管、初审 REQUEST CHANGES、修复复审 PASS、等待明确 commit/push 授权”；在提交授权和远端核对完成以前，不进入 Phase 5-B，不提交、不推送，也不把历史 P0-R1 evidence 外推为当前代码的正式运行证据。
