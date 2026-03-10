Arcana Cron Scheduler

Overview
- Local scheduler storing state under .arcana/agents/<agentId>/cron/ in your workspace (default agentId is "default").
- Job kinds: exec (shell command) and agentTurn (non-interactive Arcana agent turn).
- Schedules: at (ISO or +duration), every (duration like 10m or 1h30m), cron (m h dom mon dow; supports asterisk, lists, ranges, and step forms like every-n).

CLI
- Run due once and exit: node ./bin/arcana.js cron once
- Serve loop (CTRL+C to stop): node ./bin/arcana.js cron serve
- Run a job now: node ./bin/arcana.js cron run <id>
- List jobs: node ./bin/arcana.js cron list
- List recent runs: node ./bin/arcana.js cron runs [--limit 100]

Tool (in-chat)
Tool name: cron
Actions: add, list, runs, enable, disable, remove, update, run, run_due_once, status

Job schema (high level)
- title: string (optional; defaults to "Cron Job")
- schedule: { type: "at"|"every"|"cron", value: string, timezone: "local"|"UTC" }
- payload:
  - exec: { kind:"exec", command:string }
  - agentTurn: { kind:"agentTurn", prompt:string, timeoutMs?:number }
- sessionTarget: "main" | "isolated" (default "isolated" for agentTurn jobs created via the in-chat cron tool when sessionTarget/delivery are omitted)
- delivery: { mode:"none"|"announce"|"feishu_reply", sessionId?:string, messageId?:string, replyInThread?:boolean }

Payload semantics
- exec
  - Runs the given shell command using the current workspace as cwd.
  - Stdout/stderr are streamed into a per-run log file under logs/<jobId>/.

- agentTurn
  - Runs an Arcana agent prompt as a background turn.
  - sessionTarget === "main":
    - Runs directly inside delivery.sessionId.
    - delivery.sessionId defaults to the current chat sessionId when the job is created via the cron tool and sessionTarget or delivery is explicitly provided.
    - Per-session turn locks are used to avoid overlapping turns with interactive chat in the same session.
  - sessionTarget === "isolated":
    - Each run creates a fresh isolated session (title based on the job title + timestamp), with a "[cron-run]" prefix in the session title so it appears as a background session in the web UI.
    - When delivery.mode == "announce" and delivery.sessionId is set, the tail of the assistant text is appended as an assistant message into the delivery session (best effort, also protected by a per-session turn lock).
  - Defaults for agentTurn jobs created via the in-chat cron tool:
    - If both sessionTarget and delivery are omitted, sessionTarget defaults to "isolated", delivery.mode defaults to "announce", and delivery.sessionId defaults to a per-agent "[cron-inbox]" session (falling back to the current chat session when the inbox cannot be created).
    - When the source chat session has Feishu session metadata recorded by the Feishu bridge (including a Feishu message id) and both sessionTarget and delivery are omitted, sessionTarget defaults to "isolated" and delivery defaults to replying back to that Feishu thread using mode="feishu_reply" (with replyInThread=true).
  - timeoutMs (per payload) overrides the default cron agentTurn timeout; when omitted, the default is taken from the ARCANA_CRON_ARCANA_TIMEOUT_MS environment variable (or 60000 ms if unset).

Storage
- .arcana/agents/<agentId>/cron/jobs.json
- .arcana/agents/<agentId>/cron/runs.jsonl
- .arcana/agents/<agentId>/cron/logs/<jobId>/*.log
- .arcana/agents/<agentId>/cron/jobs.lock
- .arcana/agents/<agentId>/cron/locks/<jobId>.lock
- .arcana/agents/<agentId>/cron/session_turn_locks/

Notes
- exec uses the current user shell (e.g., bash/zsh) to run commands; output is logged.
- agentTurn jobs run under the associated agent and append to that agent's session history (under `~/.arcana/agents/<agentId>/sessions/`), logging assistant text.
- One-shot at schedules clear nextRunAtMs after execution.

Compaction
- Cron agentTurn jobs track an approximate per-session token count. By default, when a session exceeds 200000 tokens (or if token usage is unavailable and the combined history text exceeds 600000 UTF-8 bytes), older messages are compacted.
- Compaction keeps only the most recent 50 messages and summarizes earlier messages into the session summary field.
- Prompt construction uses a bounded history prelude (recent messages + summary) to reduce context-window overflow risk.
- These thresholds (tokens and fallback bytes) can be configured per agent from the web UI advanced settings panel under 设置 / 诊断 (the "会话压缩设置" section).
- Cron settings are stored per agent under .arcana/agents/<agentId>/cron/settings.json and are also accessible via the HTTP endpoints /api/cron-settings and /api/timer-settings (compatibility alias).

Timeouts and locks
- Cron agentTurn jobs have a hard timeout. By default each agentTurn is limited to 60000 ms; this can be overridden per job via payload.timeoutMs or globally via the ARCANA_CRON_ARCANA_TIMEOUT_MS environment variable. On timeout, the tool host is best-effort cancelled and the run is recorded with error="timeout".
- Per-job run locks under .arcana/agents/<agentId>/cron/locks/<jobId>.lock include a small JSON payload (pid, startedAtMs). Locks older than 10 minutes are treated as stale and can be automatically stolen; the staleness threshold is configurable via ARCANA_CRON_JOB_LOCK_STALE_MS (ms).
- Per-session turn locks under .arcana/agents/<agentId>/cron/session_turn_locks/ ensure that only one turn at a time can mutate a given session transcript (used by both interactive chat and cron agentTurn delivery).
