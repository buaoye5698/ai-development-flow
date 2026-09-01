# AI开发流框架规格

> 状态：active

## 1. 定位与运行模型

本框架是跨项目复用的 Codex/AI 开发控制框架。它只控制真相、范围、权限、验证、独立审查和证据，不替项目决定业务、技术栈、模型、工具或调度方式，也不拦截 Agent 的每一次推理、文件写入和工具调用。

唯一运行模型如下：

```text
Active Truth + Active Control（基准提交）
  → TaskPacket
  → 隔离 worktree 中的 Candidate Change
  → subjectContentDigest
  → 确定性验证
  → 独立覆盖审查
  → EvidenceBundle
  → 外部提交或合并精确内容
```

基准提交中的 Truth 与 Control 是当前 Active。隔离 worktree 中的修改只是 Candidate；Candidate 不能裁判自己。只有外部目标引用接受了证据绑定的精确内容，相关修改才在该目标中成为 Active。

controller、宿主桥接和过程产物目录构成受信边界。canonical digest 只证明内容绑定，不构成身份签名；宿主负责认证授权签发者与外部权威，并分配真实隔离的 reviewer context。框架防止合作但不可靠 Agent 的范围漂移、绑定漂移和以自述代替证据，不承诺抵御能以同一操作系统身份修改过程产物并重算摘要的恶意进程。

## 2. 来源登记

| 来源 ID | 标题 | authority | 路径 |
| --- | --- | --- | --- |
| FRAMEWORK-SPEC | AI开发流框架规格 | canonical | `docs/framework-spec.md` |

## 3. 规范性需求

**FRM-001（必须｜安全初始化）** `init` 只能创建不存在的目标目录；`adopt` 默认只读，显式应用时也只能创建缺失文件，任何冲突都必须整体拒绝。

验收：已存在目标、冲突文件和 dry-run 均不被覆盖；初始化后的项目独立拥有自己的真相、决策和证据。

**FRM-002（必须｜Active 与 Candidate）** 每次运行必须以完整 base commit 固定 Active Truth 与 Active Control，Candidate 只能存在于该 base 创建的隔离 worktree 中，当前运行不得把 Candidate Control 用作自身裁判。

验收：验证器、Schema、策略、AGENTS 或 registry 的候选修改不会改变当前运行的判定；只有接受 EvidenceBundle 所绑定精确内容的外部目标引用才激活修改。

**FRM-003（必须｜真相与控制绑定）** 项目配置、baseline 和 SpecIndex 必须共同固定 canonical 真相、完整 SpecIndex digest、base revision、框架分发来源、适配器模块与配置，以及可解释的 Truth/Control component digests；编译器与裁判必须从同一 base revision 读取这些输入。

验收：任一来源、适配器、配置、base 或组件摘要漂移都会使下游绑定失效；工作区换行或候选控制修改不能成为 base-bound TaskPacket 的输入，不得从旧产物猜测或补齐。

**FRM-004（必须｜任务契约）** TaskPacket 必须声明 task kind、stage、需求与验收、任务约束、scope、资产分类、审查 profile/lenses、能力、风险与副作用、验证器、base commit、SpecIndex digest、Truth/Control bindings 和 taskPacketDigest。

验收：`task compile` 自动从同一 base revision 生成或复用 content-addressed SpecIndex；缺失字段、未知字段、摘要不一致、未决门或声明范围与派生结果不一致时，任务不能编译或执行。

**FRM-005（必须｜资产权限）** implementation 只能写 managed implementation；truth_proposal 只能写真相、规范和验收；control_plane 只能在一次性授权覆盖下写候选控制资产；evidence_collection 只能只读采证。过程产物、unmanaged 和 sensitive 资产不得借任务范围绕过。

验收：声明路径和实际 diff 都按同一资产分类器判定；任何不允许的资产类、unmanaged 写入或 sensitive 写入均 fail-closed。

**FRM-006（必须｜执行授权）** control-plane 写入和外部写入必须消费独立 execution authorization；授权必须精确绑定 run、TaskPacket、base commit、Active Control、允许路径、允许外部效果、签发时间、过期时间和 nonce。

