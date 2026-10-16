# 运行与维护

以下命令在项目根目录的 PowerShell 执行。现有实例不需要重复安装、重新配对或重填凭据。目录整理保留根目录启停入口，`runtime/`、`exports/` 和账号工作目录的用途不变。

## 日常入口

开始菜单搜索“Codex QQ 控制台”或“Codex QQ 消息历史”。备用脚本为：

```powershell
./Start.ps1
./Start.ps1 -History
./Start.ps1 -NoBrowser
```

同一浏览器验证登录后，可收藏 `http://127.0.0.1:17329/` 和 `/history`。新浏览器、Cookie 清除或登录过期时，通过启动入口重新验证。验证链接和 `runtime/setup-url.txt` 含管理凭据，不应分享。

`./Install-Launchers.ps1` 重建开始菜单入口，本地快捷方式副本放在 `exports/launchers/`。`./Install-Autostart.ps1` 安装或更新当前 Windows 用户的登录启动任务 `QQ-Codex-Bridge` 并启动守护。任务需要用户登录，关机或睡眠期间不能处理 QQ。

`./Stop.ps1` 请求安全停机，并写停机标志防止守护立即重启。服务忙碌时拒绝停机；需要中断时，先由对应账号在 QQ 使用 `/stop`，再确认任务及投递结束。再次运行 `Start.ps1` 会清除停机标志并恢复启动。

## 配置位置

配置保存在 `runtime/config.json`，日常修改优先使用管理页。需要直接改文件时先安全停机并备份，不将配置内容提交或粘贴到公开问题中。

| 字段或位置 | 用途与检查 |
| --- | --- |
| `appId`、`clientSecret`、`sandbox` | 专用 QQ 机器人及平台环境；与 Hermes 机器人独立 |
| `adminToken`、`runtime/setup-url.txt` | 本机页面登录；修改凭据后浏览器需重新验证 |
| `users`、`pairingCodes` | 已绑定账号及临时配对码；不要用示例覆盖现有授权 |
| `usersRoot`、账号工作目录及 `allowedRoots` | 工作文件位置与访问边界，账号目录不得重叠 |
| `codexBinary` | Codex 程序；服务会尝试发现本机安装，仍需核对对应账号登录 |
| `python`、`whisperModel` | 本地语音识别；存在 `runtime/asr-venv/Scripts/python.exe` 时优先使用该环境 |
| `ffmpeg`、`ffprobe` | 媒体转换与探测程序 |
| `rotationTurns`、`idleHours` | 下次任务开始时轮换会话的阈值，保留已有设置 |
| 各账号模型设置 | 由管理页或 QQ `/model` 维护，不修改其他账号及桌面 Codex 默认值 |
| `replyFormat` | 默认 Markdown，设为 `plain` 使用纯文本 |
| `releaseNotificationsEnabled` | 仅显式为 `true` 时允许发布通知 |

服务默认监听 `127.0.0.1:17329`，Node 入口可读取 `QQ_CODEX_PORT`；现有 PowerShell 启停和守护仍按默认端口工作。不要将只换端口视为独立开发实例，运行目录、账号数据和机器人网关仍可能冲突。统一路径在 `src/paths.mjs`，默认配置及组装在 `src/app.mjs`，不提供独立运行目录的环境变量开关。

## 健康检查

```powershell
Invoke-RestMethod 'http://127.0.0.1:17329/health'
Get-ScheduledTask -TaskName 'QQ-Codex-Bridge' | Select-Object TaskName, State
```

HTTP 存活、守护运行、QQ 在线和 Codex 可执行分别检查。管理页应显示 QQ READY，模型执行还需对应账号的真实成功结果。日志按故障时间限定窗口，分享前脱敏。

| 现象 | 优先检查 |
| --- | --- |
| 页面无法连接 | `/health`、计划任务、`runtime/stderr.log` 和 `runtime/service.log` |
| 页面提示登录失效 | 用当前浏览器重新打开启动入口，不分享验证链接 |
| 历史转圈或操作延迟 | API 403/超时、所选账号/会话、网络模拟、浏览器绘制及远程软件；在本机直接复核 |
| HTTP 正常但 QQ 不回 | QQ READY、重连日志、配对账号、任务忙碌或等待审批 |
| 任务异常 | 对应账号的 Codex 登录、程序路径、模型权限、审批和媒体处理错误 |
| `workspace routing discovery failed` | 对应账号 Codex 路由发现、网络与登录状态，见下文 |
| 图片或音频异常 | 来源、下载、转码、ASR、模型能力和 QQ 实际投递分别检查 |

守护通常在进程退出或连续 HTTP 健康检查失败后恢复服务。若计划任务本身已停止，不能仅靠 HTTP 正常证明守护正常；确认不是主动停机后，通过 `Start.ps1` 恢复。仍需查明任务停止原因，单次恢复不能证明根因已修复。

### 历史页加载与性能

切换时显示动画并锁定账号、会话、搜索和翻页交互，消息绘制后解锁；读取失败时恢复操作并提供重试。先检查登录状态和实际请求，再区分数据库查询、HTTP、DOM 绘制、附件下载及远程桌面响应。

用户已在本机确认会话切换正常，先前体感卡顿来自远程软件。出现新问题仍按当前时间窗取证，不将过去远程操作的延迟当作本机查询故障。性能对照方法见 [PERFORMANCE](PERFORMANCE.md)。

