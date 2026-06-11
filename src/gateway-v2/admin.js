// Admin API for the operator console (/admin/*).
//
// Authenticated with the dedicated admin token (src/auth/admin-token.js) —
// never the regular API token, and never bypassed for loopback binds.
//
// Endpoints:
//   GET  /admin/overview                     platform summary (uptime, memory,
//                                            ws clients, services, agents)
//   GET  /admin/services                     full service status list
//   POST /admin/services/reload              rescan + start new/stopped
//   POST /admin/services/:id/start
//   POST /admin/services/:id/stop
//   POST /admin/services/:id/restart
//   GET  /admin/services/:id/logs?file=manager|service|sdk&tailBytes=N
//
// Dependencies are injectable for tests.

import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import * as serviceManager from '../services/manager.js';
import { loadAgentsSnapshot } from '../agents-snapshot.js';
import { listSessions } from '../sessions-store.js';
import { isAuthorizedAdminRequest, loadOrCreateAdminToken } from '../auth/admin-token.js';
import { renderMetrics } from './metrics.js';

const LOG_FILES = {
  manager: 'manager.log',
  service: 'service.log',
  sdk: 'sdk.log',
};
const DEFAULT_TAIL_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = 256 * 1024;

export function tailFile(path, maxBytes = DEFAULT_TAIL_BYTES){
  const limit = Math.min(Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_TAIL_BYTES)), MAX_TAIL_BYTES);
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (!size) return { content: '', size: 0, truncated: false };
    const len = Math.min(size, limit);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let content = buf.toString('utf-8');
    const truncated = size > len;
    if (truncated){
      // Drop the partial first line so the output starts on a boundary.
      const nl = content.indexOf('\n');
      if (nl >= 0 && nl < content.length - 1) content = content.slice(nl + 1);
    }
    return { content, size, truncated };
  } catch {
    return { content: '', size: 0, truncated: false, missing: true };
  } finally {
    try { if (fd != null) closeSync(fd); } catch {}
  }
}

