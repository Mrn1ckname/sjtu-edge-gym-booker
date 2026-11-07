# 上海交通大学场馆预约脚本

使用 Node.js、Playwright 和本机 Microsoft Edge 自动选场、提交订单，到支付界面停止。供同学学习浏览器自动化；不保证抢到场地，不绕过验证码，不自动付款。请遵守学校预约规则，避免创建不需要的订单。

## Windows 新手安装

1. 在仓库页面点绿色 **Code → Download ZIP**。右键下载好的压缩包，选 **全部解压**，放到以后会保留的文件夹。
2. 打开解压后的文件夹，双击 **开始设置.cmd**（隐藏扩展名时显示为“开始设置”）。如果打开了 Node.js 下载页，选择 Windows 的 LTS 安装包，按默认选项安装，再双击一次。
3. 按窗口提示选择预约时段和模式。第一次建议选 **演练**，确认日程后按提示保存。周三休息，周末使用羽毛球配置。
4. 窗口会安装依赖并打开 Edge。按窗口提示完成校内登录，再选择是否启用每天的定时任务。看到安装成功提示后即可关闭窗口。
5. 以后要改时段或切换到真实预约，双击同一个文件重新设置。定时任务依赖这个文件夹，请保留原位置。

## 手动安装和高级设置

### 1. 准备电脑和账号

本教程适用于 Windows。你需要 Microsoft Edge、Node.js 22 或更新版本，以及有场馆预约资格的校内账号。普通使用者不需要安装 Python、Codex 或配置 MCP。

先安装 Node.js（从官网 https://nodejs.org/ 下载），安装时保留加入 PATH 的默认选项。安装完成后重新打开 PowerShell，输入：

```powershell
node --version
npm.cmd --version
```

两条命令都应显示版本号。如果提示“无法识别”，先重开终端；仍然失败则检查 Node.js 是否安装成功。下面统一使用 `npm.cmd`，避免 PowerShell 阻止执行 `npm.ps1`。

### 2. 下载项目并进入正确文件夹

不熟悉 Git 可以在本仓库页面点击绿色 **Code → Download ZIP**，解压到固定目录，例如 `D:\sjtu-edge-gym-booker`。不要直接在压缩包里运行，也不要安装定时任务后随意移动文件夹。

打开解压后的 `outputs` → `edge-gym-booker` 文件夹，点击资源管理器地址栏，输入 `powershell` 并回车。新窗口的当前目录应包含 `package.json`、`booker.mjs` 和 `config.example.json`。输入 `dir` 可以检查。

如果已安装 Git，也可以在 PowerShell 中执行：

```powershell
git clone https://github.com/Mrn1ckname/sjtu-edge-gym-booker.git
cd .\sjtu-edge-gym-booker\outputs\edge-gym-booker
```

以下所有命令都在这个 `edge-gym-booker` 文件夹中运行，每次复制一组并等待完成。

### 3. 安装依赖并创建个人配置

```powershell
npm.cmd ci
Copy-Item config.example.json config.json
notepad config.json
```

`npm.cmd ci` 需要联网，完成后会生成 `node_modules`。本工具使用已安装的 Edge，不需要另外下载 Chromium。

**复制配置只需做一次。** 已经配置过时不要再次复制，否则会覆盖个人设置。仓库中的示例默认 `dryRun` 为 `false`，因此首次使用请先在记事本中把它改为 `true`，保存后再运行预约。

JSON 配置注意：使用英文双引号，布尔值写 `true` / `false`，不能加注释，也不要在最后一项后多写逗号。

### 4. 登录并检查

```powershell
npm.cmd run login
```

等待 Edge 打开，在网页中完成校内登录及需要的验证。使用的是专用浏览器配置，你日常 Edge 已登录不代表这里也已登录。脚本确认登录和场地网格后会保存认证并关闭窗口；以终端成功提示为准。

随后执行：

```powershell
npm.cmd run auth
npm.cmd run check
npm.cmd run show-time
npm.cmd test
```

