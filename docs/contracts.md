# 契约与不变量

所有机器产物使用封闭 JSON Schema；Schema 约束结构，确定性核心补充跨产物语义。未知字段、缺失绑定或摘要漂移都必须 fail-closed。每种产物只有一个当前 Schema。

## Active、Candidate 与控制来源

完整 base commit 固定本次运行的 Active Truth 与 Active Control。隔离 worktree 中的任何修改都是 Candidate Change，包括对规格、AGENTS、Schema、impact map、verifier registry 和框架代码的修改。

当前运行的资产策略、任务语义、验证器定义、审查规则和证据门只从 base revision 加载。Candidate Control 可以被验证和审查，但不能裁判自身。EvidenceBundle 证明精确内容；外部提交或合并目标接受该内容后，修改才在新目标中成为 Active。

## 产物流

| 产物 | 当前契约 | 核心绑定 |
| --- | --- | --- |
| project config | `project-config.schema.json` | controlPaths、sensitivePaths、单一 reviewProfile、过程路径 |
| baseline | `baseline.schema.json` | canonical 真相、decision register |
| SpecIndex | `spec-index.schema.json` | source、adapter module/config、framework distribution、base revision、完整 index digest |
| decision register | `decision-register.schema.json` | 阻断决策与阶段门 |
| impact map | `impact-map.schema.json` | 路径到需求、验收和 verifier 的确定性映射 |
| verifier registry | `verifier-registry.schema.json` | base Active Control 中的验证器定义 |
| TaskPacket | `task-packet.schema.json` | task/base/spec/truth/control/constraints/scope/assets/review/capabilities/risk |
| execution authorization | `execution-authorization.schema.json` | run/task/base/control/路径/外部效果/时间/nonce |
| ContextManifest | `context-manifest.schema.json` | TaskPacket 与内容主体；同源渲染 Agent/Human Brief |
| VerificationResult | `verification-result.schema.json` | task/control/subject、definition/input/output digests |
| ReviewReport | `review-report.schema.json` | task/control/subject、mandatory lens coverage |
| RunRecord | `run-record.schema.json` | controller-owned 隔离 worktree、checkpoint、CAS、授权消费、capabilities、observations |
| AuthorityReceipt | `authority-receipt.schema.json` | task/control/subject 与 Owner/production 外部权威 |
| EvidenceBundle | `evidence-bundle.schema.json` | 完整证明链、最高证据等级与外部激活目标 |

EvidenceBundle 继续承担变更证明主干；不另建 ChangeSet 产物。

## 资产分类与任务权限

资产分类从 baseline、配置的 `controlPaths`/`sensitivePaths`、过程产物路径和 impact map 自动推导。优先级确保 sensitive 与 process 不会被宽泛路径降级。

| task kind | 可写资产 |
| --- | --- |
| implementation | managed_implementation |
| truth_proposal | active_truth |
| control_plane | active_control，且必须消费一次性 execution authorization |
| evidence_collection | 无，只读采证 |

`unmanaged`、`sensitive` 和 `process` 都不能成为任务写入目标。TaskPacket 的声明路径和运行后的实际 diff 必须分别校验；通过声明不能豁免实际越界。

## TaskPacket 与过期语义

TaskPacket 必须绑定：

- 完整 base commit 和完整 SpecIndex digest；
- 可解释的 Truth/Control component digests；
- 直接需求、影响需求、全局不变量、验收和 verifier；
- 当前任务约束；
- allowed/subject/forbidden paths 及逐路径资产分类；
- review profile、mandatory/requested lenses；
- 声明能力和风险副作用；
- stage gate、decision dependencies 与 evidence targets。

编译器从 TaskPacket 请求指定的同一 base revision 读取规格、配置、决策、impact map、verifier registry、Schema 和 AGENTS，并自动生成或复用 SpecIndex。它校验请求与派生结果完全一致，并把任务请求与所选验证器声明的副作用按 kind 合并。实际 diff 后若 scope、资产类、需求、验收、verifier 或 Active Control 超出 TaskPacket，当前任务立即 stale，必须重新编译；框架不自动扩权。

## execution authorization

授权是独立契约，只对 control-plane 写入和外部写入强制。其 canonical digest 覆盖 run ID、task ID、taskPacketDigest、baseRevision、controlDigest、allowedPaths、allowedExternalEffects、issuedAt、expiresAt、nonce 和 issuedBy。

