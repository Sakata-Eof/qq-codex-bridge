# 运行与维护

在项目根目录执行维护命令。`.ps1` 入口在 Windows PowerShell 中运行，其他系统使用 npm 前台入口。现有实例不需要重复安装、重新配对或重填凭据。

## 日常入口

首次部署在 `npm ci` 后按[运行环境检查](#运行环境检查)核对依赖，再运行 `./Install.ps1`，自动识别 Node.js 24 或更高版本，安装当前用户的登录启动任务及开始菜单入口，并启动、打开控制台。`./Install.ps1 -NoBrowser` 只安装并启动后台。Node 路径保存在 `runtime/windows-host.json`；路径失效时从进程及当前用户、机器 PATH 重新发现，不再依赖特定机器的 Node 安装目录。媒体环境仍需单独核对，见[换机或重新安装](#换机或重新安装)。

日常在开始菜单搜索“Codex QQ 控制台”或“Codex QQ 消息历史”，也可直接运行脚本：

```powershell
./Start.ps1
./Start.ps1 -History
./Start.ps1 -NoBrowser
./Restart.ps1
./Restart.ps1 -OpenBrowser
./Status.ps1
./Stop.ps1
```

同一浏览器验证登录后，可收藏 `http://127.0.0.1:17329/` 和 `/history`。新浏览器、Cookie 清除或登录过期时，通过启动入口重新验证。验证链接和 `runtime/setup-url.txt` 含管理凭据，不应分享。

统一安装入口可重复运行，也用于升级旧入口：先验证 Node、依赖及计划任务归属，已有实例安全停机成功后才更新任务、快捷方式并启动新守护。服务忙碌或停机结果未确认时会终止安装，先处理对应任务再重试。原 `./Install-Launchers.ps1` 和 `./Install-Autostart.ps1` 保留，分别重建开始菜单入口、安装或更新当前用户的登录启动任务 `QQ-Codex-Bridge` 并启动守护；快捷方式副本放在 `exports/launchers/`。启动器由 Windows 自带的 .NET 编译器生成到 `runtime/launchers/`，通过 `CreateNoWindow` 启动 PowerShell，服务子进程也不创建控制台窗口。任务等待守护退出，以保留单实例和失败退出状态。

自启发生在当前用户登录后。登录任务还每分钟尝试运行守护；服务进程退出或连续健康检查失败由守护恢复，守护或任务被结束后由下次周期尝试恢复。手动禁用、删除计划任务后不会自动恢复；关机、睡眠或尚未登录时不能处理 QQ。周期触发是恢复机会，不代表服务一定能在一分钟内就绪，依赖错误仍需排查。完整重启电脑后的登录启动仍需受控验收。

`./Restart.ps1` 先请求安全停机，确认服务和守护退出后再启动，默认不打开浏览器；加 `-OpenBrowser` 可打开控制台。服务拒绝停机或停机结果未确认时会报错终止，不继续重启。脚本、启动器或守护更新后也需要重启加载；只重新注册任务不会替换已经运行的旧守护。启动器使用源码摘要命名，升级时不会覆盖仍在运行的程序，生成的 EXE 不纳入 Git。启动器错误及 PowerShell 输出记录在 `runtime/launcher.log`，服务日志仍在原位置。

`./Stop.ps1` 请求安全停机，并写入 `runtime/stop.flag`。主动停机标志持续阻止守护、周期触发及后续登录自动恢复；再次运行 `Start.ps1` 或安装入口才明确恢复。服务忙碌时拒绝停机；需要中断时，先由对应账号在 QQ 使用 `/stop`，再确认任务及投递结束。`./Status.ps1` 分别显示服务、守护、计划任务和主动停机状态，便于区分故障与有意暂停。

`./Uninstall-Autostart.ps1` 先安全停机，成功后移除登录启动计划任务；停机失败则终止卸载。它保留运行数据和开始菜单快捷方式，之后仍可用 `Start.ps1` 手动启动；需恢复自启时重新运行 `Install.ps1`。

## 跨平台前台启动

在当前用户可写的目录克隆项目。准备 Node.js 24 或更高版本，并在运行桥接的系统和用户下安装、登录 Codex。以下命令用于 Windows、Linux 和 macOS，也可在 WSL 使用 Linux 版 Node 和 Codex。

```sh
npm ci
npm run check:env
npm start
```

日志显示本机监听地址后，在本机浏览器打开 `runtime/setup-url.txt` 中包含 `#` 片段的完整链接。这个文件含管理凭据，应仅由本机所有者读取。服务在当前终端前台运行，等任务、审批、投递和导出结束后按 Ctrl+C 退出。同一份源码目录只启动一份服务。Windows 的登录自启、开始菜单和守护由上节的 PowerShell 入口提供。

首次保存机器人凭据后，等控制台显示 QQ READY，再生成配对码并用对应账号私聊机器人。新实例在项目内 `work/qq-users/` 下创建独立工作目录，`work/` 已列入 Git 忽略。文本任务可先独立验收。需要本地转写和视频处理时再装媒体依赖并运行 `npm run check:env -- --media`。`/voice` 语音合成依赖 Windows 语音引擎。

如果旧版已生成配置，且首次配对因默认目录无法创建而失败，先停机，将 `runtime/config.json` 的 `usersRoot` 改为当前用户可写的绝对路径，再启动并配对。

## 配置位置

配置保存在 `runtime/config.json`，日常修改优先使用管理页。需要直接改文件时先安全停机并备份，不将配置内容提交或粘贴到公开问题中。

管理页的“账号独立记忆”按已绑定账号提供查看、新增、修改和删除，与 QQ `/memory`、`/remember`、`/forget` 读取同一文件。保存从该账号下一次任务起加载，其他账号保持独立。状态自动更新保留草稿；QQ 或其他页面修改后，旧页面保存会被拒绝。冲突或超时后先复制需要保留的草稿，再点击该账号“刷新记忆”核对结果，不重复点击保存。刷新有未保存草稿时需确认丢弃；读取失败会保留草稿，不能误认为记忆为空。

自动记忆默认开启。各账号在同一区域分别保存“自动记忆”开关和回顾间隔，默认每 10 个成功完成轮次后台提炼一次；关闭立即阻止新的自动写入，已有记忆和手动维护仍然可用。新会话也会主动提炼有长期价值的信息。已有会话升级后保持上下文并先使用后台回顾，后续自然换会话或 `/new` 后启用对话内记忆工具，无须为开启功能强制换会话。

条目显示自动或手动来源、类别与原文依据。手动条目，以及手动编辑过的自动条目，都由用户维护；后台不会为了腾空间删除它们。删除内容的摘要哈希保存在账号的 `private-memory.settings.json`，阻止相同内容被直接自动加回；确需恢复时可手动添加。后台计数和尝试状态在 `memory-review-state.json`，账号自己的技能副本在 `codex-home/skills/qq-memory-learning/`，这些文件均属于运行数据备份范围，不纳入 Git。重启不会补扫旧聊天或重放未确认回顾。

只在需要验证记忆接入时运行 `node scripts/probes/memory-learning.mjs`；它调用真实本机 Codex，使用隔离的合成账号和工作目录，验证普通聊天提炼与后台回顾，不连接 QQ，不改绑定账号记忆。只验证后台部分可加 `--review-only`，报告保存到 `exports/verification/reports/memory-learning.json`。接口或探针成功不能替代真实 QQ 客户端验收。

| 字段或位置 | 用途与检查 |
| --- | --- |
| `appId`、`clientSecret`、`sandbox` | 专用 QQ 机器人及平台环境；与 Hermes 机器人独立 |
| `adminToken`、`runtime/setup-url.txt` | 本机页面登录；修改凭据后浏览器需重新验证 |
| `users`、`pairingCodes` | 已绑定账号及临时配对码；不要用示例覆盖现有授权 |
| `usersRoot`、账号工作目录及 `allowedRoots` | 工作文件位置与访问边界。新实例的 `usersRoot` 默认是项目内 `work/qq-users/`，升级沿用已保存的根目录和各账号目录，账号目录不得重叠 |
| `codexBinary` | Codex 程序；服务及每个账号进程启动前检查路径，桌面安装的旧版本被移除时重新发现可用版本；显式自定义路径不自动替换，仍需核对对应账号登录 |
| `python`、`whisperModel` | 本地语音识别。默认优先使用 `runtime/asr-venv` 下的 Python，其次从 PATH 查找 `python`，Linux 和 macOS 也会尝试 `python3`。未指定模型时从当前用户的 Hugging Face 缓存发现 faster-whisper-small |
| `ffmpeg`、`ffprobe` | 媒体转换与探测程序 |
| `rotationTurns`、`idleHours` | 下次任务开始时轮换会话的阈值，保留已有设置 |
| 各账号模型设置 | 由管理页或 QQ `/model` 维护，不修改其他账号及桌面 Codex 默认值 |
| `replyFormat` | 默认 Markdown，设为 `plain` 使用纯文本 |
| `releaseNotificationsEnabled` | 仅显式为 `true` 且变更属于 QQ 用户可感知范围时允许发布通知 |

服务默认监听 `127.0.0.1:17329`，Node 入口支持 `QQ_CODEX_PORT`；计划任务不会持久化调用端的环境变量，因此计划任务安装及关联启停只允许默认端口 `17329`，非默认端口会被拒绝。不要将只换端口视为独立开发实例，运行目录、账号数据和机器人网关仍可能冲突。统一路径在 `src/paths.mjs`，默认配置及组装在 `src/app.mjs`，不提供独立运行目录的环境变量开关。

## 运行环境检查

同一个检查脚本可从各系统的 npm 入口运行。

```sh
npm run check:env
npm run check:env -- --media
```

Windows 启动入口读取进程、当前用户和机器的 PATH，合并 Node 与系统工具目录；仅在相关进程内使用，不写用户或机器环境设置。`Resolve-BridgeNode` 临时刷新发现环境后恢复调用终端 PATH。服务统一发现工具并保存本次运行的绝对路径，配置仍保留原始命令或显式路径；默认 Python 和 Whisper 模型不包含固定用户名。显式自定义路径失效时应修正配置，不会悄悄改用别的程序。

```powershell
./Check-Environment.ps1
./Check-Environment.ps1 -Media
# Node 未登记到 PATH 时，可为本次检查显式指定
./Check-Environment.ps1 -NodePath 'C:\Program Files\nodejs\node.exe' -Media
```

PowerShell 检查入口会先解析 Node 绝对路径，再运行 `scripts/ops/check-environment.mjs`。JSON 输出列出已找到和缺少的工具。默认检查在 `coreReady=false` 时返回非零退出码。npm 的 `--media` 或 PowerShell 的 `-Media` 还要求 `mediaReady=true`。此检查只读配置，也可在服务首次启动前运行。

| 结果 | 能说明什么 |
| --- | --- |
| `coreReady` | Node.js 24 或更高版本可用，Codex 程序路径存在 |
| `mediaReady` | Python、FFmpeg/FFprobe 可定位，Python 可发现 faster-whisper 包，模型目录含 `model.bin` 和 `config.json` |
| `tools`、`fasterWhisper`、`whisperModel` | 具体缺项或已解析路径，辅助工具缺少不必然影响文字任务 |

两个就绪字段分别描述宿主核心和媒体依赖，不证明命令沙盒获准执行程序、Codex 已登录、模型权限有效、模型实际加载成功或 QQ 已收到回复。服务启动时记录相同诊断，认证后的 `GET /api/environment` 返回该快照；`Status.ps1` 的 `CoreToolsReady`、`MediaToolsReady` 读取运行服务摘要，取不到时为空，不能当作已通过。新电脑安装、真实 QQ 客户端及完整重启后的验收仍需分别完成。

## 健康检查

```powershell
Invoke-RestMethod 'http://127.0.0.1:17329/health'
./Status.ps1
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
| `spawn ...codex.exe ENOENT` | 目标程序已不存在；核对桌面安装目录及配置路径。账号进程启动前会重新发现被移除的桌面版本，自定义路径需人工修正；不要自动重放原任务 |
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

1. 保存可回滚的源码改动，按 [开发约定](../CONTRIBUTING.md#验证怎么选) 完成与本次范围匹配的检查；部署不重复已通过的相同测试。
2. 确认活动任务、审批、媒体投递和历史导出全部结束，用 `Stop.ps1` 安全停机。
3. 涉及运行配置、持久化数据或数据库结构变更时，备份受影响数据及恢复所需的配套状态，再执行更新。仅改源码且不改变数据兼容性时，无需复制整个 `runtime/`；保留已有账号配置、目录和授权。
4. 运行 `Start.ps1` 恢复，检查 `/health`、守护、QQ READY 及改动涉及的真实入口。

服务启动时缓存 `public/` 的前端文件，页面变更也需重新加载服务。仅刷新浏览器不足以读取新源码。

回滚前同样安全停机；涉及运行数据变更时先备份配套状态。选择已知 Git 提交恢复源码；涉及数据库结构时先核对迁移兼容性，不假设旧代码能读新数据库。保留用户的未提交工作。

## 发布通知

只有 QQ 端用户能感知的功能或行为变化，才属于发布通知范围，例如 QQ 指令、回复、附件、审批或结果投递的实际变化。QQ 用户感知不到的本机维护、无窗口启动、管理界面、消息历史界面、纯重构及文档改动不通知；无法说明具体 QQ 端影响时也不发送。配置为 `releaseNotificationsEnabled=true` 不代表每次改动都要通知。

符合上述范围的改动完成检查、上线及健康验证后，还需本机 `releaseNotificationsEnabled=true` 才能通知绑定账号。正文说明具体 QQ 端变化，不包含账号私有信息，使用唯一稳定的发布 ID：

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

按[跨平台前台启动](#跨平台前台启动)安装并检查依赖。从旧机器恢复数据时，先在新系统登录 Codex，再核对 `usersRoot`、每个账号的工作目录及其他显式绝对路径。启动后分别检查控制台、QQ READY 和真实文字任务结果。媒体功能按实际使用范围验收。

运行 `./Install.ps1` 自动安装或更新启动任务及快捷方式，记录本机 Node 路径，无须手工复制开始菜单入口。恢复旧数据后也重新运行安装入口，以新机器路径为准，再用 `Status.ps1` 和新机器的真实任务结果验证。不要把 Git 克隆当作已配置完成的机器人：凭据、授权、账号工作数据和媒体环境不在仓库中。

已安装自启的实例需要移动目录时，先在原路径运行 `./Uninstall-Autostart.ps1` 安全停机并卸载任务，成功后再移动，在新路径运行 `./Install.ps1` 重建任务和快捷方式；随后核对允许目录及配置中的绝对路径。不要直接在新路径覆盖旧任务：归属检查会拒绝操作其他目录的任务，以避免误停或误改已有实例。
