# Phase 3D 存储可见性扫描合同与实现复审报告

> 日期：2026-08-30
>
> 状态：dirty-source 独立复审在直接修正后通过；实现已由提交 `1f5e27473336b150165889106a6562653dd49a89` 纳管
>
> 基线：`a51ff8f0806981d7de6cf950708820cf361c58e9`（Phase 3C 两笔提交已与 `origin/main` 对齐）

## 1. 授权与诚实边界

用户授权路线 A：先做 Phase 3D 存储可见性扫描，不进入 Phase 4。Phase 3D-0 冻结扫描合同，Phase 3D-A 实现扫描器、CLI、测试和报告格式；测试数据允许用 Phase 3B codec 加密后直接播种 Directory ObjectStore，不要求尚未实现的 snapshot pipeline。

本阶段明确不是 ACC-32/33 正式 evidence。两项 ACC 的冻结方法仍要求在 Vault 植入 marker、由 P0-R1 pipeline 生成完整快照，再扫描该 ObjectStore 与本次进程全部 stdout/stderr。当前 pipeline、快照完成标记、日志完整性绑定均不存在，因此 37 个 ACC 全部保持 `untested`，DP-007/008/010/012 仍为 `open`，DP-011 仍为 `conditional`。HTTP 服务器视角仍受 DP-014 阻挡。

## 2. GLM 已完成且保留的工作

GLM 正确完成了以下基础工作：

- 建立 ADR-0016，明确 Directory ObjectStore 与进程日志两个扫描面；
- 复用共享核心 `decodeObjectStoreKeyV1` 校验 canonical key，不复制协议编码；
- 枚举 key/`<key>.tmp`，拒绝非法名字、子目录和非常规条目；
- 扫描三类 marker、扩展名、offset 0 magic 和调用方提供的秘密；
- findings 不摘录上下文明文，scanner I/O 失败关闭；
- 建立薄 CLI，并以真实 `sealFileObjectV1 → DirectoryObjectStoreV1.put` 覆盖“密文不含播种 marker”的正面路径；
- 保持 error registry、DP 和 ACC 状态不变。

这些工作方向与执行计划 §14、INV-01/03 和 ACC-32/33 一致，可以作为修正后的实现基础。

## 3. 初始实现未达到验收线的部分

GLM 报告的“82/82 全绿”只证明当时测试覆盖内代码自洽，不能证明扫描合同已经闭合。独立复审发现七个阻断问题：

1. **报告自泄漏**：`inputs.markers`、marker finding 的 `pattern` 和非法条目的 `entry` 原样写回实际 marker/文件名。扫描器能正确发现泄漏，却把同一禁止明文写进自己的 JSON，直接违背 ACC-33 的目标。
2. **自测可用总数替换伪造**：只比较 `found === planted`。漏掉一个 marker、让另一个重复一次，总数仍相等，可以伪通过；输入也未强制 filename/content/path 三族全部覆盖。
3. **秘密扫描不完整**：只找 ASCII hex，没有找原始 32 字节 secret；标签也未限制安全词汇，恶意或误用标签可让报告再次带入禁止明文。
4. **日志字节被改写**：CLI 先用 UTF-8 解码 stdout/stderr，非法字节会被替换；合同声称的“字节级扫描”与实际输入不一致。
5. **没有机器 Schema**：只有 TypeScript interface，没有 JSON Schema、正反样例和合同门接线，ACC oracle 中的 `schema_valid` 无可执行依据。
6. **扫描后写回漏洞**：`--output` 可指向 store 内部。CLI 会先得到 pass，再把明文 JSON 写进 ObjectStore 并以 0 退出；通过 junction/symlink alias 或已有 hardlink/symlink 还可绕过简单词法判断。
7. **失败关闭不完整**：缺失 control 的运行时输入会在读取 `input.control.plantedMarkers` 时先抛异常，而不是返回稳定 fail report。

因此，GLM 原始工作树的审查结论是 **FAIL，需要修正**；不能按其原报告直接提交。

## 4. 独立复审直接修正

### 4.1 报告不再携带被禁止的值

- marker finding 只记录 `filename`/`content`/`path` 族名，不记录实例；
- 非法文件名不进入 finding 的 `entry`；只有 canonical key/`<key>.tmp` 可以出现；
- `inputs` 只记录 marker 数、覆盖族、安全 secret label 和实际扫描日志字节数；
- secret finding 只记录安全 label 与 `raw`/`hex` 表示，不记录 secret；
- 新测试同时检查 pass/fail 两类报告都不含实际 marker、秘密、非法文件名或上下文。

