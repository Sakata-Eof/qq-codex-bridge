# QQ–Codex Bridge 项目概览

通过独立的 QQ 官方机器人，在 QQ 中指挥 Windows 本机 Codex 执行任务，并提供本机管理页和按账号、会话组织的消息历史。

## 范围与证据

本项目与 Hermes QQ 机器人独立。公开源码仓库为 [Sakata-Eof/qq-codex-bridge](https://github.com/Sakata-Eof/qq-codex-bridge)，采用 MIT 许可。源码、测试和维护文档纳入 Git；凭据、运行数据和账号工作文件不纳入仓库。

当前实现覆盖多账号配对与隔离、模型及推理强度选择、任务执行中补充、审批与询问、上下文压缩和会话轮换、全局及私有记忆、媒体收发、QQ 控件、历史检索导出、浏览器登录及进程守护。使用入口见 [README](README.md)。

实现、自动化测试、真实本机 Codex 调用和 QQ 客户端验收是不同层次的证据。不能仅凭接口或单账号验证宣称所有客户端、多账号、多模态端到端通过。未完成的验证保留在 [BACKLOG](docs/BACKLOG.md)，每次实际检查写明范围及结果。

## 模块导航

| 位置 | 职责 |
| --- | --- |
| [server.mjs](server.mjs)、[src/app.mjs](src/app.mjs) | 根目录兼容入口与实际服务组装 |
| [src/paths.mjs](src/paths.mjs) | 统一项目、运行数据、页面及维护脚本路径 |
| [src/core/accounts.mjs](src/core/accounts.mjs) | 配对账号、独立进程和状态目录 |
| [src/core/bridge.mjs](src/core/bridge.mjs)、[src/core/codex.mjs](src/core/codex.mjs) | thread/turn、审批、投递与 App Server JSON-RPC |
| [src/core/message-batches.mjs](src/core/message-batches.mjs) | 按账号及聊天合并连续输入 |
| [src/core/models.mjs](src/core/models.mjs)、[src/core/memory.mjs](src/core/memory.mjs) | 模型偏好与全局、私有记忆 |
| [src/qq/](src/qq/) | 网关投递、事件解析、指令菜单、按钮、Markdown、媒体来源校验 |
| [src/history/](src/history/) | SQLite 历史、标题、导入、查询与导出 |
| [src/history/task-store.mjs](src/history/task-store.mjs)、[src/core/task-stages.mjs](src/core/task-stages.mjs) | 新任务阶段、源消息及执行/投递状态 |
| [src/media/processor.mjs](src/media/processor.mjs)、[scripts/media/](scripts/media/) | 附件处理、转写、语音与回传 |
| [src/http/](src/http/)、[public/](public/) | 本机登录、历史 HTTP 路由与管理、历史页面 |
| [src/shared/path-security.mjs](src/shared/path-security.mjs) | 账号与媒体共用的目录边界校验 |
| [src/ops/release-notifications.mjs](src/ops/release-notifications.mjs) | 按稳定发布 ID 记录一次性通知 |
| [scripts/probes/](scripts/probes/)、[scripts/ops/](scripts/ops/) | 实际调用探针和维护操作 |
| [tests/](tests/) | 隔离、消息、存储、QQ 投递和浏览器回归测试 |
| `Start.ps1`、`Stop.ps1`、`Watchdog.ps1`、`Install-*.ps1` | 保留现有启停、守护和安装入口 |

架构与设计边界见 [ARCHITECTURE](docs/ARCHITECTURE.md)。目录按职责划分，`src/app.mjs` 负责组装；独立模块不应通过导入服务入口取得配置或状态。

## 环境与数据

使用 Node.js 24 和内置 SQLite，npm 依赖由锁文件管理。Codex 使用本机已安装、已登录的 App Server；媒体路径还依赖 FFmpeg/FFprobe、Python、faster-whisper 与本地模型。具体可执行文件和模型位置以当前安装及配置为准。

本机界面默认为 `http://127.0.0.1:17329/`，消息历史为 `/history`。`runtime/` 保存凭据、登录入口、历史数据库、账号状态及 Codex 专属数据；默认账号工作目录在项目外的 `../../work/qq-users/`，实际路径以配置为准。结构整理不代表运行数据已迁移。

`exports/` 保存历史导出及私有验证资料，探针报告位于 `exports/verification/reports/`。这些资料、运行日志和私有截图均不纳入 Git。完整备份须覆盖运行目录以及配置指向的所有账号工作目录，详见 [RUNBOOK](docs/RUNBOOK.md#备份与恢复)。

## 后续迭代

开发先读 [CONTRIBUTING](CONTRIBUTING.md)，按需查看架构及维护文档。变更说明需写清问题、行为变化和验证；已完成事项写入 [CHANGELOG](CHANGELOG.md)，剩余验收和候选工作维护在 [BACKLOG](docs/BACKLOG.md)。普通提交不自动升版本、打标签或发布。