验收：授权缺失、过期、篡改、绑定不符、路径越界、效果越权或 nonce 重放均被拒绝；普通本地 implementation 不额外要求授权。

**FRM-007（必须｜上下文与指令来源）** ContextManifest 必须由同一 TaskPacket 派生；Agent Brief 与 Human Brief 必须从同一不可编辑输入确定性渲染，Agent Brief 必须显式展示 TaskPacket 的任务约束。Codex 指令链按 `AGENTS.override.md`/`AGENTS.md`、根到目标目录、空文件和大小限制解析。

验收：`run prepare` 自动生成运行所需的 manifest 与 brief；相同输入产生相同结果；Agent Brief 不遗漏任务约束；多写路径得到不同指令链时阻断并要求拆分任务；敏感内容只保留引用。

**FRM-008（必须｜稳定内容主体）** subjectContentDigest 必须由 base commit 与排序后的最终变更条目计算，覆盖普通文件、符号链接、gitlink、删除、Git mode 和原始字节摘要；rename 规范化为删除加新增。

验收：暂存、取消暂存和提交状态不改变相同内容的摘要；换行字节差异会改变摘要；Evidence、任务、运行、审查和其他过程产物不进入被证明主体。

**FRM-009（必须｜确定性控制器）** `run prepare|inspect|resume|advance|abandon` 必须以原子单写者锁、compare-and-swap 和 checkpoint 控制生命周期；prepare 只能在用户明确给出的全新路径创建 detached isolated worktree。

验收：并发写者被拒绝；expectedRunDigest 不匹配不能 advance；prepare 与成功 advance 直接返回下一次操作所需的 runDigest；只有 task、base、control、worktree identity 和 checkpoint content 全部一致才可 resume；abandon 只升级状态并释放锁，不删除现场。

**FRM-010（必须｜Active Control 裁判）** 确定性验证、资产策略、Schema、impact map、verifier registry 和审查门必须从 base revision 的 Active Control 加载。

验收：Candidate 对上述控制资产的修改只作为被测对象；当前运行无法通过修改裁判规则让自己 PASS。

**FRM-011（必须｜实际影响复核）** TaskPacket 编译时计算计划 impact，控制器在实际 diff 后重新计算 scope、资产分类和 impact；实际需求、验收或 verifier 超出 TaskPacket 时必须 stale 并重新编译。

验收：实际 impact 扩张、漏报 verifier、越界路径或控制摘要变化均停止自动推进，不自动扩大当前任务。

**FRM-012（必须｜验证与覆盖审查）** 最终 PASS 必须先满足全部确定性 verifier，再由不同上下文完成 mandatory lens coverage；review PASS 不能覆盖 verifier FAIL。scope lens 只基于当前任务与既有架构识别无具体依据的扩张，不以代码行数、文件数或抽象数量作为目标，也不得以简化为由削弱需求、正确性或必要质量约束。

验收：缺失 lens、无理由的 `not_applicable`、未绑定决策的 blocked lens、自审、上下文复用或任一 verifier FAIL 均不能放行；scope finding 必须给出相对于任务或既有架构的具体扩张证据，单纯偏好更短实现不构成 finding。

**FRM-013（必须｜运行记录）** RunRecord 必须贯穿 taskPacketDigest、controlDigest 和 subjectContentDigest，并记录 checkpoint、授权消费、capabilities 的 admitted→resolved→used 进展及只报告不扩权的 observations。

验收：used 不是 resolved 的子集、resolved 不是 admitted 的子集时拒绝推进；observation 不改变 scope、验收、验证器或授权。

**FRM-014（必须｜证据与激活）** EvidenceBundle 是变更证明主干，必须绑定 TaskPacket、base、Active Control、subjectContentDigest、验证结果、审查覆盖、authority receipts 和目标激活信息；不得以 AI 自述、文件存在或命令字符串作为 PASS 证据。

验收：任一绑定漂移即 stale；Bundle 自身及过程产物不参与 subject；Owner/production 等级只能由相应外部 authority receipt 证明；当前 run 不自证 Candidate Control 已激活。

