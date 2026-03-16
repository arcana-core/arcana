Troubleshooting

Symptoms and fixes (reference codes from arcana doctor and support-bundle)

- Workspace not found (WORKSPACE_NOT_FOUND)
  - Set ARCANA_WORKSPACE or add workspace_root in arcana.config.json

- Config missing or unreadable (CONFIG_NOT_FOUND)
  - Create arcana.config.json in the repo root (or point ARCANA_CONFIG at a config file) or set ARCANA_MODEL/ARCANA_PROVIDER

- Unknown provider (CONFIG_PROVIDER_UNKNOWN)
  - Use a provider supported by @mariozechner/pi-ai (see its README Supported Providers section), for example openai, azure-openai-responses, anthropic, google, google-vertex, mistral, groq, cerebras, xai, openrouter, vercel-ai-gateway, minimax, amazon-bedrock, moonshot.
  - Arcana also accepts `openai-compatible` for OpenAI-compatible APIs (e.g. Ollama, vLLM, LM Studio) and `generic` for fully custom gateways.

- API key missing (ENV_API_KEY_MISSING)
- Open the Secrets UI and bind providers/<provider>/api_key for your chosen provider（例如在 Secrets 区域为 providers/openai/api_key 保存 API Key，值会加密写入内部密码箱）。

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
  - To debug with a visible browser, set ARCANA_PW_HEADLESS=false or call the web_render tool with action=open on a machine with a GUI.

- Web tools returning empty or inconsistent text
  - The tool-daemon browser reuses a profile per agent by default so web_render and web_extract calls share cookies and navigation history across tool calls.
  - To isolate profiles per session (for example in multi-tenant setups), set ARCANA_BROWSER_ISOLATE_BY_SESSION=1 before starting services or pass the header x-arcana-browser-isolate=1 to the tool-daemon.
  - Newer Arcana versions forward per-call ctx headers (x-arcana-agent-id and x-arcana-session-id) from the gateway/session into the tool-daemon client so web_render and web_extract share the correct browser profile. Older versions that only relied on async-local context could send different headers per call and cause web_extract to see about:blank or open a blank popup window.

- Unexpected automatic memory writes
  - Automatic Tier1 memory triggers are disabled by default.
  - To re-enable, set ARCANA_MEMORY_TRIGGERS=true for tool_fail/user_issue daily appends.
  - History compaction runs a silent pre-compaction memory flush by default; disable with ARCANA_MEMORY_FLUSH=false.

Support Bundle
- Run: node ./bin/arcana.js support-bundle --out ./tmp/arcana-support
- The bundle contains: doctor.json, config.sanitized.json, env.sanitized.json, versions.json, plugins.json, system.json (with OS/runtime/disk/network summary; still redacted, no IPs or MACs)
- Secrets/tokens are redacted; personal absolute paths are replaced with <HOME>/…/basename

- Tool execution timeouts
  - Long-running shell/web tool calls may be cancelled by the tool-host client if they exceed configured limits. Use ARCANA_TOOLHOST_BASH_TIMEOUT_MS and ARCANA_TOOLHOST_WEB_TIMEOUT_MS (milliseconds) to increase or disable timeouts; set either to 0 to disable client-level timeout. Per-call overrides: bash accepts a timeout (seconds); web tools accept an optional timeout (seconds).
  - When a timeout or cancellation happens, the agent now receives an explicit tool error output (not a thrown exception). The tool returns a short text message and details.ok=false with error set to timeout or cancelled so the agent can respond or retry accordingly.
  - Canonical long-term memory for the default agent lives at $ARCANA_HOME/agents/default/MEMORY.md (ARCANA_HOME defaults to ~/.arcana).

- Session history missing or sessions disappear under load
  - Ensure all Arcana processes share the same ARCANA_HOME (defaults to ~/.arcana). Using different ARCANA_HOME values on the same machine will scatter sessions across multiple directories and make them appear missing.
  - Older Arcana versions could lose or truncate sessions when multiple agents or processes wrote concurrently. Upgrade to a version with atomic session and session-key writes so concurrent runs keep existing sessions intact.
