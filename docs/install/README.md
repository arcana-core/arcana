Install & Quickstart

Prereqs
- Node.js 18+ (LTS recommended)
- npm 9+
- Optional: provider API key (e.g., OPENAI_API_KEY)

Install (macOS/Linux)
- Run: npm i
- Run: npx playwright install

Install (Windows PowerShell)
- Run: npm i
- Run: npx playwright install

Configure a provider (example: OpenAI)
- Export OPENAI_API_KEY in your shell
- Optional: set ARCANA_MODEL=openai:gpt-4o-mini
- Or create arcana/arcana.config.json with provider and model fields

Quickstart
- Health check: node ./arcana/bin/arcana.js doctor
- JSON report: node ./arcana/bin/arcana.js doctor --json
- Chat: node ./arcana/bin/arcana.js chat
- Web navigate: node ./arcana/bin/arcana.js web navigate https://example.com
- Web extract: node ./arcana/bin/arcana.js web extract
- Web serve UI: node ./arcana/bin/arcana.js web serve --port 5678

Notes
- If Playwright launch fails, run npx playwright install then retry.
- Force engine via ARCANA_PW_ENGINE=chromium|firefox|webkit.