**FRM-015（必须｜副作用与敏感信息）** read-only network 可作为已声明能力；任务请求声明的副作用必须与所选验证器副作用合并进入 TaskPacket，网络写入、外部服务写入、物理和生产动作必须由 execution authorization 覆盖。敏感路径内容不得进入上下文、日志或 EvidenceBundle。

验收：任务或验证器声明的副作用都不能在编译时丢失；未声明或未授权的外部写入被阻断；敏感资产只保留路径或安全引用，不读取或回显内容。

**FRM-016（必须｜轻量宿主边界）** 核心保持 Node.js 20+、ESM、零运行时依赖、确定性且无副作用；宿主适配器只消费控制器 envelope，不直接嵌入 Codex SDK，也不记录每次原生工具调用。本地宿主可通过 `start` 极简入口把短请求扩展为完整 TaskPacket 并准备隔离运行；入口模式采用 `auto|quick|full`，用户或 AI 只能表达模式偏好，最终由确定性资格检查决定。只有已授权阶段中、无未决阻断、低风险、无副作用与外部权威、只使用仓库读写能力、只写 managed implementation、采用 quick verifier tier 且最高要求为 contract 证据的 implementation 才可选择 quick；`quick` 不合格时回落 full，不得缩减 TaskPacket、控制器或证据门。

验收：`src/core/**` 不调用 AI、网络、Git 或外部服务；Agent 可在 envelope 范围内使用宿主原生能力；短请求可完整生成任务、运行与隔离执行入口，模式资格由完整 TaskPacket 确定性裁决，显式 full 始终保留完整流程，auto/quick 只有满足全部 quick 资格才选 quick，否则回落 full；正式扩展点只保留规格适配器、验证器适配器和执行宿主桥接；宿主不能保护认证通道和过程产物时不得声明独立审查、Owner 或 production 证据。

**FRM-017（必须｜停止与受限返修）** 未决决策、真相冲突、范围扩大、裁判修改、重复问题、A-B-A 振荡、轮次耗尽、授权问题或未经授权副作用必须停止自动循环；返修仍受原 TaskPacket 约束。

验收：任一停止条件出现时状态转为 blocked 或 escalated 并保留现场，不通过修改任务、规格、验收或证据门迁就实现。

**FRM-018（必须｜验证与交付）** 普通总检查必须覆盖核心安全不变量和两条 golden flow，并只对实际分发的文本内容执行泄漏扫描；发布检查另行覆盖 vendored CLI、真实临时 Git worktree、打包清单与私有制品卫生，不以真实 Codex、网络或 GitHub 作为测试裁判。

验收：`npm run check` 与 `npm run release:check` 均确定性通过；工作区内未进入分发清单的临时资产不制造 self-check 假失败；发布检查不发布包、不写远端、不把私有或临时内容装入制品。

## 4. 验收矩阵

