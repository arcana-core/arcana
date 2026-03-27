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

Storage isolation: the app sets a persistent Electron partition for its `BrowserWindow` so cookies/localStorage/IndexedDB are isolated from other Electron or browser instances.

- Default partition: `persist:arcana-desktop`
- Override: set env var `ARCANA_ELECTRON_PARTITION` to a trimmed, non-empty value before launch (e.g., `ARCANA_ELECTRON_PARTITION=persist:arcana-dev npm run dev`).

Note: Auto-update and installers are not included in this phase.

Releases
- Official desktop builds are provided for macOS (DMG) and Windows (MSI).
- Linux desktop installers are not provided at this time.
