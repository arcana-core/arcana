# Arcana Plugin API (v2, Proposed)

This document describes a proposed Arcana v2 Plugin API. It defines
ChannelPlugin, SinkPlugin, and ToolPlugin concepts, how Skills package them,
and how plugins interact with the proposed Gateway protocol. This is a design
only; the current implementation still uses `src/plugin-loader.js`, the
existing tool-based plugin format, and skill metadata in `SKILL.md`.

## Goals

- Make plugin structure explicit (channel, sink, tool) instead of ad-hoc tools.
- Align plugin lifecycle and observability with the Gateway event/trace model.
- Use capability-based permissions that respect Arcana exec policies.
- Keep the design compatible with the current plugin loader and Skills system.

## Plugin kinds

### ToolPlugin (Proposed)

Tool plugins expose callable tools to the agent, similar to the current
plugin loader. Today, `src/plugin-loader.js` loads modules from `plugins/`
that register tools with `registerTool({ name, execute, ... })`.

In v2, a ToolPlugin is a module that exports a default factory:

```js
export default async function toolPlugin(context) {
  const { registerTool, workspaceRoot, agentId, capabilities } = context;

  registerTool({
    kind: "tool",
    name: "web_search",
    description: "Search the web via Playwright.",
    capabilities: ["net:external"],
    async execute(callId, args) {
      // Implementation elided; must obey capabilities.
      return { content: [{ type: "text", text: "..." }], details: { ok: true } };
    }
  });
}
```

Notes (Proposed):

- `capabilities` declares what the tool may do (network, fs, shell, etc.).
- The tool implementation must honor capabilities; the Gateway or tool host
  may enforce them at runtime.
- Existing plugins (for example `plugins/web-search.js`) can be treated as
  ToolPlugins with `kind: "tool"` and optional capabilities.

### ChannelPlugin (Proposed)

Channel plugins own ingress and egress for external messaging systems (Feishu,
Slack, etc.). Today, this behavior is implemented by skills such as
`skills/feishu` plus scripts that call Gateway v2 (`/v2/turn-sync`) directly.

In v2, a ChannelPlugin is responsible for:

- Connecting to the channel (HTTP webhook, WebSocket, polling, or SDK).
- Normalizing inbound events into the Gateway Event schema.
- Starting turns via the Gateway HTTP API.
- Sending replies back to the channel based on Gateway events.

Shape (Proposed):

```js
export default async function channelPlugin(context) {
  const { gateway, logger, agentId, capabilities } = context;

  // Example: inbound message handler (pseudo-code).
  async function onInbound(raw) {
    const sessionId = gateway.routeToSession({
      agentId,
      channel: "feishu",
      channelKey: raw.chatId,
      threadKey: raw.rootId
    });

    await gateway.appendEvents({
      agentId,
      sessionId,
      events: [
        {
          type: "channel.message",
          source: "channel",
          ts: raw.ts,
          data: {
            channel: "feishu_group_" + raw.chatId,
            text: raw.text,
            dedupeKey: raw.dedupeKey
          }
        }
      ]
    });

    if (gateway.shouldStartTurn({ agentId, sessionId, reason: "channel_message" })) {
      await gateway.startTurn({
        agentId,
        sessionId,
        message: raw.text,
        policy: "restricted",
        metadata: { reason: "channel_message" }
      });
    }
  }

  // Example: subscribe to Gateway events for replies (pseudo-code).
  gateway.subscribe({ agentId, events: ["assistant_text", "assistant_image"] }, async (ev) => {
    if (!ev.sessionId) return;
    const data = ev.data || {};
    if (ev.type === "assistant_text") {
      await sendChannelReply({ sessionId: ev.sessionId, text: data.text || "" });
    }
  });
}
```

The Gateway control-plane (see `docs/arcana-gateway-protocol.md`) provides the
`routeToSession`, `appendEvents`, `startTurn`, and `subscribe` helpers in this
context. Today, channel bridges call Gateway v2 (`/v2/turn-sync`) and read from
`/v2/stream`.

### SinkPlugin (Proposed)

Sink plugins consume events and traces and forward them to external systems
(log aggregation, metrics backends, monitoring services). Today, this behavior
is implicit: the core Gateway v2 runtime broadcasts events over `/v2/stream`,
and tools like the support bundle read plugin information.

In v2, a SinkPlugin receives a filtered event/trace stream and may export data
elsewhere.

Example (Proposed):

```js
export default async function sinkPlugin(context) {
  const { subscribe, capabilities } = context;

  // Subscribe to all llm_usage and tool_execution_end events.
  subscribe({ events: ["llm_usage", "tool_execution_end"] }, async (ev) => {
    // Implementation elided: forward to metrics backend.
  });
}
```

Sink plugins run inside the Arcana process or a sidecar, depending on
deployment. They must be capability-constrained (for example `net:metrics` but
no shell access).

## Capabilities and policy (Proposed)

Plugins declare capabilities; the Gateway and tool host enforce policy.
Capabilities are strings namespaced by area.

