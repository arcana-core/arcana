Arcana Desktop Dev

This starts a minimal Electron app that embeds the Arcana web UI and server.

How to run (development):
- cd packages/desktop
- npm install
- npm run dev

What it does on first run:
- Creates a per-user workspace directory at Electron userData/workspace
- Uses a config file at Electron userData/workspace/arcana.config.json
- Starts the Arcana HTTP server on a random free port and opens a window to http://localhost:PORT

Notes:
- Security defaults are nodeIntegration=false and contextIsolation=true
- No auto-update or installer is included in this phase
