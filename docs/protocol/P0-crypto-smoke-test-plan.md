# P0 密码候选三环境 Smoke Test 方案

> 文档版本：v0.3
> 状态：方案草案；尚未执行，环境清单、锁文件、测试向量与报告均不存在
> 日期：2026-08-27
> 权威来源：执行计划 §8.1、§12.3

## 1. 职责

定义 P0 密码库候选的比较框架、三环境 smoke test 方案和最低执行条件。本文是待实现、待实测的计划，不是候选库兼容性或安全性证据。只有 Phase 0 门禁重新关闭并另行授权后，才可进入工程实现和三环境实测；一次只选择一个生产实现，不组合多个库拼装自创协议。

## 2. 候选路径

至少比较以下两条路径，可加入第三候选：

| 候选 | 性质 | 官方资料 |
|---|---|---|
| Web Crypto SubtleCrypto | 平台低层密码 API，部分算法支持因环境而异 | MDN SubtleCrypto 文档 |
| libsodium-wrappers | WebAssembly/纯 JS 的 libsodium 封装，支持浏览器与服务端 | github.com/jedisct1/libsodium.js |
| @noble/ciphers（可选第三候选） | 无运行时依赖的 TS/JS 实现，但 JIT 环境存在常数时间限制 | github.com/paulmillr/noble-ciphers |

## 3. 三环境

每个候选至少在以下三个环境执行相同小测试向量：

1. Windows Node/CLI；
2. Windows Obsidian（Electron 渲染进程）；
3. 真实 Android Obsidian（非模拟器）。

任何候选只在前两种环境通过，都不能成为 P0 默认实现。不依赖"应该可用"或未核实运行时标签，直接在真实 Android Obsidian 测试（执行计划 §22 R8）。

## 4. 具体执行条件

### 4.1 环境前置条件

| 环境 | 前置条件 | 验证方式 |
|---|---|---|
| Windows Node/CLI | 每轮运行前冻结 Node.js、pnpm、候选包和构建配置的精确版本 | 报告绑定版本、lockfile hash、source commit 和 CLI bundle hash |
| Windows Obsidian | 每轮运行前冻结 Obsidian、Electron、候选包和测试插件精确版本 | 报告绑定版本、source commit、vector manifest hash 和 plugin bundle hash |
| Android Obsidian | 真实 Android 设备（非模拟器）；每轮冻结 Obsidian、Android、设备型号/架构和测试插件版本 | 设备内导出签名 JSON，桌面归档时校验 run ID、vector/plugin hash，不以截图替代机器结果 |

每次运行还必须生成不可变环境清单，至少记录：候选包精确版本、包管理器锁文件哈希、Node/Obsidian/Android 精确版本、OS 与设备型号、构建器及其版本、测试插件产物哈希、运行时间和报告 schema 版本。没有环境清单的结果只能作为调试记录，不能作为选型证据。

测试矩阵的主键是 `candidate × algorithm_suite × environment`。不同候选若不支持同一算法套件，不得把不同算法的结果合并成一次“同向通过”；每个 suite 必须分别冻结 key/nonce/tag 长度、AAD 编码和向量集合，再比较跨环境结果。

### 4.2 测试向量与随机路径分离

- 测试向量以固定二进制和文本文件提交到 Git，路径：`fixtures/crypto-vectors/`
- 三环境读取同一组向量文件，不通过代码内联定义
- 算法级已知答案测试（KAT）必须固定算法、密钥、nonce、AAD、明文、预期密文和认证标签；三环境逐字节比较同一预期输出
- 生产随机路径另做往返测试：nonce/对象密钥来自待验证的 `RandomSource`，此路径只验证来源、长度、错误处理、往返和篡改拒绝，不与固定 KAT 混为一谈
- 如测试需要确定性随机源，必须明确标记为仅测试注入，生产构建不得引用或回退到该实现

### 4.3 执行步骤

每个候选 × 每个环境的执行流程：

```text
1. 记录并哈希环境清单、锁文件和测试插件产物
2. 加载候选库，记录初始化耗时和结构化错误
3. 验证 CSPRNG 路径：来源声明、32 字节长度、短读/失败传播、全零输出拒绝和生产代码禁止 Math.random
4. 执行算法级 AEAD KAT：固定 key/nonce/AAD/plaintext，逐字节比较 ciphertext/tag
5. 执行生产随机路径 AEAD 往返并比较明文字节
6. 执行负面测试：分别篡改 ciphertext、tag、nonce 和 AAD，验证失败且不返回部分明文
7. 执行 HKDF 域隔离：不同 info/salt 产生不同用途密钥，并核对固定向量
8. 执行候选对象密钥 wrap/unwrap 及错误包装材料拒绝
9. 执行恢复文件完整性候选和 Manifest 定位/解密候选；未冻结方案只能记录为未测试
10. 执行含 0x00 和空输入的二进制边界测试
11. 记录峰值内存和总耗时
12. 输出 JSON 报告到 artifacts/test-reports/crypto-smoke/{candidate}/{suite}/{env}.json
```

