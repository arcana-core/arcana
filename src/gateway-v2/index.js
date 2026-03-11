import { promises as fsp } from 'node:fs';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { nowMs, iso, readBodyJson } from './util.js';
import { logError } from '../util/error.js';
import { createWsHub } from './ws-hub.js';
import * as eventStore from './event-store.js';
import { getState, patchState } from './state-store.js';
import { runInLane } from './lane.js';
import { createTraceEmitter } from './trace.js';
import { loadGatewayV2Plugins } from './plugins.js';
import { reactorRunner } from './reactor-runner.js';
import { createInbox } from './runtime/inbox.js';
import { appendAudit } from './runtime/audit-store.js';
import { createCronStore } from './runtime/cron-store.js';
import { createScheduler } from './runtime/scheduler.js';
import { createOutbox } from './runtime/outbox.js';
import { createPolicyEngine } from './runtime/policy.js';
import { createEngine } from './runtime/engine.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = resolvePath(__dirname, "..", "..", "web");

function contentTypeForPath(filePath){
  try {
    const ext = extname(filePath).toLowerCase();
    if (ext === ".html") return "text/html; charset=utf-8";
    if (ext === ".js") return "application/javascript; charset=utf-8";
    if (ext === ".css") return "text/css; charset=utf-8";
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".png") return "image/png";
    if (ext === ".json") return "application/json; charset=utf-8";
  } catch {}
  return "application/octet-stream";
}

async function tryServeStatic(pathname, res){
  try {
    let rel = String(pathname || "/");
    if (!rel || rel === "/") rel = "/index.html";
    if (rel === "/index.html"){
      const filePath = join(WEB_ROOT, "index.html");
      const buf = await fsp.readFile(filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Length", buf.length);
      res.end(buf);
      return true;
    }
    const safeRel = rel.startsWith("/") ? rel.slice(1) : rel;
    const resolved = resolvePath(WEB_ROOT, safeRel);
    if (!resolved.startsWith(WEB_ROOT)) return false;
    const buf = await fsp.readFile(resolved);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeForPath(resolved));
    res.setHeader("Content-Length", buf.length);
    res.end(buf);
    return true;
  } catch (e) {
    try { if (e && e.code !== "ENOENT") logError("[arcana:gateway-v2] static error", e); } catch {}
    return false;
  }
}

function sendJson(res, statusCode, body){
  const json = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(json));
  res.end(json);
}

