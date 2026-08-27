# P0 密码候选三环境 Smoke Test 方案

> 文档版本：v0.1
> 状态：阶段 0 工作单元 9
> 日期：2026-08-27
> 权威来源：执行计划 §8.1、§12.3

## 1. 职责

定义 P0 密码库候选的比较框架和三环境 smoke test 方案。阶段 1 依此执行 smoke test，一次只选择一个生产实现，不组合多个库拼装自创协议。

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

## 4. Smoke Test 内容

每个候选在每环境执行以下测试，使用相同固定测试向量：

| 测试项 | 验证目标 | 通过条件 |
|---|---|---|
| 随机数 | CSPRNG 产生不重复、统计不可预测字节 | 连续生成无碰撞；通过 RandomSource 端口 |
| AEAD 往返 | 加密后解密恢复明文 | 明文字节一致 |
| 篡改拒绝 | 修改密文后解密应失败 | 解密返回错误，不返回部分明文 |
| 二进制输入 | 含 0x00 字节的明文正确处理 | 二进制字节一致 |
| 初始化耗时 | 库加载和初始化时间 | 记录实际耗时，无硬阈值 |
| 内存占用 | 初始化后峰值内存 | 记录实际值，无硬阈值 |

测试向量固定并提交到 Git，确保三环境使用完全相同的输入。

## 5. 候选比较维度

除 smoke test 通过性外，还需比较：

- 随机数来源（是否依赖平台 CSPRNG）；
- AEAD 算法支持（XChaCha20-Poly1305 或 AES-256-GCM）；
- 二进制分块或流式策略（大文件处理）；
- 包体积和初始化开销；
- 测试向量可重复性；
- 维护活跃度、审计信息和供应链信息；
- 错误处理（篡改时是否抛异常而非返回脏数据）；
- 升级和协议版本固定策略。

## 6. 选择规则

1. 一次只选一个生产实现；
2. 必须三环境全部通过 smoke test；
3. 三环境均通过时，优先选择维护活跃、审计信息透明、包体积小、错误处理明确的候选；
4. 选择结果写入 ADR，附三环境测试报告和决策理由；
5. 比较候选不意味着组合多个库拼装自创协议。

## 7. Obsidian 移动端限制

Obsidian 官方说明移动端不存在 Node.js 和 Electron API。因此：

- 候选库不能假设 Node Buffer 或 Electron API 可用；
- 候选库必须能在无 Node 的浏览器环境运行；
- Web Crypto 在 Android Obsidian 中的可用性必须实测确认，不能假设支持；
- libsodium.js 的 WASM 初始化在 Android Obsidian 中的行为必须实测。

## 8. 阶段 1 交付物

- 三环境 smoke test 脚本和测试向量；
- 三环境测试报告（通过/失败/未测试）；
- 候选比较表；
- 选择 ADR（选定密码库及理由）。