### 4.2 自测改成逐 marker oracle

输入必须覆盖三族，每个 marker 有非空后缀、ASCII case folding 后唯一且不得互为子串。`plantedMarkers` 必须等于配置 marker 数；control 中每个 marker 必须恰好出现一次。报告以 `marker-NNN`、族名和 occurrence 逐项记录。新增“总数仍为 3，但分布为 2/0/1”的反例，确认 verdict 为 fail。

### 4.3 原始字节与秘密双表示扫描

日志 API 改为 `Uint8Array`，CLI 用原始 Buffer 读取；ASCII case folding 只改 `A-Z`，不再借 Unicode/latin1 lowercasing 改写任意密文字节。每个已知 secret 固定为安全 label + 64 位 hex，扫描其原始 32 字节与 ASCII hex 两种表示，临时 raw/hex needle 在扫描结束后清零。

扫描器只能验证调用方提供的 secret，不能自行证明调用方没有漏传；正式 ACC harness 后续必须证明已覆盖本次运行可获得的 recovery root、Domain Data Root、Manifest Key、Object Wrap Key 和对象 key，并 hash-bind 完整进程日志。这项能力边界已写回 ADR-0016，不伪造已完成证据。

### 4.4 机器 Schema 和防回归门

新增 `docs/schemas/storage-visibility-scan-v1.schema.json`，顶层和嵌套对象全部 `additionalProperties: false`；finding 的 entry 只能是 canonical key/tmp，marker pattern 只能是三族安全枚举，known-secret finding 必须带 `raw`/`hex`。新增正反样例并接入 `verify_phase0_contracts.py --validate-samples`；负样例专门尝试把实际 marker 放回 `inputs.markers`，必须被 Schema 拒绝。

### 4.5 CLI 输出 containment

`--output` 先做词法 containment，再 realpath 输出父目录，拒绝 junction/symlink alias；报告只允许用 `wx` 独占创建新文件，已有 symlink/hardlink/普通文件都不能被改写。unit test 覆盖 store 内路径和 junction alias；构建后 CLI 冒烟确认 store 内输出 exit 2 且文件未创建。

## 5. 测试与真实运行结果

修正后的统一门禁：

```text
pnpm run test:all
  lint PASS
  typecheck PASS（6 workspace projects）
  test PASS 87/87
    core     25
    crypto   18
    adapters 39
    smoke     5
  Shared-core import gate PASS
  build PASS（6 workspace projects）

python -B tools/verify_phase0_contracts.py --validate-samples
  PHASE0_CONTRACT_CHECK_PASS mode=design-only+samples
  ACC=37 INV=16 THR=5 DP=26
  no ACC status was upgraded

git diff --check HEAD
  PASS（仅 autocrlf 提示，无 whitespace error）
```

构建产物上的 CLI 独立冒烟：

```text
clean store        exit 0, verdict pass, marker_echoed=false
output inside root exit 2, report file not created
leaky invalid file exit 1, verdict fail, store findings=3,
                   marker_echoed=false, filename_echoed=false
missing log        exit 1, verdict fail, scanner_error present
real pass JSON     storage-visibility-scan-v1 Schema PASS
```

测试临时目录位于系统 Temp，验证后逐文件和空目录清理；仓库外没有保留测试产物。

## 6. 最终裁决与停止点

修正后的 Phase 3D-0/3D-A dirty source 达到独立复审预期：**PASS，无剩余阻断项**。实现已按开发者明确授权由提交 `1f5e27473336b150165889106a6562653dd49a89` 纳管。当前产物是可供未来 ACC-32/33 harness 复用的 scanner、CLI 和机器 Schema，不是正式 ACC evidence，也没有证明 snapshot pipeline、服务器视角、完整日志捕获或全部 secret 枚举已完成。

本报告和状态对账属于开发者授权的第二笔 Phase 3D 文档提交；最终 clean-HEAD 门禁与 push 在该提交完成后执行。随后只允许起草 Phase 4-0 合同；Phase 4-A/B、snapshot/恢复实现、插件接线和 HTTP ObjectStore 仍不在授权内。
