# ADR-0024：Phase 7-0 localhost HTTP ObjectStore 合同 v1

- 状态：已接受（2026-09-05 开发者确认全部三个确认点：localhost+token+2 MiB 上限、registry 扩至 40 + 门演化、7-0/7-A/7-B 三段推进）
- 日期：2026-09-05
- 草案阶段：Phase 7-0
- 决策者：开发者
- 相关文档：执行计划 §18、ADR-0015（Directory ObjectStore v1）、ADR-0020（P0-R1 关闭）、ADR-0021/0022、`docs/contracts/p0-deferred-parameters.json`（DP-014）、`packages/core/src/ports.ts`（ObjectStore 端口）

## 1. 背景与边界

P0-R1 已关闭（§18 前置条件满足），开发者授权起草 Stage 7 合同。DP-014 冻结路径：close_artifact = "HTTP threat-model delta + THR-02 ACC 扩展 + 抓包/日志 evidence schema"；hard_stop = "未关闭前不得把 Directory ObjectStore 的 ACC-32/33 证据外推为网络传输安全证据"。§18 端口边界不变式：HTTP 后端必须经既有 `ObjectStore` 端口（put/get）接入；**若需要修改共享加密核心或恢复语义，即端口边界失败，必须回到架构修复，不得复制一套网络版本**。

## 2. 冻结规则

1. **服务器形态**：Node `node:http` 实现，仅绑定 `127.0.0.1`，HTTP/1.1 明文（localhost 段）；路由 `PUT/GET/HEAD /objects/{key}`，key 必须匹配 canonical 22 字符 base64url（与 Directory ObjectStore 同一 canonical 规则）。**无账号/团队/计费/生产部署**（§18）；每次服务进程启动生成随机 bearer token（进程本地秘密，写入 0600 权限文件），所有请求须携带；token 永不入日志。
2. **语义镜像 Directory ObjectStore v1**：PUT 同 key 同内容 → 幂等成功（不变量：对象不可变）；同 key 异内容 → 409（映射 `OBJECT_ID_COLLISION`）；GET/HEAD 缺失 → 404（GET 映射为 `undefined`，由 core 归一为 `MISSING_OBJECT`）；网络层错误（超时/断线/半开）→ `OBJECT_STORE_IO_FAILED`；对象大小上限冻结为常量（默认 2 MiB，覆盖 1 MiB chunk + 信封开销），超限拒绝。
3. **客户端适配器**：`HttpClientObjectStore` 实现既有 `ObjectStore` 端口（put/get）；`exists` 检查经 HEAD 暴露在适配器层（不改端口）。restore 流程不改一行 core——这是 §18 端口边界的直接验收。
4. **威胁面 delta（DP-014 主体）**：网络观察者可见 = 对象键（不透明 base64url，与目录文件名同级暴露）、对象大小、时序、数量；**不可见 = 明文、Vault 路径、domainId、Recovery File 材料、token**。服务器日志只记录方法/键/大小/状态码/时长；抓包/日志 evidence schema `s7-http-session-v1` 在 7-A 冻结（token 字段强制脱敏）。
5. **ACC 扩展（按 DP-014 冻结路径）**：registry 37 → 40，新增——
   - **ACC-38**：HTTP ObjectStore 经既有端口完成完整往返（restore 经 HTTP store 逐字节一致，core 零改动）；
   - **ACC-39**：网络观察面不扩大（会话捕获与服务器日志无明文/路径/domainId/token，键仅不透明 base64url）；
   - **ACC-40**：幂等重试与故障收敛（重复 PUT 幂等、缺失对象 MISSING_OBJECT、超时/断线/半开 `OBJECT_STORE_IO_FAILED`、无部分写入伪成功）。
   三项初始状态 `untested` 并带新 registry 字段 `evidence_scope: "stage-7"`；设计门 closure 规则同步演化为"全部 untested，或 37 项 R1 ACC passed（closeout 绑定）+ stage-7 项 untested"；DP-014 在三项证据、威胁模型 delta 与抓包/日志 schema 齐备并复跑证据门前不得关闭。
6. **验证与切片**：7-A 实现（服务器 + 客户端适配器 + 故障注入测试 + registry/矩阵/验证器扩展 + `s7-http-session-v1` schema 与样本）单独授权；7-B 正式证据与 DP-014 收尾报告再单独授权。故障注入以测试代理/服务器钩子模拟超时、断线、重复请求与部分失败（§18）。

## 3. 确认点裁决记录（2026-09-05，开发者确认）

1. **服务器与鉴权形态**：采纳——127.0.0.1 绑定 + 每运行随机 bearer token（进程本地秘密、永不入日志）+ 对象上限 2 MiB；无账号体系。
2. **ACC 扩展与机器门演化**：采纳——registry 37→40（ACC-38/39/40 如 §2.5），新项 `untested` + `evidence_scope: "stage-7"`，设计门与证据门规则随 7-A 注册表扩展同一 clean commit 演化，DP-014 关闭被阻断直至三项证据、威胁模型 delta 与 `s7-http-session-v1` schema 齐备。
3. **切片划分**：采纳——7-0（本合同）→ 7-A 实现 → 7-B 正式证据与 DP-014 收尾，各自单独授权。

## 4. 后果与边界

- 本合同不含任何实现；7-A 落地时注册表/矩阵/验证器/样本扩展与实现在同一 clean commit 纳管。
- Directory ObjectStore 仍是默认后端；HTTP ObjectStore 仅在显式选择时使用，不改变任何既有证据。
- `THR-02`（网络观察者）的 registry delta 随 7-A 注册表扩展一并落库（threat 链接新 ACC-38/39/40），不新增威胁条目。
- 插件中文本地化与登录等功能为后期产品项，不在 P0 任何阶段范围（开发者 2026-09-05 裁决）。
