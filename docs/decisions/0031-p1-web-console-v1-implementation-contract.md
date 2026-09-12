# ADR-0031：P1 本机只读网页控制台 v1 实现合同

- 状态：**已接受（2026-09-12，开发者授权 C1 时随 DP-027 入册一并接受）；接受 = C1 提交纳管，不构成 C2 实现授权**
- 日期：2026-09-12
- 上游：DP-027（范围）、ADR-0030（身份/密钥/localhost 边界，六项裁决）
- 本合同冻结：HTTP surface、会话自举细化、DTO 白名单、状态语义、任务窗口、响应安全基线、错误语义候选、WEB-* 候选的落库映射、浏览器基线与 C2/C3 计划
- 不授权：任何代码、依赖、schema 文件落库、registry 的 INV/ACC/THR 翻转或错误码注册——全部属于 C2 切片，另获授权

## 1. 进程与服务形态

1. v1 控制台服务是宿主进程内嵌的只读 HTTP 服务（不新增独立服务进程、不新增启动配置，ADR-0030 §7.0）。
2. 绑定 IPv4 `127.0.0.1` + 操作系统分配的临时端口；启动后在宿主日志/UI 报告实际端口；宿主可经 shell 打开 `http://127.0.0.1:<port>/`（URL 不含任何凭据）。
3. 服务停止即失效；不落盘任何会话或请求状态。
4. **C2 宿主接线范围（冻结）**：服务本体实现于适配器包子入口（`./web-console`），宿主接线 = CLI 新增 `console` 子命令——显式 `--store`/`--head-dir`/`--domain-id` 参数，沿用 ADR-0021 全部路径纪律（显式路径、互斥、物理身份校验），`build` 标识取自 CLI build-meta 的 `source_commit`。Obsidian 插件宿主接线不在 v1 范围（其任务 ring 有真实数据源，作为后续切片另议）；`console` 服务进程自身不运行任务，其任务区按 §5.3 显示空态。

## 2. HTTP surface（冻结）

| 方法 + 路径 | 语义 | 响应 |
| --- | --- | --- |
| `GET /` | 静态 HTML 壳（不含任何秘密、不含内联脚本） | `text/html; charset=utf-8` |
| `GET /app.js` | 静态同源脚本（自举 + 渲染） | `text/javascript; charset=utf-8` |
| `GET /app.css` | 静态同源样式（`style-src 'self'` 要求样式为独立文件，不用内联） | `text/css; charset=utf-8` |
| `GET /bootstrap` | 会话自举：JSON 响应体返回进程 token | `application/json`，`Cache-Control: no-store` |
| `GET /api/status` | 聚合状态 DTO（§4），需 `X-Console-Session` header | `application/json` |
| 其他任何方法/路径 | — | 405（方法不匹配）/ 404（未知路径），通用固定 body，不反射请求 |

1. 所有端点统一前置校验顺序：`Host` 精确匹配（`127.0.0.1:<实际端口>`）→ `Sec-Fetch-Site ∈ {same-origin, none}`（`same-site`/`cross-site`/缺失一律拒绝）→ 会话 token（仅 `/api/status`）→ 任何数据源访问。校验失败在任何数据源读取之前返回。
2. 不支持 WebSocket、SSE、JSONP、CORS；查询参数与请求体一律忽略（v1 无任何带参语义）。
3. 静态资源版本化不引入：v1 禁止 Service Worker 与任何缓存（全部响应 `Cache-Control: no-store`）。

## 3. 会话自举（ADR-0030 §3.4 的实现细化）

1. 宿主启动时以 256-bit CSPRNG 生成进程 token，仅存宿主内存；`/bootstrap` 返回 `{ "token": "<token>" }`，页面脚本保存于 JS 变量，不写 DOM/存储。
2. `/api/status` 请求携带 `X-Console-Session: <token>`；宿主恒定时间比较；失败返回统一 403（不区分"缺失/错误/无会话"）。
3. 刷新、第二标签页、浏览器重启：重新执行 §2 的 `GET /` + `GET /bootstrap`，取得同一进程 token；无 Cookie、无存储恢复路径。
4. `/bootstrap` 与 `/` 不需要 token（自举前不存在会话），但必须通过 §2.1 的 Host + Fetch Metadata 校验。
5. token 生命周期 = 进程生命周期；服务重启后旧 token 自然失效（进程级重生成）。

