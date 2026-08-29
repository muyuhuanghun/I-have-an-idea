# Phase 2 Fixture / Scanner / Manifest Plaintext 关闭报告

> 日期：2026-08-29  
> 状态：窄范围实现完成；Tiny fixture formal provenance 通过，ADR-0014 关闭 DP-006/009  
> 实现提交：`dc41fe435b7df95208ffb334dae9a90080bbbb3a`  
> provenance 修正提交：`d170d97bce59f991dc180319c12a7127cc3dc1bd`

## 1. 授权范围

本轮只实现：

- deterministic Tiny fixture；
- 只读 Vault 扫描器；
- Canonical Manifest plaintext v1 编解码；
- 对应测试与 formal fixture evidence。

明确不实现 Recovery File、Manifest/Object AEAD、对象密钥生成或包装、Directory/HTTP ObjectStore、fresh-process 恢复、网页端和 Phase 3 及以后内容。

## 2. 实现

### 2.1 Tiny fixture

`tools/fixture-generator.mjs` 以固定 seed `ekd-tiny-v1` 生成 `fixtures/tiny/vault/`：20 个文件、794 字节，覆盖 Markdown、图片、PDF、Canvas、C/C++、Python、空文件、中文路径和深层路径。`fixture-manifest-v1.json` 记录 schema 所需的精确清单；生成器只支持本轮获准的 `tiny` profile。

本轮没有生成 10,000 文件 representative-small/large，也没有运行性能测试。DP-008 和 ACC-26/29/30/31 不受本轮结果影响。

### 2.2 只读扫描

`packages/core/src/scan.ts` 负责内容策略、路径闭合、未知文件失败关闭、去重和 canonical 排序。`packages/adapters/src/node-vault.ts` 顺序读取 Node 文件系统，排除真实 `.obsidian` 目录，拒绝链接/特殊条目，并比较读取前后 file stamp。`VaultEntry` 使用惰性 `readBytes()`，core 先检查路径和扩展名，未知文件不会读取内容；扫描结果只保留路径、类别和字节数，不保留整个 Vault 的内容。

Obsidian product scanner adapter 仍未启用；现有插件保持 Phase 1 smoke 功能，不扩展产品工作流。

### 2.3 Manifest plaintext

`packages/core/src/manifest.ts` 实现 ADR-0011 的 `EKDM` v1 canonical plaintext：大端整数、严格 UTF-8、无 NUL/路径逃逸、32 字节 domain/snapshot IDs、P0 全零 parent ID、Suite 1、16 字节 object ID、u64 plaintext size、40 字节 wrapped-key 字段和严格 EOF。

编码器按路径 UTF-8 原始 bytes 排序；解析器拒绝重复/逆序路径、重复 object ID、非法长度、未知版本/suite、非法 UTF-8、截断和尾随字节。测试中的 wrapped-key 字段是固定 bytes，不调用密码 provider，也不实现密钥包装。

## 3. 证据边界

`tools/verify_phase2_fixture.py` 使用既有 `fixture-manifest-v1` schema，并只对 20 个 Tiny 文件做一次合同所需的 size/digest/entries 校验。manifest 现已绑定包含 generator 的实现提交 `dc41fe435b7df95208ffb334dae9a90080bbbb3a`；验证器同时核对提交中的 generator blob digest 与 tracked/clean provenance，结果为 `mode=formal`。

本轮不生成 `acc-evidence-v1` 正式报告，不修改 ACC registry 状态。ADR-0014 仅以 formal fixture provenance 和确定性双生成测试关闭 DP-006/009；DP-007/008/010/012 保持 `open`，DP-011 保持 `conditional`。不需要重跑 Phase 1 六环境矩阵。

## 4. 验证结果

Phase 2 实现复审时运行统一门禁：

```text
pnpm run test:all
lint PASS
typecheck PASS（6 workspace projects）
test PASS（30/30）
Shared-core import gate PASS
build PASS（6 workspace projects）
```

关闭时的合同与 formal fixture verifier：

```text
python -B tools/verify_phase0_contracts.py --validate-samples
PHASE0_CONTRACT_CHECK_PASS mode=design-only+samples ACC=37 INV=16 THR=5 DP=26
P0_R1 remains NOT_IMPLEMENTED / NOT_TESTED; no ACC status was upgraded.

python -B tools/verify_phase2_fixture.py --manifest fixtures/tiny/fixture-manifest-v1.json
PHASE2_FIXTURE_CHECK_PASS mode=formal files=20 bytes=794 fixture_id=tiny-v1
```

没有重跑 Phase 1 六环境 smoke。开发期间出现过两次定向测试失败：fixture-generator 测试最初按 package cwd 解析了错误脚本路径，修正后又解析到旧 core 构建产物；两项已分别改为基于 `import.meta.url` 定位脚本和直接导入当前 core 源码。Sol 复审另外发现 `.obsidian` 跳过发生在 entry 类型检查之前，已调整为先拒绝链接、再排除真实目录。

provenance 关闭时还保留了以下失败历史：提交 `8e0ed3799872d3dae183a5d4e593a7f4b8954755` 中的 manifest 仍错误绑定不含 generator 的旧提交，未带 `--allow-dirty-dev` 的 verifier 返回 `PHASE2_FIXTURE_CHECK_FAIL`。提交 `d170d97bce59f991dc180319c12a7127cc3dc1bd` 把绑定修正到 `dc41fe435b7df95208ffb334dae9a90080bbbb3a` 后，才取得上述 `mode=formal`。失败没有被改写成首次通过。

## 5. Sol 复审

二次审查确认：

- core 不导入 Node、Electron、Obsidian 或 HTTP；
- scanner 不写源 Vault，顺序读取且不在结果中保留文件 bytes；
- unsupported path 在内容策略拒绝前不会触发 `readBytes()`；
- Manifest codec 不调用 CryptoProvider，不生成 Recovery/Object/AEAD bytes；
- 新增通用解析错误 `MANIFEST_FORMAT_INVALID` 已进入 registry、ACC-16 oracle、验收矩阵和实现测试；
- Tiny 的逐文件 digest 仅用于既有 fixture schema 的 20 个小文件，没有引入内容寻址、重复全库哈希或性能 fixture；
- formal fixture provenance 足以关闭 DP-006/009，但不是 `acc-evidence-v1`；Obsidian product scanner、representative fixture、任何 ACC 状态升级和 Phase 3 全部未实施。

## 6. 停止点

完成 formal fixture provenance、ADR-0014 和一次 Phase 0 合同验证后停止。不得自动 commit/push，不进入 Recovery/Object/AEAD/ObjectStore/restore/web 工作。