- `auth`：实际打开网站检查登录，必要时尝试恢复，不下单。
- `check`：检查配置是否合法。
- `show-time`：确认目标日期、场馆及开抢时间，以实际输出为准。
- `test`：本地代码自检，不代表网站当前有名额，也不会真实下单。

登录信息保存在本机 `.auth-state.json` 和 `.edge-profile`，不要发送给同学或上传到 GitHub。

### 5. 先做一次不提交的演练

再次用 `notepad config.json` 打开配置，确认 `dryRun` 为 `true`。如果想现在就演练，设置：

- `targetDate`：改为网站当前可预约的具体日期，例如 `"YYYY-MM-DD"`（必须替换为真实日期）。
- `releaseAt`：改为 `null`（不加引号），表示不等待开抢时间。
- `timeSlots`：选择该日期开放的单小时时段，例如 `["17:00-18:00"]`。
- `activityType`、`bookingUrl`：确认对应你想预约的场馆和项目；周日会应用 `sundayBooking` 的覆盖配置。

运行：

```powershell
npm.cmd run check
npm.cmd run book
```

观察 Edge 中选中的日期、项目和时段。`dryRun: true` 只选场，不提交订单；没有可用名额时会重试，不能用“没有下单”判断脚本故障。需要提前结束时，在终端按 `Ctrl+C`。

### 6. 恢复正式配置并安装定时任务

演练结束后，务必将配置恢复为：

```json
"targetDate": "auto",
"releaseAt": "auto",
"dryRun": false
```

上面仅展示要修改的三项，**不要用它替换整个配置文件**。确认时段、场馆正确，再执行：

```powershell
npm.cmd run check
npm.cmd run show-time
powershell -ExecutionPolicy Bypass -File .\install-schedule.ps1
```

看到 `Scheduled task created` 表示安装完成。脚本将按下面的默认计划自动运行；这会真实创建订单，但不会自动付款。Windows 会直接运行 Node.js，不需要打开 Codex 或保持 PowerShell 窗口打开。

在开始菜单搜索“任务计划程序”，进入“任务计划程序库”，找到 `SJTU-Gym-Booker-Recurring`，核对触发器、下次运行时间和任务是否启用。不要为了验证安装就点击“运行”进行真实预约；非启动窗口会跳过，可先使用上面的演练方法。

电脑应保持开机、登录和联网，系统时区设为北京时间 UTC+8。锁屏可以运行；关机不能运行，睡眠唤醒取决于电源设置。电池供电允许启动，但合盖导致睡眠仍可能错过任务。

### 7. 查看结果、停止和排查

- 成功进入支付界面后脚本停止操作，支付由本人完成；不要只凭浏览器打开就判断成功。
- 出现密码或验证码要求时，需要本人处理；登录不会永久有效。
- 运行记录在 `logs` 文件夹，可先查看最新的 `*-run.log`。日志与截图保留72小时，分享前应检查并遮盖个人信息。
- 停止长期自动预约：在任务计划程序中禁用 `SJTU-Gym-Booker-Recurring`。正在运行的窗口可用 `Ctrl+C` 停止。
- 提示找不到 `package.json`：当前目录不正确，请回到第2步。
- `npm.cmd ci` 下载失败：检查网络后重试；不要删除认证文件来解决依赖下载问题。
- 修改了项目位置或 Node.js 安装路径：在新位置重新运行安装定时任务的命令。
- 查看配置字段说明和完整流程：[详细使用文档](outputs/edge-gym-booker/README.md)。

## 修改场馆、时段和每周计划

使用 `notepad config.json` 修改配置并保存，再运行 `npm.cmd run check`。定时任务每次启动会重新读取配置，无须重新安装依赖。

