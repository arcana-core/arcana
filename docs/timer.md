Arcana Timer Scheduler

Overview
- Local scheduler storing state under .arcana/agents/<agentId>/timer/ in your workspace (default agentId is "default").
- Job kinds: exec (shell command) and arcana (non-interactive Arcana turn).
- Schedules: at (ISO or +duration), every (duration like 10m or 1h30m), cron (m h dom mon dow; supports asterisk, lists, ranges, and step forms like every-n).

CLI
- Run due once and exit: node ./bin/arcana.js timer once
- Serve loop (CTRL+C to stop): node ./bin/arcana.js timer serve
- Run a job now: node ./bin/arcana.js timer run <id>
- List jobs: node ./bin/arcana.js timer list
- List recent runs: node ./bin/arcana.js timer runs [--limit 100]

Tool (in-chat)
Tool name: timer
Actions: add, list, runs, enable, disable, remove, update, run, run_due_once
Examples:
- Add every 30 minutes (exec):
  {"action":"add","title":"Ping","schedule":{"type":"every","value":"30m"},"task":{"kind":"exec","command":"echo hello"}}
- Add daily at 09:00 UTC (cron, arcana):
  {"action":"add","title":"Daily Brief","schedule":{"type":"cron","value":"0 9 any any any","timezone":"UTC"},"task":{"kind":"arcana","prompt":"Summarize repo changes in 5 bullets"}}
- Add an arcana job with a 2 minute timeout override (in ms):
  {"action":"add","title":"Short Arcana","schedule":{"type":"every","value":"10m"},"task":{"kind":"arcana","prompt":"Do a quick check","timeoutMs":120000}}
- Arcana sessionMode inherit (default): uses or auto-fills the current chat sessionId when missing so existing jobs stay backward compatible.
  {"action":"add","title":"Inherit Session","schedule":{"type":"every","value":"15m"},"task":{"kind":"arcana","prompt":"Check status","sessionMode":"inherit"}}
- Arcana sessionMode new: creates a new isolated session for each timer run (no history is shared with interactive chat or other runs).
  {"action":"add","title":"New Session Each Run","schedule":{"type":"every","value":"1h"},"task":{"kind":"arcana","prompt":"Summarize logs","sessionMode":"new"}}
- Arcana sessionMode main_queue: enqueues the prompt as a per-session event and later drains queued events into one arcana turn when the main session is idle; consecutive duplicate events are suppressed and each session queue holds at most 20 events.
  {"action":"add","title":"Main Queue Monitor","schedule":{"type":"every","value":"5m"},"task":{"kind":"arcana","prompt":"Poll latest metrics","sessionMode":"main_queue"}}

Storage
- .arcana/agents/<agentId>/timer/jobs.json
- .arcana/agents/<agentId>/timer/runs.jsonl
- .arcana/agents/<agentId>/timer/logs/<jobId>/logs
- .arcana/agents/<agentId>/timer/jobs.lock
- .arcana/agents/<agentId>/timer/locks/<jobId>.lock
- .arcana/agents/<agentId>/timer/session_events/
- .arcana/agents/<agentId>/timer/session_wakes/
- .arcana/agents/<agentId>/timer/session_turn_locks/

Notes
- exec uses /bin/zsh -lc to run commands; output is logged.
- arcana jobs run under the associated agent and append to that agent's session history (under `~/.arcana/agents/<agentId>/sessions/`), logging assistant text.
- one-shot at schedules clear nextRunAtMs after execution.

Compaction
- Arcana timer arcana jobs track an approximate per-session token count. By default, when a session exceeds 200000 tokens (or if token usage is unavailable and the combined history text exceeds 600000 UTF-8 bytes), older messages are compacted.
- Compaction keeps only the most recent 50 messages and summarizes earlier messages into the session summary field.
- These thresholds (tokens and fallback bytes) can be configured per agent from the web UI advanced settings panel under 设置 / 诊断.

Timeouts and locks
- Arcana timer arcana jobs have a hard timeout. By default each arcana task is limited to 60000 ms; this can be overridden per job via task.timeoutMs or globally via the ARCANA_TIMER_ARCANA_TIMEOUT_MS environment variable. On timeout, the tool host is best-effort cancelled and the run is recorded with error="timeout".
- Per-job run locks under .arcana/agents/<agentId>/timer/locks/<jobId>.lock include a small JSON payload (pid, startedAtMs). Locks older than 10 minutes are treated as stale and can be automatically stolen; the staleness threshold is configurable via ARCANA_TIMER_JOB_LOCK_STALE_MS (ms).
