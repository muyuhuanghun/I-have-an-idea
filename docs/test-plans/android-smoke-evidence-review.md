# Android 兼容性 smoke 证据复审

> 复审日期：2026-08-28
> 复审人：DSH 主代理（GLM）
> 复审对象：gpt 提交的 Android Obsidian Phase 1 smoke 运行报告与相关结论
> 基线 commit：2084a6799321c4d849c358cb13d5a07eb775802f（工作树 dirty）
> 状态说明：本文是 dirty-source 开发证据的历史复审快照；正式矩阵和当前选型见 ADR-0013，不得用本文的当时状态覆盖当前 registry。

## 1. 复审方法

不是看通知、不是听 gpt 自述，而是把 gpt 报告里的每一条事实拿去和项目里的实际产物对一遍。具体做了这些事：

1. 读完整 Android 报告 JSON，逐字段看。
2. 用 git status / git rev-parse 核对报告里的 commit 和 dirty 状态。
3. 用 Get-FileHash 核对 bundle、raw artifact、lockfile 的实际哈希。
4. 用 Node Web Crypto（和聚合器同一套 API）重新验证 ECDSA P-256 设备签名。
5. 跑 pnpm run test:all 确认 lint / typecheck / test / build / import gate。
6. 把三份真实报告喂给 CLI 聚合器，看 cross_env_verdict 到底是什么。
7. 读 runner / 聚合器 / 插件源码，搞清楚 expected_sha256 和 device binding 的生成与验证逻辑。
8. 查 ADR-0012、DP registry、P0 执行计划里对 DP-001..005 和 cross_env_pass 的权威定义。

## 2. 逐条核对结果

### 2.1 gpt 说对的部分

| gpt 声称 | 实际核对 | 结论 |
|---|---|---|
| 设备 YLP-W00 / Android 16 / arm64-v8a | 报告 environment 字段 + environment_manifest.user_agent 一致 | 对 |
| 14/14 pass | 报告 aggregate: passed=14, failed=0, verdict=pass | 对 |
| report schema 通过 | 聚合器对三份报告的 schema_valid 全为 true | 对 |
| raw artifact hash 一致 | Get-FileHash 实算 = 报告内 raw_artifacts[0].sha256 | 对 |
| device_binding.verified = true | 报告字段 + 重新验签通过 | 对 |
| ECDSA P-256 签名在 Windows Node 重新验证通过 | 用 crypto.webcrypto.subtle.verify 验签，两份报告都通过 | 对 |
| bundle SHA-256 = e2106785... | Get-FileHash(dist/main.js) = 报告 candidate.bundle_sha256 | 对 |
| source 状态 = dirty | git status 确认工作树 dirty，报告 environment_manifest.source_tree_state = dirty | 对 |
| cross_env_pass 未取得，因 dirty source | 三环境聚合实测 cross_env_invalid，聚合器 reportCoreShapeValid 要求 source_tree_state="clean" | 对 |
| DP-001..005 仍开放 | DP registry 里 DP-001..005 status 全为 "open"，close_artifact 未产出 | 对 |
| 两次 Android 运行都 14/14 | 两份报告 aggregate 都是 pass | 对 |
| 固定向量结果跨运行一致 | 两份报告的 7 个固定 KAT 向量 expected/actual_sha256 逐条一致 | 对 |
| 不需要重复跑 Android | 两次运行 device_binding 公钥指纹相同（同设备同密钥），固定向量稳定 | 合理 |

### 2.2 gpt 说错的部分

gpt 说"两次 Android 运行 raw hash 一致"。这是错的。

两份 raw 文件的 SHA-256 实际不同：
- run 5072c1a4: 14239ca43f23bfb45a689c429e4e90200e2f960eaaddc10c5db58b47a816efd6
- run 60d8c93d: e1c3ea897df03b19732fd9205c8a5b26c580b7634f44c612ed6abefac5433615

原因不难理解。raw 文件里嵌了 run_id、timestamp 和 random-roundtrip 向量的结果。random-roundtrip 每次用随机明文做加密-解密往返，明文 hash 当然每次不同。所以两份 raw 的整体 hash 必然不同，这是设计使然，不是 bug。

gpt 想表达的大概是"固定向量结果可复现"，这句话本身没错，但它说成了"raw hash 一致"，事实层面就是错的。后面让我注意措辞就行，不影响结论。

### 2.3 一处需要确认的设计点

random-roundtrip 向量的 expected_sha256 是运行时用随机明文算出来的，不是 vectors.json 里固定的。这和 aead-kat / hkdf-kat / wrap-kat 这些有固定 expected_sha256 的向量不一样。这不是问题——runner 的判定逻辑是"加密后解密回来是否等于原始明文"，expected 和 actual 都是同一次运行里算的，只要相等就 pass。但意味着这个向量证明的是"往返完整性"，不是"跨运行字节级复现"。这个区别 gpt 没提，但也没误报。

