# Heartbeat

Arcana's heartbeat subsystem lets an agent periodically inspect workspace state and system events and, when needed, post short updates into a target chat session.

## Enabling heartbeat for an agent

Create a heartbeat config file under your Arcana home:

- Path: `~/.arcana/agents/<agentId>/heartbeat.json`
- Minimal example:

  {
    "enabled": true,
    "every": "2m",
    "targetSessionId": "<session-id-to-post-into>"
  }

Fields:

- `enabled`: set to `true` to allow heartbeat runs for this agent (if `false` or missing, the agent is skipped).
- `every`: interval between runs. Supports values like `60000` (milliseconds) or `"2m"`, `"30s"`, `"1h"`.
- `targetSessionId`: the session that heartbeat messages should be appended to.

## System events storage

Heartbeat consumes events from the JSON-backed system events store under Arcana home. For each agent and session, events are stored at:

- `~/.arcana/agents/<agentId>/system-events/<sessionId>.json`

Each file maintains a small queue of pending events plus dedupe metadata. Heartbeat runs read from this store and, when a message is successfully delivered, acknowledge events so the queue stays bounded.

## CLI commands

Arcana provides a small CLI for managing and triggering heartbeat runs:

- `arcana heartbeat serve`
  - Starts a heartbeat runner loop using the configured agents.
  - Logs each run to stdout (status, agentId, sessionId, reason, events processed).
  - Intended for long-running background use (Ctrl+C to stop).

- `arcana heartbeat once --agent <id> --session <sessionKey> [--reason r]`
  - Triggers a single heartbeat run for the given agent/session key.
  - Uses the same logic as the background runner (including system-event processing and HEARTBEAT.md prompt).
  - Prints the full result object as JSON.

- `arcana heartbeat request --agent <id> [--session <sessionKey>] [--reason r]`
  - Enqueues a lightweight wake request for the heartbeat runner.
  - Useful when a tool or external script wants to nudge heartbeat without running it inline.

- `arcana heartbeat enqueue --agent <id> --session <sessionKey> --text <text> [--context c] [--dedupe k] [--wake]`
  - Appends a system event into the JSON store for the given agent/session key.
  - `--text`: human-readable description of the event.
  - `--context`: optional context key (for example, `cron:jobId` or `exec:<command>`).
  - `--dedupe`: optional dedupe key; recent events with the same key may be skipped.
  - `--wake`: if present, also calls `requestHeartbeatNow` so the runner processes events soon.

- `arcana heartbeat status`
  - Reads `~/.arcana/agents` to discover agents and prints, for each one:
    - `enabled` flag (derived from `heartbeat.json`)
    - `every` interval value
    - `targetSessionId` (if configured).

## HEARTBEAT.md and bootstrap context

When Arcana runs a heartbeat check, it creates a lightweight agent session with a minimal bootstrap context. In this mode, only the agent-home `HEARTBEAT.md` file is injected from the agent persona directory; other persona files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, etc.) are not added.

This keeps heartbeat prompts focused and small while still letting you define heartbeat-specific instructions in `HEARTBEAT.md` for each agent.
