# ADR-0030：P1 本机只读网页控制台身份、密钥与 localhost 边界 v1

- 状态：**已接受（2026-09-12）——开发者以六项裁决（§10）确认本边界与切片划分；本 ADR 只裁决边界，不授权 C2 实现切片**
- 日期：2026-09-11（草案）；2026-09-12（接受）
- 阶段：P1-alpha local operations visibility（DP-027）
- 决策者：开发者（OWNER-PRODUCT 与 OWNER-SECURITY 当前由项目开发者承担；安全边界已随六项裁决一并确认）
- 相关文档：DP-027 范围记录、ADR-0031 实现合同 v1（草案）、ADR-0009（Windows 路径）、ADR-0024（localhost HTTP ObjectStore）、ADR-0026/0027（head 状态协议）、ADR-0029（账号与 E2EE 信任分离）

## 1. 背景与裁决目标

开发者确认第一版采用 Windows 本机 `127.0.0.1` 只读状态页，不做公网网站、账号入口、完整网页客户端或可信设备。本 ADR 负责把“localhost”“只读”“不接触密钥”写成可测试边界，防止后续实现把状态页悄悄扩成文件系统和 E2EE 控制平面。

本 ADR 是边界裁决。当前没有 web app、web server、网页 DTO/schema、浏览器测试或网页产品 evidence；实现（C2 切片）另获授权。本 ADR 不新增依赖、代码或正式 registry 的 INV/ACC/THR 项——WEB-* 候选随 C2 实现 commit 落库（§8/§9/ADR-0031 §9）。

## 2. 信任模型

### 2.1 浏览器不是可信设备

1. 浏览器页面只是显示端，不持有设备私钥，不签署 head，不写 `devices.json`，不批准新设备。
2. 页面会话不等于 ADR-0029 的托管账号会话，更不等于 E2EE 设备信任。
3. 本机 web 会话凭据不得复用账号密码、Passkey、一次性账号恢复码、domain key、Recovery File 密钥或设备密钥。
4. 即使页面成功读取状态，也不能据此声称浏览器已完成正式设备注册。

### 2.2 宿主状态服务是只读适配器边界

1. 未来宿主服务只能读取显式配置的数据源，经验证和投影后返回固定白名单 DTO。
2. 它不得接受浏览器提供的路径、domainId、对象键、设备 ID、报告文件名或任意查询表达式。
3. 它不得加载、生成或调用 domain key、设备私钥、Recovery File 材料和账号恢复码。
4. head 状态只能来自既有验证原语或后续正式定义的只读组合适配器；不得通过 `JSON.parse` pointer/devices 文件后自行判定“签名有效”。
5. 它不得复用 ADR-0024 的 ObjectStore bearer token 作为网页会话 token。两个 token 的权限、生命周期和泄露面不同，必须分域。

### 2.3 localhost 不是安全结论

绑定 loopback 只阻止直接的外部网卡监听，不自动阻止恶意本地网页、DNS rebinding、同机其他进程、浏览器扩展或已入侵宿主机。第一版必须缓解浏览器跨站与错误监听风险，但不宣称能抵御已控制本机用户会话或内核的攻击者。

## 3. 网络与会话边界

### 3.1 监听和 origin

1. 第一版只允许绑定 IPv4 `127.0.0.1` 和操作系统分配的临时端口；不得绑定 `0.0.0.0`、LAN 地址、公网地址或把 `localhost` 自动解析结果当作等价替代。
2. 服务只接受精确匹配 `127.0.0.1:<实际端口>` 的 `Host`；未知 Host、绝对形式 URL、代理转发头或重写后的 authority 一律拒绝。
3. 状态 API 只接受同源请求。必须校验 `Origin`；实现合同冻结的 Fetch Metadata 校验（§3.4）取代“无 Origin 即可疑”的模糊地带，但不降低要求。
4. 不开放 CORS，不返回 `Access-Control-Allow-Origin: *`，不支持 JSONP、WebSocket、Server-Sent Events 或跨源嵌入。
5. 非法 Host/Origin/会话凭据必须在读取任何配置文件、报告、head 或 ObjectStore 前失败关闭。

### 3.2 只读 HTTP surface

1. 未来 surface 只允许获取静态页面与白名单状态 DTO；具体路由由 ADR-0031 冻结。
2. 不得存在 snapshot、restore、retry、delete、upload、download、enroll、revoke、approve、login、recovery、key、head publish 等动作路由。
3. 对状态 API 的 `POST`、`PUT`、`PATCH`、`DELETE` 必须返回 405；查询参数不能改变磁盘或协议状态。
4. 请求处理不得创建、覆盖、追加、触碰或修复报告、head、history、devices、ObjectStore、Vault 或 Recovery File。
5. “打开报告”不在第一版：页面既不能接收任意路径，也不能要求宿主 shell 打开浏览器传来的路径。

