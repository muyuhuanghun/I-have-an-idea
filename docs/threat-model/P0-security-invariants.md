# P0 安全不变式与 ObjectStore 元数据边界

> 文档版本：v1.0
> 当前状态：16 个不变式的设计合同已冻结；实现和运行证据不存在
> 日期：2026-08-27
> 机器追踪：`docs/contracts/p0-traceability-v1.json`

## 1. 职责

冻结 P0 的 16 个稳定安全不变式和不可信 ObjectStore 可见性边界。任何实现或测试违反不变式时，必须停止当前阶段并保留负面证据。静态追踪闭合不等于不变式已由运行证据证明。

## 2. 安全不变式

### 2.1 加密不变式

| 编号 | 不变式 | 说明 |
|---|---|---|
| <a id="inv-01"></a>INV-01 | 正文、文件名、扩展名、路径结构、内部链接和本地修改时间在进入不可信 ObjectStore 前加密 | ObjectStore 只能看到已允许的不透明元数据和密文 |
| <a id="inv-02"></a>INV-02 | 相同明文重复加密不得产生可直接关联的相同密文对象 | 每对象独立随机密钥、nonce 和 object ID |
| <a id="inv-03"></a>INV-03 | object ID 是 16 字节随机不透明标识，禁止裸内容哈希 | ObjectStore key 是 canonical 22 字符 base64url |
| <a id="inv-04"></a>INV-04 | Manifest 和文件对象使用 AEAD；密文、tag、nonce 或 AAD 篡改必须失败关闭 | 不返回部分明文 |
| <a id="inv-05"></a>INV-05 | 域根密钥和可恢复明文的秘密材料只在授权设备产生和使用 | ObjectStore 不生成或保存恢复秘密 |

### 2.2 路径不变式

| 编号 | 不变式 | 说明 |
|---|---|---|
| <a id="inv-06"></a>INV-06 | 扫描和恢复路径始终保持在指定根目录内 | 不允许 `..`、绝对路径、ADS 或校验后逃逸 |
| <a id="inv-07"></a>INV-07 | Symlink、Junction 和其他重解析点被拒绝 | 不跟随、不读取目标、不上传、不恢复 |
| <a id="inv-08"></a>INV-08 | 恢复目标必须是新建空目录 | 非空目标在任何写入前拒绝 |
| <a id="inv-09"></a>INV-09 | 源 Vault 在扫描和快照过程中零写入 | 不创建缓存、数据库、锁或临时文件 |

### 2.3 恢复不变式

| 编号 | 不变式 | 说明 |
|---|---|---|
| <a id="inv-10"></a>INV-10 | 持有性验证必须在源进程退出后重新读取 Vault 外恢复文件 | 勾选框、未关闭句柄和内存密钥不合格 |
| <a id="inv-11"></a>INV-11 | fresh-process 恢复只凭 Recovery File 和 ObjectStore | 不依赖未声明的缓存、账号、口令或 keystore |
| <a id="inv-12"></a>INV-12 | 恢复成功必须由独立验证器核对全部受支持文件的相对路径集合和字节 | Python 验证器独立于加密核心 |
| <a id="inv-13"></a>INV-13 | 任何部分写入不能被报告为完整成功 | 失败必须有稳定错误码和部分输出清单 |

### 2.4 解析与完整性不变式

| 编号 | 不变式 | 说明 |
|---|---|---|
| <a id="inv-14"></a>INV-14 | 恢复器拒绝非空目标、路径逃逸、大小写碰撞、缺失/截断/篡改/尾随对象、错误恢复文件和不支持版本 | 缺字段也失败，不能使用默认值补齐 |
| <a id="inv-15"></a>INV-15 | 扫描中变化的文件不得进入伪一致快照 | 变化必须报告，快照不得标 complete |
| <a id="inv-16"></a>INV-16 | 未支持文件不被静默跳过 | 返回 `UNSUPPORTED_FILES_FOUND` 并阻止完成 |

所有 canonical ID 使用两位数字；`INV-1` 等旧拼写仅属于历史文本，不得进入新合同、实现、报告或证据。

## 3. ObjectStore 可见性

### 3.1 P0 允许观察

- 32 字节不透明 domain ID；
- 16 字节不透明 object ID 的 22 字符 base64url store key；
- 对象数量、单个密文对象大小和总密文字节数；
- 本地写入/读取时间；
- object/protocol/suite 版本和 nonce/ciphertext/tag 长度。

P0 不做大小、数量或访问模式隐藏。Directory ObjectStore 不定义 mutable `head`、状态序号或代际；Stage 7 网络边界由 DP-014 关闭，不能由本地证据外推。

### 3.2 P0 禁止观察

- 正文、原始文件名、扩展名、相对路径；
- Markdown 链接、frontmatter、Canvas/PDF/图片内容；
- 裸内容哈希；
- recovery root、Domain Data Root、Manifest Key、Object Wrap Key、对象密钥；
- 账号、成员、权限和配额事件（P0 不产生这些控制面字段）。

### 3.3 机器验证

ACC-32/33 必须对预置 marker 做两类检查：

1. scanner 自测能在 control artifact 中找到 marker，防止“扫描器什么都找不到”造成伪通过；
2. ObjectStore 与本次进程日志中的 forbidden marker 计数都等于 0。

Stage 7 HTTP 抓包和服务器日志不属于当前 ACC-32/33 的 P0-R1 证据。

## 4. Recovery File 诚实边界

Recovery File v1 是 bearer file，含 32 字节明文 recovery root。自派生 HMAC 提供格式自洽和损坏检测，不提供针对能读取该文件的攻击者的独立真实性或静态保密。

P0 没有 freshness anchor、latest pointer 或反回滚保证。合法旧 Recovery File 与匹配旧 ObjectStore 的整体替换不违反 INV-14，因为 INV-14 只约束给定快照的内部解析与认证。THR-04 通过 ACC-37 的声明 oracle 处置，不伪造一个 P0 无法通过的负面测试。

## 5. AI 边界

P0 运行时不得让 AI 参与随机数/密钥、加密/完整性、路径验证、恢复成功、权限或不变式判断。AI 只能用于开发辅助、合成测试数据草案或离线报告；最终 oracle 必须是确定性代码和固定合同。

## 6. 硬停止条件

发生以下任一情况必须停止当前阶段：

- 源 Vault 被修改；
- fresh-process 依赖未声明状态；
- ObjectStore 或日志出现禁止明文；
- Manifest AAD 仍需从待解密明文取得字段；
- Recovery File 仍需先解密 recovery root 才能派生其解密密钥；
- wire contract、ADR、协议、实现或 KAT 的 canonical bytes 不一致；
- schema 缺字段时仍能得到 pass/incomplete 以外的有效证据；
- 10,000 文件大 fixture 相对小 fixture 的 peak RSS 增长超过 128 MiB，或大 fixture 超过冻结 RSS 上限；
- 未支持文件静默遗漏、路径写出根目录、篡改/错密钥被当成成功。

停止后只做定位、修订合同和记录负面证据，不继续后续阶段。

## 7. 声明边界

P0 关闭报告不得宣称已实现零知识安全、GDPR 合规、独立审计、生产可用、恢复文件静态加密、完整反回滚或“当前输入是历史最新快照”。ACC-37 必须同时检查当前声明和历史结论标签。
