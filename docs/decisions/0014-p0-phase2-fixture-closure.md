# ADR-0014：Phase 2 Tiny Fixture 与 Generator 关闭

- 状态：Accepted
- 日期：2026-08-29
- 关闭项：DP-006、DP-009
- 前置合同：ADR-0011、ADR-0012、`docs/protocol/P0-fixture-and-performance-baseline.md`

## 决策

接受 `tiny-v1` 作为 P0 快速测试的 deterministic Tiny fixture，并接受 `tools/fixture-generator.mjs` 1.0.0 作为其生成器。由此只关闭：

- DP-006：Tiny fixture 的精确文件清单和固定 seed；
- DP-009：fixture generator 的版本、源码绑定和确定性算法。

DP-007、DP-008、DP-010、DP-012 保持 `open`，DP-011 保持 `conditional`。本 ADR 不修改任何 ACC 状态。

## 冻结值

| 项目 | 值 |
|---|---|
| fixture ID | `tiny-v1` |
| profile / seed | `tiny` / `ekd-tiny-v1` |
| 文件数 / 总字节 | 20 / 794 |
| fixture manifest | `fixtures/tiny/fixture-manifest-v1.json` |
| entries SHA-256 | `fc508b5c3a2eaedf58dd330df852790236c7c5fd4267756fc226a1e7415907ac` |
| generator | `tools/fixture-generator.mjs` 1.0.0 |
| generator commit | `dc41fe435b7df95208ffb334dae9a90080bbbb3a` |
| generator SHA-256 | `500028874cc00239746fc6b05411aa5128caa2e18ada5b997f7f11a85215970c` |

Tiny fixture 覆盖合同要求的 Markdown、图片、PDF、Canvas、C、Python 和中文路径，并包含空文件、C++ 与深层路径。精确文件级 size/digest 继续由 fixture manifest 表达，不在本 ADR 重复抄写。

## 证据与失败历史

实现提交为 `dc41fe435b7df95208ffb334dae9a90080bbbb3a`。提交 `8e0ed3799872d3dae183a5d4e593a7f4b8954755` 首次加入 manifest 绑定时仍错误指向不含 generator 的旧提交，因此 formal verifier 按设计拒绝；该失败不被改写为通过。提交 `d170d97bce59f991dc180319c12a7127cc3dc1bd` 把 manifest 修正为绑定实现提交，随后不带开发豁免运行：

```text
python -B tools/verify_phase2_fixture.py --manifest fixtures/tiny/fixture-manifest-v1.json
PHASE2_FIXTURE_CHECK_PASS mode=formal files=20 bytes=794 fixture_id=tiny-v1
```

正式验证器核对 schema、约束、文件清单、每个文件的 size/digest、entries digest，以及 generator path/version/commit/blob digest 和 tracked/clean provenance。`packages/adapters/test/fixture-generator.test.ts` 以同一 seed 生成两个独立目录，比较完整 manifest 文本和每个文件的 bytes；Phase 2 统一门禁记录为 30/30 tests passed。

## 边界

本 ADR 只证明 Tiny fixture 与其生成器的确定性和正式来源绑定。它不把 scanner 或 Manifest plaintext 单元测试升级为正式 ACC evidence，也不证明代表性规模、性能、有界内存、恢复或加密闭环。37 个 ACC 全部保持 `untested`。

Recovery File、Manifest/Object 加密封装、对象密钥包装、Directory/HTTP ObjectStore、fresh-process 恢复、网页管理端以及 Phase 3 及以后内容均不在本次关闭范围内。
