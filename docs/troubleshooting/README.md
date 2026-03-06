Troubleshooting

Symptoms and fixes (reference codes from arcana doctor and support-bundle)

- Workspace not found (WORKSPACE_NOT_FOUND)
  - Set ARCANA_WORKSPACE or add workspace_root in arcana.config.json

- Config missing or unreadable (CONFIG_NOT_FOUND)
  - Create arcana.config.json in the repo root (or point ARCANA_CONFIG at a config file) or set ARCANA_MODEL/ARCANA_PROVIDER

- Unknown provider (CONFIG_PROVIDER_UNKNOWN)
  - Use one of: openai, anthropic, google, openrouter, xai

- API key missing (ENV_API_KEY_MISSING)
  - Export the key for your provider (e.g., OPENAI_API_KEY)

- Model unresolved (MODEL_UNAVAILABLE)
  - Check provider+model or set ARCANA_MODEL; for OpenAI try gpt-4o-mini

- Plugin load errors (PLUGINS_LOAD_ERRORS)
  - Inspect plugins/ under your project; remove or fix broken files

- No skills detected (SKILLS_NONE)
  - Add skills under ./skills or set ARCANA_SKILLS_DIRS

- Playwright not installed (PLAYWRIGHT_NOT_INSTALLED)
  - npm i -S playwright && npx playwright install

- Playwright launch failed (PLAYWRIGHT_LAUNCH_FAILED)
  - npx playwright install; set ARCANA_PW_ENGINE=chromium|firefox|webkit

- Unexpected automatic memory writes
  - Automatic Tier1 memory triggers are disabled by default.
  - To re-enable, set ARCANA_MEMORY_TRIGGERS=true for tool_fail/user_issue daily appends.
  - SOP extraction runs are enabled by default; disable with ARCANA_SOP_EXTRACTION=false.

Support Bundle
- Run: node ./bin/arcana.js support-bundle --out ./tmp/arcana-support
- The bundle contains: doctor.json, config.sanitized.json, env.sanitized.json, versions.json, plugins.json, system.json
- Secrets/tokens are redacted; personal absolute paths are replaced with <HOME>/…/basename

- Tool execution timeouts
  - Long-running shell/web tool calls may be cancelled by the tool-host client if they exceed configured limits. Use ARCANA_TOOLHOST_BASH_TIMEOUT_MS and ARCANA_TOOLHOST_WEB_TIMEOUT_MS (milliseconds) to increase or disable timeouts; set either to 0 to disable client-level timeout. Per-call overrides: bash accepts a timeout (seconds); web tools accept an optional timeout (seconds).
  - When a timeout or cancellation happens, the agent now receives an explicit tool error output (not a thrown exception). The tool returns a short text message and details.ok=false with error set to timeout or cancelled so the agent can respond or retry accordingly.
  - Canonical long-term memory for the default agent lives at $ARCANA_HOME/agents/default/MEMORY.md (ARCANA_HOME defaults to ~/.arcana).
