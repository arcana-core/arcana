Install & Quickstart

Prereqs
- Node.js 22+ (LTS recommended)
- npm 9+
- Optional: provider API key via Arcana secrets (e.g., bind providers/openai/api_key in the Secrets UI Secrets section; the value is stored encrypted in the internal vault).

Install (macOS/Linux)
- Run: npm i
- Run: npx playwright install

Install (Windows PowerShell)
- Run: npm i
- Run: npx playwright install

Configure a provider (example: OpenAI)
- In the Secrets UI, bind providers/openai/api_key in the Secrets section and paste your OpenAI API key; Arcana will encrypt it into the internal vault.
- Optional: set ARCANA_MODEL=openai:gpt-4o-mini
- Or create arcana.config.json in the repo root (or set ARCANA_CONFIG to a custom config path) with provider and model fields

Optional behavior flags
- Enable automatic Tier1 memory triggers (tool_fail + user_issue): set ARCANA_MEMORY_TRIGGERS=true
- Disable pre-compaction memory flush (memory write before history compaction): set ARCANA_MEMORY_FLUSH=false

Quickstart
- Health check: node ./bin/arcana.js doctor
- JSON report: node ./bin/arcana.js doctor --json
- Chat: node ./bin/arcana.js chat
- Web navigate: node ./bin/arcana.js web navigate https://example.com
- Web extract: node ./bin/arcana.js web extract
- Web serve UI: node ./bin/arcana.js web serve --port 5678

Notes
- If Playwright launch fails, run npx playwright install then retry.
- Force engine via ARCANA_PW_ENGINE=chromium|firefox|webkit.
- Long-term memory for the default agent lives at $ARCANA_HOME/agents/default/MEMORY.md (ARCANA_HOME defaults to ~/.arcana).
- On first run, Arcana seeds $ARCANA_HOME/APPEND_SYSTEM.md from the packaged default so you can customize global system behavior; this file is user-editable and will not be overwritten on later runs.
