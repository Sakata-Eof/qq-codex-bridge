# 运行与维护

以下命令在项目根目录的 PowerShell 执行。现有实例不需要重复安装、重新配对或重填凭据。

## 日常入口

开始菜单搜索“Codex QQ 控制台”或“Codex QQ 消息历史”。备用脚本是 `./Start.ps1` 和 `./Start.ps1 -History`；只启动而不打开浏览器可使用 `./Start.ps1 -NoBrowser`。同一浏览器验证登录后可收藏普通本机地址。

`./Install-Launchers.ps1` 重建开始菜单入口；`./Install-Autostart.ps1` 安装或更新当前 Windows 用户的登录启动任务 `QQ-Codex-Bridge` 并启动守护。该任务需要用户登录，关机或睡眠期间不会处理 QQ。

`./Stop.ps1` 请求安全停机，并使用停机标志防止守护立即重启。服务忙碌时会拒绝停机；如需中断任务，先由对应账号在 QQ 使用 `/stop`，再确认任务和发送均已结束。

## 健康检查

```powershell
Invoke-RestMethod 'http://127.0.0.1:17329/health'
Get-ScheduledTask -TaskName 'QQ-Codex-Bridge' | Select-Object TaskName, State
```

HTTP 存活、守护运行、QQ 在线和 Codex 可执行是不同条件。管理页需显示 QQ READY；任务执行还要有对应账号的成功结果。检查日志时按故障发生时间限定窗口，脱敏后再分享。

| 现象 | 优先检查 |
| --- | --- |
| 页面无法连接 | `/health`、任务状态、`runtime/stderr.log` 和 `runtime/service.log` |
| 页面提示登录失效 | 用该浏览器重新打开开始菜单入口，勿分享 `setup-url.txt` |
| 历史一直加载 | API 403、读取超时、账号/会话选择及真实记录数量 |
| HTTP 正常但 QQ 不回 | QQ READY、重连日志、配对账号、任务忙碌或审批等待 |
| 任务异常 | 对应账号的 Codex 登录、二进制路径、模型权限、审批和媒体处理错误 |
| 图片/声音异常 | 附件来源、下载、转码、ASR、模型能力及 QQ 实际投递分别检查 |

守护通常在进程退出或连续 HTTP 健康检查失败后恢复服务。若计划任务本身已停止，不能仅靠 HTTP 正常证明守护正常；确认不是主动停机后，通过 `Start.ps1` 恢复。仍需查明任务停止原因，单次恢复不能证明根因已修复。

## 更新和回滚

先保存改动并运行相关检查，确认活动任务、审批、媒体投递和历史导出均已结束。使用 `Stop.ps1` 停机后备份运行数据，再更新源码；运行 `Start.ps1` 恢复。验证 `/health`、守护状态、QQ READY 及实际相关页面。服务启动时读取静态前端，因此前端变更也需要重新加载服务。

回滚前同样停机并备份。选择已知 Git 提交恢复源码；若涉及数据库结构变化，先检查迁移兼容性，不要假设旧代码可以读取新数据库。保留用户未提交改动。

## 发布通知

本机所有者已授权在问题修复和功能上线后通知已绑定账号。管理界面和消息历史界面的改动不发送 QQ 通知。其他改动只有 `runtime/config.json` 的 `releaseNotificationsEnabled` 明确为 `true` 时可发送，其他安装默认不启用。先完成检查、上线和健康验证，再写一份不含账号私有信息的简明说明，并使用唯一稳定的发布 ID：

```powershell
node notify-release.mjs 20261015-mobile-inputs runtime/release-notice.txt --preview
node notify-release.mjs 20261015-mobile-inputs runtime/release-notice.txt
```

脚本调用已登录的本机管理 API，不另开 QQ 网关。发送前后状态保存在 `runtime/release-notifications.json`，各账号历史保留投递记录。相同发布 ID 不重复投递；失败或待核实不能通过换 ID 绕过去重。QQ 是否允许主动消息以平台实际结果为准，API 确认成功也不能证明用户已阅读。服务重启不会自动广播旧通知。

## 备份与恢复

源码用 Git；运行数据用私有备份。完整数据备份包括 `runtime/`、`exports/`（需要保留时）以及配置指向的所有账号工作目录。运行目录含 AppSecret、管理凭据、Codex 登录、记忆和聊天内容，备份应限制为本机用户可访问。

SQLite 使用 WAL。简单可靠的整目录备份应在安全停机后进行，避免只复制主数据库而遗漏 WAL；需要在线备份时使用 SQLite 一致性备份机制。恢复时保持配套配置、数据库、账号状态及工作目录一致，并验证权限与路径。

## 换机或重新安装

先安装兼容的 Node.js，再用 `npm ci` 安装锁定依赖。安装并登录本机 Codex，确认 FFmpeg/FFprobe、Python/ASR 和本地模型路径。`server.mjs` 目前含机器相关默认路径，`Watchdog.ps1` 也含固定 Node 路径；换机前必须校正。重新安装启动任务和快捷方式，并以新机器实际测试为准。

不要把 Git 克隆当成已配置完成的机器人；凭据、账号数据与媒体运行环境不在仓库中。迁移现有实例目录还需同时检查启动任务、快捷方式、允许目录和配置中的绝对路径。
