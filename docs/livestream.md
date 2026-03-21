Arcana Livestream Showrunner

Overview
- Always-on showrunner that decides when an Arcana agent should speak in a Bilibili Live room.
- Implemented as two background services managed by the Arcana service manager:
  - `services/bilibili_listener.mjs` keeps persistent WebSocket connections to Bilibili danmaku and exposes a local HTTP API on `http://127.0.0.1:28920`.
  - `services/livestream_showrunner.mjs` polls events from the local listener and calls the Arcana Gateway v2 `/v2/turn-sync` endpoint to run the showrunner loop.
- Persists minimal per-room, per-agent state under Arcana home so the loop can be restarted without losing context.

CLI
- Enable livestream for a room:

  arcana livestream enable --room <roomId> [--agent <agentId>] [--tick-ms <n>] [--tts-provider <p>] [--tts-play 0|1] [--subtitle 0|1]

- Disable livestream (optionally for a single room):

  arcana livestream disable [--agent <agentId>] [--room <roomId>]

- Show current config and log location:

  arcana livestream status [--agent <agentId>]

Arguments
- --room <roomId>
  - Required for `enable`. Bilibili Live room id or short id.
- --agent <agentId>
  - Optional. Arcana agent id (defaults to `default` or `ARCANA_AGENT_ID`). Controls which agent persona and tools are used for the LLM turns.
- --tick-ms <n>
  - Optional. Tick interval in milliseconds for this room. On each tick the showrunner may poll Bilibili and optionally run a turn.
  - Defaults to 3000 when not set in the config.
- --tts-provider <p>
  - Optional. TTS provider id exposed to the agent via the `live_tts` tool (for example: `elevenlabs`, `aliyun_cosyvoice`, `aliyun_cosyvoice_ws`).
- --tts-play 0|1
  - Optional. Preferred `play` flag passed through to `live_tts` when the agent calls it.
- --subtitle 0|1
  - Optional. Preferred `subtitle` flag passed through to `live_tts` when the agent calls it.

Livestream config
- The CLI edits the per-agent config at:
  - `~/.arcana/agents/<agentId>/livestream/config.json`
- Shape (per agent):
  - `enabled`: boolean; when false, all room loops are stopped.
  - `rooms[]`: list of room configs. Each entry may contain:
    - `roomId`: required, Bilibili room id (string).
    - `tickMs`: optional tick interval in ms (defaults to 3000).
    - `idleMs`: optional idle threshold in ms (defaults to 15000).
    - `sessionId`: optional existing Gateway session id to reuse.
    - `ttsProvider`, `ttsPlay`, `subtitle`: optional live TTS settings for this room.
- `services/livestream_showrunner.mjs` polls this config approximately every 2 seconds and starts/stops per-room loops accordingly. Changes to `config.json` take effect without restarting the service.

Services
- `services/bilibili_listener.mjs`
  - Maintains a persistent WebSocket connection per configured room to Bilibili’s danmaku servers.
  - Exposes a local HTTP API on `http://127.0.0.1:28920`:
    - `POST /start` with `{ roomId }` to start tracking a room.
    - `POST /stop` with `{ roomId }` to stop a room.
    - `GET /events?roomId=...&after=...&limit=...` to fetch recent normalized events.
    - `GET /status` for a summary of active rooms.
- `services/livestream_showrunner.mjs`
  - For each enabled room in `config.json`, ensures the local listener is started.
  - On every tick, pulls new events from the local listener, decides whether to run a turn, and calls the Gateway v2 `/v2/turn-sync` API for the configured agent.

Behavior
- On each tick the showrunner:
  - Polls recent Bilibili events from the local listener via its `/events` HTTP endpoint using the stored cursor (so only new events are considered).
  - Reads the last spoken timestamp from state to compute how long the streamer has been silent.
  - Decides whether to run an LLM turn:
    - Runs a turn when there are new events, or when the idle time exceeds the idle threshold.
    - Skips the turn when there are no events and the streamer has spoken recently.
