# AI开发流

AI开发流是一套跨项目复用的 Codex/AI 开发控制框架。它不替 Agent 思考，也不替项目决定业务和技术栈；它只在关键边界固定真相、任务、权限、验证、独立审查和证据。

核心原则：**轻执行壳，强确定性裁判；最小充分，验收即停。**

本 README 是架构概览；[框架规格](docs/framework-spec.md) 是当前唯一正式内容真相源。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| 项目拥有事实 | 通用核心不保存具体产品、厂商、环境或部署值，项目通过 baseline、规格、决策、契约和验证器注入差异 |
| Active 与 Candidate 分离 | base commit 中的 Truth/Control 才是当前裁判；候选修改不能修改规则后给自己 PASS |
| 任务即契约 | TaskPacket 固定目标、需求、验收、任务约束、范围、风险、副作用、验证器和证据等级 |
| 实际结果重新裁判 | 不只检查计划；实现后根据真实 diff 重算 scope、资产、impact 和内容摘要 |
| 机器证据优先 | verifier 负责确定性 PASS/FAIL，独立审查不能覆盖 verifier FAIL |
| 证据绑定内容 | EvidenceBundle 绑定精确候选内容，而不是 AI 自述、文件存在、命令字符串或分支名称 |
| 权限不随进度扩张 | “继续、做完、不要停”不自动授权部署、发布、生产写入或删除 |
| 经验只做提醒 | 历史案例帮助写前预防和写后复查，但不进入正式任务契约或裁判 |

## 架构总览

```text
Active Truth + Active Control（base commit）
                 ↓
             TaskPacket
                 ↓
     ContextManifest + Agent Brief
       （显式展示 constraints）
                 ↓
       isolated Candidate worktree
                 ↓
       actual diff / impact / digest
                 ↓
        deterministic verifiers
                 ↓
       independent covered review
                 ↓
            EvidenceBundle
                 ↓
       外部目标接纳精确内容后激活
```

框架不拦截 Agent 的每一次推理和工具调用。宿主把 controller 生成的 execution envelope 交给 Codex、IDE 或自动化执行者，再把真实结果交回确定性裁判。

## 真相、控制与候选内容

- **Active Truth**：baseline 登记的 canonical 规格、Owner 决策和验收。
- **Active Control**：base commit 中的配置、Schema、资产策略、impact map、verifier registry 和 AGENTS 指令链。
- **Candidate Change**：隔离 worktree 中尚未被目标接纳的修改，包括候选规格和候选控制规则。
- **subjectContentDigest**：由 base commit 与最终变更条目计算，覆盖原始字节、Git mode、删除、符号链接和 gitlink；过程产物不参与摘要。

Candidate Control 在当前运行中只能被测，不能成为自己的裁判。只有外部目标接纳 EvidenceBundle 绑定的精确内容，Candidate 才在该目标中成为新的 Active。

## 核心契约

| 产物 | 职责 |
| --- | --- |
| SpecIndex | 固定规格来源、适配器、框架分发、base revision 与内容摘要 |
| TaskPacket | 固定单次任务的目标、约束、范围、资产、能力、风险、副作用、验证和审查要求 |
| ContextManifest / Brief | 从同一任务确定性选择上下文并生成 Agent/Human Brief |
| RunRecord | 记录隔离 worktree、阶段、CAS、checkpoint、授权消费、能力和观察项 |
| VerificationResult | 绑定验证器定义、输入、输出和证据等级 |
| ReviewReport | 由不同上下文覆盖 mandatory lenses |
| AuthorityReceipt | 证明 Owner 或 production 等外部权威事件 |
| EvidenceBundle | 汇总并绑定完整证明链与目标激活状态 |

所有机器契约采用封闭 JSON Schema。未知字段、缺失绑定、摘要漂移、实际影响扩张或证据跳级均 fail-closed。

## 任务与权限

| task kind | 允许写入 |
| --- | --- |
| `implementation` | managed implementation |
| `truth_proposal` | canonical 真相、规格和验收 |
| `control_plane` | 候选控制资产，并消费一次性 execution authorization |
| `evidence_collection` | 不写候选内容，只读采证 |