### 3.3 会话能力

会话能力 token 必须同时满足：

1. 每次进程启动独立生成，至少 256 bit CSPRNG 熵；服务停止立即失效；
2. 与 ADR-0024 ObjectStore token、账号会话、恢复码及所有密码材料分域；
3. 不出现在 URL path/query、HTML、日志、错误、Referrer、进程标题、持久化配置、`localStorage`、`sessionStorage`、IndexedDB 或 Service Worker cache；
4. 只保存在宿主和页面易失内存中，比较时采用恒定时间语义；
5. 未授权请求与已授权请求不应通过错误正文泄露数据源是否存在；
6. 页面刷新、第二标签页和浏览器重启时的行为由 §3.4 明确，不靠隐式 token 复制。

### 3.4 会话自举渠道（2026-09-12 裁决：同源自举 fetch）

1. 首屏 HTML 不含任何秘密。页面脚本加载后对同源 bootstrap 端点发起 fetch；token 只能出现在该端点的 JSON 响应体中，并且只进入页面易失内存（JS 变量），不得写入 DOM、HTML 属性或任何持久化位置。
2. 包括 bootstrap 端点在内的所有端点统一要求：`Host` 精确匹配（§3.1.2）**且** `Sec-Fetch-Site ∈ {same-origin, none}`。`same-site` 与 `cross-site` 一律拒绝——DNS rebinding 生效后的请求对浏览器呈现为 same-site，因此 same-site 不能放行。Fetch Metadata header 是浏览器强制注入的 forbidden header（JS 不可伪造），HTTP `127.0.0.1` 属于 secure context，现代浏览器必然携带；不支持这些 header 的引擎按失败关闭处理，不做 fallback（兼容范围见 ADR-0031）。
3. 后续 API 请求以自定义 header 携带 token，宿主按 §3.3.4 恒定时间比较；未授权/校验失败统一返回不区分原因的通用 403，且在任何数据源读取之前失败关闭。
4. token 为进程级：宿主启动时生成，仅存宿主内存；页面刷新、第二标签页和浏览器重启都通过重新执行 §3.4.1 的同源自举取得同一进程 token，不引入 Cookie 或其他浏览器存储。
5. bootstrap 响应必须 `Cache-Control: no-store`；token 不得进入 §3.3.3 列出的任何位置（JSON 响应体不是 HTML，且 no-store 排除缓存驻留）。
6. 宿主可以经 shell 打开 `http://127.0.0.1:<port>/`（URL 不含 token）帮助用户进入页面。

## 4. 浏览器响应安全基线

未来实现至少需要冻结并测试以下响应策略：

1. `Cache-Control: no-store`；
2. `Referrer-Policy: no-referrer`；
3. `X-Content-Type-Options: nosniff`；
4. CSP 至少约束为同源脚本/连接，禁用对象、frame ancestor、base 改写和表单提交；不得依赖任意内联脚本或远程 CDN；
5. 禁止 Service Worker、离线缓存和第三方分析/字体/脚本；
6. 页面不得被 iframe 嵌入；
7. DTO 和错误响应使用固定 content type，不反射请求 header、URL 或本机路径。

精确 header 字节和 CSP 文本由 ADR-0031 冻结。

## 5. 数据最小化与 DTO 白名单

### 5.1 可以投影给页面的字段

| 类别 | 允许字段 | 事实来源 |
| --- | --- | --- |
| 服务 | status、version、build、started_at、uptime | 当前宿主进程 |
| Head | present、sequence、created_at、verification verdict、checked_at | 既有 head 验证原语的只读组合结果 |
| 存储 | object_count、total_ciphertext_bytes、observed_at | ObjectStore 聚合适配器或已验证报告 |
| 任务 | kind、status、started_at、completed_at、duration、对象计数与密文字节、归一化 error_code | §5.3 任务窗口的会话内存摘要 |
| 报告 | schema_version、verdict、时间与允许的聚合统计 | §7.0 会话内已验证报告的内存摘要 |

**2026-09-12 裁决（Q2=C）**：`file_count`、`total_plaintext_bytes` 及同类本地敏感元数据**不进入 v1 DTO 白名单**（任务与报告条目中的“计数/字节”仅指对象计数与密文字节）。未来引入必须先修订本 ADR 与 ADR-0031，不得以“页面没显示”代替“网络响应没发送”。