| 验收 ID | 标题 | 通过条件 |
| --- | --- | --- |
| AC-FRM-001 | 初始化与接管安全 | init 不覆盖；adopt 默认只读；冲突整体拒绝 |
| AC-FRM-002 | Candidate 不自证 | base Active Control 裁判；目标接受精确内容后才激活 |
| AC-FRM-003 | 完整来源绑定 | 编译与裁判从同一 base 复算 SpecIndex、适配器、分发和 Truth/Control 摘要 |
| AC-FRM-004 | TaskPacket 封闭 | task compile 自动生成 base-bound SpecIndex；任务约束、scope、资产、审查、能力、风险、验证与摘要全部一致 |
| AC-FRM-005 | 资产权限矩阵 | 四类任务的声明写入与实际 diff 均满足资产规则 |
| AC-FRM-006 | 一次性授权 | 过期、篡改、越权和 nonce 重放全部拒绝 |
| AC-FRM-007 | 指令与 brief | prepare 自动生成上下文；nested AGENTS 正确绑定；双 brief 同源且 Agent Brief 展示任务约束 |
| AC-FRM-008 | 内容摘要 | 原始字节和 Git mode 被证明；Git 状态与过程产物不影响摘要 |
| AC-FRM-009 | 控制器恢复 | 单写者、CAS、成功操作返回下一摘要、resume fail-closed、abandon 保留现场 |
| AC-FRM-010 | 基准裁判 | Candidate registry、Schema、policy 和 AGENTS 不能改变当前裁判 |
| AC-FRM-011 | 实际 impact | 实际扩张立即 stale；不自动修改 TaskPacket |
| AC-FRM-012 | 审查覆盖 | mandatory lenses 全覆盖；scope finding 有具体扩张证据；verifier FAIL 不可被覆盖 |
| AC-FRM-013 | 运行语义 | capability 单调推进；observation 只记录不扩权 |
| AC-FRM-014 | Evidence 绑定 | 证据精确绑定 subject 与外部激活目标且可判新鲜度 |
| AC-FRM-015 | 副作用与敏感信息 | 请求与验证器副作用完整合并；外部写入需授权；敏感内容不进入上下文、日志和证据 |
| AC-FRM-016 | 轻量宿主 | 核心零运行时依赖；宿主只消费 envelope；短请求生成完整任务与隔离运行；auto/quick 由确定性资格检查裁决且不合格回落 full；受信边界明确；无工具级拦截 |
| AC-FRM-017 | 停止与返修 | 所有停止条件 fail-closed；返修不越过原边界 |
| AC-FRM-018 | 总检查与发布检查 | 普通检查覆盖安全闭环且只扫描分发文本；发布检查只验证本地制品与真实临时 worktree |

## 5. 需求追踪

| 需求 ID | 来源 ID | 验收 ID | 决策 ID |
| --- | --- | --- | --- |
| FRM-001 | FRAMEWORK-SPEC | AC-FRM-001 | — |
| FRM-002 | FRAMEWORK-SPEC | AC-FRM-002 | — |
| FRM-003 | FRAMEWORK-SPEC | AC-FRM-003 | — |
| FRM-004 | FRAMEWORK-SPEC | AC-FRM-004 | — |
| FRM-005 | FRAMEWORK-SPEC | AC-FRM-005 | — |
| FRM-006 | FRAMEWORK-SPEC | AC-FRM-006 | — |
| FRM-007 | FRAMEWORK-SPEC | AC-FRM-007 | — |
| FRM-008 | FRAMEWORK-SPEC | AC-FRM-008 | — |
| FRM-009 | FRAMEWORK-SPEC | AC-FRM-009 | — |
| FRM-010 | FRAMEWORK-SPEC | AC-FRM-010 | — |
| FRM-011 | FRAMEWORK-SPEC | AC-FRM-011 | — |
| FRM-012 | FRAMEWORK-SPEC | AC-FRM-012 | — |
| FRM-013 | FRAMEWORK-SPEC | AC-FRM-013 | — |
| FRM-014 | FRAMEWORK-SPEC | AC-FRM-014 | — |
| FRM-015 | FRAMEWORK-SPEC | AC-FRM-015 | — |
| FRM-016 | FRAMEWORK-SPEC | AC-FRM-016 | — |
| FRM-017 | FRAMEWORK-SPEC | AC-FRM-017 | — |
| FRM-018 | FRAMEWORK-SPEC | AC-FRM-018 | — |

## 6. 未决决策

当前方案没有阻断实施的未决架构决策。新增项目差异必须通过项目自己的真相源、契约、配置和验证器表达，不能扩展本框架核心来容纳具体业务。

## 7. 固定证据等级

`specification → contract → runtime_stub → target_integration → owner → production`

等级集合与顺序固定。普通开发默认只要求 `contract`；只有任务验收确实需要真实集成、Owner 或生产事实时才选择更高等级。实际声明不得高于连续通过证据与 authority receipts 能证明的最高层级。

## 8. 非目标

- 不建设通用多 Agent 编排平台、知识库、配置中心、Capability Registry、Policy Pack、PKI 或 ChangeSet 子系统。
- 不替项目选择业务、技术栈、供应商、模型、云环境、硬件和部署值。
- 不用工具调用日志、AI 自述、Token 数量或 Agent 数量替代业务证据。
- 不自动合并、发布、部署或执行真实外部副作用。
- 不提供对可用同一操作系统身份篡改 controller 或过程产物的恶意进程沙箱。
