# Phase 3B Object / Manifest 纯内存加密复审报告

> 日期：2026-08-30  
> 状态：授权切片实现完成，Sol 二次复审 PASS；未提交、未推送  
> 基线：`454afddaa9f4d76ac05a2c8fd38f9c9ebd3a45c8`

## 1. 授权范围

本轮只实施：

- Domain Data Root、Manifest Key、Object Wrap Key 三条冻结 HKDF；
- 16 字节随机 object ID 与 canonical 22 字符无 padding base64url 编解码；
- 12 字节随机 nonce 和 32 字节随机文件 object key；
- AES-256-KW 对象密钥包装/解包；
- 101 字节 Object AAD v1；
- 19 字节 header 的 Object Envelope v1；
- 文件对象和 Manifest 的纯内存 AES-256-GCM seal/open；
- 对应单元测试和 dirty-source review evidence。

明确不实施 Directory/HTTP ObjectStore、扫描到加密的完整 pipeline、完整快照、Recovery/Manifest 落盘联动、服务器可见性报告、fresh-process 恢复、插件产品功能、网页端和 Phase 3C/4 以后内容。本轮不修改 DP 状态、不生成 `acc-evidence-v1`、不升级任何 ACC。

## 2. 实现

### 2.1 冻结密钥派生

`packages/core/src/keys.ts` 逐字节使用 ADR-0011 的 ASCII info：

| 输出 | IKM | salt | info | 长度 |
|---|---|---|---|---:|
| Domain Data Root | recovery root | domain ID | `ekd-v1/domain-data-root` | 32 |
| Manifest Key | Domain Data Root | domain ID | `ekd-v1/manifest-key` | 32 |
| Object Wrap Key | Domain Data Root | domain ID | `ekd-v1/object-wrap-key` | 32 |

没有新增派生层级、salt、标签、fallback 或算法。测试向量由 Python 标准库 `hashlib`/`hmac` 独立计算，再由 Web Crypto provider 复现。

### 2.2 Object ID 与碰撞边界

`generateObjectIdV1` 只从 `RandomSource` 请求 16 字节，拒绝异常、短读和全零。`encodeObjectStoreKeyV1`/`decodeObjectStoreKeyV1` 实现固定 22 字符 RFC 4648 base64url，无 padding；decoder 重新编码核对 canonical tail bits，并可与调用方期望的 raw ID 做固定长度比较。

object ID 生成与 `seal*` 明确分离。未来编排层必须先检查 ObjectStore 是否已存在相同 ID；碰撞时重新生成 ID，再调用 seal 生成新的 nonce 和密文。本切片没有 ObjectStore，因而不伪造存在性检查、重试上限或全局碰撞 registry。

### 2.3 AAD 与 Envelope

Object AAD 固定 101 字节：`EKDA`、AAD/object/protocol version、suite、object type、domain ID、object ID、snapshot ID、nonce/ciphertext/tag length。Object Envelope 固定 19 字节公开 header：`EKDO`、object/protocol version、suite、u16be nonce length、u64be ciphertext length、u16be tag length，随后是 nonce/ciphertext/tag。

Suite 1 固定 nonce 12 字节、tag 16 字节；parser 不信任对象自报长度。总长度短于声明返回 `OBJECT_TRUNCATED`，长于声明返回 `OBJECT_TRAILING_BYTES`；magic/version/suite/object type 或 suite 长度不一致返回 `OBJECT_AAD_MISMATCH`。AAD 与 envelope codec 都不导入 Node、Electron、Obsidian 或 ObjectStore。

### 2.4 文件对象

调用方提供已经过未来碰撞检查的 object ID、domain/snapshot ID、plaintext 和 Object Wrap Key。`sealFileObjectV1` 生成独立 32 字节 object key 与 12 字节 nonce，用 AES-256-KW 产生固定 40 字节 wrapped key，再以完整 101 字节 AAD 执行 AES-256-GCM，返回 envelope、wrapped key 和 plaintext size。核心接管 RandomSource 返回的临时 object-key buffer，并在成功或失败后清零同一块内存。

`openFileObjectV1` 解包 key、从 envelope header 重建 AAD、认证解密，并把输出长度与已认证 Manifest entry 的 expected plaintext size 比较。wrong context、nonce/ciphertext/tag 篡改不会返回部分 plaintext；wrapped-key 篡改由 AES-KW integrity 拒绝，核心边界的顶层规范错误码统一为冻结 registry 已有的 `OBJECT_AEAD_FAILED`。