- When running a turn:
  - Builds a compact text prompt summarizing recent events plus timing metadata.
  - The prompt contains a baked-in streamer persona:
    - Anime-style virtual streamer, cheerful 16-year-old girl.
    - The agent should speak in her voice, with a light, cheerful, anime-style tone.
    - Viewers may know she is AI, but she stays in character as the streamer.
    - The agent should only mention being an AI if a recent event explicitly asks about it; otherwise AI/TTS should not be mentioned.
  - Calls the Arcana Gateway v2 `/v2/turn-sync` endpoint for the configured agent (policy `restricted`) with this prompt.
  - The agent must follow a strict one-line protocol and respond with either:
    - `WAIT` (stay silent), or
    - `SAY:<text>` where `<text>` is a single line.
  - The assistant text from `/v2/turn-sync` is parsed; extra lines are ignored and only the first non-empty line is considered.
  - If the parsed result is `WAIT` or invalid, the tick completes with no speech.
  - If the result is `SAY:<text>`:
    - The text is sanitized (whitespace collapsed, max length 60 characters, basic keyword filter for sexual / NSFW content, including a small set of Chinese explicit terms).
    - The service logs `SAY <text>` and updates `lastSpeakAtMs`.
    - When a TTS provider is configured for the room, the prompt instructs the agent to call the `live_tts` tool with `action="say"`, passing the same `<text>` plus `provider`, `play`, and `subtitle` flags taken from the config.

State and logs
- Persistent state is stored under the agent home directory:
  - `~/.arcana/agents/<agentId>/livestream/bilibili-room-<roomId>.json`
- Fields:
  - `cursor`: last event cursor (string; stores the last listener sequence number so only new events are fetched on the next poll).
  - `sessionId`: Gateway session id used for showrunner turns.
  - `lastSpeakAtMs`: millisecond timestamp of the last successful `SAY` line.
- Service logs (per workspace):
  - Bilibili listener logs: `<workspace>/.arcana/services/bilibili_listener/`
  - Livestream showrunner logs: `<workspace>/.arcana/services/livestream_showrunner/`

Env vars
- Arcana home and agent selection:
  - `ARCANA_HOME`: optional; overrides the default `~/.arcana` home used for `config.json` and state files.
  - `ARCANA_AGENT_ID`: optional; default agent id used by `livestream_showrunner` when `--agent` is not provided.
- Gateway API token:
  - `services/livestream_showrunner.mjs` reads the Gateway API token from:
    - `ARCANA_API_TOKEN` (preferred), or
    - `~/.arcana/api_token` when the env var is empty.
  - The token is sent as an `Authorization: Bearer ...` header on `/v2/turn-sync` calls; no extra CLI flags are needed.
- Livestream tuning (non-secret env):
  - `ARCANA_LIVESTREAM_TURN_TIMEOUT_MS`
    - Hard timeout in milliseconds for each `/v2/turn-sync` call.
    - Default: 45000.
- `live_tts` provider secrets and env:
  - Bind `services/elevenlabs/api_key` in the Secrets UI (for ElevenLabs) and configure any non-secret env like `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`.
  - Bind `services/aliyun/dashscope_api_key` for DashScope-based voices; keep `ALIYUN_COSYVOICE_*` env vars for non-secret endpoint/model/voice configuration.
- Do not store provider API keys directly in plain env vars when running inside the managed Arcana environment; prefer secrets bindings stored in the internal encrypted vault.

Safety and content guarantees
- The showrunner prompt strictly instructs the agent to:
  - Respond with exactly one line using the WAIT / SAY protocol.
  - Keep any spoken line at or below 60 characters.
  - Use the baked-in persona: anime-style, cheerful, 16-year-old virtual girl.
  - Avoid physical descriptions or claims about the streamer’s body.
  - Avoid sexual, explicit, romantic, or NSFW content entirely.
  - Never sexualize the character or anyone else (the character is a minor).
  - When viewers ask for sexual / explicit / NSFW content, respond with a short, friendly refusal plus a wholesome redirect using `SAY:<text>`, and avoid echoing explicit keywords.
  - Do not output `WAIT` in response to explicit/NSFW requests; refusals are spoken as `SAY` lines instead.
- Additionally, the post-processing step enforces:
  - Length limit: anything longer than 60 characters is truncated.
  - A small keyword filter for common sexual / NSFW terms (including some Chinese phrases); if triggered, the `SAY` line is discarded and nothing is spoken on that tick.

Notes
- `services/bilibili_listener.mjs` and `services/livestream_showrunner.mjs` are started and supervised by the Arcana service manager (via `startServicesOnce` in `src/services/manager.js`).
- When restarted, the showrunner resumes from the last saved `cursor` / `sessionId` / `lastSpeakAtMs` so it does not re-announce old events.
