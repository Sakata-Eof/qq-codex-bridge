# QQ–Codex Bridge

通过独立的 QQ 官方机器人，在 QQ 中指挥 Windows 本机 Codex 执行任务，并提供本机管理页和按账号、会话组织的历史看板。

## 范围与现状

本项目使用现有专用机器人，与 Hermes QQ 机器人独立。主入口为 `server.mjs`；`package.json` 当前版本为 `1.0.0`。2026-10-15 将已有实现纳入独立 Git 仓库，未迁移运行目录。

公开源码仓库：[Sakata-Eof/qq-codex-bridge](https://github.com/Sakata-Eof/qq-codex-bridge)。开源许可为 MIT，凭据和运行数据只保留在本机。

已实现：多账号配对与隔离、独立会话和标题、模型及推理强度选择、审批按钮、上下文压缩与会话轮换、全局及账号私有记忆、图片/语音/视频/文件输入、文件/图片/音频回传、QQ 菜单同步、SQLite 分页搜索导出、本机 Cookie 登录、守护与登录启动、单条消息复制。

实现、自动化测试、真实本机 Codex 测试和 QQ 客户端验证是不同层次的证据。以本次执行结果和明确记录的客户端反馈为准，不能仅凭接口实现宣称所有客户端、多账号、多模态端到端通过。遗留验证见 [BACKLOG](docs/BACKLOG.md)。

## 代码导航

| 文件 | 职责 |
| --- | --- |
| `server.mjs` | 本机 HTTP 服务、配置、QQ 与账号管理组装 |
| `qq.mjs`、`commands.mjs` | QQ 鉴权、网关、消息投递、指令面板与菜单 |
| `accounts.mjs` | 账号配对、独立进程及状态目录 |
| `bridge.mjs`、`codex.mjs`、`controls.mjs` | 任务、App Server RPC、会话、审批和按钮 |
| `models.mjs`、`memory.mjs` | 模型偏好、全局和私有记忆 |
| `media.mjs`、`transcribe.py`、`speak.ps1` | 媒体处理、转写及语音生成 |
| `history-db.mjs`、`history.mjs` | SQLite 历史、标题、查询、导入与导出 |
| `setup.*`、`history.*`、`ui-client.js`、`ui-auth.mjs` | 配置页、历史页、浏览器会话与请求恢复 |
| `Start.ps1`、`Stop.ps1`、`Watchdog.ps1`、`Install-*.ps1` | 启停、守护、登录启动、开始菜单入口 |
| `test.mjs`、`ui-test.mjs` | 隔离、消息、数据库和浏览器逻辑验证 |

## 环境与数据

使用 Node.js 24 系列和内置 SQLite，npm 依赖由锁文件管理。使用本机 Codex App Server 和已登录的 Codex；媒体路径还依赖 FFmpeg/FFprobe、Python、faster-whisper 与本地模型。具体路径由当前安装及配置决定，不能假设换机后仍有效。

源码位于本文件所在目录，采用 MIT 许可。本机界面为 `http://127.0.0.1:17329/`，消息历史为 `/history`。

`runtime/` 保存凭据、登录入口、数据库、用户状态及 Codex 专属数据；默认账号工作目录在本项目外的 `../../work/qq-users/`，实际路径以配置为准。`exports/`、日志、验证 JSON 和历史截图包含私有运行证据，均不纳入 Git。完整备份必须同时覆盖运行数据和配置指向的账号工作目录。

## 后续开发

先读 [CONTRIBUTING](CONTRIBUTING.md)，按需进入架构或维护文档。每次变更说明解决的问题、影响范围和验证证据；已完成事项写入 [CHANGELOG](CHANGELOG.md)，未完成事项维护在 [BACKLOG](docs/BACKLOG.md)。
