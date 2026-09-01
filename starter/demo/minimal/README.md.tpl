# __PROJECT_NAME__

这是显式选择的 AI开发流 minimal demo，不是默认项目模板，也不代表真实业务项目的产品事实。

```powershell
node --test tests/normalize.test.mjs
git init
git add .
git -c user.name="AI Flow Demo" -c user.email="demo@example.invalid" commit -m "initialize minimal demo"
node tools/ai-flow/bin/ai-flow.mjs start --project . --input demo-task.json --mode auto --json
```

最后一条命令会生成完整 TaskPacket，并在系统临时目录准备隔离 worktree。demo 的 baseline、stage、impact map 和 verifier 已配置为可运行状态。
