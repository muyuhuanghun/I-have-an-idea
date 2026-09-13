# P1-beta 团队协议 T3 证据报告（ACC-50..58 关闭）

- 切片：T3 证据切片（ADR-0035 §6.3）；正式运行 `TEAM_EVIDENCE_RUN_DONE 9 reports at HEAD b58443e`，翻转提交 `e21d225`
- 绑定：closeout 报告第五行 `P1_BETA_TEAM_EVIDENCE_CLOSED_AT_COMMIT: b58443ef18329121194964f17ae1827839b75755`（验证器证据门六路：R1/S7/P1-alpha/web-console/p1-beta/…）
- 结果：**registry 58/58 ACC `passed`**（ACC-50..58 由 `untested` 翻转），DP-018/025/019 的实现与证据闭环完成

## 1. 证据构成（ACC-50..58，oracle 逐项）

| ACC | 场景与关键断言 | 观察 |
| --- | --- | --- |
| ACC-50 登记物与审批负例 | 签名篡改（保留合法文件字节、破坏签名首字符）、旧序号回滚、陌生人密钥审批、已撤销密钥审批 | 全部失败关闭：`PRO_REGISTRY_SIGNATURE_INVALID` / `PRO_REGISTRY_ROLLBACK` / `PRO_REVIEWER_UNREGISTERED` / `PRO_REVIEWER_REVOKED` |
| ACC-51 验收持久化 | 审批记录携带注册表状态哈希（43 字符 base64url）；撤销后历史记录对照历史状态仍可验证；审核者撤销不改 group-state 字节 | 三断言全过 |
| ACC-52 自注册与分域 | 冒名签名的登记文件经诚实权威视图加载 | `PRO_REGISTRY_SIGNATURE_INVALID` 拒绝；全部登记产物无私钥标记/材料字节/锚材料混入 |
| ACC-53 加入起点 | 加入推 epoch、前代分布无新成员封装、当期解封成功、无变更不推进 | 全过 |
| ACC-54 移除前向失效 | 移除推 epoch、新分布无被移除条目、解封拒绝、旧分布按 §4.5 保留（历史可读语义） | 全过，可验证擦除成立 |
| ACC-55 三级边界 | 用户字符串无越级声明（5 类禁用模式）、L1 保留文档化、协议层密钥门控在场 | 全过 |
| ACC-56 恢复承认 | 错误材料拒（`GOV_MATERIAL_INVALID`）；锚签名承认可验证；非锚（管理员）签名承认 → `GOV_RECOVERY_ANCHOR_INVALID` | 建议-授权分离结构性成立 |
| ACC-57 epoch 延续与权威交接 | 恢复后 epoch 序号延续；新权威签名后续更新；旧权威签名被拒 | 全过 |
| ACC-58 历史不重写与分域 | superseded 追加记录不删除；journal 篡改（高水位伪升）检出 `GRP_EPOCH_ROLLBACK`；恢复产物无内容密钥；错域材料 `GOV_MATERIAL_DOMAIN_MISMATCH` | 全过 |

## 2. 门禁（翻转提交 `e21d225` 时点）

- `python -B tools/verify_phase0_contracts.py --validate-samples --evidence-root artifacts` → `PHASE0_CONTRACT_CHECK_PASS mode=design+evidence+samples ACC=58 INV=31 THR=16 DP=27`（六路证据路由）
- design-only+samples PASS；验证器单测 12 项通过

## 3. 诚实边界

1. L2 传输层门控在协议层的证明形态是"被移除设备在新分布中无封装条目"（密钥层拒绝）；共享对象存储 HTTP 层的对象级门控属于部署形态接线，随自托管传输切片交付（ADR-0033 §5.2 措辞纪律适用）。
2. 活跃成员保留历史 epoch 密钥（ADR-0035 §4.5 备份语义）——代价（活跃设备泄露暴露可见历史）已在该节声明，MLS 树式逐 epoch 前向安全为未来裁决。
3. 治理恢复材料泄露不可远程吊销（ADR-0034 §9.1）；材料轮换为未来裁决。
4. 正式运行环境为单一 Windows 工作机；团队并发/多域规模未在证据范围内。

## 4. 后续

DP-023 挂起待真实使用观测数据；P1-release（DP-020 签名更新/DP-021 删除 SLA/DP-022 迁移）与移动端（DP-024/026）未启动；团队内容加密的产品接线（提交入口/审核队列 UI）为独立产品课题。