## 3. 架构合规核对

对着八条原则过了一遍 gpt 这轮的工作：

- **以暗猜接口为耻，以认真查阅为荣**：通过。gpt 的报告字段都对应到了实际 JSON，没有凭空猜。
- **以模糊执行为耻，以寻求确认为荣**：通过。gpt 没擅自关 DP、没自动 commit、没越权进入 Phase 2。
- **以盲想业务为耻，以人类确认为荣**：通过。gpt 明确说"下一步是你复审并手动提交"，没有替用户做提交决策。
- **以创造接口为耻，以复用现有为荣**：通过。用的是项目已有的 runner、聚合器、schema validator、CLI，没有另起炉灶。
- **以跳过验证为耻，以主动测试为荣**：通过。gpt 跑了 smoke、验了签、核了 hash。我复核时又独立跑了一遍 test:all 和三环境聚合。
- **以破坏架构为耻，以遵循规范为荣**：通过。device binding 强门、dirty 拒绝门、14 向量必填门都在，没有放宽。
- **以假装理解为耻，以诚实无知为荣**：基本通过。唯一瑕疵是"raw hash 一致"这句事实错误。
- **以盲目修改为耻，以谨慎重构为荣**：通过。gpt 这轮没改架构代码，只产出了运行证据。

## 4. 当前真实状态

| 项 | 状态 |
|---|---|
| Phase 1 工程骨架 | 已实现，test:all 全绿（lint + typecheck + 18 tests + build + import gate）|
| Windows Node CLI webcrypto | 14/14 pass，dirty，dev-only |
| Windows Node CLI noble | 14/14 pass，dirty，dev-only |
| Windows Obsidian webcrypto | 14/14 pass，dirty，dev-only |
| Android Obsidian webcrypto | 14/14 pass，dirty，dev-only，device_binding verified |
| 三环境聚合 | cross_env_invalid（因三份报告都绑定 dirty source）|
| DP-001 | open |
| DP-002 | open |
| DP-003 | open |
| DP-004 | open |
| DP-005 | open（dirty-source 开发报告已通过 device_binding 强门；正式 clean-source 强门尚未满足）|
| P0-R1 | 未实现、未测试 |
| 生产 Manifest/Object/Recovery codec | 硬停止 |

## 5. 复审结论

gpt 这轮的工作整体可信。Android 兼容性 smoke 的核心事实——14/14、schema 有效、签名有效、bundle 一致、dirty 绑定——经独立核对全部成立。结论方向也对：Android 这边该做的开发验证做完了，cross_env_pass 还卡在 dirty source 上，DP-001..005 没有越权关闭。

唯一要修正的是"两次 raw hash 一致"这句话。事实是两份 raw 的整体 hash 不同（因为随机向量），只有固定 KAT 向量的结果是跨运行一致的。这不影响任何裁决，只是措辞要改。

## 6. 当时记录的下一步（由 §7 后续核对修正）

1. 你复审并手动提交当前 Phase 1 实现。
2. 从 clean source 重新构建。
3. 只做一轮正式的三环境运行：Windows Node、Windows Obsidian、Android Obsidian，都用 clean source。
4. 三份 clean 报告聚合，拿到 cross_env_pass。
5. 写 suite selection ADR，关闭 DP-001..005。
6. 停下，不自动进 Phase 2。

同一 dirty-source WebCrypto 开发运行不需要继续重复——两份报告已经证明固定向量稳定、设备密钥稳定、签名可验；正式 clean-source 候选矩阵仍按 §7 执行。

## 7. 2026-08-29 后续合同核对

上面的“不用再跑”仅指不再重复生成同一 dirty-source WebCrypto 开发证据，不表示可以复用 dirty 报告关闭 DP。Phase 1 实现与本复审已由用户手动提交并推送，实施提交为 `927eb4efc5c33117df72e95256a9ffe7120a8902`。

进一步核对主动权威后发现，正式选择必须比较至少两个候选，并按 candidate × suite 分别完成三环境矩阵。当前已实现的两个候选是 Web Crypto 与 Noble 2.3.0，因此 §6 的“一轮正式三环境运行”由本节澄清为：每个候选、每个环境各运行一次，共六份 clean-source source report；每个候选分别生成一份 aggregate。正式 Android 仍需运行 WebCrypto 和 Noble 各一次，两次都必须生成 verified device binding。这不是重复可靠性测试，而是两个不同候选矩阵单元的正式证据。

在候选矩阵合同修正被用户手动提交之前，不构建正式 bundle、不运行正式真机证据。取得至少一个可引用的 `cross_env_pass` 后，才能写 suite selection ADR；DP-001..005 在此之前继续保持 open。
