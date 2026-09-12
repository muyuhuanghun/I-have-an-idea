# DP-027：本机只读网页控制台范围

- 状态：**范围已由开发者确认（2026-09-11），身份/密钥/localhost 边界已按 ADR-0030 接受（2026-09-12，六项裁决）；DP-027 已随 2026-09-12 C1 轮登记入册（registry 26→27），C2 实现与 C3 正式证据另获授权**
- 编号：DP-027（已占用；2026-09-12 入册前现场检查 registry 为 DP-001..DP-026，编号无冲突）
- Owner：OWNER-PRODUCT
- 阶段：P1-alpha local operations visibility
- 依赖：ADR-0024（localhost HTTP 边界）、ADR-0026/0027（状态协议）、ADR-0029（账号不参与 E2EE 信任）、ADR-0030（已接受）、ADR-0031（实现合同 v1，已接受）
- 拟议关闭产物：网页控制台范围裁决 + web 身份/密钥/localhost 边界 ADR + 实现合同（ADR-0031）中的 threat/invariant/ACC delta + 实现与正式证据（C2/C3）

## 1. 要解决的问题

现有仓库只有 CLI 和 Obsidian 插件，没有独立 web app。用户需要一个简单页面查看本机运行状态、最近任务摘要与状态协议验证结果，但不希望第一版顺势变成可以驱动文件系统、恢复材料、设备注册或账号体系的控制平面。

本 DP 只定义第一版产品范围。它不选择前端框架，不定义 HTTP 路由，不注册机器 schema，不实现服务，也不改变任何既有 ACC、INV、THR 或 evidence。

## 2. 已确认的第一版范围

第一版是 **Windows 本机 `127.0.0.1` 只读运维状态页**。名称可以叫“网页控制台”，但产品能力只能观察，不能发出改变协议状态或磁盘内容的命令。

### 2.1 允许能力

1. 显示本地进程健康状态、产品版本、构建标识、启动时间和运行时长。
2. 面向单个、由宿主进程预先配置的本地域显示状态；第一版不枚举磁盘上的域，也不允许浏览器提交 domainId 或目录路径。
3. 显示经验证后的 head 摘要：是否存在、sequence、记录时间、签名/注册设备/回滚/分叉检查的归一化结论，以及检查时间。
4. 显示密文侧统计：对象数量、密文字节数、最近更新时间；不得把对象键或对象 ID 发送给浏览器。
5. 显示最近快照/恢复任务的只读摘要：完成或失败、开始/结束时间、耗时、文件或对象计数、字节总量、归一化错误码。
6. 显示通过既有 schema 验证的脱敏报告摘要；第一版不向页面暴露本机报告绝对路径，也不提供任意文件打开接口。

### 2.2 明确排除

第一版不得提供以下能力：

1. 创建快照、发起恢复、重试任务或终止任务；
2. 删除、移动、覆盖、上传或下载 Vault、ObjectStore、head、报告或恢复产物；
3. 修改 latest head、`devices.json`、history journal 或任何权威状态；
4. 注册、撤销、批准或迁移设备；
5. 登录、注册账号、Passkey/WebAuthn、2FA、账号恢复或账号删除；
6. 导入、导出、生成、解封或恢复 domain key、设备私钥、Recovery File 材料或一次性账号恢复码；
7. 读取或显示 Vault 正文、文件名、扩展名、相对路径、绝对路径或内容片段；
8. 监听局域网、公网或 `0.0.0.0`；
9. 让普通浏览器会话成为 trusted device，或赋予它 `devices` 写入权、head 签名权；
10. 把页面摘要称为正式 ACC evidence、安全审计、生产监控或远程管理能力。

## 3. 数据来源边界

网页控制台只能消费宿主侧显式配置且经过专用读取适配器处理的数据：

1. 已通过现有 schema 校验的 `p0-plugin-snapshot-report-v1`、`snapshot-log-v1` 或 `p0-roundtrip-report-v1` 中的允许字段；v1 落地形态：报告摘要只取本会话内宿主自己产生、已验证报告的内存摘要（ADR-0030 §7.0），控制台服务不新增磁盘报告读取；
2. 由既有状态协议验证原语计算出的 head 结论；不得在 UI 层直接解析 pointer、head wire 或 `devices.json` 后自行推断“有效”；
3. ObjectStore 适配器返回的聚合计数；不得把原始对象键、对象内容或目录列表原样传给浏览器；
4. 进程自身的版本、启动时间与健康检查结果。

