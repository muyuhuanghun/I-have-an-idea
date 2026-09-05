# ADR-0026：P1-alpha-0 状态协议合同 v1

- 状态：已接受（2026-09-05 开发者确认全部三个确认点：head 目录 + 签名指针、ECDSA P-256 + devices.json 显式注册、分叉拒绝并输出证据）
- 日期：2026-09-05
- 草案阶段：P1-alpha-0（DP-015）
- 决策者：开发者
- 相关文档：DP-015（mutable head、状态序号、设备签名、分叉证明）、ADR-0011（wire bytes 惯例）、ADR-0024（ObjectStore 端口）、执行计划 §24、README 设备信任模型（"普通网页登录不是可信设备"）、Phase 1 `StoredDeviceKey`（ECDSA P-256）

## 1. 背景与边界

P0 接受的已知限制：完整旧快照替换/回滚没有外部新鲜度锚点——同一 Vault 再次快照后，没有任何机制能检测"目标被回滚到旧快照"。P1-alpha 引入状态协议解决此问题。本合同只冻结状态协议的设计；实现（P1-alpha-A）与证据（P1-alpha-B）各自单独授权。**不改 P0 恢复语义**（INV-11 恢复材料边界不动）、不引入账号（DP-017 另立）、不宣称跨设备并发写一致性（分叉是显式检测的合法状态）。

## 2. 冻结规则

1. **Head 记录（不可变对象）**：canonical wire bytes = `domain_id(32) || snapshot_id(32) || parent_snapshot_id(32) || sequence(u64 big-endian) || device_id(16) || created_at_unix(u64)`；由快照设备的 ECDSA P-256 私钥（SHA-256 摘要）签名，签名字段 base64url 附于记录后。head 对象本身作为不可变对象进入 ObjectStore（键沿用 16 字节随机 object id 体系，`decodeObjectStoreKeyV1` 兼容）。
2. **Mutable latest 指针（唯一可变状态）**：用户显式配置的 head 目录（Vault 外、ObjectStore 外，复用 ADR-0021 路径互斥校验）内每域一个指针文件：`{ head_object_key, sequence, device_id, pointer_signature }`，pointer_signature 覆盖前三字段。指针防回滚：读取方拒绝 sequence 低于本地已见最大值的指针。
3. **验证链**（恢复/读取 head 时强制）：指针签名 → head 对象签名 → 设备已注册 → sequence 单调 → parent 链回到已知起点。任一步失败即拒绝并输出证据。
4. **设备注册**：head 目录内 `devices.json`（device_id → SPKI base64url 公钥），显式注册流程；未注册设备签署的 head 一律无效。签名体系固定 ECDSA P-256 + SHA-256（与 Phase 1 `StoredDeviceKey` 同形态，WebCrypto 可用）。
5. **分叉**：同 sequence 两个不同有效 head = 分叉；恢复默认**拒绝**并输出分叉证据（两个 head 对象引用与签名），由用户裁决，不自动择优。
6. **机器门 delta（DP-015 close_artifact 的具体化）**：新增 INV-17（head 链签名与单调性可验证）、INV-18（回滚检测：sequence 回退被拒绝）；新增 ACC-41（head 链验证通过）、ACC-42（回滚/篡改指针被拒绝）、ACC-43（分叉被检测并拒绝）——三 ACC 挂 THR-02/THR-03，初始 `untested` + `evidence_scope: "p1-alpha"`，沿用 7-A 的 `evidence_scope` 门机制（registry 40→43、设计/证据门同 commit 演化）。DP-015 在三项证据齐备前不得关闭。
7. **无网页端假设**：状态协议不假设任何特定客户端形态；网页端（§24.2，未立项）若未来接入，只能作为完成正式设备注册的可信端，或只读消费 head 链。

## 3. 确认点裁决记录（2026-09-05，开发者确认）

1. **指针载体**：采纳——head 目录 + 签名指针文件，唯一可变状态集中在一个可审计目录。
2. **设备体系**：采纳——ECDSA P-256 + SHA-256，head 目录内 `devices.json` 显式注册，未注册设备的 head 无效。
3. **分叉语义**：采纳——恢复默认拒绝并输出分叉证据（两个 head 引用与签名），用户裁决，不自动择优。

## 4. 后果

- 接受后新增 wire token `P1_ALPHA_0_STATE_PROTOCOL_CONTRACT_ACCEPTED`；DP-015 保持 `deferred` 直至 ACC-41..43 证据齐备（P1-alpha-B）。
- 实现（P1-alpha-A）：head 编解码/签名/验证进共享 core（WebCrypto + Node 双适配器），指针文件适配器进 adapters；registry/矩阵/验证器扩展与实现同一 clean commit。
- 本合同不触碰恢复语义、Recovery File、INV-11 与任何 P0 证据。
