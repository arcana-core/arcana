# Chrome DevTools MCP backend

This is an **experimental** browser backend that attaches to an
existing local Chrome/Chromium session via the official
`chrome-devtools-mcp` server.

It is wired through the existing tool-daemon HTTP tools:

- `web_render`
- `web_extract`

and is supervised by the `services/chrome_mcp_daemon.mjs` service.

## Prerequisites

- Chrome/Chromium version: 144+ (as required by `chrome-devtools-mcp`)
- Enable remote debugging in the target browser:
  - Chrome: `chrome://inspect/#remote-debugging`
  - Brave: `brave://inspect/#remote-debugging`
  - Edge: `edge://inspect/#remote-debugging`
- When attaching, Chrome will show a consent prompt; you must confirm it.

## Services

The recommended setup is to run the HTTP supervisor service:

- `services/chrome_mcp_daemon.mjs`

This service starts a local HTTP daemon which lazily spawns
`npx -y chrome-devtools-mcp@latest` and keeps MCP client connections
per `profileKey`.

Logs live under:

- `.arcana/services/chrome_mcp_daemon/`

## Selecting the backend

### Profile keys

You can pick the browser "profile" (in the tool-daemon sense) via any
of these request fields:

- `profileKey`
- `browserProfile`
- `profile`

If none is provided, Arcana falls back to the existing header-derived
profile key (`x-arcana-agent-id`, `x-arcana-session-id`, and optional
session isolation).

### Driver

The driver is selected via the `driver` field.

- Default (Playwright): omit `driver`.
- MCP attach: set `driver` to any of these aliases:
  - `existing-session`
  - `mcp`
  - `chrome-mcp`
  - `chrome-devtools-mcp`
  - `chrome_devtools_mcp`
  - `devtools`
  - `chrome-devtools`

Special-case:

- `profileKey: "user"` defaults to the MCP driver even if `driver` is
  omitted. This is the closest analogue to OpenClaw's built-in `user`
  profile.

### MCP config

When using the MCP driver, you may pass an optional `mcp` object.
This is forwarded to the `chrome_mcp_daemon` and maps to
`chrome-devtools-mcp` CLI options.

Common fields:

- `autoConnect` (boolean): attach to a local running Chrome instance.
- `channel` (string): `stable|beta|dev|canary`.
- `userDataDir` (string): explicit Chrome user data directory.
- `browserUrl` (string): attach to an explicit remote debugging HTTP
  endpoint (e.g. `http://127.0.0.1:9222`).
- `wsEndpoint` (string): attach via explicit DevTools websocket endpoint.

Defaults for `profileKey: "user"` (unless `browserUrl`/`wsEndpoint` is
provided):

- `autoConnect: true`
- `mode: "autoConnect"`
- `channel: "stable"`

## web_render usage

The tool-daemon route is:

- `POST /tool/web_render`

The response shape stays compatible:

```json
{ "content": [{"type":"text","text":"..."}], "details": {"ok":true} }
```

Example: attach and navigate using the built-in `user` profile:

```json
{
  "action": "navigate",
  "profileKey": "user",
  "url": "https://example.com"
}
```

### New actions for existing-session workflows

- `action: "tabs"`
  - In MCP mode, calls the MCP `list_pages` tool and parses its output.
  - Returns `details.tabs = [{ pageId, url, selected }]`.

- `action: "select_tab"`
  - In MCP mode, calls the MCP `select_page` tool.
  - Provide either:
    - `index` (treated as MCP `pageId`), or
    - `url` (resolved by listing pages first).

## web_extract usage

The tool-daemon route is:

- `POST /tool/web_extract`

In MCP mode, extraction is implemented via:

- `evaluate_script` (to compute a DOM text snapshot)
- fallback: `take_snapshot` (a11y-based snapshot)

`autoScroll` is supported by running a simple scrolling loop inside
`evaluate_script`.

## Notes / limitations

- `waitUntil=networkidle` is a Playwright concept; MCP navigation uses
  `navigate_page` and does not provide the same semantics.
- Clicking by CSS selector / text is implemented by running
  `evaluate_script` in-page. For best fidelity you can use MCP
  snapshots and `uid`-based actions by calling MCP tools directly.
