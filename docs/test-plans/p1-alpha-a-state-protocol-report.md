# P1-alpha-A 状态协议实现报告

> 日期：2026-09-05
>
> 状态：dirty-source implementation evidence（门禁全绿，提交随开发者授权执行）
>
> 合同：ADR-0026（P1-alpha-0 状态协议合同 v1，开发者三点确认）
>
> 范围：head 编解码/签名/验证进 core、ECDSA 设备签名进 crypto、head 目录适配器进 adapters、registry/矩阵/验证器 40→43 扩展；不触碰恢复语义（INV-11）与任何 P0 证据

## 1. 交付内容

1. **core `src/head.ts`**：Head Record v1——签名 canonical bytes 严格为 ADR-0026 §2.1 冻结的 128 字节（domain‖snapshot‖parent‖sequence u64BE‖device‖created_at u64，无版本字节）；wire 记录 = version(1) || signed(128) || signature(64) = 193 字节；`createHeadRecordV1`（经 `HeadSigner` 端口签名）、`decodeHeadRecordWire`/`encodeHeadRecordWire`（offset 修正：signed 段无版本字节）、`verifyHeadRecordWire`（canonical 重排等价 + 签名验证，INV-17）。新错误码：`HEAD_SIGNATURE_INVALID`、`HEAD_DEVICE_UNREGISTERED`、`HEAD_ROLLBACK_DETECTED`、`HEAD_FORK_DETECTED`（registry error_codes +4）。
2. **core `ports.ts`**：新端口 `DeviceSignaturePort`（sign/verify，私钥构造期绑定、永不外泄）。
3. **crypto `src/device-signature.ts`**：`WebCryptoDeviceSignatureProvider`——ECDSA P-256/SHA-256，WebCrypto 签名/验签均为 raw r‖s（64 字节），构造期导入 PKCS8 私钥并缓存 CryptoKey。
4. **adapters `src/head-directory.ts`**：head 目录——`devices.json` 显式设备注册（未注册设备发布/验证即 `HEAD_DEVICE_UNREGISTERED`）；签名指针文件（唯一可变状态，`encodeHeadPointerBytes` canonical 序列化：utf8 key ‖ sequence u64BE ‖ utf8 device_id）；发布流程强制 head 重验证 + sequence 单调（回退 → `HEAD_ROLLBACK_DETECTED`，INV-18）；同序号异对象 → `HEAD_FORK_DETECTED` 并携带完整分叉证据；并发同内容竞争经碰撞后重读比对幂等收敛；追加式 history journal（`history-<domainhash>.jsonl`）为本地新鲜度锚点；`localHighWaterMark` 供回滚检测。指针/日志文件名使用 domain 哈希，不暴露 domainId。
5. **registry/矩阵/验证器 40→43**：INV-17/18（挂 ACC-41/42/43 回链）、ACC-41（head 链验证）、ACC-42（回滚与篡改拒绝）、ACC-43（分叉检测拒绝）——`evidence_scope: "p1-alpha"`、`untested`；THR-03 回链更新；验证器 `expected_ids("ACC", 43)`/`("INV", 18)`、closure 规则按 passed 项 scope 集合演化（stage-7 → S7 行、p1-alpha → P1 行，均与 R1 行共存）、证据门按 `evidence_scope` 双/三绑定路由。DP-015 保持 `deferred` 至 P1-alpha-B 证据。

## 2. 验证结果

- `pnpm run test:all` → **exit 0**（core 61、crypto 21、adapters 71、smoke 5、plugin 11、cli 8；Python 验证器 12）。
- 新增测试：adapters `head-directory.test.ts` 4 项——注册/发布/回读链验证、sequence 回退拒绝（`HEAD_ROLLBACK_DETECTED`）、同序号分叉拒绝（`HEAD_FORK_DETECTED` + 完整证据 JSON）、篡改指针与未注册设备拒绝（`HEAD_SIGNATURE_INVALID`/`HEAD_DEVICE_UNREGISTERED`）。
- `--validate-samples` → PASS（**ACC=43 INV=18**）；`--validate-samples --evidence-root artifacts` → PASS（40 份既有 evidence 照常校验，3 项 p1-alpha untested 按规则跳过）。

## 3. 边界与后续

- ACC-41/42/43 仍为 `untested`（`evidence_scope: "p1-alpha"`），正式证据属 P1-alpha-B（需含会话捕获的 head 链场景），DP-015 关闭被阻断。
- CLI/插件的 head 发布接线未在本切片（快照时发布 head 属下一个合同决定）；`devices.json` 的注册记录完整性依赖 head 目录所在环境的访问控制（ADR-0026 §3 未冻结注册表自身的签名，作为已知限制记录）。
- 网页端仍未立项（§24.2）；本切片与插件 UI/中文本地化等后期产品项无耦合。
