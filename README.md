# QQ–Codex Bridge

**在 QQ 里，把任务交给你的本机 Codex。**

发需求、补充上下文、确认审批、接收文件。每个 QQ 账号拥有独立的工作目录、会话、模型和记忆；电脑上的任务，在手机上也能跟进。

[快速开始](#快速开始) · [QQ 指令](docs/COMMANDS.md) · [维护手册](docs/RUNBOOK.md) · [MIT 许可](LICENSE)

![消息历史与任务查看](docs/images/message-history.png)

*截图使用离线合成数据，不含真实账号或聊天。*

<details>
<summary>查看运行概览</summary>

![运行概览](docs/images/console-overview.png)

</details>

## 能做什么

| 能力 | 使用方式 |
| --- | --- |
| 对话执行任务 | 直接发文字；连续消息自动合并，执行中还能补充要求 |
| 多账号独立使用 | 进程、项目目录、会话、审批、模型和私有记忆分别隔离 |
| 收发图片与文件 | 图片交给模型，语音转写，视频抽样分析，结果可回传为附件 |
| 保留长期偏好 | 手动保存记忆，也可自动提炼；支持查看依据、编辑和关闭自动学习 |
| 控制任务与模型 | 查看进度、停止任务、回答审批，按账号选择模型与推理强度 |
| 统一管理控制台 | 配对、记忆、会话策略、消息搜索、导出和任务阶段都在同一界面 |

## 快速开始

准备 **Node.js 24 或更高版本**、已安装并登录的 Codex，以及自行创建的 QQ 官方机器人。把仓库克隆到当前用户可写的目录。Codex 和桥接应在同一系统和用户下运行。

```sh
git clone https://github.com/Sakata-Eof/qq-codex-bridge.git
cd qq-codex-bridge
npm ci
npm run check:env
```

### Windows 后台运行

```powershell
./Install.ps1
```

安装脚本会注册当前用户的登录自启，创建开始菜单入口，并启动、打开控制台。使用 `./Install.ps1 -NoBrowser` 可只安装并启动后台。自启需要登录 Windows，关机或睡眠期间不能处理任务。日常启停见[维护手册](docs/RUNBOOK.md#日常入口)。

### Windows、Linux 和 macOS 前台运行

目前已在 Windows 和 Ubuntu WSL 的隔离环境中验证前台启动。独立 Linux 主机和 macOS 尚未实际部署验证。

```sh
npm start
```

在本机浏览器打开 `runtime/setup-url.txt` 里的完整链接。服务运行在当前终端，任务和投递结束后按 Ctrl+C 退出。语音转写和视频处理是可选能力，装好 FFmpeg/FFprobe、Python、faster-whisper 和模型后用 `npm run check:env -- --media` 检查。`/voice` 语音合成使用 Windows 语音引擎。 [前台启动与环境检查](docs/RUNBOOK.md#跨平台前台启动)

### 配对并发送第一条任务

在控制台填写机器人 AppID 和 AppSecret，生成配对码，再用对应 QQ 账号私聊机器人发送 `/pair 配对码`。新实例会在项目内 `work/qq-users/` 为每个账号建独立目录。绑定后可在“账号管理”选择自己的项目目录，并在“使用模型”区域选择模型和推理强度。等控制台显示 QQ READY，再发一条文字任务确认执行和回复。

> 查看当前项目，先总结结构，再列出最值得解决的三个问题。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `/help`、`/buttons` | 帮助与按钮菜单 |
| `/status`、`/context`、`/result` | 查看进度、上下文和最近结果 |
| `/stop`、`/new` | 停止当前任务、开始新会话 |
| `/models`、`/model` | 选择模型、查看当前设置 |
| `/file 绝对路径` | 回传账号允许目录内的文件 |
| `/memory`、`/remember 内容` | 查看或添加账号记忆 |

完整用法见 [QQ 指令](docs/COMMANDS.md)。审批和询问也可通过 QQ 原生按钮回答。

## 运行说明

- 电脑需保持开机；本机服务默认监听 `127.0.0.1:17329`，群聊默认不开放。
- 模型执行和 QQ 投递分别记录；结果不明确时先核对，不自动重跑任务或重发回复。媒体能否投递以 QQ 接口实际结果为准。
- `runtime/` 保存凭据、账号记忆和聊天数据；`exports/` 保存导出与私有验证资料。请勿提交或公开这些目录。

## 文档与开发

| 文档 | 内容 |
| --- | --- |
| [项目概览](PROJECT.md) · [架构](docs/ARCHITECTURE.md) | 模块结构与账号边界 |
| [维护手册](docs/RUNBOOK.md) | 配置、启动、备份、升级与故障排查 |
| [开发约定](CONTRIBUTING.md) | 修改、验证与提交流程 |
| [任务状态](docs/TASKS.md) | 执行、投递与待核实状态 |
| [变更记录](CHANGELOG.md) · [待办](docs/BACKLOG.md) | 已交付内容与待验收范围 |

```powershell
npm run check     # 语法、导入与页面资源
npm test          # 离线回归测试
node scripts/probes/setup-ui-preview.mjs  # 合成数据界面预览
```

预览不连接 QQ 或 Codex，输入 `quit` 退出。真实调用探针与离线测试的区别见[开发约定](CONTRIBUTING.md#验证怎么选)。

[MIT](LICENSE) · 外部软件、模型和平台服务遵循[各自条款](THIRD_PARTY.md)。