### 2.5 Manifest 对象

Manifest 使用由 Domain Data Root 派生的 Manifest Key，不做 key wrapping。`sealManifestObjectV1` 复用既有 canonical Manifest plaintext encoder，并在加密前要求 plaintext 的 domain/snapshot/suite 与 AAD context 一致。`openManifestObjectV1` 使用 `object_type=manifest` 重建 AAD，AEAD 失败统一为 `MANIFEST_AEAD_FAILED`；认证成功后调用既有严格 Manifest decoder，并再次核对身份字段。

## 3. 测试范围

core byte-codec 测试覆盖：

- raw ID `00..0f` 的固定 22 字符 canonical base64url；
- padding、错误长度、非 canonical tail bits 和 wrong-ID substitution；
- RandomSource 异常、短读和全零；
- 101 字节 AAD 的每个字段、端序、file/manifest type 和非法固定字段；
- 19 字节 envelope header、nonce/ciphertext/tag roundtrip；
- envelope 的每个截断长度、尾随字节和非法固定字段。

crypto integration 测试覆盖：

- 三条 HKDF 的独立 byte-exact 输出；
- 空文件 object key wrap、seal、open 和 size check；
- RandomSource 返回的原始 object-key buffer 被原位清零；
- nonce/ciphertext/tag、AAD context 与 wrapped key 篡改拒绝；
- 相同明文在 fresh ID/key/nonce 下产生不同 envelope 和 wrapped key；
- Canonical Manifest seal/open、tag 篡改、wrong snapshot 和 plaintext/AAD identity mismatch。

## 4. 真实失败与修正历史

本轮保留以下真实问题和审查修正：

1. 新 integration test 的绝对路径把 Windows 用户名少写一个字母，文件被创建在工作区外的 `C:\Users\muyuhanghun\...`。发现后核对精确源/目标路径，将唯一文件移回当前仓库，并逐层删除本次错误产生的空目录；没有触碰其他数据。
2. 首次独立 HKDF 预计算命令把 expand counter `0x01` 写成了转义文本，导致测试期望值错误；core 25/25 和其余 crypto 16/16 当时已通过。改用 `bytes([1])` 重新通过 Python 标准库计算，得到与 Web Crypto 一致的三条输出后，只修正测试向量，crypto 17/17 通过，未修改实现迎合错误 expected bytes。
3. 首次统一门禁在 lint 阶段因 object ID 负面测试保留了未使用局部变量而停止，未进入 typecheck/test/build。删除该变量后只重跑统一门禁一次，完整通过。
4. Sol 初审发现 `randomBytesExact` 复制了 object key，导致清零的不是 RandomSource 持有的原 buffer；同时 `openFileObjectV1` 会把 provider 内部 `OBJECT_KEY_UNWRAP_FAILED` 泄漏为公共错误码。修正为由核心接管并原位清零该 buffer，并把 unwrap 失败收敛为既有 `OBJECT_AEAD_FAILED`；另同步 Phase 3A 已提交和 Phase 3C/4+ 未授权的文档措辞。修正后的定向测试为 core 25/25、crypto 18/18。

## 5. 当前验证结果

Sol 初审修正后的定向结果：core 25/25、crypto 18/18。Sol 对修正做定向二次复核，结论为 PASS、无阻断项。之后运行一次最终统一门禁：

```text
pnpm run test:all
lint PASS
typecheck PASS（6 workspace projects）
test PASS（57/57：core 25、crypto 18、adapters 9、smoke unit tests 5）
Shared-core import gate PASS
build PASS（6 workspace projects）
```

这里的 smoke 5/5 是既有 package 单元测试，不是 Windows Node/Obsidian/Android 正式矩阵。本轮没有运行 Phase 1 smoke harness，也没有生成 runtime smoke report。

## 6. 证据边界与停止点

这些结果是 dirty-source implementation review evidence，不是正式 ACC evidence。DP-007/008/010/012 保持 `open`，DP-011 保持 `conditional`，37 个 ACC 全部保持 `untested`。本切片没有声称 object ID 全局碰撞已处理、内存有界、ObjectStore 可用、快照完成或恢复可执行。

Phase 3B 已到授权停止点。不得自动 commit/push，不进入 ObjectStore、pipeline、快照、恢复、插件或网页端工作。