### 5.2 绝不发送给浏览器的字段

1. domainId、domain hash、snapshot ID、run ID、ObjectStore key/object ID；
2. device ID、公钥、签名、pointer 原文、head wire、`devices.json`、history journal 原文；
3. Vault 正文、文件名、扩展名、相对/绝对路径和内容片段；
4. 用户名、主机名、环境变量、命令行参数、堆栈、任意本机目录列表；
5. Recovery File 内容或路径、domain key、设备私钥、Passkey 材料、账号恢复码；
6. 网页会话 token、ADR-0024 ObjectStore token 或任何认证 header；
7. 未经 schema 验证的 raw JSON、raw log 或 arbitrary diagnostic object。

白名单投影必须显式构造新 DTO，不能用对象展开、序列化原始异常、返回源对象后在前端隐藏字段，也不能把“页面没显示”误当成“网络响应没发送”。

### 5.3 任务窗口（2026-09-12 裁决：会话内存 ring buffer）

1. “最近任务”是宿主进程内存中的 FIFO ring buffer，容量 20 条；不持久化、不从磁盘日志回填。
2. 进程重启即清空；页面必须如实显示“进程已重启，暂无任务历史”，不得把空窗口伪装成“一切正常”或回读旧数据。
3. 任务条目字段以 §5.1 任务行为准。

## 6. Head 与健康状态的诚实语义

1. `healthy` 不能仅凭文件存在、JSON 可解析或 HTTP 200 得出。
2. head 摘要只有在既有签名与设备注册检查成功、sequence 与 pointer 一致、所需回滚/分叉检查得到明确结论后才能显示 `verified`。
3. 如果当前实现原语没有证明完整 parent 链或新鲜度，页面必须分别显示 `not_checked` / `unknown`，不得合并成绿色总状态。
4. 数据源缺失、schema 版本未知、签名错误、设备未注册、回滚、分叉、路径越界或读取失败必须保留不同的归一化结果；不得 fallback 到原始内容展示。
5. 页面展示的 `checked_at` 是本次检查时间，不是 head 或报告的可信新鲜度证明。
6. 在 ADR-0031 冻结时限前，不设置任意“超过 N 分钟变黄/红”的阈值，也不把旧报告自动称为 current。
7. **2026-09-12 裁决（Q5=A）**：DTO 不包含聚合 `overall` 字段；每个检查独立携带 verdict 与 `checked_at`。“总状态”只允许作为前端展示规则（verified=正常、unknown=灰、failed=红）冻结在 ADR-0031，协议层不做 worst-of 聚合，任何聚合都不得把 unknown 合并成绿色。

## 7. Windows 文件读取边界

### 7.0 数据源配置（2026-09-12 裁决：会话域派生，零新增配置）

1. v1 数据源完全派生自宿主进程的当前会话域：服务状态与任务/报告摘要来自宿主内存中的会话状态，head 结论经既有验证原语（只读组合），存储统计经 ObjectStore 聚合适配器；不存在“控制台选择域或路径”的入口。
2. v1 控制台服务**不新增磁盘读取路径**：报告摘要只取本会话内宿主自己产生、已通过 schema 验证的报告的内存摘要；§5.3 的任务窗口不回读磁盘日志。
3. 因此 v1 没有“允许读取的固定文件集合”清单需要冻结；§7.1–7.6 的物理路径纪律继续约束宿主既有的 head/ObjectStore 读取（ADR-0009 已覆盖）。未来若引入磁盘报告读取，必须先修订本节并补齐相应边界与负向测试。

### 7.1–7.6（路径身份与读取纪律，约束宿主既有读取）

1. 数据源路径只能由宿主启动配置提供，浏览器不能选择或拼接路径；
2. 必须沿用 ADR-0009/Phase 5-A 的物理路径身份检查，覆盖 realpath、ancestor Junction/symlink/reparse point、8.3 短路径和不存在末端的真实父目录；
3. 只允许读取明确配置的单个文件或根目录下的已知固定文件名，禁止 glob 任意 JSON、目录遍历和跟随链接；
4. 报告读取需先限定最大字节数，再按精确 schema 校验；未知 schema 或额外字段失败关闭；
5. 检查与读取之间发生替换、大小或时间戳变化时失败关闭，不继续返回旧的绿色摘要；
6. 读取错误只返回归一化错误码，原始路径和系统异常仅能留在不含秘密的本地诊断边界，不能进入网页响应。

## 8. 威胁与不变式候选

