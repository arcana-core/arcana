# Mac Native Arcana Shell Devlog

## Context
- Agent-driven, Mac-native Arcana shell.
- Acts as a front-end client that connects to the existing whiteboard server.
- Renders boards using the same templates, state, and interactions as `whiteboard-mobile`.

## Phase 1: Mac Catalyst client
- Phase 1 is a Mac Catalyst port of the existing iOS `whiteboard-mobile` app, targeting `My Mac` / `My Mac (Mac Catalyst)`.
- The Mac client embeds the whiteboard UI full-screen and connects to the existing whiteboard server.
- Protocol: reuse the current whiteboard template plus state plus `set_board`; no new protocol surface in Phase 1.

### What the client does in Phase 1
- Connects to the existing whiteboard server and joins a board session.
- Renders the board using the existing templates and state, identical to `whiteboard-mobile`.
- Relays user input and agent-driven updates via the existing `set_board`-based flow.

### What the client does not do in Phase 1
- Does not introduce any new protocol messages, board schema, panel definitions, or state model changes.
- Does not add versioning, rollback, or tracing features beyond what the current server already supports.
- Does not add multi-device sync, collaboration, account systems, or sandbox/permissions features; those remain future phases.

## Phase Plan
- Phase 1: Mac Catalyst port of the existing `whiteboard-mobile` client as an agent-driven Mac shell.
- Phase 2: Solidify board template plus state model and panel primitives (building on the existing implementation).
- Phase 3: Introduce versioning, rollback of N versions, and tracing (future work, no design in this doc).
- Phase 4: Explore sandboxing, permissions, and broader tool integration.

## Implementation Notes

- Phase 1 uses the existing iOS `whiteboard-mobile` `App` target built with **Mac Catalyst** as the initial Mac client.
- For detailed run/build steps (Xcode and `xcodebuild`), see the **"Running on macOS via Mac Catalyst"** section in `whiteboard-mobile/README.md`.