Suggested capability families:

- `net:external` (generic outbound HTTP).
- `net:channel:<id>` (network access for a specific channel backend).
- `fs:read`, `fs:write` (workspace-level file access).
- `shell:exec` (ability to run shell commands via tools).
- `metrics:write`, `logs:write` (external observability sinks).

Policy hooks (Proposed):

- Global configuration may restrict capabilities per agent, session, or plugin.
- Exec policy (`open` vs `restricted`) augments this:
  - In `restricted` policy, `shell:exec` and broad `net:external` may be
    disabled even if the plugin declares them.
  - In `open` policy, more capabilities may be granted, subject to agent
    configuration.
- Skills can further restrict capabilities when packaging plugins (for example
  limiting a channel skill to a specific host allow-list).

## Lifecycle

The plugin system has a simple lifecycle that aligns with the current
`loadArcanaPlugins` behavior while extending it.

### Discovery

- Tool, channel, and sink plugins live under:
  - `arcana/plugins/` (package-level plugins, as today).
  - `<workspaceRoot>/plugins/` (workspace overrides).
  - `.pi/extensions/` in either the package or workspace (already used by
    the existing loader).
- Modules are discovered by extension (`.js` or `.mjs`) as in
  `src/plugin-loader.js`.

### Initialization

For each discovered plugin module:

- The loader constructs a context object with:
  - `workspaceRoot`, `agentId`.
  - `registerTool` (for ToolPlugins).
  - `gateway` helpers (for ChannelPlugins and SinkPlugins, Proposed).
  - `logger` (logging helper, Proposed).
  - `capabilities` (effective capability set for this plugin instance).
- The module default export is awaited and given the context.
- For ToolPlugins, registered tools are merged with built-in tools and skill
  tools (see `src/session.js`).

### Reload and disposal

- When the workspace configuration or Skills set changes, plugins may need to
  be reloaded. The v2 API reserves optional hooks:
  - `onReload(newContext)`.
  - `onDispose()`.
- These hooks are Proposed; current plugins do not implement them. Today,
  `src/session.js` rebuilds tool lists and reloads skill tools when
  `SKILL.md` files change.

## Observability (events and traces)

Plugins must integrate with the Gateway event/trace model to keep behavior
observable and debuggable.

Requirements (Proposed):

- ChannelPlugins emit `channel.*` events when they receive, dedupe, buffer, or
  drop messages.
- ToolPlugins rely on the tool host to emit `tool_execution_*` events; plugin
  authors should not bypass the host when running tools.
- SinkPlugins do not emit user-visible events, but may emit diagnostic events
  (for example `sink.error`) when forwarding fails.
- All plugins should attach `traceId` and `spanId` where possible:
  - Channel ingress may create a new trace and root span per user-visible
    turn, then link subsequent tool spans under it.
  - Tool execution spans can be derived from existing `tool_execution_*`
    events emitted on the Gateway event bus.

The existing Gateway v2 WebSocket stream from `/v2/stream` already carries many event types
that correspond to these concepts (see `docs/arcana-gateway-protocol.md`). The
v2 Plugin API standardizes how plugins participate in that stream.

## Skills and plugins

Skills (see `src/skills.js` and existing `SKILL.md` files) describe
capabilities in a user-facing way and map to concrete tools. In v2, Skills can
also package plugins.

### Skill packaging (Proposed)

Skill frontmatter (in `SKILL.md`) gains optional plugin metadata, for example:

```yaml
arcana:
  tools:
    - name: feishu_message
      label: Feishu Message
      description: Feishu messaging send/reply
      allowedHosts: ["open.feishu.cn:443"]
  plugins:
    - kind: channel
      module: skills/feishu/scripts/feishu-channel.mjs
      capabilities: ["net:channel:feishu"]
```

Behavior:

- `tools` behaves as today: tools are exposed to the agent and gated by
  skills-aware activation.
- `plugins` (Proposed) tells the runtime to load additional ChannelPlugins or
  SinkPlugins when the skill is present.
- The loader resolves `module` relative to the skill file or workspace root.

### Code layout

Recommended placement (compatible with current repo layout):

- ToolPlugins:
  - Package-level: `arcana/plugins/<name>.js`.
  - Workspace-level: `<workspaceRoot>/plugins/<name>.js`.
- ChannelPlugins:
  - Often live next to skills, for example `skills/feishu/scripts/feishu-channel-runtime.mjs`.
  - May also live under `plugins/` when truly generic.
- SinkPlugins:
  - Typically under `plugins/` or `.pi/extensions/metrics-*.js`.

Existing code references:

- `src/plugin-loader.js` discovers plugin modules and registers tools.
- `src/session.js` integrates plugin tools with built-in tools and skill tools.
- `skills/feishu/SKILL.md` documents a concrete messaging skill and describes
  a WebSocket bridge that calls Gateway v2 (`/v2/turn-sync`) directly. In v2, that bridge
  would be re-expressed as a ChannelPlugin using the Gateway helpers.

