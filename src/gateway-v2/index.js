import { promises as fsp } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { loadOrCreateApiToken, isAuthorizedRequest, tokenHint, getApiTokenFilePath } from '../auth/api-token.js';
import { nowMs, iso, readBodyJson } from './util.js';
import { logError } from '../util/error.js';
import { createWsHub } from './ws-hub.js';
import * as eventStore from './event-store.js';
import { eventBus, runWithContext } from '../event-bus.js';
import { requestTurnAbort } from '../cron/arcana-task.js';
import { getSessionIdForKey } from '../session-key-store.js';
import { getState, patchState } from './state-store.js';
import { runInLane } from './lane.js';
import { createTraceEmitter } from './trace.js';
import { loadGatewayV2Plugins } from './plugins.js';
import { reactorRunner } from './reactor-runner.js';
import { createArcanaSession } from '../session.js';
import { createInbox } from './runtime/inbox.js';
import { appendAudit } from './runtime/audit-store.js';
import { createCronStore } from './runtime/cron-store.js';
import { createScheduler } from './runtime/scheduler.js';
import { createOutbox } from './runtime/outbox.js';
import { createPolicyEngine } from './runtime/policy.js';
import { createEngine } from './runtime/engine.js';
import { arcanaHomePath, ensureArcanaHomeDir } from '../arcana-home.js';
import { runChatMessage, abortChat } from './chat-runtime.js';
import { resolveWorkspaceRoot, ensureReadAllowed, ensureWriteAllowed } from '../workspace-guard.js';
import { loadArcanaConfig, loadAgentConfig } from '../config.js';
import {
  createSession as ssCreate,
  listSessions as ssList,
  loadSession as ssLoad,
  deleteSession as ssDelete,
} from '../sessions-store.js';
import { runDoctor } from '../doctor.js';
import { createSupportBundle } from '../support-bundle.js';
import { WELL_KNOWN_SECRETS, secrets } from '../secrets/index.js';
import { readToolOutputBundle } from '../tool-output-store.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = resolvePath(__dirname, "..", "..", "web");
let apiToken = "";

const DEFAULT_AGENT_ID = 'default';

