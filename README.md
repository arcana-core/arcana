<p align="right">
  <a href="README_CN.md">🇨🇳 中文</a>
</p>

# Arcana

An open-source agent harness for building, running, and observing multi-agent systems.

Arcana is not a chatbot or a personal assistant — it's the runtime you use to **build** them. It provides agent isolation, tool execution with full observability, a sandboxed skill system, and a multi-session control plane. You bring the model; Arcana handles everything else.

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#why-arcana">Why Arcana</a> ·
  <a href="#core-concepts">Core Concepts</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#contributing">Contributing</a>
</p>

<!-- TODO: add screenshot of Web UI here -->

## Install

**Requirements:** Node.js 22+ (LTS recommended)

### Option A: Desktop App

Download the latest release for your platform:

- **macOS**: [Arcana.dmg](https://github.com/ArcanaAgent/Arcana/releases) (Apple Silicon & Intel)
- **Windows**: [Arcana.msi](https://github.com/ArcanaAgent/Arcana/releases)

Open the app → configure your model provider in Settings → start using.

### Option B: From Source

```bash
git clone https://github.com/ArcanaAgent/Arcana.git
cd arcana
npm install

# Optional: install browsers for web tools
npx playwright install

# Start the gateway (serves the Web UI on port 8787)
npm run gateway
```

Open http://localhost:8787 in your browser, configure a model provider in Secrets, and you're ready.

### Option C: Build Desktop App From Source

```bash
cd packages/desktop
npm install
npm run dist:mac    # or dist:win for Windows
```

## Quick Start

1. Start Arcana: `npm run gateway` (or open the desktop app)
2. Open http://localhost:8787
3. Go to Secrets and add your model provider API key (e.g. `providers/openai/api_key`)
4. Start chatting — every tool call is visible in the UI

That's it. No CLI wizards, no config files, no daemon installs.

<!-- TODO: add screenshot of chat + tool call trace here -->

## Why Arcana

### 🔍 Full Observability

Every tool call, every prompt, every agent decision is visible and traceable. Real-time event stream over WebSocket. Structured JSONL audit logs. You always know exactly what your agent did and why.

<!-- TODO: add screenshot of event stream / trace view here -->

### 🔒 Sandboxed by Default

Tools run in **isolated child processes** with explicit permission boundaries. Skills must declare network access and file system scope in their frontmatter. No default bash access. No ambient permissions.

```yaml
# Example skill frontmatter — explicit permission declaration
arcana:
  tools:
    - name: fetch_data
      allowNetwork: true
      allowedHosts: ["api.example.com:443"]
      allowWrite: false
```

### 🧩 Multi-Agent, Multi-Session

Run multiple agents concurrently, each with its own:

- **Workspace** — isolated file system root, enforced by workspace guard
- **Memory** — per-agent long-term memory and daily notes
- **Skills** — layered skill discovery (agent → workspace → package)
- **Sessions** — independent conversation history per `(agentId, sessionKey)`
- **Services** — per-agent background processes (bridges, listeners, queues)

<!-- TODO: add screenshot of multi-agent session management here -->

### 🛠️ Extensible Skill System

Build custom tools as simple JS modules. Drop them into a skill folder, declare permissions, and they're available to your agent:

```
my-skill/
  SKILL.md          # Description + tool declarations
  tools/
    my_tool/
      tool.js       # export default factory → { name, description, parameters, execute }
```

Skills support hot-reload. Agent-scoped skills override shared ones. The execution sandbox is the default — no `--dangerously-skip-permissions` needed.

### ⚡ Built-in Primitives

| Primitive | What it does |
|-----------|-------------|
| **Cron** | Schedule agent tasks, recurring or one-shot |
| **Subagents** | Spawn, steer, and manage child agents |
| **Memory** | Persistent, searchable long-term memory with daily notes |
| **Heartbeat** | Wake agents on schedule for background work |
| **Services** | Managed background processes with lifecycle hooks |
| **MCP** | Model Context Protocol support for tool interop |

## Core Concepts

```
                    ┌─────────────────────────────┐
  Web UI / Desktop  │         Gateway (v2)         │
  Channel bridges ──│  HTTP + WebSocket + Plugins  │
  CLI / API         │         :8787                │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                     ▼
        ┌──────────┐        ┌──────────┐         ┌──────────┐
        │ Agent A   │        │ Agent B   │         │ Agent C   │
        │ home/     │        │ home/     │         │ home/     │
        │ workspace │        │ workspace │         │ workspace │
        │ sessions  │        │ sessions  │         │ sessions  │
        │ memory    │        │ memory    │         │ memory    │
        │ skills    │        │ skills    │         │ skills    │
        │ services  │        │ services  │         │ services  │
        └──────────┘        └──────────┘         └──────────┘
```

- **Gateway** — single HTTP + WebSocket control plane. Manages agents, sessions, events, scheduling, and tool execution.
- **Agent** — an isolated unit with its own home directory, workspace root, persona files, memory, skills, and services.
- **Session** — a conversation context scoped to `(agentId, sessionKey)`. Agents can run multiple sessions concurrently.
- **Skill** — a folder containing `SKILL.md` + tools. Skills are layered: agent-scoped overrides workspace-scoped overrides package-scoped.
- **Tool** — a JS module executed in an isolated sandbox per call. Permissions are declared, not assumed.

## Security Model

Arcana follows a principle of **least privilege by default**:

| Layer | Default | Override |
|-------|---------|----------|
| Tool execution | Isolated child process | Opt-in to tool-daemon for stateful tools |
| File system | Read/write within declared paths only | `allowedWritePaths` / `allowedReadPaths` in frontmatter |
| Network | Blocked | `allowNetwork: true` + `allowedHosts` in frontmatter |
| Bash | Not available by default | Provided via tool-daemon, not default |
| Workspace | Guarded by workspace-guard.js | Per-agent `workspaceRoot` in agent.json |
| Memory | Agent-scoped, no cross-agent access | Enforced by agent-guard.js |

## Roadmap

- [ ] Low-stability network resilience (auto-retry, connection recovery, offline queue)
- [ ] Plugin marketplace for community skills
- [ ] Linux desktop builds

## Documentation

| Topic | Path |
|-------|------|
| Install & quickstart | [`docs/install/README.md`](docs/install/README.md) |
| Skills & custom tools | [`docs/skills/README.md`](docs/skills/README.md) |
| Multi-agent architecture | [`docs/multi-agent.md`](docs/multi-agent.md) |
| Gateway protocol (v2) | [`docs/arcana-gateway-protocol.md`](docs/arcana-gateway-protocol.md) |
| Plugin API | [`docs/arcana-plugin-api.md`](docs/arcana-plugin-api.md) |
| Cron & scheduled jobs | [`docs/cron.md`](docs/cron.md) |
| Heartbeat & background | [`docs/heartbeat.md`](docs/heartbeat.md) |
| Channel runtime | [`docs/channel-runtime.md`](docs/channel-runtime.md) |
| Troubleshooting | [`docs/troubleshooting/README.md`](docs/troubleshooting/README.md) |

## Contributing

Bug reports, feature requests, and patches are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup and pull request workflow.

## Security

If you believe you have found a security issue, please do not open a public GitHub issue. Follow the process in [`SECURITY.md`](SECURITY.md) to report it via GitHub Security Advisories.

## License

MIT — see [`LICENSE`](LICENSE).
