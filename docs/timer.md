Arcana Timer Scheduler

Overview
- Local scheduler storing state under .arcana/timer/ in your workspace.
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

Storage
- .arcana/timer/jobs.json
- .arcana/timer/runs.jsonl
- .arcana/timer/logs/<jobId>/logs
- .arcana/timer/jobs.lock
- .arcana/timer/locks/<jobId>.lock

Notes
- exec uses /bin/zsh -lc to run commands; output is logged.
- arcana appends to .sessions/ and logs assistant text.
- one-shot at schedules clear nextRunAtMs after execution.
