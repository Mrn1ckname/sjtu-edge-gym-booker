# 上海交通大学场馆预约脚本

使用 Node.js、Playwright 和本机 Microsoft Edge 自动选场、提交订单，到支付界面停止。供同学学习浏览器自动化；不保证抢到场地，不绕过验证码，不自动付款。请遵守学校预约规则，避免创建不需要的订单。

## 快速开始

需要 Windows、Microsoft Edge、Node.js 22 或更新版本，以及有预约资格的校内账号。

```powershell
cd outputs/edge-gym-booker
npm ci
Copy-Item config.example.json config.json
npm run login
npm run check
npm run show-time
npm test
```

先将 `config.json` 的 `dryRun` 设为 `true` 演练（只选场，不提交）；确认目标后改为 `false`。`npm run book` 会实际按配置执行，可能创建订单。

安装定时任务：在上述目录运行 `powershell -ExecutionPolicy Bypass -File .\install-schedule.ps1`。

## 默认计划

- 除周三外，每天 11:59:50 启动，12:00 开抢，12:05 截止；预约七天后的 17:00–18:00。
- 周日：气膜体育中心羽毛球，任意可用场地。
- 周一、周二、周四、周五、周六：学生中心健身房。
- 系统时区应设为北京时间 UTC+8；Windows 任务按本机时间启动。
- 允许电池供电；电脑需保持登录、联网及可运行状态，睡眠唤醒受系统电源设置影响。
- 正常通过切换日期更新；登录失效或空页面时整页刷新恢复。失败后等待两秒再尝试，加载时间另计。

## 数据与故障排查

认证文件 `.auth-state.json`、`.edge-profile` 含登录凭据，绝对不要分享。`config.json`、日志、截图和浏览器数据均不纳入 Git。日志保留72小时，独立清理任务每天03:00执行。登录过期可能需要手动登录，无法保证永久有效。

详细配置、认证恢复及运行说明见 [使用文档](outputs/edge-gym-booker/README.md)。主要代码为 `booker.mjs`（流程）、`grid-sync.mjs`（等待新数据）、`diagnostics.mjs`（日志）、`log-retention.mjs`（清理）。

停止自动预约可在 Windows 任务计划程序中禁用 `SJTU-Gym-Booker-Recurring`；清理任务名为 `SJTU-Gym-Booker-LogCleanup`。

## 许可

[MIT](LICENSE)。本项目非学校官方软件，与学校无隶属关系。