授权必须在有效期内、精确匹配运行，并覆盖实际路径和效果。nonce 在项目控制器范围内一次性消费；重复、篡改、过期或越权均拒绝。read-only network 只需作为 TaskPacket capability 声明，不视为外部写入授权。

## subjectContentDigest

被证明内容由“base commit + 排序后的最终变更条目”计算。条目覆盖：

- 普通文件原始字节摘要与 Git mode；
- 符号链接目标字节与 mode；
- gitlink object ID 与 mode；
- 删除；
- rename 规范化为删除加新增。

不归一化换行，不包含 staging、commit 或分支状态。TaskPacket、ContextManifest、VerificationResult、ReviewReport、RunRecord、EvidenceBundle、authority receipt 和其他过程产物不进入 subject，避免证据自引用。

## 控制器与恢复

`prepare` 原子获取单写者锁，在全新绝对路径创建 detached isolated worktree，固定 task/base/control/worktree identity/content 并生成 RunRecord、ContextManifest 和 execution envelope。RunRecord 只能由 controller 的 `prepare` 创建并绑定该隔离 worktree；调用者构造的记录、当前 checkout、项目根目录或既有目录不能成为运行主体。

`advance` 以 `expectedRunDigest` compare-and-swap，在实现、验证、审查、返修和封存边界重查 scope、actual impact、subject content、Active Control、基准框架分发和授权。`prepare` 与成功 `advance` 都直接返回下一次操作使用的 runDigest，不要求额外 inspect。内容只允许在进入实现或由实现/返修进入验证时更新；controller 会同时重建 ContextManifest 与两种 brief。验证、审查或封存阶段发现内容变化时立即 stale，不能沿用旧结果。`cycle evaluate` 与 `evidence seal` 同样必须绑定 run、最新 `expectedRunDigest` 和显式 UTC 时间；task、context、verification 与 changed paths 从 RunRecord 及其 worktree 推导，外部请求不得替换。`resume` 仅在 task、base、control、框架分发、worktree identity 与 checkpoint content 全部一致时恢复；若进程在 terminal RunRecord 落盘后、释放 writer lock 前中断，`resume` 会幂等回收该精确 terminal run 的锁。`abandon` 只标记精确 run 为 escalated 并释放锁，不删除现场。

`advance` 的 `sealed` 阶段只有在引用的 EvidenceBundle 通过当前 Schema、canonical digest，以及 run/task/control/subject/activation/evidence/review/verification/exclusions 的精确绑定校验后，才可把 RunRecord 转为 `accepted`。

RunRecord 的 capabilities 只记录 admitted→resolved→used，不记录每次宿主工具调用。observations 只记录范围外缺陷、真相冲突、缺失接口或 blocker，不改变任务范围。

## 验证、审查与证据

所有必需 verifier 必须真实执行并绑定 definition/input/output digests。ReviewReport 必须由不同上下文覆盖 TaskPacket 的 mandatory lenses；`not_applicable` 必须有理由，blocked lens 必须绑定有效决策。任何 verifier FAIL 都不能被 review PASS 覆盖。

证据等级固定为：

`specification → contract → runtime_stub → target_integration → owner → production`

不得跳级。Owner 和 production 只由宿主认证的 authority receipts 证明。EvidenceBundle 的 taskPacketDigest、controlDigest、subjectContentDigest、验证、审查或授权任一绑定变化，证据即 stale。Bundle 自身摘要不参与自己的 subject。

## 敏感信息与宿主边界

敏感路径内容不得进入 Context、brief、日志或 EvidenceBundle，只保存安全引用。网络写入、外部服务写入、物理和生产动作必须有 execution authorization。

宿主桥接只消费 controller envelope，并把真实结果写回当前契约；框架不直接嵌入 Codex SDK、不拦截每个原生调用，也不把 Agent 自述当作裁判。

controller、宿主桥接及过程产物目录构成受信边界。ReviewReport、AuthorityReceipt、execution authorization 和验证结果必须由宿主在真实事件发生并完成身份或执行校验后写入，Agent 不得直接伪造这些产物。框架不承诺隔离拥有同一操作系统写权限的恶意进程；若宿主不能保护过程产物和认证通道，就不得声明独立审查、Owner 或 production 证据。这个边界不引入 PKI 或工具级拦截。
