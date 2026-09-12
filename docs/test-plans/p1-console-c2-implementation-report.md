# P1 网页控制台 C2 实现报告（DP-027）

- 切片：C2 实现切片（ADR-0031 §11），feat 提交 `6060bbb`，工作树 clean
- 合同：DP-027（范围）、ADR-0030（边界，六项裁决）、ADR-0031（实现合同 v1）
- 状态：实现与单元/HTTP 测试完成；WEB-ACC-44..49 保持 `untested`（`evidence_scope: "web-console"`），正式证据属 C3 切片，未授权未执行

## 1. 交付物

1. `packages/adapters/src/web-console.ts`（新，子入口 `./web-console`）：
   - `startWebConsoleServer`：`127.0.0.1` + 临时端口；校验顺序冻结为 Host 精确匹配 → `Sec-Fetch-Site ∈ {same-origin, none}`（same-site/cross-site/缺失一律拒绝）→ 会话 token（仅 `/api/status`）→ 路由；全部在触碰任何数据源之前失败关闭（ADR-0031 §2.1）。
   - 会话自举：进程级 256-bit CSPRNG token 只经 `GET /bootstrap` JSON 响应体交付；`X-Console-Session` header 恒定时间比较；失败统一 403 `Forbidden.`，不区分缺失/错误（ADR-0030 §3.3.5）。
   - 响应头冻结集合（`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、CSP `default-src 'none'; script-src 'self'; …`）附加于每个响应（ADR-0031 §6）。
   - 白名单 DTO `p1-web-console-status-v1`：显式构造新对象；`file_count`/`total_plaintext_bytes` 及 §5.2 字段结构性不存在；storage/report 缺源时为 `null`/`unknown`，不冒充 0/绿色（ADR-0030 §6、ADR-0031 §4）。
   - 只读投影：`projectHeadStatus` 组合既有 `HeadDirectory.readLatestHead`（指针/head 签名、设备注册、序列一致性的归一化错误码即 verdict）；`projectStorageStats` 对扁平 ObjectStore 做密文侧聚合，lstat-only，reparse point/非文件条目整体失败关闭（`CONSOLE_SOURCE_UNAVAILABLE`）。
   - `WebConsoleTaskRing`：内存 FIFO，容量 20，重启即空（ADR-0030 §5.3）。
   - 静态资源内嵌（HTML 壳 + `/app.js` + `/app.css`）：无内联脚本/事件处理器、无远程资源、渲染只用 `textContent`。
2. `apps/cli/src/main.ts`：`console` 子命令（ADR-0031 §1.4）——显式 `--store/--head-dir/--domain-id`，复用 ADR-0021 的互斥与物理身份纪律；`build` 绑定 build-meta `source_commit`；signPointer 显式拒绝（verify-only 宿主）；token 不打印不落盘。
3. `packages/adapters/src/errors.ts`：`ConsoleAdapterError`（`CONSOLE_SESSION_REJECTED`、`CONSOLE_SOURCE_UNAVAILABLE`），两码已入 `p0-traceability-v1.json` 错误码 registry。

## 2. 机器门同步（同一提交）

- `p0-traceability-v1.json`：THR-01..05 → THR-01..11（WEB-THR-01..06 = THR-06..11）、INV-01..18 → INV-01..24（WEB-INV-01..06 = INV-19..24）、ACC-01..43 → ACC-01..49（WEB-ACC-01..06 = ACC-44..49，`untested`/`web-console`，oracle 含 `required_error_code_groups`）；错误码 +2。
- `P0-acceptance-matrix.md`：ACC-44..49 六条（状态 `untested`）。
- 验证器：THR/INV/ACC 期望计数 11/24/49；`allowed_scopes` += `web-console`；schema 清单与样本对清单 += `p1-web-console-status-v1`（12 对）；PASS 行打印同步。
- `docs/schemas/p1-web-console-status-v1.schema.json`：封闭白名单 schema（`additionalProperties: false` 全层级）；负样本即"DTO 携带 `file_count`/`total_plaintext_bytes` 必须被拒"。

## 3. 门禁结果（feat 提交时点）

- `pnpm run test:all`（lint + typecheck + test + test:restore-verifier + build）exit 0。
- 测试计数：core 61、crypto 21、**adapters 86（含新增 web-console 15 项：gate 顺序/Host 含重复与缺失/socket 级/site 矩阵/方法与反射负例/DTO 白名单扫描/失败源语义/ring 容量/真实签名 head 投影矩阵/存储聚合 fail-closed）**、smoke 5、cli 8、obsidian-plugin 11。
- `python -B -m unittest tools.test_verify_restore tools.test_verify_phase0_contracts`：12 项通过。
- `python -B tools/verify_phase0_contracts.py --validate-samples`：`PHASE0_CONTRACT_CHECK_PASS mode=design-only+samples ACC=49 INV=24 THR=11 DP=27`，待证据行为 `ACC-44..49(web-console)`。
- 实机冒烟：`ekd-p0 console` 启动 → `/bootstrap` 200（token 43 字符）→ `/api/status` 200（build = `0254b11`、head `not_checked`、storage 计数）→ 无 token 403 → POST 405。

## 4. 诚实边界与已知限制

1. **读侧回滚不检测**：`HeadDirectory.localHighWaterMark` 在指针存在时以指针序列为准，当前读原语不构成"指针落后于 journal"的回滚检测；投影不做任何 raw journal 解析来伪造该 verdict（ADR-0030 §2.2.4/§6）。回滚仍是发布时（publish-head）的冻结语义。ACC-47 的 verdict 矩阵在 C3 按"实际验证了什么"如实取证。
2. `console` 服务进程自身不运行任务，任务区恒为空态提示"进程已重启，暂无任务历史"（ADR-0031 §1.4 冻结）；插件宿主接线（有真实任务 ring 数据源）留待后续切片。
3. `service.status` 恒为 `ok`（服务进程可响应），不是聚合健康结论；head/storage 可信度只由各自 verdict/null 表达。

## 5. 后续

- C3 切片（未授权）：实机浏览器 WEB-ACC-01..06 正式证据（loopback/Host/Site/rebinding 负例、响应字节扫描、写探测指纹、verdict 矩阵、token 泄露扫描、真实 Junction/8.3 负例）→ ACC-44..49 翻转 `passed` → closeout 报告新增 `WEB_EVIDENCE_CLOSED_AT_COMMIT` 绑定行（验证器同步第四路由）→ DP-027 关闭裁决。
