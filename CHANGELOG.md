# 当前版本

## 1.0.0（滚动最新版）

- 只维护一个当前发行，`frameworkVersion` 固定为 `1.0.0`，不维护 patch/minor 版本序列。
- 兼容内容变化由 `distributionDigest` 与受管文件摘要精确识别；`schemaVersion` 仅用于不兼容的产物契约。
- Agent Brief 内联绑定后的需求与验收正文；`init --demo minimal` 提供显式可运行样例，默认 `init` 仍保持待配置骨架。
- 摘要、Task、Run、Review、Evidence 与基准裁判绑定保持不变；旧分发裁判不能放行新候选。
- `run inspect` 与 `run resume` 返回不落盘的确定性 `nextAction`；普通审查出口由 `run finalize` 一次完成证据封存与接受。