浏览器请求不得携带本机文件路径、domainId、ObjectStore key 或报告路径。数据源缺失、schema 不匹配、验证失败或新鲜度未知时，页面必须显示 `unknown` / `unavailable` / 明确错误，不能退化成解析原始 JSON 后显示绿色状态。

## 4. 页面最小信息结构

| 区域 | 第一版字段 | 禁止混入 |
| --- | --- | --- |
| 服务 | status、version、build、started_at、uptime | 环境变量、命令行、用户名、主机目录 |
| Head | present、sequence、created_at、verification verdict、checked_at | domainId、domain hash、device ID、公钥、签名、head/object key |
| 存储 | object_count、total_ciphertext_bytes、observed_at | 对象键、对象内容、目录路径 |
| 最近任务 | kind、status、started_at、completed_at、duration、计数、字节总量、error_code | Vault 路径、文件名、Recovery File 路径、原始异常栈 |
| 报告摘要 | schema_version、verdict、时间、允许的聚合统计 | 报告绝对路径、raw JSON、正式 evidence 身份冒充 |

第一版不冻结视觉布局。页面可以只有一页，不需要路由、账号页、设置页或操作按钮。

## 5. 硬停止

> C2 实现切片另获授权前，不得创建 web app 或本地 web 服务，不得新增任何写操作，不得让浏览器接触 domain key、设备私钥、Recovery File、账号恢复码、原始路径或 E2EE 授权能力，也不得声称网页控制台已实现、可远程使用或属于可信设备。范围与边界裁决（本文件 + ADR-0030）不构成实现授权。

## 6. 关闭条件

DP-027 只能在以下事项全部完成后关闭：

1. 产品 owner 接受本范围，明确第一版是单域、localhost、只读状态页；
2. ADR-0030 解决会话引导、Host/Origin/DNS rebinding、CORS、缓存、密钥隔离与 Windows 路径读取边界；
3. 后续实现合同冻结允许字段 DTO、数据源、新鲜度语义、HTTP surface 与错误语义；
4. threat/invariant/ACC 候选经评审后进入正式 registry，并有对应负向测试计划；
5. 实现与正式证据另获授权并通过；普通单元测试或页面截图本身不能关闭本 DP。

## 7. 原未决项 → 2026-09-12 裁决记录

草案阶段留白的五个问题已随 ADR-0030 六项裁决全部落定：

1. 会话 bootstrap → **同源自举 fetch**：token 只经同源 JSON 响应体进入页面易失内存，`Sec-Fetch-Site ∈ {same-origin, none}`，无 Cookie/URL/持久化（ADR-0030 §3.4）；
2. 宿主数据源选择与物理路径越界 → **会话域派生、零新增配置**：v1 控制台不新增磁盘读取路径，报告摘要取会话内存副本，head/存储只走既有原语与适配器（ADR-0030 §7.0）；
3. “最近任务”保留窗口 → **内存 ring buffer 20 条，重启清空，不回填**（ADR-0030 §5.3）；
4. `file_count`/`total_plaintext_bytes` 敏感元数据 → **v1 DTO 不投影**（ADR-0030 §5.1）；
5. DTO/schema、HTTP 路由、打包方式与浏览器兼容范围 → 冻结在实现合同 **ADR-0031（草案）**，随其接受与 C2 落库生效。

## 8. 入册记录

本文件是 DP-027 的范围记录。2026-09-12 C1 轮已完成正式入册：`docs/contracts/p0-deferred-parameters.json` 追加 DP-027（status `deferred`，registry 26→27），`tools/verify_phase0_contracts.py` 期望计数同步（两处），状态文档（README、执行计划、一致性检查）同轮对账，未出现“文档声称 DP-027 存在、机器门仍只认识 26 项”的分裂状态。WEB-* threat/invariant/ACC 候选仍留在 ADR-0030 §8/§9 与 ADR-0031 §9，随 C2 实现 commit 落库正式 registry。