以下候选随 C2 实现 commit 落库正式 registry；正式编号（INV/THR/ACC 连续尾号）在落库时按当时 registry 尾号分配，映射关系由 ADR-0031 §9 冻结。

### 8.1 威胁候选

- **WEB-THR-01**：恶意网页、DNS rebinding 或跨源请求读取 localhost 状态；
- **WEB-THR-02**：会话能力经 URL、日志、缓存、Referrer 或浏览器持久化泄露；
- **WEB-THR-03**：raw DTO、异常或报告投影泄露路径、标识符、密钥或正文；
- **WEB-THR-04**：状态页成为 confused deputy，触发快照、恢复、删除、设备或 head 写入；
- **WEB-THR-05**：陈旧、未验证或部分验证状态被显示成绿色；
- **WEB-THR-06**：Windows Junction/symlink/8.3 别名把只读数据源重定向到授权根外。

### 8.2 不变式候选

- **WEB-INV-01 LoopbackOnly**：服务只绑定并只接受 `127.0.0.1:<port>`；
- **WEB-INV-02 ReadOnlySurface**：任何浏览器请求都不能改变磁盘或协议状态；
- **WEB-INV-03 NoSecretToBrowser**：响应中不存在 §5.2 字段；
- **WEB-INV-04 VerifiedOrUnknown**：不能验证的状态只能是 unknown/unavailable，不能伪装 verified/healthy；
- **WEB-INV-05 CapabilitySeparation**：网页会话能力与账号、恢复、ObjectStore、domain/device 密钥完全分域且不持久化；
- **WEB-INV-06 PhysicalSourceConfinement**：读取源按物理身份限制在显式授权范围内。

## 9. 后续 ACC 候选

随 C2 实现 commit 落库（`evidence_scope: "web-console"`，验证器路由同步扩展）：

1. **WEB-ACC-01**：实机浏览器验证 loopback bind、Host/Origin/Sec-Fetch-Site 拒绝、DNS rebinding/CORS 负例；
2. **WEB-ACC-02**：响应字节扫描证明所有 §5.2 字段、token、路径和正文 marker 均不存在；
3. **WEB-ACC-03**：对所有方法、路由和参数做写操作探测，前后文件系统与 head/ObjectStore 指纹不变；
4. **WEB-ACC-04**：有效、篡改、未注册、回滚、分叉、未知 schema 和缺失数据源分别得到冻结 verdict，不能假绿；
5. **WEB-ACC-05**：浏览器历史、cache、storage、Referrer、服务日志和错误输出中均不存在会话 token；
6. **WEB-ACC-06**：Windows 真实 Junction、symlink、8.3 短路径与读时替换负例全部失败关闭。

普通 unit tests、静态页面截图或“浏览器能打开”不能替代这些证据。

## 10. 裁决记录（2026-09-12，开发者逐项确认）

| # | 事项 | 裁决 | 细节 |
| --- | --- | --- | --- |
| Q1 | 会话 bootstrap | **B：同源自举 fetch**（无 token 即无 bootstrap；token 只进页面易失内存） | §3.4 |
| Q2 | 敏感元数据默认值 | **C：v1 DTO 不投影** `file_count`/`total_plaintext_bytes` | §5.1 |
| Q3 | 任务窗口 | **A：宿主内存 ring buffer 20 条，重启清空，不回填** | §5.3 |
| Q4 | 数据源配置 | **C：派生宿主当前会话域，零新增配置，v1 不新增磁盘读取路径** | §7.0 |
| Q5 | 状态组合 | **A：DTO 无 overall 字段，聚合仅为冻结的展示规则** | §6.7 |
| Q6 | 切片划分 | **C：三片——C1 合同/入册，C2 实现，C3 正式证据** | §11、ADR-0031 §11 |

## 11. 后果与停止点

- 本 ADR 已接受：C1 切片的边界输入齐备。C1 内容 = DP-027 正式入册（registry 26→27 同步验证器期望计数）+ 本 ADR + ADR-0031 实现合同；三者同一授权提交。
- **C2 实现（代码、依赖、服务、schema 落库、WEB-* registry 翻转、错误码注册）与 C3 正式证据（实机浏览器负向测试 + ACC 翻转 + closeout 绑定行）各自单独授权**；本 ADR 与 ADR-0031 均不构成实现授权。
- 不改变 ADR-0024 ObjectStore 端口和 token，不修改 ADR-0026 head wire、设备注册或签名语义，不改变 ADR-0029 账号边界。
- 即便未来实现通过本地测试，也不能自动授权提交、推送、开放 LAN/公网、加入写操作或把浏览器升级为可信设备。