export function createAdminRouter(opts = {}){
  const manager = opts.manager || serviceManager;
  const wsHub = opts.wsHub || null;
  const adminToken = opts.adminToken || null; // lazily resolved when null
  const agentsSnapshotFn = opts.agentsSnapshotFn || loadAgentsSnapshot;
  const listSessionsFn = opts.listSessionsFn || listSessions;
  const startedAtMs = Number(opts.startedAtMs) > 0 ? Number(opts.startedAtMs) : Date.now();

  function sendJson(res, statusCode, body){
    try {
      const payload = JSON.stringify(body);
      res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(payload);
    } catch {
      try { res.end(); } catch {}
    }
  }

  function authorized(req){
    return isAuthorizedAdminRequest(req, adminToken || loadOrCreateAdminToken());
  }

  function servicesSummary(){
    let status = { count: 0, services: [] };
    try { status = manager.getServicesStatus(); } catch {}
    const byStatus = {};
    for (const s of status.services || []){
      const key = String(s.status || 'unknown');
      byStatus[key] = (byStatus[key] || 0) + 1;
    }
    return { ...status, byStatus };
  }

  async function handleOverview(req, res){
    const services = servicesSummary();
    let agents = [];
    try {
      const snapshot = await agentsSnapshotFn();
      agents = (snapshot || []).map((a) => {
        let sessionCount = 0;
        let lastActivity = '';
        try {
          const sessions = listSessionsFn(a.agentId) || [];
          sessionCount = sessions.length;
          lastActivity = sessions.length ? String(sessions[0].updatedAt || '') : '';
        } catch {}
        return { agentId: a.agentId, sessionCount, lastActivity };
      });
    } catch {}
    let wsClients = 0;
    try { wsClients = wsHub && typeof wsHub.countMatchingClients === 'function' ? wsHub.countMatchingClients({}) : 0; } catch {}
    const mem = process.memoryUsage();
    sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      uptimeMs: Date.now() - startedAtMs,
      pid: process.pid,
      node: process.version,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      wsClients,
      services: { count: services.count, byStatus: services.byStatus },
      agents,
    });
  }

  function findService(id){
    try {
      const status = manager.getServicesStatus();
      return (status.services || []).find((s) => s.id === id) || null;
    } catch {
      return null;
    }
  }

  function handleLogs(req, res, id, u){
    const svc = findService(id);
    if (!svc){
      sendJson(res, 404, { ok: false, error: 'unknown_service' });
      return;
    }
    const fileKey = String(u.searchParams.get('file') || 'manager').trim();
    const fileName = LOG_FILES[fileKey];
    if (!fileName){
      sendJson(res, 400, { ok: false, error: 'bad_file', allowed: Object.keys(LOG_FILES) });
      return;
    }
    const path = join(svc.logDir, fileName);
    if (!existsSync(path)){
      sendJson(res, 200, { ok: true, id, file: fileKey, content: '', size: 0, missing: true });
      return;
    }
    const tail = tailFile(path, u.searchParams.get('tailBytes'));
    sendJson(res, 200, { ok: true, id, file: fileKey, ...tail });
  }

  async function handle(req, res, u){
    if (!u.pathname.startsWith('/admin/')) return false;
    const method = String(req.method || 'GET').toUpperCase();

    if (!authorized(req)){
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    try {
      if (method === 'GET' && u.pathname === '/admin/overview'){
        await handleOverview(req, res);
        return true;
      }

      if (method === 'GET' && u.pathname === '/admin/services'){
        sendJson(res, 200, { ok: true, ...servicesSummary() });
        return true;
      }

      if (method === 'GET' && u.pathname === '/admin/metrics'){
        const svc = servicesSummary();
        const mem = process.memoryUsage();
        let wsClients = 0;
        try { wsClients = wsHub && typeof wsHub.countMatchingClients === 'function' ? wsHub.countMatchingClients({}) : 0; } catch {}
        const gauges = {
          arcana_uptime_seconds: { value: Math.floor((Date.now() - startedAtMs) / 1000), help: 'Gateway uptime in seconds' },
          arcana_memory_rss_bytes: { value: mem.rss, help: 'Resident set size' },
          arcana_memory_heap_used_bytes: { value: mem.heapUsed, help: 'Heap used' },
          arcana_ws_clients: { value: wsClients, help: 'Connected WebSocket clients' },
          arcana_services_total: { value: svc.count, help: 'Tracked services' },
        };
        let body = renderMetrics(gauges);
        // Per-status service counts as a single labeled gauge series.
        const statusEntries = Object.entries(svc.byStatus || {});
        if (statusEntries.length){
          body += '# HELP arcana_services_status Services by status\n# TYPE arcana_services_status gauge\n';
          body += statusEntries
            .map(([status, n]) => 'arcana_services_status{status="' + String(status).replace(/"/g, '\\"') + '"} ' + n)
            .join('\n') + '\n';
        }
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
        return true;
      }

      if (method === 'POST' && u.pathname === '/admin/services/reload'){
        const status = await manager.reloadServices({});
        sendJson(res, 200, { ok: true, ...status });
        return true;
      }

      const serviceAction = u.pathname.match(/^\/admin\/services\/([^/]+)\/(start|stop|restart|logs)$/);
      if (serviceAction){
        const id = manager.normalizeServiceId(decodeURIComponent(serviceAction[1]));
        const action = serviceAction[2];
        if (action === 'logs'){
          if (method !== 'GET'){
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
            return true;
          }
          handleLogs(req, res, id, u);
          return true;
        }
        if (method !== 'POST'){
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
          return true;
        }
        let status;
        if (action === 'start') status = await manager.startService({ id });
        else if (action === 'stop') status = await manager.stopService({ id, reason: 'admin' });
        else status = await manager.restartService({ id });
        sendJson(res, 200, { ok: true, ...status });
        return true;
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: 'admin_failed',
        message: e && e.message ? String(e.message) : String(e || ''),
      });
      return true;
    }
  }

  return { handle };
}

export default { createAdminRouter, tailFile };
