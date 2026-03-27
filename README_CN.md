<p align="right">
  <a href="README.md">🇬🇧 English</a>
</p>

# Arcana

**开源 AI Agent 平台。给你的 Agent 真正的技能——并看清它做的每一件事。**

Arcana 是一个 AI Agent 运行平台，用来构建真正干活的 Agent：管理社媒、剪辑视频、自动化工作流、直播互动。你定义 Agent 的人设、记忆和模块化技能，Arcana 负责执行、隔离和可观测。

不是聊天机器人套壳，不是又一个 LangChain。是一个让 Agent 透明地为你工作的平台。

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#为什么选-arcana">为什么选 Arcana</a> ·
  <a href="#技能系统">技能系统</a> ·
  <a href="#架构">架构</a> ·
  <a href="#文档">文档</a>
</p>

<!-- TODO: Web UI 主界面截图 -->

## 安装

**环境要求：** Node.js 22+（推荐 LTS）

### 方式一：桌面应用

| 平台 | 下载 |
|------|------|
| macOS（Apple Silicon 和 Intel） | [Arcana.dmg](https://github.com/ArcanaAgent/Arcana/releases) |
| Windows | [Arcana.msi](https://github.com/ArcanaAgent/Arcana/releases) |

打开应用 → 在设置中添加模型 API Key → 开始使用。

### 方式二：从源码运行

```bash
git clone https://github.com/ArcanaAgent/Arcana.git
cd arcana
npm install
npm run gateway
```

浏览器打开 http://localhost:8787，在密钥箱中添加模型 API Key，完成。

### 方式三：自行编译桌面应用

```bash
cd packages/desktop
npm install
npm run dist:mac    # Windows 用 dist:win
```

## 快速开始

1. 启动 Arcana（桌面应用或 `npm run gateway`）
2. 浏览器打开 http://localhost:8787
3. 在密钥箱中添加模型 API Key（OpenAI、Anthropic、DeepSeek 等）
4. 开始对话——每一次工具调用都在界面上实时可见

不需要命令行向导，不需要配置文件，不需要安装守护进程。

<!-- TODO: 对话界面 + 工具调用截图 -->

## 为什么选 Arcana

### 🔍 全链路可观测

每次工具调用、每个 prompt、每个 Agent 决策——实时可见可追溯。WebSocket 事件流，结构化 JSONL 审计日志。你的 Agent 做了什么、为什么这么做，一目了然。

这是 Arcana 的核心设计原则：**Agent 不应该是黑盒。**

<!-- TODO: 事件流 / 工具调用链路截图 -->

### 🔒 默认沙箱隔离

没有隐式权限。每个技能必须声明自己能访问什么：

```yaml
arcana:
  tools:
    - name: fetch_data
      allowedHosts: ["api.example.com:443"]    # 只能访问这些域名
      allowedWritePaths: ["artifacts/output"]   # 只能写这些目录
```

- **默认没有 bash** — Agent 不能执行任意 Shell 命令
- **默认没有网络** — 工具只能访问声明的主机
- **隔离执行** — 每次工具调用在独立子进程中运行
- **文件系统受限** — 读写范围仅限声明的路径

### 🧩 多 Agent、多会话

并发运行多个 Agent，各自拥有隔离的：

- **工作区** — 每个 Agent 独立的文件系统根目录
- **记忆** — 持久化长期记忆 + 每日笔记
- **技能** — 分层发现（Agent 级 → 工作区级 → 包级）
- **会话** — 按 `(agentId, sessionKey)` 独立的对话
- **服务** — 每个 Agent 独立的后台进程

<!-- TODO: 多 Agent 会话列表截图 -->

### 🛠️ 技能系统

技能（Skill）是你赋予 Agent 的模块化能力。一个技能就是一个文件夹：

```
my-skill/
  SKILL.md          # 描述 + 权限声明
  tools/
    my_tool/
      tool.js       # export default factory → { name, parameters, execute }
```

**技能如何工作：**
- 把技能文件夹放到 `skills/` 目录——Arcana 自动发现
- 技能在 frontmatter 中声明权限——网络主机、文件路径，没有隐式权限
- 工具在隔离子进程中运行——默认沙箱，支持热重载
- 技能分层：Agent 级覆盖工作区级，工作区级覆盖包级

**你可以用技能构建什么：**
- 社媒自动化（发帖、排期、回复管理）
- 视频合成和剪辑流水线
- 直播叠层和互动机器人
- 消息集成（飞书、Slack、微信、Discord）
- 文档生成和发布工作流
- 任何可以描述为 API 调用或文件操作的事

工具获得沙箱化的上下文：
- `ctx.safeOps.fs` — 受保护的文件操作（工作区范围内）
- `ctx.safeOps.http` — 受保护的 HTTP（白名单范围内）
- `ctx.secrets` — 加密密钥访问（不用环境变量）

### ⚡ 内置 Agent 基础能力

| 能力 | 说明 |
|------|------|
| **Cron** | 调度 Agent 任务——定时或一次性 |
| **子 Agent** | 创建、调度和管理子 Agent |
| **记忆** | 持久化、可检索的长期记忆 + 每日笔记 |
| **心跳** | 按计划唤醒 Agent 执行后台工作 |
| **服务** | 带生命周期钩子的后台进程管理 |
| **MCP** | 支持 Model Context Protocol 工具互操作 |

## 架构

```
                    ┌─────────────────────────────┐
  Web UI / 桌面应用  │         Gateway (v2)         │
  Channel 桥接 ─────│  HTTP + WebSocket + 插件     │
  API               │         :8787                │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                     ▼
        ┌──────────┐        ┌──────────┐         ┌──────────┐
        │ Agent A   │        │ Agent B   │         │ Agent C   │
        │ 工作区     │        │ 工作区     │         │ 工作区     │
        │ 会话       │        │ 会话       │         │ 会话       │
        │ 记忆       │        │ 记忆       │         │ 记忆       │
        │ 技能       │        │ 技能       │         │ 技能       │
        │ 服务       │        │ 服务       │         │ 服务       │
        └──────────┘        └──────────┘         └──────────┘
```

- **Gateway** — HTTP + WebSocket 控制面。管理 Agent、会话、事件和工具执行。
- **Agent** — 隔离单元，拥有独立的主目录、工作区、人设、记忆、技能和服务。
- **会话** — 按 `(agentId, sessionKey)` 划分的对话上下文，支持并发。
- **技能** — 包含 `SKILL.md` + 工具的文件夹。分层加载：Agent → 工作区 → 包。
- **工具** — 在隔离沙箱中执行的 JS 模块。权限声明，不是假定。

### 安全模型

| 层级 | 默认行为 | 可配置 |
|------|---------|--------|
| 工具执行 | 隔离子进程 | 有状态工具可选择 tool-daemon |
| 文件系统 | 仅声明路径可读写 | `allowedWritePaths` / `allowedReadPaths` |
| 网络 | 禁止 | `allowedHosts` 白名单 |
| Bash | 不可用 | 通过 tool-daemon，非默认 |
| 工作区 | 按 Agent 隔离 | agent.json 中的 `workspaceRoot` |
| 记忆 | Agent 级隔离 | agent-guard 强制执行 |

## 路线图

- [ ] 技能市场——发现和安装社区技能
- [ ] 低稳定性网络适配（自动重试、离线队列）
- [ ] Linux 桌面构建
- [ ] 更多平台集成（Discord、Slack、Telegram）

## 文档

| 主题 | 链接 |
|------|------|
| 安装与快速开始 | [`docs/install/`](docs/install/README.md) |
| 技能与自定义工具 | [`docs/skills/`](docs/skills/README.md) |
| 多 Agent 架构 | [`docs/multi-agent.md`](docs/multi-agent.md) |
| Gateway 协议 (v2) | [`docs/arcana-gateway-protocol.md`](docs/arcana-gateway-protocol.md) |
| 插件 API | [`docs/arcana-plugin-api.md`](docs/arcana-plugin-api.md) |
| 定时任务 | [`docs/cron.md`](docs/cron.md) |
| 心跳与后台 | [`docs/heartbeat.md`](docs/heartbeat.md) |
| Channel 运行时 | [`docs/channel-runtime.md`](docs/channel-runtime.md) |
| 故障排查 | [`docs/troubleshooting/`](docs/troubleshooting/README.md) |

## 参与贡献

欢迎提交 Bug 报告、功能需求和 PR。详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 安全

发现漏洞？请不要开公开 Issue。通过 [GitHub Security Advisories](https://github.com/ArcanaAgent/Arcana/security/advisories) 提交。

## 许可证

MIT — 详见 [`LICENSE`](LICENSE)。
