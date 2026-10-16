# QQ–Codex Bridge

[GitHub 仓库](https://github.com/Sakata-Eof/qq-codex-bridge) · [MIT 许可](LICENSE)

通过专用 QQ 官方机器人，在 QQ 中使用 Windows 本机 Codex。每个已配对账号拥有独立的 Codex 进程、工作目录、会话、审批、模型设置和历史；本机管理页负责配对与配置，消息历史页用于检索、复制和导出。

## 已有实例怎么使用

在 Windows 开始菜单搜索“Codex QQ 控制台”或“Codex QQ 消息历史”。也可以在项目根目录运行：

```powershell
./Start.ps1           # 启动服务并打开管理页
./Start.ps1 -History  # 打开消息历史
./Start.ps1 -NoBrowser
```

现有实例不需要重新填凭据或配对。浏览器首次通过本机入口验证后，可收藏 [管理页](http://127.0.0.1:17329/) 和 [消息历史](http://127.0.0.1:17329/history)。新浏览器、Cookie 清除或登录失效时，重新运行启动入口验证。

管理页生成一次性配对码，在自己的机器人私聊发送 `/pair 配对码` 后即可对话。连续普通消息会在停顿约 3 秒后合并，连续发送最长等待 10 秒；单独发图片也会自动处理，文字与附件先后不限。任务执行时补充内容会追加到当前轮，已经结束时进入同一会话的下一轮。`/status`、审批和 `/stop` 即时响应。

`./Stop.ps1` 用于安全停机；任务或投递尚未结束时会拒绝停机。再次运行 `Start.ps1` 可恢复。守护、登录启动、备份和故障排查见 [维护手册](docs/RUNBOOK.md)。

## 从源码准备新实例

当前主要支持 Windows 本地运行，需要 Node.js 24、已安装并登录的 Codex，以及自行创建的 QQ 官方机器人。媒体功能另需 FFmpeg/FFprobe、Python、faster-whisper 和本地识别模型。

```powershell
npm ci
./Start.ps1
```

在打开的本机页面填写机器人凭据，再生成配对码。启动脚本、媒体默认路径仍有本机安装假设，换机前按 [安装检查](docs/RUNBOOK.md#换机或重新安装) 核对；Git 克隆不包含账号授权、模型或运行数据。不要在已有运行实例旁直接启动第二份服务，开发实例的隔离条件见 [开发约定](CONTRIBUTING.md#仓库与运行实例)。

安装开始菜单入口和当前用户的登录启动任务：

```powershell
./Install-Launchers.ps1
./Install-Autostart.ps1
```

## 常用功能

- 多账号隔离：独立进程、`CODEX_HOME`、项目目录、会话、审批、模型偏好和私有记忆；仅管理页编辑的全局记忆共享。
- 任务控制：连续消息合并、执行中补充、原生审批和询问按钮、新会话、上下文状态与会话轮换。
- 媒体处理：图片输入、语音转写、视频抽帧及音轨转写、文件读取，以及文件、图片、音频回传。
- 历史看板：按账号和会话查看、标题修改、分页、搜索、JSON 导出、完整正文复制和附件按需预览。
- 任务追踪：`/status` 查看当前聊天最近任务号与阶段；历史页展开“账号最近任务”，分别查看模型执行、QQ 投递及中文阶段记录。
- 本机管理：浏览器登录、QQ 指令及快捷菜单同步、开始菜单入口、守护与登录启动。

| 指令 | 用途 |
| --- | --- |
| `/help`、`/buttons` | 帮助与按钮菜单 |
| `/status`、`/context`、`/result` | 查看任务、上下文和最近结果 |
| `/stop`、`/new` | 中断当前任务、开始新会话 |
| `/model`、`/models` | 查看当前模型或打开模型选择 |
| `/model 模型名 [推理强度]` | 保存本账号模型偏好，下次任务生效 |
| `/model default` | 恢复继承本账号 Codex 配置 |
| `/project 绝对路径` | 切换至本账号允许范围内的项目 |
| `/file 绝对路径`、`/send 绝对路径` | 回传本账号允许范围内的文件 |
| `/voice 文本`、`/media-test` | 生成语音、发送媒体测试素材 |
| `/memory`、`/remember 内容`、`/forget 编号` | 查看记忆，保存或删除本账号私有记忆 |
| `/approve 编号`、`/deny 编号` | 回答审批 |
| `/answer 编号 回答` | 回答询问，多题用 `\|` 分隔 |

模型与推理强度按本机 Codex 返回的可用列表验证；任务执行及结果发送期间不能切换。默认完成 40 轮或空闲 6 小时后，在下次任务开始时轮换会话，实际值以已保存配置为准。模型原生上下文压缩、会话轮换和长期记忆分别维护。

任务时间线只记录升级后的新任务，旧消息不会补造阶段。“执行完成”与“已投递”分别确认，投递也不代表用户已读。待确认状态需要先核对实际结果，不会自动重跑任务或重发回复，详见 [任务状态说明](docs/TASKS.md)。

## 配置和数据在哪里

管理页提供日常配置入口。`runtime/config.json` 还保存程序与媒体路径等安装设置，修改文件前先安全停机并备份。主要字段及迁移检查见 [维护手册](docs/RUNBOOK.md#配置位置)。

| 位置 | 内容 |
| --- | --- |
| `runtime/config.json`、`runtime/setup-url.txt` | 机器人凭据、管理登录信息与账号配置，仅限本机 |
| `runtime/users/<key>/` | 账号状态、私有记忆、独立 Codex 数据 |
| `runtime/history.sqlite` | QQ 收发、结果与错误审计 |
| `runtime/global-memory.json` | 显式共享的全局记忆 |
| 配置中的 `usersRoot` 和账号工作目录 | 任务文件，可能位于项目外 |
| `exports/` | 历史导出与私有验证记录 |

Git 只管理源码与文档。完整备份还需覆盖配置指向的账号工作目录，不能仅备份仓库。不要分享运行目录、登录链接、原始聊天记录或私有验证截图。

## 目录与开发入口

```text
server.mjs                  兼容启动入口
notify-release.mjs          兼容通知脚本入口
src/
  app.mjs                   服务与模块组装
  paths.mjs                 项目、运行、页面和脚本路径
  core/                     账号、任务、Codex RPC、模型、记忆、输入合并
  qq/                       QQ 网关、事件、控件、指令、Markdown、媒体 URL
  history/                  历史存储与查询
  media/                    附件处理与回传
  http/                     本机认证与历史 HTTP 路由
  ops/                      发布通知
  shared/                   跨模块的目录边界校验
public/                     管理页、历史页、浏览器共享逻辑
tests/                      离线测试
scripts/                    实际调用探针、媒体、维护及基准脚本
docs/                       架构、维护与待办
Start.ps1 / Stop.ps1         现有启停入口，守护和安装脚本也保留在根目录
```

先读 [项目概览](PROJECT.md) 和 [开发约定](CONTRIBUTING.md)，模块边界见 [架构说明](docs/ARCHITECTURE.md)。验证、优化和遗留验收记录在 [待办](docs/BACKLOG.md)，已完成改动见 [CHANGELOG](CHANGELOG.md)。

```powershell
npm run check      # 语法、导入与页面资源检查
npm test           # 离线逻辑与浏览器交互回归
npm run benchmark  # 合成历史与长 Markdown 性能对照
npm run preview:tasks # 只含合成数据的任务界面预览，不连接 QQ 或模型
npm run probe      # 实际 Codex 调用；运行前先阅读探针脚本
```

测试数量以本次命令输出为准。探针位于 `scripts/probes/`，可能调用模型、创建文件或写入验证记录，不等同于离线测试。报告写入 `exports/verification/reports/`，私有截图与日志分别归档到 `exports/verification/screenshots/` 和 `exports/verification/logs/`。

性能基准的测试方法、结果与适用范围见 [性能记录](docs/PERFORMANCE.md)。合成数据中的查询或分片改善不能直接代表 QQ 投递、浏览器或远程桌面的响应时间。

后续按 [演进路线](docs/ROADMAP.md) 逐轮交付，当前第一轮聚焦任务状态时间线与故障诊断。

## 已知边界

本机服务仅监听 `127.0.0.1`，群聊默认不开放。电脑关机或睡眠时不能处理 QQ，登录启动任务需要当前 Windows 用户登录。

QQ 客户端、平台权限、消息有效期及回复次数会影响按钮、Markdown 和媒体投递。模型结果已生成与 QQ 已成功发送分别记账；不明确的发送不会自动重试。自动化测试和本机模型探针不能替代真实 QQ 多账号、多模态验收，剩余验证见 [待办](docs/BACKLOG.md)。

本项目采用 [MIT](LICENSE)。外部软件、模型和平台服务按各自条款使用，见 [第三方组件](THIRD_PARTY.md)。
