<p align="right">
  <a href="README.md">🇬🇧 English</a>
</p>

# Arcana

开源 AI Agent 运行框架——用于构建、运行和观测多 Agent 系统。

Arcana 不是聊天机器人，也不是个人助手——它是你**造**这些东西用的底座。你提供模型，Arcana 负责其余一切：Agent 隔离、工具执行的全链路可观测、沙箱化的技能系统、多会话控制面。

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#为什么选-arcana">为什么选 Arcana</a> ·
  <a href="#核心概念">核心概念</a> ·
  <a href="#文档">文档</a> ·
  <a href="#参与贡献">参与贡献</a>
</p>

<!-- TODO: 在这里插入 Web UI 截图 -->

## 安装

**环境要求：** Node.js 22+（推荐 LTS）

### 方式一：桌面应用（推荐）

下载对应平台的安装包：

- **macOS**: [Arcana.dmg](https://github.com/ArcanaAgent/Arcana/releases)（Apple Silicon 和 Intel）
- **Windows**: [Arcana.msi](https://github.com/ArcanaAgent/Arcana/releases)

打开应用 → 在设置中配置模型供应商 → 开始使用。

### 方式二：从源码运行

```bash
git clone https://github.com/ArcanaAgent/Arcana.git
cd arcana
npm install

# 可选：安装浏览器引擎（用于网页工具）
npx playwright install

# 启动 Gateway（在 8787 端口提供 Web UI）
npm run gateway
```

浏览器打开 http://localhost:8787，在密钥箱中配置模型供应商的 API Key，即可使用。

### 方式三：自行编译桌面应用

```bash
cd packages/desktop
npm install
npm run dist:mac    # Windows 用 dist:win
```

## 快速开始

1. 启动 Arcana：`npm run gateway`（或打开桌面应用）
2. 浏览器打开 http://localhost:8787
3. 进入密钥箱，添加模型供应商 API Key 和 URL
4. 开始对话——每一次工具调用都在界面上可见

就这样。不需要命令行向导，不需要配置文件，不需要安装守护进程。

<!-- TODO: 在这里插入对话 + 工具调用链路截图 -->

## 为什么选 Arcana

### 🔍 全链路可观测

每次工具调用、每个 prompt、每个 Agent 决策都可追溯。WebSocket 实时事件流，结构化 JSONL 审计日志。你的 Agent 做了什么、为什么这么做，一目了然。

<!-- TODO: 在这里插入事件流 / Trace 截图 -->

### 🔒 默认沙箱隔离

工具在**独立子进程**中运行，具有显式权限边界。Skill 必须在 frontmatter 中声明网络访问和文件系统范围。默认不提供 bash。没有隐式权限。

```yaml
# Skill frontmatter 示例——显式声明权限
arcana:
  tools:
    - name: fetch_data
      allowNetwork: true
      allowedHosts: ["api.example.com:443"]
      allowWrite: false
```

### 🧩 多 Agent、多会话

并发运行多个 Agent，每个 Agent 拥有独立的：

- **工作区** — 隔离的文件系统根目录，由 workspace guard 强制执行
- **记忆** — 每个 Agent 独立的长期记忆和每日笔记
- **技能** — 分层技能发现（Agent 级 → 工作区级 → 包级）
- **会话** — 按 `(agentId, sessionKey)` 独立的对话历史
- **服务** — 每个 Agent 独立的后台进程（桥接、监听、队列）

<!-- TODO: 在这里插入多 Agent 会话管理截图 -->

### 🛠️ 可扩展的技能系统

用简单的 JS 模块构建自定义工具。放进 skill 文件夹、声明权限，即可被 Agent 使用：

```
my-skill/
  SKILL.md          # 描述 + 工具声明
  tools/
    my_tool/
      tool.js       # export default factory → { name, description, parameters, execute }
```

支持热重载。Agent 级技能覆盖共享技能。沙箱执行是默认行为——不需要 `--dangerously-skip-permissions`。

### ⚡ 内置基础能力

| 能力 | 说明 |
|------|------|
| **Cron** | 调度 Agent 任务，支持定时和一次性 |
| **子 Agent** | 创建、调度和管理子 Agent |
| **记忆** | 持久化、可检索的长期记忆 + 每日笔记 |
| **心跳** | 按计划唤醒 Agent 执行后台工作 |
| **服务** | 托管后台进程，带生命周期管理 |
| **MCP** | 支持 Model Context Protocol 工具互操作 |

## 核心概念

```
                    ┌─────────────────────────────┐
  Web UI / 桌面应用  │         Gateway (v2)         │
  Channel 桥接 ─────│  HTTP + WebSocket + 插件     │
  CLI / API         │         :8787                │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                     ▼
        ┌──────────┐        ┌──────────┐         ┌──────────┐
        │ Agent A   │        │ Agent B   │         │ Agent C   │
        │ home/     │        │ home/     │         │ home/     │
        │ 工作区     │        │ 工作区     │         │ 工作区     │
        │ 会话       │        │ 会话       │         │ 会话       │
        │ 记忆       │        │ 记忆       │         │ 记忆       │
        │ 技能       │        │ 技能       │         │ 技能       │
        │ 服务       │        │ 服务       │         │ 服务       │
        └──────────┘        └──────────┘         └──────────┘
```

- **Gateway** — 统一的 HTTP + WebSocket 控制面。管理 Agent、会话、事件、调度和工具执行。
- **Agent** — 隔离单元，拥有独立的主目录、工作区根路径、人设文件、记忆、技能和服务。
- **会话（Session）** — 按 `(agentId, sessionKey)` 划分的对话上下文。每个 Agent 可并发运行多个会话。
- **技能（Skill）** — 包含 `SKILL.md` + 工具的文件夹。技能分层加载：Agent 级覆盖工作区级，工作区级覆盖包级。
- **工具（Tool）** — 每次调用在隔离沙箱中执行的 JS 模块。权限是声明的，不是假定的。

## 安全模型

Arcana 遵循**默认最小权限**原则：

| 层级 | 默认行为 | 可覆盖 |
|------|---------|--------|
| 工具执行 | 隔离子进程 | 需要有状态的工具可选择 tool-daemon |
| 文件系统 | 仅在声明路径内读写 | frontmatter 中的 `allowedWritePaths` / `allowedReadPaths` |
| 网络 | 禁止 | frontmatter 中的 `allowNetwork: true` + `allowedHosts` |
| Bash | 默认不可用 | 通过 tool-daemon 提供，非默认 |
| 工作区 | workspace-guard.js 强制隔离 | agent.json 中按 Agent 配置 `workspaceRoot` |
| 记忆 | Agent 级隔离，禁止跨 Agent 访问 | agent-guard.js 强制执行 |

## 路线图

- [ ] 低稳定性网络适配（自动重试、连接恢复、离线队列）
- [ ] 社区技能市场
- [ ] Linux 桌面构建

## 文档

| 主题 | 路径 |
|------|------|
| 安装与快速开始 | [`docs/install/README.md`](docs/install/README.md) |
| 技能与自定义工具 | [`docs/skills/README.md`](docs/skills/README.md) |
| 多 Agent 架构 | [`docs/multi-agent.md`](docs/multi-agent.md) |
| Gateway 协议 (v2) | [`docs/arcana-gateway-protocol.md`](docs/arcana-gateway-protocol.md) |
| 插件 API | [`docs/arcana-plugin-api.md`](docs/arcana-plugin-api.md) |
| 定时任务 | [`docs/cron.md`](docs/cron.md) |
| 心跳与后台服务 | [`docs/heartbeat.md`](docs/heartbeat.md) |
| Channel 运行时 | [`docs/channel-runtime.md`](docs/channel-runtime.md) |
| 故障排查 | [`docs/troubleshooting/README.md`](docs/troubleshooting/README.md) |

## 参与贡献

欢迎提交 Bug 报告、功能需求和 PR。详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 安全

如果你发现了安全问题，请不要开公开 Issue。请按照 [`SECURITY.md`](SECURITY.md) 中的流程通过 GitHub Security Advisories 提交。

## 许可证

MIT — 详见 [`LICENSE`](LICENSE)。
