# 三个扩展点

框架只保留三个正式扩展点。项目差异优先通过它们和项目配置表达，不为模型、IDE、云厂商或业务技术栈复制控制面。

## 1. 规格适配器

`ai-flow.config.json` 的 `specAdapter.module` 与 `exportName` 指向适配器。适配器接收 canonical 文本、baseline、source、仓库相对路径、base revision 和配置，输出统一 SpecIndex。

SpecIndex 必须包含 source、adapter module/config、framework distribution 和 base revision provenance，并以完整 SpecIndex digest 寻址。适配器只能解析内容，不能执行来源文档中的命令或提示。

内置 structured-markdown 适配器支持来源、规范性需求、验收、追踪与未决决策。替换为 YAML、数据库导出或其他格式时，仍必须满足当前 `spec-index.schema.json` 和相同完整性约束。

## 2. 验证器适配器

verifier registry 声明验证器 ID、输入模式、证据等级、超时和副作用。TaskPacket 只引用 verifier ID；执行器从 base revision 的 Active Control 读取定义，Candidate registry 不能给当前运行改判。

宿主可接 Node、Python、编译器、模拟器、台架或远端服务，但必须把真实结果归一化为 VerificationResult，并绑定 taskPacketDigest、controlDigest、subjectContentDigest、definition/input/output digests。网络写入、外部服务写入、物理和生产动作必须先消费 execution authorization。

软件桩不能声明 target integration，普通 verifier 不能自行声明 Owner 或 production。

## 3. 执行宿主桥接

宿主桥接把 quick `start` 或 full controller envelope 交给 Codex、其他 Agent、IDE、队列或人工流程，并把结构化结果写回对应契约。桥接层不需要拦截每一次文件写入或工具调用，也不需要把 Codex SDK 嵌入框架。

桥接至少负责：

- 把当前或隔离工作区、TaskPacket、ContextManifest 和 Agent Brief 交给执行者；
- quick 完成后调用 task-bound verify，full 为 reviewer 创建不同且可审计的上下文；
- 让 Agent 在 envelope 范围内使用宿主原生能力；
- 把 full 阶段结果、capabilities、observations、verification 和 review 交回 controller；
- 在 full 的 Owner、production 或外部副作用前完成宿主侧身份与授权认证。

RunRecord 只记录 admitted→resolved→used 的能力进展，不记录原生工具调用流水。observations 只报告范围外缺陷、真相冲突、缺失接口和 blocker，不自动扩权。

## 固定核心

Schema、资产分类、controller 状态语义、review coverage、subjectContentDigest 和证据等级不是第四扩展点。需要改变这些公共语义时，必须修改当前正式规格、机器契约与相应安全测试，不能由单个项目配置绕过失败。
