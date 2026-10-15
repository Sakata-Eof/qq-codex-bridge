# 第三方组件

本项目源码采用 [MIT](LICENSE)。依赖通过包管理器或用户自行安装，不将依赖包、模型权重、Codex、FFmpeg 或其他可执行程序纳入源码仓库。

## npm 依赖

当前 `package-lock.json` 中的以下直接或间接依赖均标注 MIT；安装后的各包附带其各自版权和许可证。版本以锁文件为准，分发包含依赖的安装包时应同时保留相应许可声明。

| 包 | 许可证 |
| --- | --- |
| ws | MIT |
| undici | MIT |
| https-proxy-agent | MIT |
| agent-base | MIT |
| debug | MIT |
| ms | MIT |

## 外部运行环境

本项目 MIT 授权仅覆盖本仓库源码。Node.js、Python、FFmpeg、faster-whisper、语音识别模型及其他外部软件或模型按其各自许可证使用。仓库不提供这些软件或模型的再授权；打包分发它们时需核对具体版本和构建。

QQ 官方机器人平台及 OpenAI/Codex 服务的账号、平台条款和使用权限独立于本项目开源许可证。本项目是社区集成工具。