`unmanaged`、`sensitive` 和过程产物不能通过宽泛路径获得写权限。任务请求声明的副作用与所选验证器副作用会合并进入 TaskPacket；网络写入、外部服务写入、物理和生产动作必须由独立授权覆盖。

## 运行闭环

```text
prepare → implementing → verifying → reviewing
                    ↘ repair ↗
               → sealed → accepted
```

1. `task compile` 从完整 base commit 自动生成 SpecIndex，并结合决策、impact map 和 verifier registry 生成 TaskPacket。
2. `run prepare` 获取单写者锁、创建 detached worktree，并自动生成 ContextManifest 与 brief。
3. Agent 只在 envelope 和 TaskPacket 范围内实现；Controller 根据真实 diff 重算内容、资产和影响。
4. 确定性验证通过后，由新的 reviewer context 覆盖 `spec_conformance`、`scope`、`evidence`。
5. `evidence seal` 绑定全部结果；`run advance` 复核新鲜度后接受，并直接返回下一次操作使用的 runDigest。

`spec compile`、`context build/render` 和 `run inspect` 保留为诊断与恢复入口，不属于普通任务的必经步骤。

`resume` 只有在 task、base、control、框架分发、worktree identity 和 checkpoint content 全部一致时恢复。`abandon` 只停止运行并保留现场，不删除用户内容。

## 验证、审查与完成定义

证据等级固定且不能跳级：

```text
specification → contract → runtime_stub → target_integration → owner → production
```

普通开发默认使用 `contract`；只有验收确实依赖真实集成、Owner 或生产事实时才提高等级。

- 静态检查、单测、本地运行、部署和生产可用是不同完成层级。
- Owner 与 production 只能由宿主认证的 authority receipt 证明。
- review PASS 不能覆盖 verifier FAIL。
- 敏感内容不进入上下文、日志或 EvidenceBundle，只保留安全引用。
- 未决决策、真相冲突、重复 finding、A-B-A 振荡、范围扩大、轮次耗尽或授权问题会停止自动循环。

## 信任边界与非目标

Controller、宿主桥接、认证通道和过程产物目录构成受信边界。摘要证明内容绑定，不是身份签名；如果宿主不能保护这些边界，就不能宣称独立审查、Owner 或 production 证据。

框架明确不建设通用多 Agent 平台、知识库、配置中心、PKI、Policy Pack、Capability Registry 或独立 ChangeSet，也不自动提交、合并、部署、发布或执行真实外部副作用。

正式扩展点只有三个：规格适配器、验证器适配器、执行宿主桥接。

## 快速入口

要求 Node.js 20+，核心零运行时依赖。

```powershell
node bin/ai-flow.mjs self-check
node bin/ai-flow.mjs init ./new-project --id example-project --name "Example Project" --spec ./product-spec.md
node bin/ai-flow.mjs doctor ./new-project
node bin/ai-flow.mjs start --project ./new-project --input ./small-fix.json --mode auto --json
npm run check
```

普通小改动和缺陷修复可用 `start` 的三字段短请求进入：目标、计划改动路径、直接需求。`auto` 默认自主选择，用户明确要求快速或完整流程时可用 `quick` 或 `full`；quick 资格由确定性规则裁决，不合格自动回落 full，二者都生成完整 TaskPacket 并经过同一控制器。

`init` 不覆盖已有目录；`adopt` 默认只读，显式应用也只创建缺失文件。发布前再运行 `npm run release:check`。

## 仓库导航

```text
bin/             ai-flow 命令入口
src/core/        确定性、无副作用核心
src/controller/  隔离运行与生命周期裁判
src/task/        TaskPacket、ContextManifest 与 Brief
src/verify/      验证器、缓存与真实 Git diff
src/workflow/    审查、周期、证据与新鲜度
schemas/         当前机器契约
starter/         可复制项目骨架
ai-dev/          本框架自身控制面
docs/            规格、契约、使用和扩展说明
tests/           安全不变量与 golden flows
```

- [框架规格](docs/framework-spec.md)：规范性需求与验收矩阵。
- [契约与不变量](docs/contracts.md)：机器产物及绑定语义。
- [完整使用方式](docs/usage.md)：命令闭环与运行规则。
- [扩展点](docs/extension-points.md)：三个正式扩展边界。
