<p align="right">
  <a href="README_CN.md">🇨🇳 中文</a>
</p>

# Arcana

**Open-source AI agent platform. Give your agents real skills — and watch everything they do.**

Arcana is a runtime for building AI agents that actually do things: manage social media, edit videos, automate workflows, interact with live streams. You define agents with personas, memories, and modular skills. Arcana handles execution, isolation, and observability.

Not a chatbot wrapper. Not another LangChain. A platform where agents work for you — transparently.

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#why-arcana">Why Arcana</a> ·
  <a href="#the-skill-system">Skills</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#docs">Docs</a>
</p>

<!-- TODO: hero screenshot of Web UI -->

## Install

**Requirements:** Node.js 22+ (LTS recommended)

### Option A: Desktop App

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon & Intel) | [Arcana.dmg](https://github.com/ArcanaAgent/Arcana/releases) |
| Windows | [Arcana.msi](https://github.com/ArcanaAgent/Arcana/releases) |

Open the app → add your model API key in Settings → start using.

### Option B: From Source

```bash
git clone https://github.com/ArcanaAgent/Arcana.git
cd arcana
npm install
npm run gateway
```

Open http://localhost:8787, add a model provider API key in Secrets, done.

### Option C: Build Desktop App

```bash
cd packages/desktop
npm install
npm run dist:mac    # or dist:win
```

## Quick Start

1. Start Arcana (desktop app or `npm run gateway`)
2. Open http://localhost:8787
3. Add your model API key in Secrets (OpenAI, Anthropic, DeepSeek, etc.)
4. Start chatting — every tool call is visible in the UI

No CLI wizards. No config files. No daemon installs.

<!-- TODO: screenshot of chat with visible tool calls -->

## Why Arcana

### 🔍 Full Observability

Every tool call, every prompt, every agent decision — visible and traceable in real time. WebSocket event stream. Structured JSONL audit logs. You always know exactly what your agent did and why.

This is Arcana's core design principle: **agents should never be black boxes.**

<!-- TODO: screenshot of event stream / tool call trace -->

### 🔒 Sandboxed by Default

No ambient permissions. Every skill declares exactly what it can access:

```yaml
arcana:
  tools:
    - name: fetch_data
      allowedHosts: ["api.example.com:443"]    # only these domains
      allowedWritePaths: ["artifacts/output"]   # only these folders
```

- **No bash by default** — agents can't run arbitrary shell commands
- **No ambient network** — tools only reach declared hosts
- **Isolated execution** — each tool call runs in its own child process
- **File system scoped** — read/write limited to declared paths

### 🧩 Multi-Agent, Multi-Session

Run multiple agents concurrently, each with isolated:

- **Workspace** — separate file system root per agent
- **Memory** — persistent long-term memory and daily notes
- **Skills** — layered discovery (agent → workspace → package)
- **Sessions** — independent conversations per `(agentId, sessionKey)`
- **Services** — managed background processes per agent

<!-- TODO: screenshot of multi-agent session list -->

### 🛠️ The Skill System

Skills are modular capabilities you give to your agents. A skill is a folder:

```
my-skill/
  SKILL.md          # Description + permission declarations
  tools/
    my_tool/
      tool.js       # export default factory → { name, parameters, execute }
```

**How skills work:**
- Drop a skill folder into `skills/` — Arcana discovers it automatically
- Skills declare permissions in frontmatter — network hosts, file paths, nothing implicit
- Tools run in isolated child processes — sandboxed by default, hot-reloadable
- Skills layer: agent-scoped overrides workspace-scoped overrides package-scoped

**What you can build with skills:**
- Social media automation (posting, scheduling, reply management)
- Video compositing and editing pipelines
- Live streaming overlays and interaction bots
- Messaging integrations (Feishu, Slack, WeChat, Discord)
- Document generation and publishing workflows
- Anything that can be described as an API call or file operation

Tools get a sandboxed context:
- `ctx.safeOps.fs` — guarded file operations (workspace-scoped)
- `ctx.safeOps.http` — guarded HTTP (allowlist-scoped)
- `ctx.secrets` — encrypted credential access (no env vars)

### ⚡ Built-in Agent Primitives

| Primitive | What it does |
|-----------|-------------|
| **Cron** | Schedule agent tasks — recurring or one-shot |
| **Subagents** | Spawn, steer, and manage child agents |
| **Memory** | Persistent, searchable long-term memory with daily notes |
| **Heartbeat** | Wake agents on schedule for background work |
| **Services** | Managed background processes with lifecycle hooks |
| **MCP** | Model Context Protocol support for tool interop |

## Architecture

```
                    ┌─────────────────────────────┐
  Web UI / Desktop  │         Gateway (v2)         │
  Channel bridges ──│  HTTP + WebSocket + Plugins  │
  API               │         :8787                │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                     ▼
        ┌──────────┐        ┌──────────┐         ┌──────────┐
        │ Agent A   │        │ Agent B   │         │ Agent C   │
        │ workspace │        │ workspace │         │ workspace │
        │ sessions  │        │ sessions  │         │ sessions  │
        │ memory    │        │ memory    │         │ memory    │
        │ skills    │        │ skills    │         │ skills    │
        │ services  │        │ services  │         │ services  │
        └──────────┘        └──────────┘         └──────────┘
```

- **Gateway** — HTTP + WebSocket control plane. Manages agents, sessions, events, and tool execution.
- **Agent** — isolated unit with its own home, workspace, persona, memory, skills, and services.
- **Session** — conversation context scoped to `(agentId, sessionKey)`. Multiple sessions run concurrently.
- **Skill** — folder with `SKILL.md` + tools. Layered: agent → workspace → package.
- **Tool** — JS module executed in isolated sandbox. Permissions declared, not assumed.

### Security Model

| Layer | Default | Configurable |
|-------|---------|-------------|
| Tool execution | Isolated child process | Opt-in tool-daemon for stateful tools |
| File system | Scoped to declared paths | `allowedWritePaths` / `allowedReadPaths` |
| Network | Blocked | `allowedHosts` allowlist |
| Bash | Not available | Via tool-daemon, not default |
| Workspace | Isolated per agent | `workspaceRoot` in agent.json |
| Memory | Agent-scoped, no cross-access | Enforced by agent-guard |

## Roadmap

- [ ] Skill marketplace — discover and install community skills
- [ ] Low-stability network resilience (auto-retry, offline queue)
- [ ] Linux desktop builds
- [ ] More channel integrations (Discord, Slack, Telegram)

## Docs

| Topic | Link |
|-------|------|
| Install & quickstart | [`docs/install/`](docs/install/README.md) |
| Skills & custom tools | [`docs/skills/`](docs/skills/README.md) |
| Multi-agent architecture | [`docs/multi-agent.md`](docs/multi-agent.md) |
| Gateway protocol (v2) | [`docs/arcana-gateway-protocol.md`](docs/arcana-gateway-protocol.md) |
| Plugin API | [`docs/arcana-plugin-api.md`](docs/arcana-plugin-api.md) |
| Cron & scheduled jobs | [`docs/cron.md`](docs/cron.md) |
| Heartbeat & background | [`docs/heartbeat.md`](docs/heartbeat.md) |
| Channel runtime | [`docs/channel-runtime.md`](docs/channel-runtime.md) |
| Troubleshooting | [`docs/troubleshooting/`](docs/troubleshooting/README.md) |

## Contributing

Bug reports, feature requests, and PRs are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Found a vulnerability? Don't open a public issue. Report via [GitHub Security Advisories](https://github.com/ArcanaAgent/Arcana/security/advisories).

## License

MIT — see [`LICENSE`](LICENSE).
