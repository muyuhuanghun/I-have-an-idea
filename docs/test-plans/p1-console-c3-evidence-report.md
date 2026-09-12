# P1 网页控制台 C3 证据报告（DP-027 关闭）

- 切片：C3 证据切片（ADR-0031 §11）；正式运行 `WEB_EVIDENCE_RUN_DONE 6 reports at HEAD 9c160ce`，翻转提交 `9a2efd3`
- 绑定：closeout 报告第四行 `WEB_EVIDENCE_CLOSED_AT_COMMIT: 9c160ce0cff259ac3b21775a3753818538299d2b`（验证器 `--evidence-root` 模式四路路由：R1/S7/P1-alpha/web-console）
- 结果：**registry 49/49 ACC `passed`**（ACC-44..49 由 `untested` 翻转），DP-027 依 ADR-0030/0031 关闭

## 1. 证据构成（ACC-44..49，oracle 逐项）

| ACC | 场景与关键负例 | 观察 |
| --- | --- | --- |
| ACC-44 Loopback/Host/Site/rebinding | 4 组错误 Host（含 rebinding 形态 `evil.example`）、3×3 Sec-Fetch-Site 负例矩阵、缺失 Site、OPTIONS 非预征 | 全部 403 且共享单一 body `Forbidden.`；**负例期间数据源调用计数为 0**（校验先于任何数据源触碰）；无任何 `Access-Control-*` 头；实机浏览器 opaque-origin fetch 被拒（TypeError: Failed to fetch） |
| ACC-45 字节扫描 | 12 个响应类 × 10 类敏感 marker（token、domain/device/snapshot 十六进制、head 键、路径前缀、`file_count`/`total_plaintext_bytes`、devices.json、`C:\Users`） | 白名单外命中数为 0；`/bootstrap` 是唯一 token 通道且 body 恰为 `{ token }`；DTO 顶层/嵌套键集与 ADR-0031 §4 逐字一致 |
| ACC-46 写探测 | 4 方法 × 9 路由（含不存在的 `/snapshot`、`/restore`、`/devices`）× 查询参数 | 405/404 全对；探测前后 store+head 指纹（文件名+大小+sha256）完全一致 |
| ACC-47 verdict 矩阵 | verified / 无 head / 篡改指针 / 未注册设备 / head 对象缺失 / 存储缺失 / 存储源失败（served） | 每场景得到冻结 verdict；served 存储失败显示 `null`（不是 0）；前端显示规则把 unknown/not_checked 映射为灰色类（冻结于实现） |
| ACC-48 token 泄露 | 实机浏览器存储扫描 + 25 行净化日志 + 全响应扫描 + Referrer-Policy | cookie/localStorage/sessionStorage/IndexedDB/SW 全零；日志零 token；非 bootstrap 响应零 token；`Referrer-Policy: no-referrer` 在场 |
| ACC-49 Windows 路径 | 真实 Junction（指向授权根外）、文件 symlink、8.3 短名别名、读时替换 | Junction/symlink 条目 → `CONSOLE_SOURCE_UNAVAILABLE` 拒不跟随；8.3 别名聚合与真名一致（身份一致）；10 次替换试验全部为"读时真相 + 沉降后即真相"，静默替换探针 before=30/after=80 证明无缓存 |

## 2. 实机浏览器部分（观察记录为 runner 硬前置）

`artifacts/web-console/browser-observations.json` 由交互式 IAB 会话产出：页面五区完整渲染（head `已验证` seq 3、存储 3 对象 385 字节、任务区诚实空态）、刷新按钮重自举成功、存储扫描全零、资源请求仅 `/app.css` `/app.js` `/bootstrap` `/api/status` 四端点且无查询串、跨源 fetch 失败。runner 缺该文件即 fail-closed。

## 3. 门禁（翻转提交 `9a2efd3` 时点）

- `python -B tools/verify_phase0_contracts.py --validate-samples --evidence-root artifacts` → `PHASE0_CONTRACT_CHECK_PASS mode=design+evidence+samples ACC=49 INV=24 THR=11 DP=27`（嵌套证据门四路路由 PASS）
- design-only+samples PASS；`tools.test_verify_restore` + `tools.test_verify_phase0_contracts` 12 项通过

## 4. 诚实边界

1. 读侧回滚检测在当前原语下不可达（`localHighWaterMark` 指针优先），ACC-47 的回滚场景由发布时（publish-head）冻结语义覆盖；控制台读路径不伪造该 verdict。
2. `console` 服务进程自身不运行任务，任务区恒为诚实空态；插件宿主接线（真实任务 ring）留待后续切片。
3. 正式运行环境为单一 Windows 11 工作机 + IAB（Chromium 内核）浏览器；证据不声明生产部署、远程访问或多浏览器矩阵。
4. LAN/公网不可达性由"只绑定 127.0.0.1"的结构性事实 + bind 地址断言证明，未做主动局域网探测（防火墙环境不可控，不构成额外证据）。

## 5. DP-027 关闭

DP-027 已按 ADR-0030/0031 关闭（`closure_adr: docs/decisions/0031-p1-web-console-v1-implementation-contract.md`）。关闭不放宽边界：写操作、LAN/公网监听、账号集成、浏览器可信设备化、插件宿主接线、DTO 白名单外投影均需新合同 + 新证据。
