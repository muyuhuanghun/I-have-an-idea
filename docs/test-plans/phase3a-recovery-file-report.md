# Phase 3A Recovery File v1 复审报告

> 日期：2026-08-30  
> 状态：授权切片实现完成，等待 Sol 二次复审；未提交、未推送  
> 基线：`e49b677af805ebac300955336ab08ad6927bbdb8`

## 1. 授权范围

本轮只实施：

- 在现有 `CryptoProvider` 增加 SHA-256、HMAC-SHA-256 生成和验证；
- Recovery File v1 生成、严格编码、严格解析和 HMAC 验证；
- Node 侧 Vault 外独占写入，关闭写句柄后重新从磁盘读取；
- 对应单元测试和复审证据。

明确不实施 Manifest/Object AEAD、对象密钥包装、Object Envelope、Directory/HTTP ObjectStore、完整快照、fresh-process 恢复、插件产品功能、网页端和 Phase 3B/4 以后内容。本轮不修改延期项状态，不生成 `acc-evidence-v1`，不升级任何 ACC。

## 2. 实现

### 2.1 密码原语

`CryptoProvider` 新增 `sha256`、`hmacSha256` 和 `verifyHmacSha256`。Web Crypto provider 使用 `SubtleCrypto.digest/sign/verify`；Noble 候选使用 `@noble/hashes` 的 `sha256`/`hmac` 并以固定长度循环比较标签；unconfigured provider 继续使用同一 fail-closed 错误。没有增加算法、fallback、签名体系或新密钥层级。

两条 provider 路径均用 SHA-256 `abc` 向量和 RFC 4231 HMAC-SHA-256 case 1 验证，并覆盖正确标签接受与单字节篡改拒绝。P0 生产选择仍是 ADR-0013 的 Web Crypto wrapper 0.1.0；Noble 只保持既有比较路径接口完整。

### 2.2 Recovery File v1

`packages/core/src/recovery.ts` 逐字节复用 ADR-0011 和 `p0-wire-contract-v1.json`：

- 固定 167 字节，magic `EKDR`；
- recovery format/protocol/suite 均为 1；
- 32 字节 domain ID、recovery root、snapshot ID；
- 16 字节 Manifest object ID；
- `trunc16(SHA-256(ascii("ekd-v1/recovery-fingerprint") || domain_id))`；
- integrity key 使用 HKDF-SHA-256，info 为 `ekd-v1/recovery-file-integrity`；
- HMAC-SHA-256 严格覆盖 `file[0:135]`，tag 位于 `135..166`。

生成路径只从 `RandomSource` 请求 32 字节 recovery root，拒绝异常、短读和全零输出。解析器先拒绝错误长度、magic、version 和 suite，再使用文件内 recovery root 派生 integrity key 并验证 HMAC；HMAC 通过前不返回任何恢复结构。HMAC 通过后还核对 fingerprint 的 canonical 值，避免接受“重新计算 HMAC 但 fingerprint 不符合合同”的自洽非 canonical 文件。

### 2.3 Vault 外落盘与回读

`packages/adapters/src/node-recovery-file.ts` 使用 real path 比较确保目标不在 Vault 根目录内；父目录必须已经存在。目标使用 Node `open(..., "wx", 0o600)` 独占创建，已有文件不会被覆盖；写入后 `sync()`，在 `finally` 中关闭句柄，随后才调用 `readFile()`。回读 bytes 与输入逐字节比较，不增加额外文件 hash。

该适配器只负责保存和回读一份已经编码的 167 字节 Recovery File，不创建快照、不访问 ObjectStore、不执行恢复。

## 3. 测试范围

Recovery codec 测试覆盖：

- 167 字节偏移和所有字段往返；
- 从 0 到 166 的每个截断长度；
- 尾随字节；
- magic、recovery version、protocol version 和 suite；
- recovery root、snapshot ID、Manifest locator、fingerprint 和 HMAC 单字节翻转；
- fingerprint 被修改且重新计算 HMAC 的非 canonical 输入；
- RandomSource 异常、短读和全零；
- caller 提供错误字段长度。

Node adapter 测试覆盖 Vault 外写入/回读、Vault 内路径零创建和已有恢复文件零覆盖。

## 4. 执行证据

首次三包定向测试保留了两项真实失败历史：

1. `CORE_VERSION` 已升级，但旧 scaffold 测试仍期待 Phase 2 字符串；同步断言后 core Recovery tests 7/7 通过。
2. adapter 在 build 前从旧 `@ekd/core/dist` 读取新长度常量，得到 `undefined`；改为在 adapter 内直接使用机器合同固定值 167，避免测试依赖预构建产物。随后 adapter tests 9/9 通过。

修正后的定向结果：core 17/17、crypto 11/11、adapters 9/9。全 workspace typecheck 已通过 6/6 项目。

最终统一门禁只运行一次并通过：

```text
pnpm run test:all
lint PASS
typecheck PASS（6 workspace projects）
test PASS（42/42：core 17、crypto 11、adapters 9、smoke unit tests 5）
Shared-core import gate PASS
build PASS（6 workspace projects）
```

这里的 smoke 5/5 是既有 package 单元测试，不是重跑 Windows Node/Obsidian/Android 正式环境矩阵。本轮没有运行 Phase 1 smoke harness，也没有生成 runtime smoke report。

## 5. Sol 二次复审

独立 Sol 只读复审结论为 `PASS`，无阻断项。复审逐项确认 167 字节偏移、fingerprint、HKDF、HMAC 覆盖和验证顺序正确；Web Crypto/Noble/unconfigured 接口完整；Node adapter 符合 realpath、`wx`、close-before-read；shared core 没有 Node/Electron/Obsidian/HTTP import；未实现任何禁止的 Phase 3B/4 功能；DP registry 和 ACC traceability 没有 diff。

复审提出一个非阻断测试建议：增加独立完整 167 字节 KAT，以进一步防止 encoder/decoder 同时写错 label 或覆盖区间。当前测试已经用标准 SHA-256/HMAC 向量独立验证原语，并逐字段核对偏移、覆盖所有截断长度和关键篡改变体。为遵守本项目“精简而完全、不做大量哈希和反复验证”的要求，本切片不追加由当前实现自生成的整文件 KAT；若以后引入外部权威 Recovery KAT，再作为独立证据纳管。

复审还记录两个不属于当前授权的残余文件系统问题：realpath 检查与 `open("wx")` 之间存在面对敌对本机并发目录替换时的 TOCTOU 窗口；write/sync 失败可能留下不完整文件。当前 P0 合同没有冻结目录句柄级打开或失败清理/原子发布语义，本轮不自行发明；进入正式 Recovery 生命周期编排前必须另行裁决。

## 6. 证据边界与停止点

这些结果是 dirty-source implementation review evidence，不是正式 ACC evidence。ACC-04/05/08/09/10 等恢复相关条目继续保持 `untested`；DP-007/008/010/012 保持 `open`，DP-011 保持 `conditional`。

统一门禁和 Sol 二次复审完成后停止。不得自动 commit/push，不进入 Manifest/Object AEAD、对象密钥包装、Object Envelope、ObjectStore、完整快照、fresh-process 恢复、插件产品功能或网页端工作。
