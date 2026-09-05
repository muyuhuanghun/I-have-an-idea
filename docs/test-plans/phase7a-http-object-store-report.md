# Phase 7-A HTTP ObjectStore 实现报告

> 日期：2026-09-05
>
> 状态：已纳管（feat 提交 + 本报告 docs 提交，随开发者 Phase 7-A 授权交付）
>
> 合同：ADR-0024（Phase 7-0 localhost HTTP ObjectStore 合同 v1，开发者三点确认）
>
> 范围：服务器 + 客户端适配器 + registry/矩阵/验证器扩展（37→40）+ `s7-http-session-v1` schema 与样本；7-B 正式证据与 DP-014 收尾另行授权

## 1. 交付内容

1. **HTTP 服务器**（`packages/adapters/src/http-object-store.ts` `startHttpObjectStoreServer`）：`node:http` 仅绑定 `127.0.0.1`；路由 `PUT/GET/HEAD /objects/{key}`；每次启动生成 32 字节随机 bearer token（可选写入 0600 token 文件），`Authorization: Bearer` 经 timing-safe 比较校验；对象上限冻结 2 MiB（超限 413，先响应后排水，客户端可靠收到冻结语义）；存储后端复用 `DirectoryObjectStoreV1`（§18 目录后端复用）。语义镜像：同 key 同内容重发布 → 200 幂等（并发同内容竞争在碰撞后重读比对，仍幂等收敛）；异内容 → 409 → `OBJECT_ID_COLLISION`；缺失 → 404（GET 映射 `undefined`，core 归一 `MISSING_OBJECT`）；键强制 canonical 22 字符 base64url（`decodeObjectStoreKeyV1`）。访问日志只含方法/键/状态/字节/时长，token 永不出现；测试专用 `faultInjector` 钩子支持延时与断线注入。
2. **客户端适配器**（`HttpClientObjectStore`）：实现既有 core `ObjectStore` 端口（put/get），`exists` 经 HEAD 停留在适配器层；`AbortController` 超时（默认 10 s）与网络错误统一映射 `OBJECT_STORE_IO_FAILED`；409 映射 `OBJECT_ID_COLLISION`；客户端侧键规范校验 → `OBJECT_ID_INVALID`。**restore 流程 core 零改动**（§18 端口边界）。
3. **registry/矩阵扩展 37→40**：ACC-38（HTTP 端口等价往返）、ACC-39（网络观察面不扩大且令牌不泄露）、ACC-40（幂等与故障收敛）——`kind: security`、`threat_ids: ["THR-02"]`、`status: untested`、`evidence_scope: "stage-7"`、唯一 evidence_path、oracle（required_checks/错误码组/禁用副作用）冻结；THR-02 回链更新为 [ACC-38, ACC-39, ACC-40]（oracle 文本同步为 Stage 7 语义）。验收矩阵同步 40 条目（37 passed + 3 untested）。
4. **机器门演化**：设计门 `_require_acc_statuses` 允许"全部 untested / 全部 passed / 37 passed + stage-7 untested（必须带 `evidence_scope`）"三种形态；证据门对非 passed 项仅在 stage-7 untested 时跳过；design-only 输出如实报告 "R1 ACC all passed; stage-7 ACC pending evidence: ACC-38, ACC-39, ACC-40"。**DP-014 关闭被阻断**：三项证据 + 威胁模型 delta + session schema 齐备并复跑证据门前保持 `deferred`。
5. **`s7-http-session-v1` schema + 样本**（第 11 份机器 schema，样本 10→11 对）：会话捕获条目（method ∈ PUT/GET/HEAD、object_key 22 字符 base64url、请求/响应字节、状态码、时长）+ `token_redacted: true` 强制字段 + `base_origin` 锁定 `http://127.0.0.1:{port}`。

## 2. 验证结果

- `pnpm run test:all` → **exit 0**（adapters 新增 6 项 HTTP 测试全过：端口 put/get/exists 往返、token 拒绝、幂等+碰撞、尺寸上限+键规范、超时/断线/并发重复请求收敛、**Directory 快照 → HTTP store 恢复逐字节一致**）。
- `--validate-samples` → PASS（**ACC=40** INV=16 THR=5 DP=26，11 对样本）；`--validate-samples --evidence-root artifacts` → PASS（37 份 R1 evidence 照常校验，3 项 stage-7 untested 按冻结规则跳过）。
- 已知边界：服务器当前未实现断点续传/分块（对象 ≤ 2 MiB 一次写入）；`faultInjector` 为显式测试专用钩子；插件不引入该子入口（bundle 不含 HTTP store）。

## 3. 后续

- **Phase 7-B（另行授权）**：正式证据（ACC-38/39/40 evidence 生成 + 会话捕获产出）→ registry/矩阵三项翻转 passed → 复跑证据门 → DP-014 收尾报告与关闭裁决。
