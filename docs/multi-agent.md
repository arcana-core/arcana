# Multi-Agent Architecture

This document describes how Arcana models multiple agents, how they stay isolated from each other, and how the web API and services layer interact with that model.

## Agent Home vs Workspace

Arcana now separates **agent home** from **workspace root**.

- **Arcana home**
  - Resolved from `ARCANA_HOME` (default `~/.arcana`).

- **Agent home**
  - One directory per agent under Arcana home:
    - `$ARCANA_HOME/agents/<agentId>/`
  - Contents (convention, not strict schema):
    - `agent.json` – metadata:
      ```jsonc
      {
        "agentId": "my-agent",
        "workspaceRoot": "/abs/path/to/workspace",   // required
        "createdAt": "2026-03-04T12:34:56.000Z"
      }
      ```
    - Persona / long‑term context (user-editable):
      - `AGENTS.md`
      - `MEMORY.md`
      - optional `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`
    - Agent‑scoped memory & skills:
      - `memory/` (daily logs, reflections, SOPs)
      - `skills/`
      - `.agents/skills/`
    - `services.ini` – agent‑scoped services configuration (see below).

- **Workspace root**
  - Arbitrary filesystem directory (project root, monorepo, etc.).
  - Stored in `agent.json.workspaceRoot` and **never inferred from the agent home path**.
  - All tool I/O, search/read/ls/find, and project‑level operations are rooted here and enforced by the workspace guard.

A typical layout looks like (ARCANA_HOME defaults to `~/.arcana`):

```text
$ARCANA_HOME/
  agents/
    default/
      agent.json               # { agentId: "default", workspaceRoot: "/projects/foo" }
      AGENTS.md
      MEMORY.md
      SOUL.md
      IDENTITY.md
      USER.md
      TOOLS.md
      BOOTSTRAP.md
      HEARTBEAT.md
      services.ini
      memory/
      skills/
      .agents/
        skills/
    other-agent/
      agent.json               # { agentId: "other-agent", workspaceRoot: "/projects/bar" }
      ...
```

The **workspace root** in this example is `/projects/foo` or `/projects/bar`, not under `~/.arcana`.
The **agent home** paths above are all resolved under `$ARCANA_HOME`.

## Agent Isolation

Arcana treats each agent as an isolated unit along four axes:

- **Workspace**
  - Each request runs with a `workspaceRoot` taken from that agent's `agent.json`.
  - The workspace guard (`workspace-guard.js`) enforces read/write access under this root.
  - Tools like `read`, `grep`, `find`, and `ls` can only see paths within the configured workspace.

- **Persona**
  - Each agent has its own persona and behavior prompts under its agent home:
    - `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`, `AGENTS.md`, plus optional `APPEND_SYSTEM.md`.
  - When a session is created, Arcana prefers persona files from **agent home**, with a fallback to workspace‑local files for backward compatibility.

- **Memory**
  - Long‑term memory lives **under the agent home**, not the workspace:
    - `$ARCANA_HOME/agents/default/MEMORY.md` (canonical long‑term memory for the default agent)
    - `$ARCANA_HOME/agents/<agentId>/memory/YYYY-MM-DD.md`
  - Memory tools (`memory_search`, `memory_get`) are guarded by `agent-guard.js` and can only read inside the owning agent's home.

- **Skills**
  - Skills are layered so agents can share package skills but still override them locally:
    - Package skills (shared): `skills/` in this repo (or `<pkgRoot>/skills` in general).
    - Agent skills (preferred): `$ARCANA_HOME/agents/<agentId>/skills` and `$ARCANA_HOME/agents/<agentId>/.agents/skills`.
    - Workspace‑local skills (legacy/back‑compat): `<workspaceRoot>/skills`, `<workspaceRoot>/.agents/skills`.
  - **Tool execution:** tools provided by user-authored skills are executed in an **isolated sandbox by default** (one Node child process per call). The tool-daemon is reserved for long-lived, stateful hosts like Playwright web tools and `bash`.
  - Skill discovery runs with `cwd = agentHomeRoot` and merges package + agent + workspace layers, de‑duplicating by skill name.

## Services Per Agent

Background services are configured **per agent** via `services.ini` in the agent home, with an optional workspace fallback.

- **services.ini (recommended)**
  - Preferred location: `~/.arcana/agents/<agentId>/services.ini`.
  - Preferred location: `$ARCANA_HOME/agents/<agentId>/services.ini`.
  - For legacy setups, `services.ini` under the workspace root is also honored if no agent‑level file exists.
  - Format:

    ```ini
    [feishu]
    command = node $ARCANA_PKG_ROOT/skills/feishu/scripts/feishu-bridge.mjs
    # 在 Arcana 密码箱 Secrets 区域绑定 services/feishu/app_id 和 services/feishu/app_secret
    env.FEISHU_DOMAIN = feishu
    ```

  - Keys:
    - `command` – shell command to start the service process.
    - `module` – optional ESM module to load instead of `command`.
    - `cwd` – optional working directory (defaults to the workspace root).
    - `env.*` – environment variables passed into the service.
  - The services manager:
    - Resolves `workspaceRoot` from the active agent/session.
    - Resolves `agentId` via async‑local context and sets `ARCANA_AGENT_ID` for `command` services.

- **Legacy `./services` modules**
  - Files under `<workspaceRoot>/services/*.js|*.mjs` remain supported.
  - They receive `{ workspaceRoot, servicePath, serviceId, logDir, env, agentId }` and log under `<workspaceRoot>/.arcana/services/<serviceId>/`.

