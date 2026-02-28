# Arcana Desktop (Phase 1)

Minimal Electron shell that embeds Arcana's web UI and server. It creates a per-user workspace and config under Electron userData directory.

- Workspace: userData/workspace
- Config: userData/workspace/arcana.config.json

Dev:
- cd packages/desktop
- npm install
- npm run dev

This launches the Electron app, starts Arcana's local web server on a random free port, and opens a window to it.

Security defaults: nodeIntegration=false, contextIsolation=true.

Note: Auto-update and installers are not included in this phase.
