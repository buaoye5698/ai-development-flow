# __PROJECT_NAME__

本项目使用 AI开发流 `__FRAMEWORK_VERSION__` 作为 Codex/AI 开发控制框架。产品事实、决策、契约、验证器和证据均由本项目独立拥有。

```powershell
npm run ai:doctor
npm run ai:upgrade-check
```

初始化状态为 `draft`。先登记 canonical 产品规格、stage gate、impact map 和 verifier registry，再编译 TaskPacket。普通低风险 implementation 可在当前工作区通过 task-bound verify 完成本地验证；其他任务进入隔离 full 闭环。两者都由 base revision 的 Active Control 裁判，只有 full Candidate 在外部目标接受 EvidenceBundle 绑定的精确内容后才声明激活。

框架不替本项目决定业务或技术栈，也不限制 Agent 在 execution envelope 范围内使用宿主原生能力。