历史页展开“账号最近任务”可分开检查模型执行和 QQ 投递，并查看中文阶段原因；QQ `/status` 提供当前聊天的短任务号与摘要。任务记录只覆盖升级后新任务，采集失败和待确认状态不能当成没有执行；先核对结果，勿自动重提或补发。恢复、接口和离线预览见 [TASKS](TASKS.md)。

### 工作区路由发现失败

`workspace routing discovery failed` 是 Codex 返回的执行错误。对照历史中的失败时间，以及对应账号 `codex-home/sessions` 的 `task_complete`、`codex-home/logs_2.sqlite` 的路由与重试记录，区分任务仍在执行和已经失败。Codex 可能先重试 WebSocket，再回退 HTTP；切换传输后仍报同一错误时，检查共同的路由发现环节，不能仅据此判定图片解析或 QQ 网关异常。

`account/read` 显示已登录、QQ READY 或 HTTP 成功，都不能替代真实模型调用。用隔离测试会话验证文字、图片和后续请求，避免自动重放原任务或向 QQ 额外投递。当前调用恢复只证明当前可用；缺少当时连接或服务端错误时，不认定具体网络原因已修复。持续失败时，待任务和投递结束后，在控制台重新连接 Codex，再核对账号登录及网络。

## 更新和回滚

1. 保存当前源码改动，运行 `npm run check`、相关测试，按变更范围检查实际页面或媒体链路。
2. 确认活动任务、审批、媒体投递和历史导出全部结束，用 `Stop.ps1` 安全停机。
3. 备份运行数据，再更新源码；保留已有账号配置、目录和授权。
4. 运行 `Start.ps1` 恢复，检查 `/health`、守护、QQ READY 及改动涉及的真实入口。

服务启动时缓存 `public/` 的前端文件，页面变更也需重新加载服务。仅刷新浏览器不足以读取新源码。

回滚前同样停机并备份。选择已知 Git 提交恢复源码；涉及数据库结构时先核对迁移兼容性，不假设旧代码能读新数据库。保留用户的未提交工作。

## 发布通知

管理界面和消息历史界面的改动不发送 QQ 通知。其他问题修复和功能上线后，只有本机 `releaseNotificationsEnabled=true` 才按已授权范围通知绑定账号。先完成检查、上线及健康验证，再准备不含账号私有信息的简明说明，使用唯一稳定的发布 ID：

```powershell
node notify-release.mjs 20261016-example-change runtime/release-notice.txt --preview
node notify-release.mjs 20261016-example-change runtime/release-notice.txt
```

上例 ID 仅为格式示例，每次实际发布确定自己的稳定 ID。根 `notify-release.mjs` 保留原调用方式，实际实现位于 `scripts/ops/notify-release.mjs`。预览确认正文、人数和启用状态后，再发送。

脚本调用已登录本机管理 API，不另开 QQ 网关。状态保存在 `runtime/release-notifications.json`，历史保留各账号投递记录。同一发布 ID 不重复投递；失败或待核实不能通过换 ID 绕过去重。平台返回成功也不能证明用户已读，服务重启不自动广播旧通知。

## 验证资料与目录清理

| 位置 | 内容 |
| --- | --- |
| `exports/<账号目录键>/` | 管理页导出的会话 JSON |
| `exports/verification/reports/` | 实际 Codex、媒体、菜单等验证报告 |
| `exports/verification/screenshots/` | 私有页面验收截图 |
| `exports/verification/logs/` | 归档验证日志 |
| `exports/launchers/` | 本地快捷方式副本 |
| `runtime/*.log`、`runtime/history.sqlite` | 在线服务日志与历史审计 |

源码之外的资料按用途归档，不删除原始证据；上述导出与运行资料均不提交。结构整理不移动账号工作目录，也不清空 `runtime/`。`npm test` 是离线检查，`scripts/probes/` 会实际调用模型并写报告，运行前先阅读，不能为了查状态盲目重跑。

## 备份与恢复

源码用 Git，运行数据用私有备份。完整备份包括 `runtime/`、需要保留的 `exports/`，以及配置指向的所有账号工作目录。运行目录含 AppSecret、管理凭据、Codex 登录、记忆和聊天内容，备份应限制为本机用户可访问。

SQLite 使用 WAL。整目录备份应在安全停机后进行，避免只复制主数据库而遗漏 WAL；在线备份需使用 SQLite 一致性备份机制。恢复时保持配套配置、数据库、账号状态及工作目录一致，验证权限与路径。备份与恢复演练仍列在 [BACKLOG](BACKLOG.md)。

## 换机或重新安装

安装兼容 Node.js 后，运行 `npm ci`。安装并登录本机 Codex，核对 FFmpeg/FFprobe、Python、ASR 模型及账号工作目录。`src/app.mjs` 的默认媒体路径和 `Watchdog.ps1` 的 Node 路径仍有机器假设，换机必须检查。

重新安装启动任务和快捷方式，再以新机器的真实任务结果验证。不要把 Git 克隆当作已配置完成的机器人：凭据、授权、账号工作数据和媒体环境不在仓库中。移动现有实例目录时还要核对启动任务、快捷方式、允许目录和配置中的绝对路径。
