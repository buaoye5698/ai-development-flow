# 框架自身控制面

此目录只记录 AI开发流框架自身的 Active Truth/Control 路由和运行产物，不保存由它初始化的其他项目数据。

- `baseline.json`：canonical 框架规格与摘要。
- `decisions/`：阶段门、未决决策及权威解决证据。
- `impact-map.json`：框架路径到需求、验收和 verifier 的影响映射。
- `verifiers/`：从 base revision 加载的确定性验证器注册表。
- `authorizations/`：control-plane 或外部写入的一次性授权。
- `tasks/`：TaskPacket。
- `reviews/`：独立上下文的 ReviewReport。
- `runs/`：RunRecord 与 checkpoint。
- `evidence/`：EvidenceBundle 和 authority receipts。

Candidate Control 不能裁判当前运行；只有外部目标接受证据绑定的精确内容后才成为新的 Active Control。过程产物不进入 subjectContentDigest。