| 配置项 | 填写方法 |
| --- | --- |
| `bookingUrl` / `activityType` | 普通日期使用的场馆详情链接和项目名，示例为学生中心、健身房 |
| `timeSlots` | 例如 `["17:00-18:00"]`；填写网站上的完整时段 |
| `preferredCourts` | 例如 `["场地10", "场地9"]`，按顺序尝试，均无名额时再选其他可用场地 |
| `excludedCourts` | 不希望选择的场地名称关键词；默认 `[]` |
| `sundayBooking` | 只在周日覆盖基础配置，可独立填写场馆、项目、优先场地和时段 |
| `thursdayBooking` | 可选，只在周四覆盖基础配置，例如 `{ "timeSlots": ["16:00-17:00"] }`；示例文件未启用 |
| `keepOpenMinutes` | 完成或报错后保留预约浏览器的时间，默认60分钟 |

周三跳过是程序和任务安装脚本的默认设置；周六使用基础健身房配置。周日覆盖按**脚本执行当天**判断；自动预约日期为执行日的七天后。手动测试若恰逢周日，也会应用周日覆盖，请同时检查该项。

## 更新已有安装

使用Git下载的用户，在仓库根目录执行：

```powershell
git pull --ff-only origin main
cd .\outputs\edge-gym-booker
npm.cmd ci
npm.cmd test
npm.cmd run check
powershell -ExecutionPolicy Bypass -File .\install-schedule.ps1
```

重新安装同名定时任务会更新启动时间，不会立即抢场。保留原有 `config.json`、`.auth-state.json` 和 `.edge-profile`，不要重新复制示例配置。使用ZIP下载的用户先关闭正在运行的预约脚本，再将新版源码解压到原目录，保留这些个人文件，并执行上述安装依赖、检查和安装任务命令。

## 如何确认预约结果

打开 `logs` 中最新的 `*-run.log`，查找“已到达支付界面并停止”；随后由本人支付。选中绿色格子、点击下单或仅打开订单详情都不能单独作为成功依据。`*-run.jsonl` 记录接口耗时、认证恢复、目标日期、选场及提交结果，排查失败时可与文字日志对照。`sinceReleaseMs` 表示提交时距计划开抢时间的毫秒数。

遇到网络变化或导航中断，程序会重试；正在登录回跳时先等待返回场馆网站。出现密码、滑块等人工验证要求时，请在页面完成。11:59:45启动只提供15秒准备时间，登录过期或网站响应较慢时可能错过最早名额。

## 默认计划

- 除周三外，每天 11:59:45 启动，12:00 开抢，12:03停止预约，随后保留Edge界面60分钟；预约七天后的 17:00–18:00。
- 周日：气膜体育中心羽毛球，优先场地10 → 9 → 8 → 7 → 6 → 5；均不可用时再选其他可用场地。
- 周一、周二、周四、周五、周六：学生中心健身房。
- 系统时区应设为北京时间 UTC+8；Windows 任务按本机时间启动。
- 允许电池供电；电脑需保持登录、联网及可运行状态，睡眠唤醒受系统电源设置影响。
- 正常通过点击目标日期获取新数据；登录失效或空页面时整页刷新恢复。无名额或明确下单拒绝后等待0.3秒，网络失败逐步退避，频率限制等待5秒；加载时间另计。

## 数据与故障排查

认证文件 `.auth-state.json`、`.edge-profile` 含登录凭据，绝对不要分享。`config.json`、日志、截图和浏览器数据均不纳入 Git。日志保留72小时，独立清理任务每天03:00执行。登录过期可能需要手动登录，无法保证永久有效。

详细配置、认证恢复及运行说明见 [使用文档](outputs/edge-gym-booker/README.md)。主要代码为 `booker.mjs`（流程）、`grid-sync.mjs`（等待新数据）、`diagnostics.mjs`（日志）、`log-retention.mjs`（清理）。

停止自动预约可在 Windows 任务计划程序中禁用 `SJTU-Gym-Booker-Recurring`；清理任务名为 `SJTU-Gym-Booker-LogCleanup`。

## 许可

[MIT](LICENSE)。本项目非学校官方软件，与学校无隶属关系。