export async function startGatewayV2({ port } = {}) {
  const desiredPort = typeof port === 'number' && Number.isFinite(port)
    ? port
    : (process.env.PORT ? Number(process.env.PORT) : 8787);

  const wsHub = createWsHub();
  const trace = createTraceEmitter({ wsHub });

  const plugins = await loadGatewayV2Plugins(process.cwd());
  const runnerRegistry = new Map();

  runnerRegistry.set(reactorRunner.id, reactorRunner);

  if (plugins && Array.isArray(plugins.runners)){
    for (const r of plugins.runners){
      if (!r || typeof r !== 'object') continue;
      const idRaw = r.id != null ? String(r.id) : '';
      const id = idRaw.trim();
      const run = typeof r.run === 'function'
        ? r.run
        : (typeof r.runTurn === 'function' ? r.runTurn : null);
      if (!id || !run) continue;
      if (id === reactorRunner.id) continue;
      if (runnerRegistry.has(id)) continue;
      runnerRegistry.set(id, { id, run });
    }
  }

  const stateStore = { getState, patchState };

  const inbox = createInbox({
    wsHub,
    eventStore,
    auditStore: { appendAudit },
    trace,
  });

  const policy = createPolicyEngine({ trace, denyByDefaultDangerous: false });
  const outbox = createOutbox({ wsHub, inbox, trace, policy });
  const cronStore = createCronStore();
  const scheduler = createScheduler({ wakeDelayMsDefault: 250, cronStore, trace, wsHub });

  const engine = createEngine({
    lane: runInLane,
    scheduler,
    inbox,
    outbox,
    stateStore,
    runnerRegistry,
    trace,
    wsHub,
  });

  if (typeof scheduler.setEngine === 'function'){
    scheduler.setEngine(engine);
  }
  scheduler.start();

  if (plugins && Array.isArray(plugins.sinks) && outbox && typeof outbox.registerSink === 'function'){
    for (const sink of plugins.sinks){
      try { outbox.registerSink(sink); } catch {}
    }
  }

  const channelRunners = [];
  if (plugins && Array.isArray(plugins.channels)){
    for (const ch of plugins.channels){
      if (!ch || typeof ch !== 'object') continue;
      if (typeof ch.start === 'function'){
        try {
          await ch.start({ inbox, scheduler, wsHub, trace });
          channelRunners.push({
            channel: ch,
            stop: typeof ch.stop === 'function' ? ch.stop : null,
          });
        } catch (e) {
          try {
            logError('[arcana:gateway-v2] channel start error', e);
          } catch {}
        }
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { method, url } = req;
      if (!method || !url) {
        sendJson(res, 400, { ok: false, error: 'bad_request' });
        return;
      }

      const u = new URL(url, 'http://localhost');

      if (method === 'GET' && u.pathname === '/v2/health'){
        sendJson(res, 200, {
          ok: true,
          kind: 'gateway-v2',
          time: iso(nowMs()),
        });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/events'){
        const body = await readBodyJson(req).catch(() => null);
        const agentId = (body && body.agentId) || 'default';
        const sessionKey = (body && body.sessionKey) || 'session';
        const events = (body && Array.isArray(body.events)) ? body.events : [];
        if (!events.length){
          sendJson(res, 400, { ok: false, error: 'no_events' });
          return;
        }
        let stored;
        try {
          stored = await inbox.ingestEvents({ agentId, sessionKey, events });
        } catch {
          sendJson(res, 500, { ok: false, error: 'ingest_failed' });
          return;
        }
        if (body && body.wake){
          try {
            scheduler.requestWake({ agentId, sessionKey, reason: 'events', priority: 0, delayMs: 0 });
          } catch {}
        }
        sendJson(res, 200, { ok: true, events: stored });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/wake'){
        const body = await readBodyJson(req).catch(() => null);
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        const delayRaw = body && body.delayMs;
        const delayMs = (typeof delayRaw === 'number' && Number.isFinite(delayRaw) && delayRaw >= 0) ? delayRaw : undefined;
        const prRaw = body && body.priority;
        const priority = (typeof prRaw === 'number' && Number.isFinite(prRaw)) ? prRaw : undefined;
        const reason = body && body.reason ? String(body.reason) : 'wake';
        try {
          scheduler.requestWake({ agentId, sessionKey, priority, reason, delayMs });
        } catch {}
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/turn'){
        const body = await readBodyJson(req).catch(() => null);
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        const text = body && body.text ? String(body.text) : '';
        if (!text){
          sendJson(res, 400, { ok: false, error: 'missing_text' });
          return;
        }
        let ev;
        try {
          ev = await inbox.ingestEvent({
            agentId,
            sessionKey,
            type: 'message',
            source: 'user',
            data: { text },
          });
        } catch {
          sendJson(res, 500, { ok: false, error: 'ingest_failed' });
          return;
        }
        try {
          scheduler.requestWake({ agentId, sessionKey, reason: 'turn', priority: 5, delayMs: 0 });
        } catch {}
        sendJson(res, 200, { ok: true, event: ev });
        return;
      }

      if (method === 'GET' && u.pathname === '/v2/state'){
        const agentId = u.searchParams.get('agentId') || 'default';
        const sessionKey = u.searchParams.get('sessionKey') || 'session';
        const scope = u.searchParams.get('scope') || 'default';
        const state = await getState({ agentId, sessionKey, scope });
        sendJson(res, 200, { ok: true, state });
        return;
      }

      if (method === 'PATCH' && u.pathname === '/v2/state'){
        const body = await readBodyJson(req).catch(() => null);
        if (!body || typeof body !== 'object'){
          sendJson(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        const agentId = body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body.sessionKey ? String(body.sessionKey) : 'session';
        const scope = body.scope ? String(body.scope) : 'default';
        const expectedVersion = body.expectedVersion != null ? Number(body.expectedVersion) : null;
        const value = body.value;
        const result = await patchState({
          agentId,
          sessionKey,
          scope,
          expectedVersion,
          mutator: () => value,
        });
        if (result && result.conflict){
          sendJson(res, 409, { ok: false, error: 'version_conflict', state: result.current });
          return;
        }
        sendJson(res, 200, { ok: true, state: { value: result.value, version: result.version, updatedAtMs: result.updatedAtMs } });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/runners/start'){
        const body = await readBodyJson(req).catch(() => null);
        if (!body || typeof body !== 'object'){
          sendJson(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        const agentId = body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body.sessionKey ? String(body.sessionKey) : 'session';
        const runnerId = body.runnerId != null ? String(body.runnerId) : undefined;
        try {
          const result = await engine.startRunner({ agentId, sessionKey, runnerId });
          sendJson(res, 200, { ok: true, state: result.state });
        } catch {
          sendJson(res, 500, { ok: false, error: 'runner_start_failed' });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/runners/stop'){
        const body = await readBodyJson(req).catch(() => null);
        if (!body || typeof body !== 'object'){
          sendJson(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        const agentId = body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body.sessionKey ? String(body.sessionKey) : 'session';
        try {
          const result = await engine.stopRunner({ agentId, sessionKey });
          sendJson(res, 200, { ok: true, state: result.state });
        } catch {
          sendJson(res, 500, { ok: false, error: 'runner_stop_failed' });
        }
        return;
      }

      if (method === 'GET' && u.pathname === '/v2/runners/status'){
        const agentId = u.searchParams.get('agentId') || 'default';
        const sessionKey = u.searchParams.get('sessionKey') || 'session';
        try {
          const status = await engine.getRunnerStatus({ agentId, sessionKey });
          sendJson(res, 200, status);
        } catch {
          sendJson(res, 500, { ok: false, error: 'runner_status_failed' });
        }
        return;
      }

      if (method === 'GET' && u.pathname === '/v2/cron/jobs'){
        const jobs = await cronStore.listJobs();
        sendJson(res, 200, { ok: true, jobs });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/cron/jobs'){
        const body = await readBodyJson(req).catch(() => null);
        if (!body || typeof body !== 'object'){
          sendJson(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        try {
          const job = await cronStore.createJob(body);
          sendJson(res, 200, { ok: true, job });
        } catch {
          sendJson(res, 500, { ok: false, error: 'cron_create_failed' });
        }
        return;
      }

      if (method === 'PATCH' && u.pathname === '/v2/cron/jobs'){
        const body = await readBodyJson(req).catch(() => null);
        if (!body || typeof body !== 'object'){
          sendJson(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        const id = body.id || body.jobId;
        if (!id){
          sendJson(res, 400, { ok: false, error: 'missing_id' });
          return;
        }
        const patch = { ...body };
        delete patch.id;
        delete patch.jobId;
        try {
          const job = await cronStore.updateJob(id, patch);
          if (!job){
            sendJson(res, 404, { ok: false, error: 'job_not_found' });
            return;
          }
          sendJson(res, 200, { ok: true, job });
        } catch {
          sendJson(res, 500, { ok: false, error: 'cron_update_failed' });
        }
        return;
      }

      if (method === 'DELETE' && u.pathname === '/v2/cron/jobs'){
        const body = await readBodyJson(req).catch(() => null);
        if (!body || typeof body !== 'object'){
          sendJson(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        const id = body.id || body.jobId;
        if (!id){
          sendJson(res, 400, { ok: false, error: 'missing_id' });
          return;
        }
        try {
          const result = await cronStore.deleteJob(id);
          sendJson(res, 200, { ok: true, deleted: !!(result && result.deleted) });
        } catch {
          sendJson(res, 500, { ok: false, error: 'cron_delete_failed' });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/cron/run'){
        const body = await readBodyJson(req).catch(() => null);
        if (!body || typeof body !== 'object'){
          sendJson(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        const id = body.id || body.jobId;
        if (!id){
          sendJson(res, 400, { ok: false, error: 'missing_id' });
          return;
        }
        const job = await cronStore.getJob(id);
        if (!job){
          sendJson(res, 404, { ok: false, error: 'job_not_found' });
          return;
        }
        const agentId = job.agentId || 'default';
        const sessionKey = job.sessionKey || 'session';
        try {
          await engine.tick({ agentId, sessionKey, reason: 'cron:' + id });
          try {
            await cronStore.recordRun(id, { status: 'manual', trigger: 'manual' });
          } catch {}
          sendJson(res, 200, { ok: true });
        } catch {
          sendJson(res, 500, { ok: false, error: 'cron_run_failed' });
        }
        return;
      }

      if (method === 'GET' && !u.pathname.startsWith('/v2/')){
        const served = await tryServeStatic(u.pathname, res);
        if (served) return;
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (e) {
      try {
        console.error('[arcana:gateway-v2] handler error', e && e.stack ? e.stack : e);
      } catch {}
      try {
        sendJson(res, 500, { ok: false, error: 'internal_error' });
      } catch {}
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    wsHub.addClient(ws);
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = req && req.url ? req.url : '';
      const u = new URL(url, 'http://localhost');
      if (u.pathname !== '/v2/stream'){
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      try { socket.destroy(); } catch {}
    }
  });

  await new Promise((resolve) => {
    server.listen(desiredPort, () => resolve());
  });

  const bound = server.address();
  const actualPort = bound && typeof bound.port === 'number' ? bound.port : desiredPort;
  console.log('[arcana:gateway-v2] listening on http://localhost:' + actualPort);

  return {
    server,
    port: actualPort,
    wsHub,
    trace,
    plugins,
    runnerRegistry,
    inbox,
    outbox,
    scheduler,
    engine,
    cronStore,
    channelRunners,
  };
}

export default { startGatewayV2 };

