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
  - Directive stripping (leading `/think`, `/model`, etc.) before sending to the agent.
  - Queue modes: `collect_followup` (default), `off`, `steer`.
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
  - `onExecuteSteer(msg)` -> (optional, legacy) use steering semantics if you still integrate with `/api/steer`; new adapters should prefer sending another turn via Gateway v2 instead of in-flight steering.
  - `onLocalReply(msg, text)` -> reply without calling Arcana.

Reference Implementation
- Feishu wrapper: `skills/feishu/scripts/feishu-channel-runtime.mjs`
- Feishu bridge: `skills/feishu/scripts/feishu-bridge.mjs`
