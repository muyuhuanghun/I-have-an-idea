# ADR-0003：共享核心与适配器端口架构

- 状态：已接受
- 日期：2026-08-27
- 决策者：开发者
- 相关文档：执行计划 §7、安全不变式 INV-09

## 背景

执行计划 §7 要求共享核心通过端口（port）与平台适配器交互，核心不得直接导入 Node fs/path、Electron、Obsidian API、Windows/Android 专属 API 或 localhost HTTP 实现。这确保同一核心能在 CLI、Obsidian 插件和未来移动端复用。

Obsidian 官方说明移动端不存在 Node.js 和 Electron API，因此核心及其依赖不能假设 Node/Electron 可用。

## 决策

### 端口定义

共享核心定义以下端口（接口），适配器提供具体实现：

| 端口 | 职责 | P0 适配器 |
|---|---|---|
| VaultSource | 只读扫描 Vault 目录，返回文件相对路径和字节流 | Node read-only Vault、Obsidian Vault |
| CryptoProvider | 提供随机数、AEAD、KDF 等密码操作 | 基于 smoke test 选定的密码库 |
| ObjectStore | 按不透明 ID 保存和读取密文对象 | Directory ObjectStore、localhost HTTP（阶段 7） |
| RandomSource | 提供 CSPRNG 字节 | Node crypto.randomBytes / Web Crypto getRandomValues |
| Clock | 提供当前时间（用于日志和报告，不用于保留倒计时） | 系统时钟 |

### 依赖方向

```text
apps/cli ─────────────┐
                      ├─► Application Core ──► Domain Core
apps/obsidian-plugin ─┘            │
                                   ├─► VaultSource port
                                   ├─► CryptoProvider port
                                   ├─► ObjectStore port
                                   ├─► RandomSource port
                                   └─► Clock port

Adapters:
  adapters/node-vault
  adapters/obsidian-vault
  adapters/directory-object-store
  adapters/http-object-store
```

### 共享核心禁止导入

packages/core 和 packages/crypto 不得直接导入：

- Node fs 或 path 模块；
- Electron API；
- Obsidian API；
- Windows 专属 API；
- Android 专属 API；
- localhost HTTP 的具体实现；
- 任何假设特定运行时（Node/Deno/浏览器）的全局对象。

### 依赖检查

通过 ESLint 规则或构建期 import 检查阻止共享核心导入禁止模块。检查在 CI 和本地 typecheck 时执行。任何禁止导入出现是硬停止条件（安全不变式 §5）。

### 仓库结构

```text
packages/
  core/           # 共享核心：端口定义、Domain Core、Application Core
  crypto/         # CryptoProvider 的核心抽象和共享密码逻辑
  adapters/
    node-vault/
    obsidian-vault/
    directory-object-store/
    http-object-store/   # 阶段 7

apps/
  cli/
  obsidian-plugin/
  mock-server/            # 阶段 7 localhost HTTP

tools/
  fixture-generator/
  python-verifier/

fixtures/
  tiny/
  edge-cases/

artifacts/                 # 不提交 Git
  generated-fixtures/
  test-reports/
  performance-reports/
```

大型 fixture 和运行报告不得提交 Git。Git 只保存生成器、固定种子、配置、摘要和小型 fixture（tiny + edge-cases 中的固定部分）。

## 后果

- 加入 HTTP ObjectStore（阶段 7）后，如果必须修改共享加密核心或恢复语义，说明端口边界失败，必须回到架构修复，不能复制一套网络版本；
- Python 独立验证器不通过端口接入核心：它直接比较恢复目录与源目录的字节，独立于加密核心实现；
- Obsidian 插件只调用共享核心，不复制密码或 Manifest 实现（执行计划 §16）。
