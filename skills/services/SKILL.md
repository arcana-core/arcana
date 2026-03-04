---
name: services
description: "Manage Arcana background services in ./services (reload/status/start/stop/restart). 管理 Arcana 的常驻服务：重载/状态/启动/停止/重启"

arcana:
  tools:
    - name: services
      label: "Services"
      description: "Manage ./services background services: status/reload/start/stop/restart."
      allowNetwork: false
      allowWrite: false

---

# Services Manager

Arcana supports auditable long-running background services by placing service modules under `services/*.js|*.mjs`.

- On Arcana startup, core will start all services found in `./services`.
- To avoid restarting Arcana, use the `services` tool to reload/start/stop/restart.

Service module contract
- A service file is an ESM module exporting either:
  - `export async function start(ctx) { ... }`, or
  - `export default async function(ctx) { ... }`
- `start()` may return `{ stop() }` for graceful shutdown.

Logs
- Manager log: `.arcana/services/<serviceId>/manager.log`
- Service-specific logs are service-defined (e.g. child stdout/stderr).

Tool: `services`
- Actions:
  - `status` (default): list known services and their status in this Arcana process
  - `reload`: rescan `./services` and start any *new* service files (no restart)
  - `start`: start a specific service by id (filename without extension)
  - `stop`: stop a specific service by id (requires the service handle to expose `stop()`)
  - `restart`: stop then start a specific service by id

Examples
- Show status:
  { "action": "status" }

- Reload directory after copying a new service file:
  { "action": "reload" }

- Restart one service:
  { "action": "restart", "id": "feishu" }
