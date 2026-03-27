Channel Runtime (Ingress Framework)

Goal
- Centralize channel-specific message handling into a shared runtime so new channels only implement event normalization + reply sending.
- Make inbound behavior predictable and consistent across channels (OpenClaw-style): ingress policy + injection policy + dedupe boundary.

Core Module
- `src/channel-runtime/channel-runtime.js` exports `ChannelRuntime`.

Concepts
- Ingress policy:
  - Dedupe by `msg.dedupeKey` with TTL.
  - Mention gating (group messages that do not trigger are buffered).
  - Slash commands handled locally (via `commands`).
  - Built-in `/hey` forced interrupt: if a run is in-flight, `/hey` aborts it via `onExecuteAbort` and then treats the same message as a normal queued turn (with `/hey` removed from the first line). If the remaining text is empty, nothing is queued. When used during in‑flight, any already queued followups are dropped and only this message is kept.
  - Directive stripping (leading `/think`, `/model`, etc.) before sending to the agent.
  - Queue modes: `collect_followup` (default), `off`, `steer`.
    - In `steer` mode, while a run is in-flight, any incoming message (except `/hey`) is treated as a steer signal: `onExecuteSteer` is called and `steerTarget` is set for the pending reply. The previous urgency heuristic is no longer used for gating.
- Injection policy:
  - Stable prompt envelope:
    - `[Channel Context]` (channel, conversation type, ids)
    - `[Buffered Messages - for context]` (pending-only)
    - `[Queued Messages While You Were Busy - for context]` (batched)
    - `[Current Question]` (normalized text)
- Dedupe boundary:
  - The runtime decides which messages are ignored (duplicate), buffered (non-triggering), queued (followups), or used for steering.

Adapter Contract (recommended)
- Normalize inbound events into a plain object (example fields):
  - `sessionId`, `text`, `isGroup`, `mentionMe`, `chatId`, `threadId`, `messageId`, `senderId`, `senderName`, `ts`, `dedupeKey`.
- Provide callbacks:
  - `onExecuteTurn(msg, prompt, batch)` -> call Gateway v2 (`/v2/turn-sync`) with `prompt`, then reply.
  - `onExecuteSteer(msg)` -> called in `steer` mode for any message received while a run is in-flight; implementations typically notify the agent of the correction/stop.
  - `onExecuteAbort(msg, cmd?)` -> called when `/hey` is received during an in‑flight run; implementations should abort the active run/session (e.g., POST `/v2/abort`).
  - `onLocalReply(msg, text)` -> reply without calling Arcana.
  - `onLocalReply(msg, text)` -> reply without calling Arcana.

Reference Implementation
- Feishu wrapper: `skills/feishu/scripts/feishu-channel-runtime.mjs`
- Feishu bridge: `skills/feishu/scripts/feishu-bridge.mjs`

Notes
- `defaultLooksUrgentForSteer(text)` remains exported for compatibility, but steer-mode gating no longer consults it; all messages during in-flight are treated as steer events except for the special `/hey`.
