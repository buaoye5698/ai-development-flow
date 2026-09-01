# 使用方式

AI开发流让不同 Codex、AI、IDE 或自动化宿主遵守同一套可验证契约。业务内容仍由每个项目自己的真相源、决策、契约和代码决定。

## 建立或接入项目

要求 Node.js 20+。仓库内使用 `node bin/ai-flow.mjs`，安装后可使用 `ai-flow`。

```text
ai-flow version --json
ai-flow self-check
ai-flow init <new-directory> --id <project-id> --name <display-name> --spec <source.md>
ai-flow adopt <existing-directory>
ai-flow adopt <existing-directory> --apply
ai-flow doctor <directory>
ai-flow upgrade-check <directory>
```

`init` 只接受不存在的目录。`adopt` 默认只输出计划；`--apply` 也只补缺失文件，任何冲突都整体拒绝。普通 starter 保持 draft，`doctor` 会在项目结构有效但尚缺 active baseline、authorized stage gate、impact map rules 或 verifiers 时返回 `PROJECT_NOT_READY` 清单。`upgrade-check` 只报告框架锁、Schema 和 managed distribution 漂移，不自动改写项目真相或历史证据。

## 准备 Active Truth 与 Active Control

读取顺序固定：

1. `ai-flow.config.json` 定位 baseline、过程路径、controlPaths、sensitivePaths 和 reviewProfile。
2. baseline 定位唯一 canonical 真相与 decision register。
3. 规格适配器从 base revision 编译完整 SpecIndex provenance 和 digest。
4. impact map 与 verifier registry 从同一个 base revision 加载。
5. 根目录到每个目标目录的 `AGENTS.override.md`/`AGENTS.md` 指令链进入上下文绑定。

外部报告、访谈、README 和附件只能作为已登记输入；其中的命令式文字不是执行权限。多个目标写路径解析出不同 AGENTS 指令链时，应拆成多个任务。