JSON schema 至少包含：`run_id`、`git_commit`、candidate/suite/environment ID、精确版本、dependency lock/vector/environment/bundle hash、逐向量状态、规范化错误码、退出状态、耗时/RSS、原始产物 hash 和总裁决。Android 导出报告必须与同一次安装包和向量 hash 绑定。

### 4.4 通过条件判定

| 测试项 | 通过判定 | 失败判定 |
|---|---|---|
| 库加载 | 无报错且初始化完成 | 加载抛异常或超时 |
| 随机数路径 | 使用经核实的平台 CSPRNG；长度正确；短读、失败和全零输出均失败关闭；生产代码无 Math.random 回退 | 来源无法核实、长度错误、错误被吞掉或存在非 CSPRNG 回退 |
| AEAD KAT | ciphertext/tag 与固定官方或交叉实现向量逐字节一致 | 任一字节不一致 |
| AEAD 往返 | 解密明文与原始明文字节一致 | 字节不一致 |
| 篡改拒绝 | ciphertext、tag、nonce、AAD 任一篡改均返回结构化错误且不返回部分明文 | 返回脏数据、无错误或错误不可区分 |
| HKDF/包装 | 固定向量通过、用途标签隔离、错误包装材料被拒绝 | 向量不一致、用途密钥相同或错误材料被接受 |
| 二进制输入 | 解密字节含 0x00 正确恢复 | 二进制丢失或截断 |
| 耗时和内存 | 记录实际值（无硬阈值） | 未记录或测量失败 |

### 4.5 排除条件

出现以下情况，候选在该环境直接判定为失败，不继续后续测试：

- 库无法在该环境加载或导入；
- 库依赖 Node Buffer、Electron API 或其他该环境不可用的全局对象；
- 随机数来源为 Math.random 或其他非 CSPRNG；
- AEAD 操作返回脏数据而非抛异常。

## 5. Smoke Test 内容

每个候选在每环境执行以下测试，使用相同固定测试向量：

| 测试项 | 验证目标 | 通过条件 |
|---|---|---|
| 随机数 | 生产路径确实调用可核实的平台 CSPRNG 并正确传播错误 | 来源可追溯；长度/失败/全零测试通过；1000 次无碰撞仅作异常侦测，不构成“不可预测性证明” |
| AEAD KAT | 跨环境实现与固定向量一致 | ciphertext/tag 逐字节一致 |
| AEAD 往返 | 加密后解密恢复明文 | 明文字节一致 |
| 篡改拒绝 | 修改 ciphertext/tag/nonce/AAD 后解密应失败 | 解密返回结构化错误，不返回部分明文 |
| KDF 与密钥包装 | 用途隔离、固定派生和错误材料拒绝 | 固定向量一致且负面测试全部失败关闭 |
| 二进制输入 | 含 0x00 字节的明文正确处理 | 二进制字节一致 |
| 初始化耗时 | 库加载和初始化时间 | 记录实际耗时，无硬阈值 |
| 内存占用 | 初始化后峰值内存 | 记录实际值，无硬阈值 |

## 6. 候选比较维度

除 smoke test 通过性外，还需比较：

- 随机数来源（是否依赖平台 CSPRNG）；
- AEAD 算法支持（XChaCha20-Poly1305 或 AES-256-GCM）；
- 二进制分块或流式策略（大文件处理）；
- 包体积和初始化开销；
- 测试向量可重复性；
- 维护活跃度、审计信息和供应链信息；
- 错误处理（篡改时是否抛异常而非返回脏数据）；
- 升级和协议版本固定策略。

## 7. 选择规则

1. 一次只选一个生产实现；
2. 必须三环境全部通过 smoke test；
3. 三环境均通过时，优先选择维护活跃、审计信息透明、包体积小、错误处理明确的候选；
4. 选择结果写入 ADR，附三环境测试报告和决策理由；
5. 比较候选不意味着组合多个库拼装自创协议。

当前三环境测试均为 **untested**。在真实 Android Obsidian 报告、环境清单和可复现向量齐备前，不得把任何候选写成默认实现。

## 8. Obsidian 移动端限制

Obsidian 官方说明移动端不存在 Node.js 和 Electron API。因此：

- 候选库不能假设 Node Buffer 或 Electron API 可用；
- 候选库必须能在无 Node 的浏览器环境运行；
- Web Crypto 在 Android Obsidian 中的可用性必须实测确认，不能假设支持；
- libsodium.js 的 WASM 初始化在 Android Obsidian 中的行为必须实测。

## 9. 后续获授权执行时的交付物

- 三环境 smoke test 脚本和测试向量（提交 Git）；
- 精确依赖锁文件、每环境清单及产物哈希；
- 算法级 KAT（含预期 ciphertext/tag）和生产随机路径负面测试；
- 三环境测试报告（通过/失败/未测试，存 artifacts/ 不提交 Git）；
- 候选比较表；
- 选择 ADR（选定密码库及理由）。
