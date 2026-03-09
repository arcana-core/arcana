Arcana Livestream Showrunner

Overview
- Always-on loop that polls Bilibili Live room events and decides when the agent should speak.
- Uses the existing cron/agent infrastructure (runArcanaTask) plus the bilibili_events_pull and live_tts skill tools.
- Persists minimal per-room, per-agent state under Arcana home so the loop can be restarted without losing context.

CLI
- Start the showrunner loop (Ctrl+C to stop):

  arcana livestream serve --room <roomId> [--agent <agentId>] [--tick-ms <n>] [--session <sid>] [--tts-provider <p>] [--tts-play 0|1] [--subtitle 0|1]

Arguments
- --room <roomId>
  - Required. Bilibili Live room id or short id.
- --agent <agentId>
  - Optional. Arcana agent id (defaults to "default"). Controls which agent persona and tools are used for the LLM turns.
- --tick-ms <n>
  - Optional. Tick interval in milliseconds. On each tick the showrunner may poll Bilibili and optionally run a turn.
  - Defaults to ARCANA_LIVESTREAM_TICK_MS (env) or 3000 when not set.
- --session <sid>
  - Optional. Existing Arcana session id to use as the showrunner chat session.
  - When omitted, a session is created on first successful LLM turn and its id is persisted in the livestream state file so restarts continue the same conversation.
- --tts-provider <p>
  - Optional. Provider to pass through to the live_tts skill tool (for example: "elevenlabs", "aliyun_cosyvoice", "aliyun_cosyvoice_ws").
  - When omitted, the showrunner still decides what to say but no audio is synthesized.
- --tts-play 0|1
  - Optional. When set, overrides the live_tts play flag for action=say.
  - "1" (or true/yes) means also instruct the overlay to play the audio.
  - "0" (or false/no) means only synthesize audio but do not play it.
  - When omitted, live_tts uses its default (play=true).
- --subtitle 0|1
  - Optional. When set, overrides the live_tts subtitle flag for action=say.
  - "1" enables subtitle commands; "0" disables them.
  - When omitted, live_tts uses its default (subtitle=true when play is not false).

Behavior
- On each tick the showrunner:
  - Polls recent Bilibili events using the bilibili_events_pull tool with the stored cursor (so only new events are considered).
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
  - Calls runArcanaTask with a strict one-line protocol:
    - The agent must respond with either:
      - "WAIT" (stay silent), or
      - "SAY:<text>" where <text> is a single line.
  - The assistantText buffer from runArcanaTask is parsed; extra lines are ignored and only the first non-empty line is considered.
  - If the parsed result is WAIT or invalid, the tick completes with no speech.
  - If the result is SAY:<text>:
    - The text is sanitized (whitespace collapsed, max length 60 characters, basic keyword filter for sexual / NSFW content, including a small set of Chinese explicit terms).
    - When tts-provider is configured and the sanitized text is non-empty, live_tts is invoked with action=say to synthesize and optionally play the audio + subtitle.
    - When tts-provider is not configured, the sanitized SAY line is still emitted to stdout as:
      - `[arcana] livestream: SAY <text>`
    - lastSpeakAtMs is updated.

State and logs
- Persistent state is stored under the agent home directory:
  - ~/.arcana/agents/<agentId>/livestream/bilibili-room-<roomId>.json
- Fields:
  - cursor: last bilibili_events_pull cursor (string; used as a timestamp threshold for the next poll).
  - sessionId: Arcana session id used for showrunner turns.
  - lastSpeakAtMs: millisecond timestamp of the last successful SAY line.
- Logs for individual turns are written under:
  - ~/.arcana/agents/<agentId>/livestream/logs/room-<roomId>-<timestamp>.log
  - These logs reuse the cron-style Arcana task logging (prompt + assistant tail).

Env vars
- General:
  - OPENAI_API_KEY
    - Used by Arcana to run LLM turns via runArcanaTask.

- Livestream tuning:
  - ARCANA_LIVESTREAM_TICK_MS
    - Default tick interval in milliseconds when --tick-ms is not provided.
    - Default: 3000.
  - ARCANA_LIVESTREAM_IDLE_MS
    - Idle time threshold in milliseconds. When there are no new events and the time since lastSpeakAtMs exceeds this value, the showrunner may run a "keep-alive" turn.
    - Default: 15000.
  - ARCANA_LIVESTREAM_TURN_TIMEOUT_MS
    - Hard timeout in milliseconds for each showrunner LLM turn.
    - Default: 45000.

- live_tts provider env (delegated to the skill):
  - ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID
  - ALIYUN_DASHSCOPE_API_KEY / DASHSCOPE_API_KEY
  - ALIYUN_COSYVOICE_ENDPOINT, ALIYUN_COSYVOICE_MODEL
  - ALIYUN_COSYVOICE_WS_URL, ALIYUN_COSYVOICE_WS_MODEL, ALIYUN_COSYVOICE_VOICE

Safety and content guarantees
- The showrunner prompt strictly instructs the agent to:
  - Respond with exactly one line using the WAIT / SAY protocol.
  - Keep any spoken line at or below 60 characters.
  - Use the baked-in persona: anime-style, cheerful, 16-year-old virtual girl.
  - Avoid physical descriptions or claims about the streamer’s body.
  - Avoid sexual, explicit, romantic, or NSFW content entirely.
  - Never sexualize the character or anyone else (the character is a minor).
  - When viewers ask for sexual / explicit / NSFW content, respond with a short, friendly refusal plus a wholesome redirect using SAY:<text>, and avoid echoing explicit keywords.
  - Do not output WAIT in response to explicit/NSFW requests; refusals are spoken as SAY lines instead.
- Additionally, the post-processing step enforces:
  - Length limit: anything longer than 60 characters is truncated.
  - A small keyword filter for common sexual / NSFW terms (including some Chinese phrases); if triggered, the SAY line is discarded and nothing is spoken on that tick.

Notes
- The showrunner loop traps SIGINT so that Ctrl+C from the CLI cleanly stops the loop.
- When restarted, the showrunner resumes from the last saved cursor/sessionId/lastSpeakAtMs so it does not re-announce old events.