## 4. DTO 白名单（冻结；候选 schema `p1-web-console-status-v1`，JSON schema 文件随 C2 落库）

```jsonc
{
  "schema": "p1-web-console-status-v1",
  "service": { "status": "ok|degraded", "version": "...", "build": "...", "started_at": "...", "uptime_seconds": 0 },
  "head": {
    "present": true,
    "sequence": 0,              // 无 head 时为 null
    "created_at": "...",        // 无 head 时为 null
    "verdict": "verified|not_checked|signature_invalid|device_unregistered|rollback_detected|fork_detected|unreadable|unknown",
    "checked_at": "..."         // 本次检查时间，非新鲜度证明（ADR-0030 §6.5）
  },
  "storage": { "object_count": 0, "total_ciphertext_bytes": 0, "observed_at": "..." },
  // storage 数值字段为 null 表示来源不可用（unavailable），不是 0；observed_at 仍为本次观察时间
  "tasks": {                    // ADR-0030 §5.3：内存 ring buffer 20 条，重启清空
    "items": [{
      "kind": "snapshot|restore", "status": "complete|failed",
      "started_at": "...", "completed_at": "...", "duration_ms": 0,
      "object_count": 0, "total_ciphertext_bytes": 0, "error_code": "..."
    }]
  },
  "report": {                   // 本会话宿主产生的已验证报告的内存摘要（ADR-0030 §7.0）；null 表示本会话尚无报告
    "schema_version": "...", "verdict": "...", "created_at": "...",
    "object_count": 0, "total_ciphertext_bytes": 0
  }
}
```

1. **明确不含**：`file_count`、`total_plaintext_bytes` 及 ADR-0030 §5.2 全部字段（含 domainId、device ID、路径、对象键、token 等）。任务/报告/存储中的计数与字节仅指对象计数与密文字节。
2. DTO 必须显式构造新对象；禁止对象展开、直接序列化内部异常或返回内部对象引用。
3. `service.status` 不得是聚合健康结论：`ok` 仅表示服务进程自身可响应；head/storage 的可信度只由各自 `verdict`/`observed_at` 表达（ADR-0030 §6.7）。
4. head `verdict` 枚举复用 ADR-0026/0027 既有归一化结论；无检查运行时必须是 `not_checked`，不得默认 `verified`。

## 5. 状态展示规则（前端，冻结）

1. verified → 正常色；unknown/not_checked/unavailable → 灰色并标注"未检查/不可用"；各 failed 归一化结论 → 红色并显示归一化错误码。
2. 无聚合 `overall` 状态灯；不得把 unknown 渲染为正常色（ADR-0030 §6.7）。
3. 任务区在 ring buffer 为空时显示"进程已重启，暂无任务历史"。

## 6. 响应安全基线（冻结字节）

所有响应统一携带：

```
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'
```

1. 静态 HTML/CSS/JS 为服务内嵌资源（同源、无远程 CDN、无内联事件处理器）；CSS 经 `<link>` 或 `style-src 'self'` 引入。
2. 禁止 Service Worker 注册、离线缓存、第三方资源（ADR-0030 §4.5）。
3. JSON 响应 `Content-Type: application/json` 固定；错误 body 为固定短字符串，不反射请求 header、URL 或本机路径。

## 7. 错误语义（候选；正式注册随 C2）

