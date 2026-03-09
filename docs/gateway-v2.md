Gateway v2 HTTP + WebSocket gateway
===================================

Start the gateway
-----------------

To start the v2 gateway from the Arcana CLI:

    node ./bin/arcana.js gateway serve --port 8787

If you omit `--port`, it defaults to `8787` (or `PORT` env if set).

Health check
------------

Once the server is running, you can check its health endpoint:

    curl http://localhost:8787/v2/health

You should see a small JSON object with `ok: true` and `kind: "gateway-v2"`.

Posting a turn and receiving assistant replies
----------------------------------------------

To post a user message, send a JSON payload to `POST /v2/turn`:

    curl -X POST http://localhost:8787/v2/turn \
      -H "Content-Type: application/json" \
      -d '{"agentId":"default","sessionKey":"session","text":"Hello from HTTP"}'

This enqueues a user message event and triggers a reactor turn. The assistant's reply (and other events) are delivered over WebSocket on `/v2/stream`.

Managing runners (always-on sessions)
-------------------------------------

Gateway v2 exposes a runner lifecycle API so you can start and stop a runner for a given `{ agentId, sessionKey }` pair. Once started, the runner will keep processing new events and self-scheduling wakes until it is stopped.

Start a runner with `POST /v2/runners/start`:

    curl -X POST http://localhost:8787/v2/runners/start \
      -H "Content-Type: application/json" \
      -d '{"agentId":"default","sessionKey":"session","runnerId":"reactor"}'

If you omit `runnerId`, the gateway uses the default runner (currently `reactor`).

You can check the runner status with:

    curl "http://localhost:8787/v2/runners/status?agentId=default&sessionKey=session"

To stop a runner, call `POST /v2/runners/stop`:

    curl -X POST http://localhost:8787/v2/runners/stop \
      -H "Content-Type: application/json" \
      -d '{"agentId":"default","sessionKey":"session"}'

Connecting to the WebSocket stream
----------------------------------

The gateway exposes a WebSocket endpoint that streams events:

    ws://localhost:8787/v2/stream

If you have `wscat` installed (optional), you can connect like this:

    wscat -c ws://localhost:8787/v2/stream

Then, when you POST a turn as shown above, you should see events appear in the WebSocket client, including any assistant replies.


Serving the web UI
---------------------

When the v2 gateway is running it also serves the built-in Arcana web UI. Open:

    http://localhost:8787/

The root path `/` (and `/index.html`) are served from the `web/` directory in this repo. Static assets such as `app.js`, `styles.css`, and SVG icons are also served from this directory.

The web UI automatically probes `GET /v2/health` on page load. If that endpoint reports an `ok` response with `kind: "gateway-v2"`, the UI switches into "gateway v2" transport mode and will:

- Send user messages via `POST /v2/turn` with `{ agentId, sessionKey, text }`.
- Maintain a stable `sessionKey` in `localStorage` so that browser reloads keep the same v2 conversation.
- Listen for events over a WebSocket connection to `/v2/stream` instead of using the legacy SSE `/api/events` endpoint.

If `/v2/health` is not available or does not report a v2 gateway, the UI falls back to the existing legacy transport and continues to talk to the `/api/...` endpoints as before.