Service configuration is **owned by the agent**. Different agents can share a workspace but use different `services.ini` files.

## Sessions Store

Sessions are stored **per agent** under the agent home.

- Layout:

  ```text
  $ARCANA_HOME/agents/<agentId>/sessions/<sessionId>.json
  ```

- Schema (new):

  ```jsonc
  {
    "id": "2026-03-04__...",
    "title": "新会话",
    "agentId": "my-agent",      // defaults to "default" when omitted
    "createdAt": "...",
    "updatedAt": "...",
    "messages": [
      { "role": "user", "text": "...", "ts": "..." },
      { "role": "assistant", "text": "...", "ts": "..." }
    ]
    // Optional legacy fields:
    // "workspace": "/abs/path/to/workspace"  // ignored by new code
  }
  ```

- Behavior:
  - New sessions created via `/api/sessions` or Gateway v2 chat (`/v2/turn-sync`) set `agentId` and **do not** write `workspace`.
  - Legacy sessions that still contain `workspace` continue to load; the field is ignored by new callers.
  - Sessions for the default `default` agent live in `$ARCANA_HOME/agents/default/sessions/`.

## Agents Listing

- `GET /api/agents`
  - Scans `$ARCANA_HOME/agents/*/agent.json` and returns:

    ```jsonc
    {
      "agents": [
        {
          "agentId": "default",
          "agentDir": "/Users/.../.arcana/agents/default",
          "agentHomeDir": "/Users/.../.arcana/agents/default",
          "workspaceRoot": "/projects/foo",
          "createdAt": "2026-03-04T12:34:56.000Z"
        },
        {
          "agentId": "other-agent",
          "agentDir": "/Users/.../.arcana/agents/other-agent",
          "agentHomeDir": "/Users/.../.arcana/agents/other-agent",
          "workspaceRoot": "/projects/bar",
          "createdAt": "..."
        }
      ]
    }
    ```

  - There is always at least a `default` agent:
  - On first use, the server calls `ensureDefaultAgentExists()` which:
    - Picks a `workspaceRoot` (from `ARCANA_WORKSPACE`, config workspace_root/workspaceRoot, or `process.cwd()`).
    - Creates `$ARCANA_HOME/agents/default/agent.json` pointing at that workspace.
    - Seeds `AGENTS.md`, `MEMORY.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`, `memory/`, `skills/`, `.agents/skills/`, and a commented `services.ini` example.
    - If `$ARCANA_HOME/agents/default/` does not exist but there are existing agents, copies the newest agent home (by `createdAt` in `agent.json`, with a fallback to the file's creation/modification time) into `$ARCANA_HOME/agents/default/` once and rewrites `agent.json.agentId` to "default" so existing persona, memory, and sessions carry over.

## Sessions API

### `GET /api/sessions?agentId=<id>`

- Lists sessions for that agent:

  ```jsonc
  {
    "sessions": [
      {
        "id": "2026-03-04__...",
        "title": "新会话",
        "agentId": "default",
        "createdAt": "...",
        "updatedAt": "...",
        "last": { "role": "assistant", "text": "...", "ts": "..." }
      }
    ]
  }
  ```

- `agentId` is required by the client; the server defaults to `default` if omitted.

### `POST /api/sessions`

- Body:

  ```jsonc
  {
    "title": "新会话",     // optional
    "agentId": "default"      // optional, defaults to "default"
  }
  ```

- Behavior:
  - Resolves the agent via `agentId`.
  - Fails with `400 agent_not_found` if the agent does not exist or has no `workspaceRoot`.
  - Creates a new session JSON under `$ARCANA_HOME/agents/<agentId>/sessions/`.

### `GET /api/sessions/:id?agentId=<id>`

- Loads a single session JSON for the given agent.
- If `agentId` is omitted, the server assumes `default` and does **not** scan across agents.

### `DELETE /api/sessions/:id?agentId=<id>`

- Deletes one session JSON under `$ARCANA_HOME/agents/<agentId>/sessions/`.
- If `agentId` is omitted, only sessions for the default agent are considered.

## Gateway v2 Chat (`/v2/turn-sync`) – Agent-Aware Chat

The Gateway v2 chat endpoint is **agent-centric** and replaces legacy `/api/chat2`.

- Request body (synchronous chat):

  ```jsonc
  {
    "text": "...",            // required user message
    "policy": "open" | "restricted",  // optional, defaults to "restricted"
    "agentId": "default",           // optional, defaults to "default"
    "sessionKey": "..."           // optional; stable key for this channel/session
  }
  ```

- Behavior:
  - Resolves the agent via `agentId` and its `workspaceRoot` from `agent.json`.
  - Creates or loads the session under that agent home.
  - Runs the chat turn inside an async‑local context containing:

    ```js
    {
      sessionId,
      agentId,
      agentHomeRoot: "$ARCANA_HOME/agents/<agentId>",
      workspaceRoot: agent.workspaceRoot
    }
    ```

  - This context is visible to:
    - `workspace-guard` (tool I/O root).
    - `agent-guard` (memory/services/persona root).
    - Services manager (for `ARCANA_AGENT_ID`).
  - If the request body includes a `workspace` field (from older clients), the server ignores it; the active workspace always comes from the resolved agent's `workspaceRoot`.
  - If a loaded session has a different `agentId` than the request, the server returns `409 agent_mismatch`.

---

This model lets you:

- Keep **agent identity, memory, skills, and services** in a stable per‑agent home under `$ARCANA_HOME/agents/<agentId>/`.
- Point each agent at any **workspace root** on disk for project‑specific work.
