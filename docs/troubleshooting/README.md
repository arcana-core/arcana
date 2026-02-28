Troubleshooting

Symptoms and fixes (reference codes from arcana doctor and support-bundle)

- Workspace not found (WORKSPACE_NOT_FOUND)
  - Set ARCANA_WORKSPACE or add workspace_root in arcana.config.json

- Config missing or unreadable (CONFIG_NOT_FOUND)
  - Create arcana/arcana.config.json or set ARCANA_MODEL/ARCANA_PROVIDER

- Unknown provider (CONFIG_PROVIDER_UNKNOWN)
  - Use one of: openai, anthropic, google, openrouter, xai

- API key missing (ENV_API_KEY_MISSING)
  - Export the key for your provider (e.g., OPENAI_API_KEY)

- Model unresolved (MODEL_UNAVAILABLE)
  - Check provider+model or set ARCANA_MODEL; for OpenAI try gpt-4o-mini

- Plugin load errors (PLUGINS_LOAD_ERRORS)
  - Inspect arcana/plugins; remove or fix broken files

- No skills detected (SKILLS_NONE)
  - Add skills under ./skills or set ARCANA_SKILLS_DIRS

- Playwright not installed (PLAYWRIGHT_NOT_INSTALLED)
  - npm i -S playwright && npx playwright install

- Playwright launch failed (PLAYWRIGHT_LAUNCH_FAILED)
  - npx playwright install; set ARCANA_PW_ENGINE=chromium|firefox|webkit

Support Bundle
- Run: node ./arcana/bin/arcana.js support-bundle --out ./tmp/arcana-support
- The bundle contains: doctor.json, config.sanitized.json, env.sanitized.json, versions.json, plugins.json, system.json
- Secrets/tokens are redacted; personal absolute paths are replaced with <HOME>/…/basename