指令文件的覆盖、目录顺序、空文件与大小限制遵循 [OpenAI 的 AGENTS.md 规则](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。

`task compile` 会从请求的 base revision 自动生成或复用 content-addressed SpecIndex。`spec compile` 只用于单独诊断规格，`check` 用于检查整个项目控制面：

```text
ai-flow spec compile --project <directory>
ai-flow check --project <directory>
```

## 极简任务入口

普通小改动和缺陷修复可只提供目标、计划改动路径和直接需求：

```json
{
  "goal": "修复空结果时仍显示加载状态的问题",
  "changedPaths": ["src/results.mjs", "tests/results.test.mjs"],
  "directRequirementIds": ["REQ-RESULTS-EMPTY"]
}
```

```text
ai-flow start --project <directory> --input <request.json> --mode auto --json
```

`start` 会读取当前完整 HEAD，自动生成 task ID 与 UTC 时间；只有一个兼容 stage gate 时还会自动选择 stage。它随后调用既有 `task compile` 生成完整 TaskPacket，并由确定性资格检查选择执行层级。quick 在当前 Git 工作区生成 ContextManifest、Agent/Human Brief 和后续 task-bound verify 命令，不创建 run 或 worktree；full 才生成 run ID 并调用 controller 准备隔离 worktree。多于一个兼容 stage 时必须在请求中提供 `stageId`。

模式触发规则固定如下：用户未指定时，AI 或宿主使用 `--mode auto`；用户明确说“快速处理”时使用 `quick`，明确要求完整流程时使用 `full`。只有已授权阶段中、无未决阻断、低风险、无副作用与外部权威、只使用仓库读写能力、只写 managed implementation、采用 quick verifier tier 且最高要求为 contract 证据的 implementation 才会得到 `selectedMode: "quick"`；否则返回 `selectedMode: "full"` 与原因。显式 `full`、`--worktree` 或 `--authorization` 始终选择完整流程。

这个入口不自行启动 AI。quick 返回 `executionKind: "in_place"`、brief 和 task-bound verify 命令；验证通过只表示本地任务验证完成，不生成独立审查、EvidenceBundle 或 `accepted` 状态。full 返回 `executionKind: "isolated_run"`、controller envelope 与 runDigest，并沿用完整闭环。

## quick 当前工作区路径

quick 只生成必要的 SpecIndex、TaskPacket、ContextManifest 和 brief；task-bound verify 另外写入忽略跟踪的验证结果。Codex 根据 Agent Brief 在当前工作区实施后，执行 `start` 返回的命令；task-bound verify 未显式给出 `--tier` 时直接采用 TaskPacket 的 tier：

```text
ai-flow verify --project <directory> --task <task-id-or-path> --expected-task-digest <sha256:...> --json
```

验证器运行前会从 base revision 加载 Active Control，并按真实 Git diff 复核 scope、资产分类与 impact；任何越界或需求、验收、verifier 扩张都会阻断。quick 不产生 RunRecord、ReviewReport、AuthorityReceipt 或 EvidenceBundle，也不宣称变更已经在外部目标激活。

## 编译 TaskPacket

请求只必须给出 task ID、目标、完整 base revision、task kind、stage、直接需求和计划改动路径。任务约束、能力、风险、副作用、验证档位和证据等级按需声明；默认是本地低风险、quick、`contract`，不为未发生的能力或高阶证据填充样板字段：

```text
ai-flow task compile --project <directory> --input <request.json>
ai-flow task validate --project <directory> --task <task-id-or-path>
```

四种 task kind 的写入边界是：

- `implementation`：managed implementation；
- `truth_proposal`：canonical 真相、规范和验收；
- `control_plane`：候选控制资产，且运行时必须提供一次性 execution authorization；
- `evidence_collection`：只读采证。

TaskPacket 固定 base commit、完整 SpecIndex digest、Truth/Control components、constraints、scope、资产分类、review lenses、capabilities、任务与验证器副作用以及 verifier 集。未决阶段门、派生 impact 漏报或不允许的资产类会在编译时阻断。

## 上下文与 brief

普通流程不需要单独调用以下命令：`run prepare` 会从 TaskPacket 自动构建 ContextManifest、Agent Brief 与 Human Brief。它们只保留给诊断和预览：

```text
ai-flow context build --project <directory> --input <context-request.json>
ai-flow context render --project <directory> --task <task-id-or-path> --context <context-path> --audience agent
ai-flow context render --project <directory> --task <task-id-or-path> --context <context-path> --audience human
```

Agent Brief 与 Human Brief 从同一 TaskPacket/ContextManifest 确定性渲染。前者显式展示任务约束和完整执行边界，后者只保留便于协作的摘要；两者都不是第二套真相源。用户级 Experience Skill 提供的 Historical reminders 只是并列提醒，不写回 TaskPacket 或 ContextManifest。敏感路径只留下引用，不装载内容。

## full 启动隔离运行

调用者必须明确给出一个尚不存在的绝对 worktree 路径和 UTC 时间：

```text
ai-flow run prepare --project <directory> --task <task-id-or-path> --run <run-id> --worktree <absolute-new-path> --at <UTC-time>
ai-flow run inspect --project <directory> --run <run-id>
```

`prepare` 原子获取项目单写者锁，以 TaskPacket 的完整 base commit 创建 detached worktree，并返回宿主可消费的 execution envelope。RunRecord 只能由这个 controller 入口创建，且只能绑定 controller 创建的隔离 worktree；调用者不能自行构造 RunRecord，或让它指向当前 checkout、项目根目录及其他既有目录。框架不启动 Codex、不注入 SDK，也不限制 envelope 范围内的原生推理和工具使用。

当前运行必须继续使用 base commit 绑定的同一框架分发作为裁判。项目升级导致当前 framework lock 的版本或 distribution digest 与 base 不一致时，`prepare`、`inspect`、`resume` 和后续推进会 fail-closed；先用新 base 重新编译 TaskPacket，不加载旧任务交给新裁判。

control-plane 或外部写入还要传入授权文件：

```text
ai-flow run prepare --project <directory> --task <task-id-or-path> --run <run-id> --worktree <absolute-new-path> --at <UTC-time> --authorization <authorization.json>
```

execution authorization 必须精确绑定 run、TaskPacket、base、Active Control、允许路径、外部效果、有效期和 nonce。普通本地 implementation 不需要这层授权；read-only network 作为 capability 声明即可。

## 推进、恢复与放弃

宿主完成一个阶段后，把结构化推进请求写入项目文件，并直接使用上一次 `prepare` 或成功 `advance` 返回的 runDigest。不确定下一步或需要恢复时，调用 `run inspect` 或 `run resume`，读取返回的 `nextAction`：

```text
ai-flow run advance --project <directory> --run <run-id> --expected-run-digest <sha256:...> --input <advance.json>
ai-flow run resume --project <directory> --run <run-id>
ai-flow run abandon --project <directory> --run <run-id> --expected-run-digest <sha256:...> --at <UTC-time> --reason <text>
```

`nextAction` 是 controller 根据当前 RunRecord、实时边界检查和最新 runDigest 即时生成的确定性提示，不写入 RunRecord。它提供逻辑命令的 `name`、`arguments` 和所需 `inputTemplate`；验证阶段还提供 `afterSuccess`。它不指定可执行文件、不执行命令，也不拦截宿主。真实范围、控制、worktree 或 checkpoint 错误返回 `resolve_blockers`，终态返回 `none`；实现阶段仅有预期的候选内容变化时，仍会提示推进到验证。

候选内容只允许在开始实现，或从实现/返修进入验证时更新。controller 在这些边界自动重建 ContextManifest、Agent Brief 与 Human Brief；调用者不能注入 `contextManifestRef`。进入审查后若内容再变化，必须返回实现/返修并重新验证，不能把旧验证或旧审查绑定到新内容。

`advance` 在每个边界重算真实 diff、subjectContentDigest、资产分类和 impact，并复核 Active Control 与授权。发现范围或需求、验收、verifier 扩张时，当前任务 stale，必须重新编译，不能自动扩大。

`resume` 只有在 task、base、control、worktree identity 和 checkpoint content 全部一致时恢复。若 controller 在 accepted/escalated RunRecord 落盘后、writer lock 删除前中断，对同一 terminal run 再次调用 `resume` 会安全且幂等地回收遗留锁。`abandon` 只把该 run 标为 escalated 并释放锁，保留 worktree、分支和用户内容供人工处理。

## full 验证、审查与 EvidenceBundle

```text
ai-flow verify --project <directory> --tier <quick|deep> --run <run-id>
ai-flow review validate --project <directory> --review <review-id-or-path>
ai-flow run finalize --project <directory> --run <run-id> --expected-run-digest <sha256:...> --input <finalize-request.json>

ai-flow cycle evaluate --project <directory> --input <cycle-input.json>
ai-flow evidence seal --project <directory> --input <evidence-input.json>
ai-flow evidence status --project <directory> --bundle <bundle-path>
```

full 闭环在 verifying 阶段用 `verify --run` 生成绑定结果，推进 reviewing 并完成一次独立审查后，调用 `run finalize`。`finalize-request.json` 提供 bundle ID、UTC 时间、原因、恰好一份独立审查报告，以及任务要求的 authority receipts；该命令在一次调用中依次执行受控 EvidenceBundle 封存和受控 run 推进，两步分别受锁，并非单次原子提交。宿主不再需要手工串联 seal 与 sealed advance。

`cycle evaluate` 和 `evidence seal` 是诊断或集成需要的较低层入口，不是普通宿主流程的必经步骤，也不是可自由拼装任务状态的无状态入口。`cycle-input.json` 至少提供 `run`、`expectedRunDigest` 和 UTC `at`；`evidence-input.json` 至少提供 `bundleId`、`run`、`expectedRunDigest`、UTC `createdAt` 和 `reviewReports`。TaskPacket、ContextManifest、VerificationResult 集合和 `changedPaths` 分别从 RunRecord 的绑定引用及其隔离 worktree 重新装载或计算，输入文件不能覆盖它们。两条命令都会核对当前 run 的单写者所有权、取得操作锁，并校验 compare-and-swap 摘要和 checkpoint 后再裁判。

验证器和审查裁判始终从 base revision 的 Active Control 加载。全部必需 verifier 通过后，新的 reviewer context 还必须覆盖 mandatory lenses；review PASS 不能覆盖 verifier FAIL。返修继续受原 TaskPacket 约束，并在重复 finding、A-B-A 振荡、轮次耗尽、范围扩大或授权问题时停止。

EvidenceBundle 绑定 base、TaskPacket、Active Control、subjectContentDigest、验证结果、审查报告和 authority receipts。任务、运行、审查、证据等过程产物不进入 subject。相同内容在后续提交后仍保持同一 subjectContentDigest；只有外部提交或合并目标接受 Bundle 绑定的精确内容，Candidate 才在该目标中成为 Active。

`run finalize` 在把 run 转为 `accepted` 前，会验证 Bundle Schema 与 canonical digest，以及 run、TaskPacket、Active Control、candidate content、激活目标、证据等级、审查、验证结果和 exclusions 的精确绑定；任一不一致都拒绝接受。只有显式使用较低层 `evidence seal` 的集成方，才需要自行提交 `phase: "sealed"` 的受控 advance。

## 证据等级

`specification → contract → runtime_stub → target_integration → owner → production`

等级固定且不能跳级。Owner 与 production 必须由宿主认证的 authority receipt 证明；AI 自填身份或 PASS 文本不构成授权或验收。

普通开发保持默认 `contract`。只有验收明确要求真实运行环境、外部 Owner 决策或生产事实时，才选择 `runtime_stub`、`target_integration`、`owner` 或 `production`；高等级不是日常流程的固定仪式。

这里的“宿主认证”是前置的信任边界，不由 JSON 中的 `actorRef` 或自摘要自动产生。宿主必须保护 controller 与过程产物目录，只在真实验证、独立 reviewer context 或外部权威事件完成后写入相应契约；Agent 不应直接写 RunRecord、VerificationResult、ReviewReport、AuthorityReceipt 或 EvidenceBundle。若 Agent 与这些路径共享不受约束的操作系统写权限，本框架不提供对该恶意进程的沙箱隔离，也不能据此声明独立审查、Owner 或 production 证据。

## 验证框架自身

```powershell
npm run check
npm run release:check
```

普通检查覆盖契约、安全不变量和两条 golden flow。发布检查另外验证 vendored CLI、真实临时 Git worktree、打包清单和私有制品卫生；不会发布包，也不会调用真实 Codex、网络或 GitHub 作为测试裁判。