function normalizeAgentId(raw){
  try {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return DEFAULT_AGENT_ID;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function sanitizeConfig(cfg){
  if (!cfg) return null;
  const out = {
    provider: cfg.provider || '',
    base_url: cfg.base_url || '',
    model: cfg.model || '',
    path: cfg.path || '',
  };
  out.has_key = !!cfg.key || !!cfg.api_key || !!cfg.apiKey;
  delete out.key;
  delete out.api_key;
  delete out.apiKey;
  return out;
}

function nowIso(){
  try { return new Date().toISOString(); } catch { return String(new Date()); }
}

let gatewayServerInfo = null;

function buildModelLabel(model){
  try {
    if (!model) return '<auto>';
    const provider = String(model.provider || '').trim();
    const id = String(model.id || model.model || '').trim();
    const baseUrl = String(model.baseUrl || model.base_url || model.baseURL || '').trim();
    const core = provider ? (provider + ':' + id) : (id || '');
    if (!core) return '<auto>';
    return baseUrl ? (core + ' @ ' + baseUrl) : core;
  } catch { return '<auto>'; }
}

async function refreshGatewayServerInfo(){
  try {
    const agentId = DEFAULT_AGENT_ID;
    let ws = '';
    try { ws = resolveWorkspaceRoot(); } catch { ws = process.cwd(); }
    const agentHomeDir = arcanaHomePath('agents', agentId);
    let created = null;
    await runWithContext(
      { sessionId: 'gateway-v2:server-info', agentId, agentHomeRoot: agentHomeDir, workspaceRoot: ws },
      async () => {
        created = await createArcanaSession({ workspaceRoot: ws, agentHomeRoot: agentHomeDir, execPolicy: 'restricted', bootstrapContextMode: 'lightweight' });
      },
    );
    if (!created) return;
    const modelLabel = buildModelLabel(created.model || null);
    const tools = Array.isArray(created.toolNames) ? created.toolNames.slice() : [];
    const skills = Array.isArray(created.skillNames) ? created.skillNames.slice() : [];
    gatewayServerInfo = { model: modelLabel, tools, skills, workspace: ws };
    try {
      const sess = created.session;
      if (sess && typeof sess.abort === 'function'){
        const p = sess.abort();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {}
  } catch (e) {
    try { logError('[arcana:gateway-v2] server info refresh failed', e); } catch {}
  }
}

function buildServerInfoEvent(){
  const info = gatewayServerInfo;
  if (!info) return null;
  return {
    type: 'server_info',
    model: info.model || '<auto>',
    tools: Array.isArray(info.tools) ? info.tools : [],
    workspace: info.workspace || '',
    skills: Array.isArray(info.skills) ? info.skills : [],
  };
}

function ensureDefaultAgentExistsGateway(){
  try { ensureArcanaHomeDir(); } catch {}
  const agentsBase = arcanaHomePath('agents');
  try { mkdirSync(agentsBase, { recursive: true }); } catch {}

  const agentId = DEFAULT_AGENT_ID;
  const agentHomeDir = arcanaHomePath('agents', agentId);
  const metaPath = join(agentHomeDir, 'agent.json');
  let meta = null;
  try {
    if (existsSync(metaPath)){
      const raw = readFileSync(metaPath, 'utf-8');
      meta = raw ? JSON.parse(raw) : null;
    }
  } catch {
    meta = null;
  }
  if (!meta || typeof meta !== 'object') meta = {};
  meta.agentId = agentId;

  let ws = '';
  try {
    const envWs = String(process.env.ARCANA_WORKSPACE || '').trim();
    if (envWs) ws = envWs;
    else {
      const cfg = loadArcanaConfig();
      const cand = cfg && (cfg.workspace_root || cfg.workspaceRoot || cfg.workspace_dir || cfg.workspaceDir);
      if (cand) ws = String(cand).trim();
    }
  } catch {}
  if (!ws) ws = process.cwd();
  try { mkdirSync(ws, { recursive: true }); } catch {}
  try { mkdirSync(join(ws, 'artifacts'), { recursive: true }); } catch {}

  if (!meta.workspaceRoot){
    meta.workspaceRoot = ws;
  }
  if (!meta.createdAt){
    meta.createdAt = nowIso();
  }
  try { mkdirSync(agentHomeDir, { recursive: true }); } catch {}
  try { writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8'); } catch {}

  return {
    agentId,
    agentDir: agentHomeDir,
    agentHomeDir,
    workspaceRoot: meta.workspaceRoot,
    createdAt: meta.createdAt,
  };
}

function loadAgentsSnapshotGateway(){
  ensureArcanaHomeDir();
  const agentsDir = arcanaHomePath('agents');
  let entries = [];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return { agentsDir, agents: [] };
  }
  const agents = [];
  for (const entry of entries){
    try {
      if (!entry || typeof entry.name !== 'string') continue;
      const isDir = entry.isDirectory ? entry.isDirectory() : true;
      if (!isDir) continue;
      const dirId = entry.name;
      const agentHomeDir = join(agentsDir, dirId);
      const metaPath = join(agentHomeDir, 'agent.json');
      let metaStat;
      try { metaStat = statSync(metaPath); } catch { metaStat = null; }
      if (!metaStat || !metaStat.isFile || !metaStat.isFile()) continue;
      let meta = null;
      try {
        const raw = readFileSync(metaPath, 'utf-8');
        if (raw) meta = JSON.parse(raw);
      } catch {
        meta = null;
      }
      let agentId = dirId;
      try {
        const idFromFile = meta && meta.agentId ? String(meta.agentId || '').trim() : '';
        if (idFromFile) agentId = idFromFile;
      } catch {}
      let workspaceRoot = '';
      try {
        const rawWs = meta && (meta.workspaceRoot || meta.workspaceDir || '');
        if (rawWs) workspaceRoot = String(rawWs);
      } catch {}
      let createdAt = '';
      if (meta && typeof meta.createdAt === 'string' && meta.createdAt.trim()){
        createdAt = meta.createdAt.trim();
      }
      if (!createdAt && metaStat){
        const ts = metaStat.birthtimeMs || metaStat.ctimeMs || metaStat.mtimeMs || Date.now();
        try { createdAt = new Date(ts).toISOString(); } catch { createdAt = nowIso(); }
      }
      agents.push({ agentId, agentDir: agentHomeDir, agentHomeDir, workspaceRoot, createdAt });
    } catch {}
  }
  agents.sort((a, b) => {
    const aT = String(a.createdAt || '');
    const bT = String(b.createdAt || '');
    if (!aT && !bT) return String(a.agentId || '').localeCompare(String(b.agentId || ''));
    if (!aT) return 1;
    if (!bT) return -1;
    return aT.localeCompare(bT);
  });
  return { agentsDir, agents };
}

function findAgentMetaGateway(agentIdRaw){
  const id = normalizeAgentId(agentIdRaw);
  const snap = loadAgentsSnapshotGateway();
  const agents = Array.isArray(snap && snap.agents) ? snap.agents : [];
  for (const a of agents){
    const cur = String((a && a.agentId) || '').trim();
    if (cur === id) return a;
  }
  return null;
}

function resolveSessionContext(sessionId, explicitAgentId){
  const sid = String(sessionId || '').trim();
  const rawAgentId = explicitAgentId || DEFAULT_AGENT_ID;
  const agentId = normalizeAgentId(rawAgentId);
  const session = sid ? ssLoad(sid, { agentId }) : null;
  let ws = '';
  try {
    if (session && session.workspace) ws = String(session.workspace || '');
  } catch {}
  if (!ws){
    try { ws = resolveWorkspaceRoot(); }
    catch { ws = process.cwd(); }
  }
  const agentHomeDir = arcanaHomePath('agents', agentId);
  return { session, agentId, agentHomeDir, workspaceRoot: ws };
}

function resolveAgentHomeDirForEnv(agentIdRaw){
  try {
    const id = normalizeAgentId(agentIdRaw);
    const meta = findAgentMetaGateway(id) || (id === DEFAULT_AGENT_ID ? ensureDefaultAgentExistsGateway() : null);
    if (meta && (meta.agentHomeDir || meta.agentDir)) return meta.agentHomeDir || meta.agentDir;
    return arcanaHomePath('agents', id);
  } catch {
    return arcanaHomePath('agents', normalizeAgentId(agentIdRaw));
  }
}

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

  apiToken = loadOrCreateApiToken();
  try {
    const hint = tokenHint(apiToken);
    let tokenPath = '';
    try { tokenPath = getApiTokenFilePath(); } catch {}
    if (tokenPath){
      console.log('[arcana:gateway-v2] API token ' + hint + ' (file: ' + tokenPath + ', localStorage key: arcana.apiToken.v1)');
    } else {
      console.log('[arcana:gateway-v2] API token ' + hint + ' (localStorage key: arcana.apiToken.v1)');
    }
  } catch {}

  const wsHub = createWsHub({
    getInitialMessages: () => {
      const ev = buildServerInfoEvent();
      return ev ? [ev] : [];
    },
  });
  const trace = createTraceEmitter({ wsHub });

  // Bridge Codex/event-bus events into the WebSocket stream.
  // For most events we forward them as-is, but we synthesize
  // thinking_progress from thinking_delta so the web UI can show
  // stable THINK progress (chars + timing) per session.
  const thinkStatsBySession = new Map(); // sessionId -> { startedAtMs, chars }

  try {
    eventBus.on('event', (ev) => {
      try {
        if (!ev || typeof ev !== 'object') return;
        const t = ev.type ? String(ev.type) : '';
        if (!t) return;

        if (t === 'thinking_start' || t === 'thinking_delta' || t === 'thinking_end') {
          const rawSessionId = (ev.sessionId != null ? ev.sessionId : (ev.session_id != null ? ev.session_id : undefined));
          const sessionId = rawSessionId != null ? String(rawSessionId) : '';

          if (t === 'thinking_start') {
            if (sessionId) {
              thinkStatsBySession.set(sessionId, { startedAtMs: nowMs(), chars: 0 });
              wsHub.broadcast({ type: 'thinking_start', sessionId });
            } else {
              wsHub.broadcast({ type: 'thinking_start' });
            }
            return;
          }

          if (t === 'thinking_delta') {
            if (!sessionId) return;
            let stats = thinkStatsBySession.get(sessionId);
            if (!stats) {
              stats = { startedAtMs: nowMs(), chars: 0 };
              thinkStatsBySession.set(sessionId, stats);
            }
            let size = 0;
            try {
              const src = (ev.delta != null ? ev.delta : ev);
              size = JSON.stringify(src).length;
            } catch {}
            if (size > 0) stats.chars += size;
            wsHub.broadcast({ type: 'thinking_progress', sessionId, chars: stats.chars });
            return;
          }

          if (t === 'thinking_end') {
            if (sessionId) {
              const stats = thinkStatsBySession.get(sessionId);
              if (stats) {
                thinkStatsBySession.delete(sessionId);
                const tookMs = Math.max(0, nowMs() - (stats.startedAtMs || 0));
                wsHub.broadcast({ type: 'thinking_end', sessionId, chars: stats.chars || 0, tookMs });
              } else {
                wsHub.broadcast({ type: 'thinking_end', sessionId });
              }
            } else {
              wsHub.broadcast({ type: 'thinking_end' });
            }
            return;
          }
        }

        // Default: forward the original event as-is.
        wsHub.broadcast(ev);
      } catch {}
    });
  } catch {}

  await refreshGatewayServerInfo();

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

      if (u.pathname.startsWith('/v2/')){
        if (!isAuthorizedRequest(req, apiToken)){
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
      }

      if (u.pathname.startsWith('/api/')){
        if (!isAuthorizedRequest(req, apiToken)){
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
      }

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

      if (method === 'POST' && u.pathname === '/v2/abort'){
        const body = await readBodyJson(req).catch(() => null);
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        let sessionId = null;
        try {
          if (body && body.sessionId){
            sessionId = String(body.sessionId || '').trim() || null;
          } else {
            const resolvedId = await getSessionIdForKey({ agentId, sessionKey });
            if (resolvedId) sessionId = String(resolvedId || '').trim() || null;
          }
        } catch {}

        // First try to abort an interactive chat session (Gateway chat runtime)
        let chatResult = null;
        try {
          chatResult = await abortChat({ agentId, sessionKey, sessionId });
        } catch {}
        if (chatResult && chatResult.ok){
          sendJson(res, 200, { ok: true, reason: null });
          return;
        }

        // Fallback: abort a cron/automation turn managed by runArcanaTask
        const result = requestTurnAbort({ agentId, sessionKey, sessionId });
        try {
          if (result && result.ok !== false){
            eventBus.emit('event', { type: 'abort_done', agentId, sessionKey, sessionId: sessionId || null });
          }
        } catch {}
        sendJson(res, 200, { ok: result && result.ok !== false, reason: result && result.reason ? result.reason : null });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/turn'){
        const body = await readBodyJson(req).catch(() => null);
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        const sessionIdRaw = body && body.sessionId ? String(body.sessionId) : '';
        const text = body && body.text ? String(body.text) : '';
        if (!text){
          sendJson(res, 400, { ok: false, error: 'missing_text' });
          return;
        }
        let policy = 'restricted';
        try {
          const rawPol = body && typeof body.policy === 'string' ? body.policy : '';
          const p = String(rawPol || '').trim().toLowerCase();
          if (p === 'open' || p === 'restricted') policy = p;
        } catch {}
        const chat = await runChatMessage({ agentId, sessionKey, sessionId: sessionIdRaw || null, text, policy, title: 'Arcana Web', sync: false });
        if (!chat || chat.ok === false){
          const errMsg = chat && chat.error ? String(chat.error) : 'turn_failed';
          try {
            const ev = {
              type: 'error',
              agentId,
              sessionId: chat && chat.sessionId ? chat.sessionId : (sessionIdRaw || null),
              message: errMsg,
            };
            eventBus.emit('event', ev);
          } catch {}
          sendJson(res, 500, { ok: false, error: errMsg });
          return;
        }
        sendJson(res, 200, { ok: true, sessionId: chat.sessionId, mode: chat.mode || 'turn' });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/turn-sync'){
        const body = await readBodyJson(req).catch(() => null);
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        const sessionIdRaw = body && body.sessionId ? String(body.sessionId) : '';
        const text = body && body.text ? String(body.text) : '';
        if (!text){
          sendJson(res, 400, { ok: false, error: 'missing_text' });
          return;
        }
        let policy = 'restricted';
        try {
          const rawPol = body && typeof body.policy === 'string' ? body.policy : '';
          const p = String(rawPol || '').trim().toLowerCase();
          if (p === 'open' || p === 'restricted') policy = p;
        } catch {}
        const chat = await runChatMessage({ agentId, sessionKey, sessionId: sessionIdRaw || null, text, policy, title: 'Arcana Web', sync: true });
        if (!chat || chat.ok === false){
          const respBody = {
            ok: false,
            error: chat && chat.error ? chat.error : 'turn_failed',
            sessionId: chat && chat.sessionId ? chat.sessionId : (sessionIdRaw || null),
            text: chat && typeof chat.text === 'string' ? chat.text : '',
          };
          if (chat && Object.prototype.hasOwnProperty.call(chat, 'warning') && chat.warning != null){
            respBody.warning = chat.warning;
          }
          if (chat && Object.prototype.hasOwnProperty.call(chat, 'logPath') && chat.logPath){
            respBody.logPath = chat.logPath;
          }
          sendJson(res, 500, respBody);
          return;
        }
        const respBody = { ok: true, sessionId: chat.sessionId, text: chat.text || '', mode: chat.mode || 'turn' };
        if (Object.prototype.hasOwnProperty.call(chat, 'warning') && chat.warning != null){
          respBody.warning = chat.warning;
        }
        if (Object.prototype.hasOwnProperty.call(chat, 'logPath') && chat.logPath){
          respBody.logPath = chat.logPath;
        }
        sendJson(res, 200, respBody);
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


      // --- Legacy /api/* compatibility for web UI on the gateway host ---

      if (method === 'GET' && u.pathname === '/api/agents'){
        try {
          ensureDefaultAgentExistsGateway();
        } catch {}
        try {
          const snap = loadAgentsSnapshotGateway();
          const list = Array.isArray(snap && snap.agents) ? snap.agents : [];
          sendJson(res, 200, { agents: list });
        } catch (e) {
          sendJson(res, 500, { error: 'agents_list_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'GET' && u.pathname === '/api/sessions'){
        try {
          const agentIdParam = String(u.searchParams.get('agentId') || '').trim();
          const agentId = agentIdParam || DEFAULT_AGENT_ID;
          const sessions = ssList(agentId);
          sendJson(res, 200, { sessions });
        } catch (e) {
          sendJson(res, 500, { error: 'list_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/sessions'){
        try {
          const body = await readBodyJson(req).catch(() => ({}));
          const title = String(body && body.title ? body.title : '新会话').trim();
          let agentId = '';
          try {
            if (body && Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null){
              agentId = String(body.agentId || '').trim();
            }
          } catch {}
          if (!agentId) agentId = DEFAULT_AGENT_ID;

          const meta = findAgentMetaGateway(agentId) || (agentId === DEFAULT_AGENT_ID ? ensureDefaultAgentExistsGateway() : null);
          if (!meta || !meta.workspaceRoot){
            sendJson(res, 400, { error: 'agent_not_found' });
            return;
          }

          const obj = ssCreate({ title, agentId });
          sendJson(res, 200, obj);
        } catch (e) {
          sendJson(res, 500, { error: 'create_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (u.pathname.startsWith('/api/sessions/')){
        const id = u.pathname.slice('/api/sessions/'.length);
        if (method === 'GET'){
          try {
            const agentIdParam = String(u.searchParams.get('agentId') || '').trim();
            const agentId = agentIdParam || DEFAULT_AGENT_ID;
            const obj = ssLoad(String(id || '').trim(), { agentId });
            if (!obj){
              sendJson(res, 404, { error: 'not_found' });
              return;
            }
            sendJson(res, 200, obj);
          } catch (e) {
            sendJson(res, 500, { error: 'get_failed', message: e && e.message ? String(e.message) : String(e || '') });
          }
          return;
        }
        if (method === 'DELETE'){
          try {
            const agentIdParam = String(u.searchParams.get('agentId') || '').trim();
            const agentId = agentIdParam || DEFAULT_AGENT_ID;
            let decoded = '';
            try { decoded = decodeURIComponent(String(id || '').trim()); }
            catch { decoded = String(id || '').trim(); }
            const ok = ssDelete(decoded, { agentId });
            if (!ok){
              sendJson(res, 404, { error: 'not_found' });
              return;
            }
            sendJson(res, 200, { ok: true });
          } catch (e) {
            sendJson(res, 500, { error: 'delete_failed', message: e && e.message ? String(e.message) : String(e || '') });
          }
          return;
        }
      }


      if (method === 'GET' && u.pathname === '/api/secrets'){
        try {
          const agentIdParam = String(u.searchParams.get('agentId') || '').trim();
          const agentId = agentIdParam || DEFAULT_AGENT_ID;
          const agentHomeDir = resolveAgentHomeDirForEnv(agentId);
          const { bindings, meta } = await secrets.listNames(agentHomeDir);
          sendJson(res, 200, { bindings, wellKnown: WELL_KNOWN_SECRETS || [], meta });
        } catch (e) {
          sendJson(res, 500, { error: 'secrets_list_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/secrets'){
        try {
          const body = await readBodyJson(req).catch(() => ({}));
          let agentId = '';
          try {
            if (body && Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null){
              agentId = String(body.agentId || '').trim();
            }
          } catch {}
          if (!agentId) agentId = DEFAULT_AGENT_ID;
          const agentHomeDir = resolveAgentHomeDirForEnv(agentId);
          const bindings = body && body.bindings && typeof body.bindings === 'object' ? body.bindings : {};
          for (const [nameRaw, specRaw] of Object.entries(bindings)){
            const name = String(nameRaw || '').trim();
            if (!name) continue;
            const spec = specRaw && typeof specRaw === 'object' ? specRaw : {};
            const deleteFlag = !!spec.delete;
            const scopeRaw = String(spec.scope || '').trim().toLowerCase();
            const scope = scopeRaw === 'agent' ? 'agent' : (scopeRaw === 'global' ? 'global' : '');
            if (!scope) continue;
            if (deleteFlag){
              try { await secrets.unset(name, scope, agentHomeDir); } catch {}
            }
          }
          try { eventBus.emit('event', { type: 'secrets_refresh' }); } catch {}
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { error: 'secrets_update_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/secrets/import'){
        try {
          const body = await readBodyJson(req).catch(() => null);
          if (!body || typeof body !== 'object'){
            sendJson(res, 400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
            return;
          }
          let agentId = '';
          try {
            if (Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null){
              agentId = String(body.agentId || '').trim();
            }
          } catch {}
          if (!agentId) agentId = DEFAULT_AGENT_ID;
          const nameRaw = typeof body.name === 'string' ? body.name : '';
          const name = String(nameRaw || '').trim();
          const scopeRaw = typeof body.scope === 'string' ? body.scope : '';
          const scopeLower = String(scopeRaw || '').trim().toLowerCase();
          const scope = scopeLower === 'agent' ? 'agent' : (scopeLower === 'global' ? 'global' : '');
          const valueRaw = body.value;
          const value = valueRaw != null ? String(valueRaw) : '';
          if (!name){
            sendJson(res, 400, { error: 'name_required' });
            return;
          }
          if (!scope){
            sendJson(res, 400, { error: 'invalid_scope' });
            return;
          }
          if (!value){
            sendJson(res, 400, { error: 'value_required' });
            return;
          }
          const agentHomeDir = resolveAgentHomeDirForEnv(agentId);
          try {
            await secrets.setText(name, value, scope, agentHomeDir);
          } catch (e) {
            const code = e && e.code;
            if (code === 'VAULT_UNINITIALIZED'){
              sendJson(res, 409, { error: 'vault_uninitialized' });
              return;
            }
            if (code === 'VAULT_LOCKED'){
              sendJson(res, 423, { error: 'vault_locked' });
              return;
            }
            sendJson(res, 400, { error: 'secrets_import_failed', message: e && e.message ? String(e.message) : String(e || '') });
            return;
          }
          try { eventBus.emit('event', { type: 'secrets_refresh' }); } catch {}
          sendJson(res, 200, { ok: true, name, scope });
        } catch (e) {
          sendJson(res, 400, { error: 'secrets_import_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/secrets/init'){
        try {
          const body = await readBodyJson(req).catch(() => null);
          const passRaw = body && typeof body.password === 'string' ? body.password : '';
          const pass = String(passRaw || '');
          if (!pass){
            sendJson(res, 400, { error: 'password_required' });
            return;
          }
          try {
            const st = secrets.init(pass);
            try { ensureDefaultAgentExistsGateway(); } catch {}
            sendJson(res, 200, { ok: true, initialized: !!st.initialized, locked: !!st.locked });
          } catch (e) {
            const code = e && e.code;
            if (code === 'VAULT_ALREADY_INITIALIZED'){
              sendJson(res, 409, { error: 'vault_already_initialized' });
              return;
            }
            sendJson(res, 400, { error: 'vault_init_failed', message: e && e.message ? String(e.message) : String(e || '') });
          }
        } catch (e) {
          sendJson(res, 400, { error: 'vault_init_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/secrets/unlock'){
        try {
          const body = await readBodyJson(req).catch(() => null);
          const passRaw = body && typeof body.password === 'string' ? body.password : '';
          const pass = String(passRaw || '');
          if (!pass){
            sendJson(res, 400, { error: 'password_required' });
            return;
          }
          try {
            const st = secrets.unlock(pass);
            try { ensureDefaultAgentExistsGateway(); } catch {}
            sendJson(res, 200, { ok: true, initialized: !!st.initialized, locked: !!st.locked });
          } catch (e) {
            const code = e && e.code;
            if (code === 'VAULT_UNINITIALIZED'){
              sendJson(res, 409, { error: 'vault_uninitialized' });
              return;
            }
            if (code === 'VAULT_BAD_PASSPHRASE'){
              sendJson(res, 403, { error: 'vault_bad_passphrase' });
              return;
            }
            sendJson(res, 400, { error: 'vault_unlock_failed', message: e && e.message ? String(e.message) : String(e || '') });
          }
        } catch (e) {
          sendJson(res, 400, { error: 'vault_unlock_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'GET' && u.pathname === '/api/secrets/status'){
        try {
          const st = secrets.status();
          sendJson(res, 200, { initialized: !!st.initialized, locked: !!st.locked });
        } catch (e) {
          sendJson(res, 500, { error: 'vault_status_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/secrets/reset'){
        try {
          const body = await readBodyJson(req).catch(() => ({}));
          let agentId = '';
          try {
            if (body && Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null){
              agentId = String(body.agentId || '').trim();
            }
          } catch {}
          if (!agentId) agentId = DEFAULT_AGENT_ID;
          const agentHomeDir = resolveAgentHomeDirForEnv(agentId);
          let deleted = { global: false, agent: false };
          try { deleted = secrets.reset(agentHomeDir) || deleted; } catch {
            try { secrets.lock(); } catch {}
          }
          try { secrets.lock(); } catch {}
          try { eventBus.emit('event', { type: 'secrets_refresh' }); } catch {}
          sendJson(res, 200, { ok: true, deleted });
        } catch (e) {
          try { secrets.lock(); } catch {}
          sendJson(res, 200, { ok: true, deleted: { global: false, agent: false } });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/secrets/migrate_env_vault'){
        sendJson(res, 410, { error: 'legacy_migration_removed' });
        return;
      }

      if (method === 'GET' && u.pathname === '/api/config'){
        try {
          const cfg = loadArcanaConfig();
          const out = sanitizeConfig(cfg || {});
          sendJson(res, 200, out || {});
        } catch {
          sendJson(res, 200, {});
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/config'){
        try {
          const body = await readBodyJson(req).catch(() => null);
          if (!body || typeof body !== 'object'){
            sendJson(res, 400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
            return;
          }
          const provider = String(body.provider || '').trim();
          const modelId = String(body.model || '').trim();
          const baseUrl = String(body.base_url || '').trim();
          const key = String(body.key || '').trim();
          const cfgObj = { provider, model: modelId, base_url: baseUrl };
          if (key) cfgObj.key = key;

          const envCfg = String(process.env.ARCANA_CONFIG || '').trim();
          let pathCfg = '';
          if (envCfg) pathCfg = envCfg;
          else {
            ensureArcanaHomeDir();
            pathCfg = arcanaHomePath('config.json');
          }
          await fsp.writeFile(pathCfg, JSON.stringify(cfgObj, null, 2), 'utf-8');

          // Refresh cached server_info so the UI sees updated model/base_url.
          try {
            await refreshGatewayServerInfo();
            const ev = buildServerInfoEvent();
            if (ev) {
              try { eventBus.emit('event', ev); } catch {}
            }
          } catch {}

          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { error: 'config_write_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'GET' && u.pathname === '/api/agent-config'){
        try {
          const agentIdParam = String(u.searchParams.get('agentId') || '').trim();
          const agentId = agentIdParam || DEFAULT_AGENT_ID;
          const meta = findAgentMetaGateway(agentId) || (agentId === DEFAULT_AGENT_ID ? ensureDefaultAgentExistsGateway() : null);
          const baseHome = meta && (meta.agentHomeDir || meta.agentDir) ? (meta.agentHomeDir || meta.agentDir) : arcanaHomePath('agents', agentId);
          const agentHomeDir = baseHome || arcanaHomePath('agents', agentId);
          const rawCfg = loadAgentConfig(agentHomeDir);
          const cfgPath = join(agentHomeDir, 'config.json');
          const merged = rawCfg ? { ...rawCfg } : { path: cfgPath };
          if (!merged.path) merged.path = cfgPath;
          const out = sanitizeConfig(merged) || { provider: '', base_url: '', model: '', path: cfgPath, has_key: false };
          sendJson(res, 200, out);
        } catch {
          sendJson(res, 200, {});
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/agent-config'){
        try {
          const body = await readBodyJson(req).catch(() => null);
          if (!body || typeof body !== 'object'){
            sendJson(res, 400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
            return;
          }
          let agentId = '';
          try {
            if (Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null){
              agentId = String(body.agentId || '').trim();
            }
          } catch {}
          if (!agentId) agentId = DEFAULT_AGENT_ID;
          const meta = findAgentMetaGateway(agentId) || (agentId === DEFAULT_AGENT_ID ? ensureDefaultAgentExistsGateway() : null);
          const baseHome = meta && (meta.agentHomeDir || meta.agentDir) ? (meta.agentHomeDir || meta.agentDir) : arcanaHomePath('agents', agentId);
          const agentHomeDir = baseHome || arcanaHomePath('agents', agentId);
          const cfgPath = join(agentHomeDir, 'config.json');

          const shouldClear = !!(body && body.clear === true);
          if (shouldClear){
            try { await fsp.unlink(cfgPath); } catch {}
          } else {
            const provider = String(body.provider || '').trim();
            const modelId = String(body.model || '').trim();
            const baseUrl = String(body.base_url || '').trim();
            const key = String(body.key || '').trim();
            const cfgObj = { provider, model: modelId, base_url: baseUrl };
            if (key) cfgObj.key = key;
            const baseDir = String(agentHomeDir || '').trim();
            if (baseDir){
              try { mkdirSync(baseDir, { recursive: true }); } catch {}
              await fsp.writeFile(cfgPath, JSON.stringify(cfgObj, null, 2), 'utf-8');
            }
          }

          // Refresh cached server_info after agent config changes.
          try {
            await refreshGatewayServerInfo();
            const ev = buildServerInfoEvent();
            if (ev) {
              try { eventBus.emit('event', ev); } catch {}
            }
          } catch {}

          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { error: 'agent_config_write_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'GET' && u.pathname === '/api/doctor'){
        try {
          const sidRaw = String(u.searchParams.get('sessionId') || '').trim();
          const skRaw = String(u.searchParams.get('sessionKey') || '').trim();
          let sid = sidRaw;
          if (!sid && skRaw){
            try {
              const resolvedId = await getSessionIdForKey({ agentId: DEFAULT_AGENT_ID, sessionKey: skRaw });
              if (resolvedId) sid = String(resolvedId || '').trim();
            } catch {}
          }
          const ctx = resolveSessionContext(sid || undefined);
          const ws = ctx.workspaceRoot || resolveWorkspaceRoot();
          const result = await runWithContext({ sessionId: sid || undefined, agentId: ctx.agentId, agentHomeRoot: ctx.agentHomeDir, workspaceRoot: ws }, () => runDoctor({ cwd: ws }));
          sendJson(res, 200, result);
        } catch (e) {
          sendJson(res, 500, { error: 'doctor_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/support-bundle'){
        try {
          const body = await readBodyJson(req).catch(() => null);
          const sidRaw = String(body && body.sessionId || '').trim();
          const skRaw = String(body && body.sessionKey || '').trim();
          let sid = sidRaw;
          if (!sid && skRaw){
            try {
              const resolvedId = await getSessionIdForKey({ agentId: DEFAULT_AGENT_ID, sessionKey: skRaw });
              if (resolvedId) sid = String(resolvedId || '').trim();
            } catch {}
          }
          const ctx = resolveSessionContext(sid || undefined);
          const ws = ctx.workspaceRoot || resolveWorkspaceRoot();
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const outDirRaw = join(ws, 'artifacts', 'support-' + stamp);
          const outDir = await runWithContext({ sessionId: sid || undefined, agentId: ctx.agentId, agentHomeRoot: ctx.agentHomeDir, workspaceRoot: ws }, () => ensureWriteAllowed(outDirRaw));
          const { dir, tarPath } = await createSupportBundle({ outDir, cwd: ws });
          sendJson(res, 200, { ok: true, dir, tarPath: tarPath || '' });
        } catch (e) {
          sendJson(res, 500, { error: 'support_bundle_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'GET' && u.pathname === '/api/local-file'){
        try {
          const p = u.searchParams.get('path') || '';
          const sidRaw = String(u.searchParams.get('sessionId') || '').trim();
          const skRaw = String(u.searchParams.get('sessionKey') || '').trim();
          let sid = sidRaw;
          if (!sid && skRaw){
            try {
              const resolvedId = await getSessionIdForKey({ agentId: DEFAULT_AGENT_ID, sessionKey: skRaw });
              if (resolvedId) sid = String(resolvedId || '').trim();
            } catch {}
          }
          const ctx = resolveSessionContext(sid || undefined);
          const ws = ctx.workspaceRoot || resolveWorkspaceRoot();
          const filePath = await runWithContext({ sessionId: sid || undefined, agentId: ctx.agentId, agentHomeRoot: ctx.agentHomeDir, workspaceRoot: ws }, () => ensureReadAllowed(p));
          const data = await fsp.readFile(filePath);
          const typeExt = extname(filePath).toLowerCase();
          const ct = typeExt === '.png'
            ? 'image/png'
            : typeExt === '.jpg' || typeExt === '.jpeg'
              ? 'image/jpeg'
              : typeExt === '.gif'
                ? 'image/gif'
                : typeExt === '.webp'
                  ? 'image/webp'
                  : 'application/octet-stream';
          res.statusCode = 200;
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'no-store');
          res.end(data);
        } catch {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not Found');
        }
        return;
      }

      if (method === 'GET' && u.pathname === '/api/tool-output'){
        try {
          const agentIdParam = String(u.searchParams.get('agentId') || '').trim();
          const sidRaw = String(u.searchParams.get('sessionId') || '').trim();
          const skRaw = String(u.searchParams.get('sessionKey') || '').trim();
          let sessionId = sidRaw;
          if (!sessionId && skRaw){
            try {
              const resolvedId = await getSessionIdForKey({ agentId: DEFAULT_AGENT_ID, sessionKey: skRaw });
              if (resolvedId) sessionId = String(resolvedId || '').trim();
            } catch {}
          }
          const toolCallId = String(u.searchParams.get('toolCallId') || '').trim();
          const tailRaw = String(u.searchParams.get('tailBytes') || '').trim();
          const agentId = agentIdParam || DEFAULT_AGENT_ID;
          if (!sessionId || !toolCallId){
            sendJson(res, 400, { ok: false, error: 'missing_params' });
            return;
          }

          let tailBytes;
          if (tailRaw){
            try {
              const n = Number(tailRaw);
              if (Number.isFinite(n) && n > 0) tailBytes = Math.floor(n);
            } catch {}
          }

          const bundle = readToolOutputBundle({ agentId, sessionId, toolCallId, tailBytes });
          if (!bundle || (!bundle.meta && !bundle.result && !bundle.streamTail)){
            sendJson(res, 404, { ok: false, error: 'not_found' });
            return;
          }

          sendJson(res, 200, {
            ok: true,
            meta: bundle.meta || null,
            result: bundle.result || null,
            streamTail: bundle.streamTail || '',
          });
        } catch (e) {
          try {
            console.error('[arcana:gateway-v2] /api/tool-output error', e && e.stack ? e.stack : e);
          } catch {}
          sendJson(res, 500, { ok: false, error: 'tool_output_failed' });
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
      if (!isAuthorizedRequest(req, apiToken)){
        try { socket.destroy(); } catch {}
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      try { socket.destroy(); } catch {}
    }
  });

  const bindHost = process.env.ARCANA_BIND_HOST && String(process.env.ARCANA_BIND_HOST).trim()
    ? String(process.env.ARCANA_BIND_HOST).trim()
    : '127.0.0.1';

  await new Promise((resolve) => {
    server.listen(desiredPort, bindHost, () => resolve());
  });

  const bound = server.address();
  const actualPort = bound && typeof bound.port === 'number' ? bound.port : desiredPort;
  const hostLabel = (bound && typeof bound.address === 'string' && bound.address) ? bound.address : bindHost;
  console.log('[arcana:gateway-v2] listening on http://' + hostLabel + ':' + actualPort);

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