1. 复用既有归一化错误码表达数据源结论（如 ObjectStore/head 既有错误码）；HTTP 层只用 200/403/404/405 与固定 body。
2. C2 需新增的控制台候选错误码（须走错误码 registry + 静态门，与本合同引用的 ADR 同 commit 落库）：`CONSOLE_SESSION_REJECTED`（会话校验失败，仅宿主日志可见，浏览器只见 403）、`CONSOLE_SOURCE_UNAVAILABLE`（会话数据源缺失，DTO 呈现 unknown/unavailable）。
3. 浏览器永远收不到原始异常、堆栈或路径（ADR-0030 §7.6）。

## 8. 浏览器基线（冻结）

1. v1 兼容范围：Chrome/Edge/Firefox/Safari 的当前与上一主要版本（Fetch Metadata 全面可用的引擎集合）。
2. 不支持 `Sec-Fetch-Site` 的引擎按失败关闭拒绝（403），不做 Origin-only fallback——这是显式取舍：宁可旧浏览器不可用，不可防线退化（ADR-0030 §3.4.2）。
3. 不支持移动端浏览器作为目标（本机桌面场景）；不承诺响应式布局。

## 9. WEB-* 候选落库映射（随 C2 实现 commit）

1. WEB-THR-01..06 → 正式 THR 编号按落库时 registry 尾号连续分配（当前候选预计 THR-08..13；THR-06/07 已被 ADR-0029 账号候选预留）。
2. WEB-INV-01..06 → INV 连续尾号（当前预计 INV-19..24；若 ADR-0029 的 INV-19 先落库则顺延），并回填威胁回链。
3. WEB-ACC-01..06 → ACC 连续尾号（当前预计 ACC-44..49），`evidence_scope: "web-console"`；验证器 `expected_ids` 计数与 `_require_acc_statuses` 的 scope 路由同步扩展。
4. 落库顺序以 C2 实际提交时的 registry 现场为准；映射冲突时按连续编号规则顺延，不得跳号或复用。

## 10. 测试与证据计划

1. C2：单元/适配器测试覆盖 §2 校验顺序与 §4 DTO 白名单（负向：白名单外字段不存在）；HTTP 负向测试覆盖 Host/Sec-Fetch-Site/方法/token 负例与写操作探测（本地测试，不升级 ACC）。
2. C3：WEB-ACC-01..06 正式证据——实机浏览器（loopback bind、rebinding/CORS 负例）、响应字节扫描（§5.2 marker）、文件系统与 head/ObjectStore 指纹不变、逐 verdict 矩阵、token 不出现在历史/缓存/日志、真实 Junction/8.3 负例。普通 unit tests 与截图不能替代（ADR-0030 §9）。
3. C3 closeout 报告追加 `WEB_EVIDENCE_CLOSED_AT_COMMIT` 第四条绑定行；`acc-evidence-v1` schema 的 acc_id 模式同步扩展。

## 11. 切片与授权（ADR-0030 §10 Q6=C 的落地）

| 切片 | 内容 | 授权状态 |
| --- | --- | --- |
| C1 | DP-027 入册（registry 26→27 + 验证器同步）+ ADR-0030 accepted + 本合同接受，同一提交 | ✅ 已完成（`0254b11`） |
| C2 | 实现切片：代码 + 依赖 + `p1-web-console-status-v1` schema 落库 + WEB-THR/INV/ACC 与错误码 registry 翻转 + 验证器扩展，单 clean commit | ✅ 已完成（`6060bbb`；测试与门禁见 `docs/test-plans/p1-console-c2-implementation-report.md`） |
| C3 | 证据切片：实机浏览器正式 evidence run + ACC 翻转 passed + closeout 绑定行 + 状态文档 reconcile | ✅ 已完成（正式运行 `WEB_EVIDENCE_RUN_DONE 6 reports at HEAD 9c160ce`；翻转 `9a2efd3`；DP-027 已关闭；详见 `docs/test-plans/p1-console-c3-evidence-report.md`） |

## 12. 硬停止（继承 ADR-0030 §11）

本合同接受后仍不得：创建 web app/服务代码、安装前端框架或依赖、注册 schema/错误码/registry 项、声称网页控制台已实现。C2 启动必须另有明确授权。
