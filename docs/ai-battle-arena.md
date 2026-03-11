
# AI Battle Arena (Standalone)

This doc covers how to run the local Battle‑arena server+client as a standalone Colyseus app, and how an Arcana agent joins/observes/acts using the `ai-battle-arena` skill tools (no background services).

## What changed (March 9, 2026)
- Removed auto‑starting Arcana services that used to spawn the arena server and AI bot.
- Server now exposes entities and chat in state; supports `say` and `interact` actions; chest toggles between `closed` and `opened`.
- Web client updated to match docs:
  - Player vs spectator via `?play=1` (or `?play=true`).
  - Chat overlay (last ~8 messages). Press `Enter` to send.
  - Entities render as labels; press `E` (player mode) to interact with nearest entity within 120 px.
  - Spectator camera cycling with `Tab` to follow different players; overlay shows followed id.
- Added Arcana tools: `arena_connect`, `arena_observe`, `arena_move`, `arena_say`, `arena_interact`, `arena_status`, `arena_disconnect`.

## Run the arena locally
Location: `playground/Battle-arena`

1) Install deps and build the client once (first run):
- `cd playground/Battle-arena`
- `npm install`
- `npm run build` (optional; `start:server` only runs the server)

2) Start the server:
- `npm run start:server`
- Server websocket: `ws://localhost:2567`
- Web UI: `http://localhost:2567/` (spectator by default; append `?play=1` to join as a player)

Optional Dockerfile (quick local image):
- A minimal `Dockerfile` is provided under `playground/Battle-arena/` to run `node server/index.js` on port 2567.

## Protocol additions (server)
Room: `outdoor`
- State now includes `entities` (Map), each with `id`, `type`, `label`, `x`, `y`, `state`, `actions` (comma‑separated).
- State includes a short `chat` log (Array), newest appended and truncated (~32 msgs).
- New actions from clients:
  - `say`: `{ action: "say", text }` → broadcasts `{ event: "chat", from, text }` and appends to state.chat.
  - `interact`: `{ action: "interact", entityId }` → server validates player distance, updates entity state (e.g., open a chest), and broadcasts `{ event: "interaction", entityId, by, state }`.

## Web client UX
- `http://localhost:2567/` → spectator by default; append `?play=1` (or `?play=true`) to join as a player.
- Spectator: press `Tab` to cycle the follow target among current players (excluding self); overlay shows the current followed player id.
- Chat: an overlay shows the last ~8 messages; press `Enter` to type and send a message. Messages appear for all clients.
- Entities: labels render from server state and update on change. In player mode, press `E` to interact with the nearest entity within 120 px (e.g., toggle the chest).

## Arcana tools (skill: ai-battle-arena)
Use these from an Arcana chat or automation. All tools persist per‑session connection keyed by `ctx.sessionId`.

- `arena_connect` (endpoint: string = `ws://localhost:2567`, room: string = `"outdoor"`)
  - Connects as a player and performs initial spawn positioning.
- `arena_observe` → JSON + summary with:
  - self: `{ id, x, y, rotation }`
  - nearby: `players[]`, `entities[]` (sorted by distance)
  - `chat[]` (last few messages)
- `arena_move` (x: number, y: number, rotation?: number) → sends `move`.
- `arena_say` (text: string) → sends `say`.
- `arena_interact` (entityId: string) → sends `interact`.
- `arena_status` → connection state.
- `arena_disconnect` → leaves the room.

Note: Tools require `colyseus.js` in the Arcana workspace. Two ways to satisfy this:
- Install at root: `npm install colyseus.js@0.10` (preferred), or
- Install under `playground/Battle-arena` (the tools fall back to that path).

## Manual verification checklist
- Server
  - Start with `npm run start:server`; open `http://localhost:2567/` (spectator view renders)
  - Open `http://localhost:2567/?play=1`; a player spawns and can move/shoot
  - Press `Enter` to send a chat message; it appears in the overlay on all clients
  - Labels for a chest and a sign appear; move near and press `E` → interaction message appears
- Arcana tools
  - Run `arena_connect` (defaults to ws://localhost:2567)
  - Run `arena_observe` to see self position, nearby players/entities, and chat
  - Run `arena_move` to reposition; observe change in `arena_observe`
  - Run `arena_say` and confirm message appears in web client
  - Run `arena_interact` with a visible entity id; confirm server broadcasts an interaction
  - Run `arena_status`, then `arena_disconnect`
