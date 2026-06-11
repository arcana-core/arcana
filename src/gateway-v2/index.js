import { promises as fsp } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve as resolvePath, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { configureLongRunningHttpServer } from '../http-server-timeouts.js';

import { loadOrCreateApiToken, isAuthorizedRequest, tokenHint, getApiTokenFilePath } from '../auth/api-token.js';
import { nowMs, iso, readBodyJson } from './util.js';
import { logError } from '../util/error.js';
import { createWsHub } from './ws-hub.js';
import * as eventStore from './event-store.js';
import { eventBus, runWithContext } from '../event-bus.js';
import {
  requestTurnAbort,
  requestTurnSteer,
  ensureSessionId,
  invalidateRuntimeSessions,
  clearRuntimeSessionContext,
} from '../cron/arcana-task.js';
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
import {
  runChatMessage,
  abortChat,
  clearChatContext,
  invalidateChatSessions,
  attachLocalToolProxyHub,
  cancelLocalToolProxyCallsForClient,
  handleLocalToolProxyHeartbeat,
  handleLocalToolProxyMessage,
  normalizeAgentHomeRootOverride,
  normalizeWorkspaceRootOverride,
} from './chat-runtime.js';
import { normalizeChatAttachments } from './chat-attachments.js';
import { requestCompactionAbort } from '../context-manager.js';
import { resolveWorkspaceRoot, ensureReadAllowed, ensureWriteAllowed } from '../workspace-guard.js';
import { loadArcanaConfig, loadAgentConfig } from '../config.js';
import { loadArcanaSkills } from '../skills.js';
import {
  createSession as ssCreate,
  listSessions as ssList,
  loadSession as ssLoad,
  deleteSession as ssDelete,
} from '../sessions-store.js';
import {
  createGroupSession as gsCreate,
  listGroupSessions as gsList,
  loadGroupSession as gsLoad,
  appendGroupEvent as gsAppendEvent,
  deleteGroupSession as gsDelete,
} from '../group-sessions-store.js';
import { runDoctor } from '../doctor.js';
import { createSupportBundle } from '../support-bundle.js';
import { WELL_KNOWN_SECRETS, providerApiKeyName, agentProviderApiKeyName, secrets } from '../secrets/index.js';
import { readToolOutputBundle } from '../tool-output-store.js';
import { readThinkingBundle } from '../thinking-output-store.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = resolvePath(__dirname, "..", "..", "web");
const PKG_ROOT = resolvePath(__dirname, "..", "..");
const REPO_ROOT = dirname(PKG_ROOT);
let apiToken = "";


const DEFAULT_AGENT_ID = 'default';
const TURN_REQUEST_MAX_BYTES = 12 * 1024 * 1024;
const ARCANA_LOCAL_PROXY_DEBUG = (() => {
  try {
    const raw = String(process.env.ARCANA_LOCAL_PROXY_DEBUG || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  } catch {
    return false;
  }
})();

function localProxyDebugLog(...args){
  if (!ARCANA_LOCAL_PROXY_DEBUG) return;
  try {
    console.log('[arcana:gateway-v2:local-proxy:debug]', ...args);
  } catch {}
}

function summarizeToolRoutingRoutes(toolRouting){
  try {
    const tools = toolRouting && toolRouting.tools && typeof toolRouting.tools === 'object'
      ? toolRouting.tools
      : null;
    if (!tools) return [];
    return Object.entries(tools).map(([name, route]) => {
      const execution = route && route.execution ? String(route.execution) : 'default';
      const fallback = route && route.fallback ? String(route.fallback) : 'default';
      return `${name}:${execution}/${fallback}`;
    });
  } catch {
    return [];
  }
}

function normalizeToolAllowlist(raw){
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  const seen = new Set();
  for (const item of raw){
    if (typeof item !== 'string') continue;
    const name = item.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

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

function parseExplicitAgentMentions(text){
  const out = [];
  const seen = new Set();
  const raw = String(text || '');
  const re = /(^|[^\w-])@([A-Za-z0-9_-]+)/g;
  let match;
  while ((match = re.exec(raw))) {
    const agentId = String(match[2] || '').trim();
    if (!agentId || seen.has(agentId)) continue;
    seen.add(agentId);
    out.push(agentId);
  }
  return out;
}

function parseLeadingAgentMentionsForHandoff(text){
  const lines = String(text || '').split(/\r?\n/g);
  let firstNonEmpty = '';
  for (const line of lines){
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    firstNonEmpty = trimmed;
    break;
  }
  if (!firstNonEmpty || !firstNonEmpty.startsWith('@')) return [];
  const out = [];
  const seen = new Set();
  let rest = firstNonEmpty;
  while (rest){
    const match = rest.match(/^@([A-Za-z0-9_-]+)(?=$|[^\w-])/);
    if (!match) break;
    const agentId = String(match[1] || '').trim();
    if (agentId && !seen.has(agentId)){
      seen.add(agentId);
      out.push(agentId);
    }
    rest = rest.slice(match[0].length);
    const ws = rest.match(/^\s+/);
    if (!ws) break;
    rest = rest.slice(ws[0].length);
  }
  return out;
}

function emitGroupEventAppended(groupId, event){
  const gid = String(groupId || '').trim();
  if (!gid || !event || typeof event !== 'object') return;
  try {
    eventBus.emit('event', { type: 'group.event.appended', groupId: gid, event });
  } catch {}
}

function ensureAgentMetaForGroup(agentIdRaw){
  const agentId = normalizeAgentId(agentIdRaw);
  if (agentId === DEFAULT_AGENT_ID){
    return ensureDefaultAgentExistsGateway();
  }
  return findAgentMetaGateway(agentId);
}

function buildGroupAssistantText(agentIdRaw, text){
  const agentId = String(agentIdRaw || '').trim();
  const body = String(text || '');
  if (!agentId) return body;
  if (body.startsWith('@' + agentId)) return body;
  return '@' + agentId + ' ' + body;
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
  // Non-secret history compression fields — expose if present
  try {
    if (Object.prototype.hasOwnProperty.call(cfg, 'openai_api_version')) {
      out.openai_api_version = cfg.openai_api_version || '';
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(cfg, 'azure_api_version')) {
      out.azure_api_version = cfg.azure_api_version || '';
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(cfg, 'azure_deployment_name_map')) {
      out.azure_deployment_name_map = cfg.azure_deployment_name_map || '';
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(cfg, 'history_compression_enabled')) {
      out.history_compression_enabled = cfg.history_compression_enabled;
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(cfg, 'history_compression_threshold_tokens')) {
      out.history_compression_threshold_tokens = cfg.history_compression_threshold_tokens;
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(cfg, 'history_compression_keep_user_turns')) {
      out.history_compression_keep_user_turns = cfg.history_compression_keep_user_turns;
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(cfg, 'history_compression_compact_instructions')) {
      out.history_compression_compact_instructions = cfg.history_compression_compact_instructions;
    }
  } catch {}
  delete out.key;
  delete out.api_key;
  delete out.apiKey;
  return out;
}

function applyStringConfigField(target, body, fieldName, options){
  try {
    if (!target || typeof target !== 'object') return;
    if (!body || typeof body !== 'object') return;
    const opts = options || {};
    const allowDeleteOnEmpty = !!opts.allowDeleteOnEmpty;
    if (!Object.prototype.hasOwnProperty.call(body, fieldName)) return;
    const value = String(body[fieldName] || '').trim();
    if (value){
      target[fieldName] = value;
    } else if (allowDeleteOnEmpty){
      try { delete target[fieldName]; } catch {}
    }
  } catch {}
}

function mergeAgentConfigForGateway(globalCfg, agentCfg){
  const base = (globalCfg && typeof globalCfg === 'object') ? { ...globalCfg } : {};
  const agent = (agentCfg && typeof agentCfg === 'object') ? agentCfg : null;
  if (agent){
    for (const [k, vRaw] of Object.entries(agent)){
      if (k === 'path') continue;
      const v = vRaw;
      if (v == null) continue;
      if (typeof v === 'string'){
        if (v.trim() === '') continue;
      }
      base[k] = v;
    }
    if (agent.path) base.path = agent.path;
  }
  return base;
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

function isLoopbackBindHost(raw){
  try {
    const value = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!value) return false;
    return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
  } catch {
    return false;
  }
}

function emitAsyncTurnFailure({ agentId, sessionKey, sessionId, error, message } = {}){
  try {
    eventBus.emit('event', {
      type: 'error',
      agentId,
      sessionKey,
      sessionId,
      error: String(error || 'turn_failed'),
      message: String(message || error || 'turn_failed'),
    });
  } catch {}
  try {
    eventBus.emit('event', {
      type: 'turn_end',
      agentId,
      sessionKey,
      sessionId,
    });
  } catch {}
}

export async function startGatewayV2({ port } = {}) {
  const desiredPort = typeof port === 'number' && Number.isFinite(port)
    ? port
    : (process.env.PORT ? Number(process.env.PORT) : 8787);
  const bindHost = process.env.ARCANA_BIND_HOST && String(process.env.ARCANA_BIND_HOST).trim()
    ? String(process.env.ARCANA_BIND_HOST).trim()
    : '127.0.0.1';
  const bypassTokenAuth = isLoopbackBindHost(bindHost);

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
  if (bypassTokenAuth){
    console.warn('[arcana:gateway-v2] loopback bind host detected; API token auth bypass enabled for local requests');
  }

  const wsHub = createWsHub({
    getInitialMessages: () => {
      const ev = buildServerInfoEvent();
      return ev ? [ev] : [];
    },
    onMessage: (msg, client) => {
      try {
        let handled = false;
        if (msg && typeof msg === 'object' && String(msg.type || '') === 'local_proxy_heartbeat'){
          const heartbeatAck = {
            type: 'local_proxy_heartbeat_ack',
            tsMs: Number.isFinite(Number(msg.tsMs)) ? Number(msg.tsMs) : null,
            serverTsMs: Date.now(),
          };
          const msgSessionKey = String(msg.sessionKey || '').trim();
          const msgAgentId = String(msg.agentId || '').trim();
          const msgClientId = String(msg.clientId || '').trim();
          if (msgSessionKey) heartbeatAck.sessionKey = msgSessionKey;
          if (msgAgentId) heartbeatAck.agentId = msgAgentId;
          if (msgClientId) heartbeatAck.clientId = msgClientId;
          try {
            const ws = client && client.ws ? client.ws : null;
            if (ws && ws.readyState === ws.OPEN){
              ws.send(JSON.stringify(heartbeatAck));
            }
          } catch {}
          return;
        }
        if (msg && typeof msg === 'object' && String(msg.type || '') === 'local_tool_heartbeat'){
          handled = !!handleLocalToolProxyHeartbeat(msg);
          const heartbeatAck = {
            type: 'local_tool_heartbeat_ack',
            callId: String(msg.callId || '').trim() || null,
            tool: String(msg.tool || '').trim() || null,
            handled,
            tsMs: Number.isFinite(Number(msg.tsMs)) ? Number(msg.tsMs) : null,
            serverTsMs: Date.now(),
          };
          const msgSessionKey = String(msg.sessionKey || '').trim();
          const msgAgentId = String(msg.agentId || '').trim();
          const msgClientId = String(msg.clientId || '').trim();
          if (msgSessionKey) heartbeatAck.sessionKey = msgSessionKey;
          if (msgAgentId) heartbeatAck.agentId = msgAgentId;
          if (msgClientId) heartbeatAck.clientId = msgClientId;
          try {
            const ws = client && client.ws ? client.ws : null;
            if (ws && ws.readyState === ws.OPEN){
              ws.send(JSON.stringify(heartbeatAck));
            }
          } catch {}
          localProxyDebugLog('ws local_tool_heartbeat', {
            callId: heartbeatAck.callId,
            tool: heartbeatAck.tool,
            sessionKey: msgSessionKey || null,
            agentId: msgAgentId || null,
            handled,
          });
          return;
        }
        if (msg && typeof msg === 'object' && String(msg.type || '') === 'local_tool_result'){
          handled = !!handleLocalToolProxyMessage(msg);
          const resultAck = {
            type: 'local_tool_result_ack',
            callId: String(msg.callId || '').trim() || null,
            tool: String(msg.tool || '').trim() || null,
            handled,
            ok: msg.ok !== false,
            serverTsMs: Date.now(),
          };
          const msgSessionKey = String(msg.sessionKey || '').trim();
          const msgAgentId = String(msg.agentId || '').trim();
          const msgClientId = String(msg.clientId || '').trim();
          if (msgSessionKey) resultAck.sessionKey = msgSessionKey;
          if (msgAgentId) resultAck.agentId = msgAgentId;
          if (msgClientId) resultAck.clientId = msgClientId;
          try {
            const ws = client && client.ws ? client.ws : null;
            if (ws && ws.readyState === ws.OPEN){
              ws.send(JSON.stringify(resultAck));
            }
          } catch {}
          localProxyDebugLog('ws local_tool_result', {
            callId: String(msg.callId || '').trim() || null,
            sessionKey: msgSessionKey || null,
            agentId: msgAgentId || null,
            ok: msg.ok !== false,
            handled,
          });
          return;
        }
        handleLocalToolProxyMessage(msg);
      } catch {}
    },
    onDisconnect: (client, meta) => {
      try {
        const remaining = meta && Number.isFinite(Number(meta.remainingMatchingClients))
          ? Number(meta.remainingMatchingClients)
          : 0;
        if (remaining > 0) return;
        const cancelled = cancelLocalToolProxyCallsForClient({
          agentId: client && client.agentId,
          sessionKey: client && client.sessionKey,
          clientId: client && client.clientId,
          reason: meta && meta.reason ? String(meta.reason) : 'websocket_disconnect',
        });
        if (cancelled > 0) {
          localProxyDebugLog('ws disconnect cancelled local tool calls', {
            agentId: client && client.agentId ? String(client.agentId) : null,
            sessionKey: client && client.sessionKey ? String(client.sessionKey) : null,
            clientId: client && client.clientId ? String(client.clientId) : null,
            cancelled,
          });
        }
      } catch {}
    },
  });
  try { attachLocalToolProxyHub(wsHub); } catch {}
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


        if (t === 'llm_usage'){
          try {
            const data = (ev && typeof ev.data === 'object' && ev.data) ? ev.data : {};

            let contextTokens = Number(
              data.contextTokens ?? data.context_tokens ?? ev.contextTokens ?? ev.context_tokens ?? 0,
            ) || 0;
            let inputTokens = Number(
              data.inputTokens ?? data.input_tokens ?? ev.inputTokens ?? ev.input_tokens ?? 0,
            ) || 0;
            let cacheReadTokens = Number(
              data.cacheReadTokens ?? data.cache_read_tokens ?? data.cacheRead ?? data.cache_read ??
              ev.cacheReadTokens ?? ev.cache_read_tokens ?? ev.cacheRead ?? ev.cache_read ?? 0,
            ) || 0;
            let cacheWriteTokens = Number(
              data.cacheWriteTokens ?? data.cache_write_tokens ?? data.cacheWrite ?? data.cache_write ??
              ev.cacheWriteTokens ?? ev.cache_write_tokens ?? ev.cacheWrite ?? ev.cache_write ?? 0,
            ) || 0;
            let outputTokens = Number(
              data.outputTokens ?? data.output_tokens ?? ev.outputTokens ?? ev.output_tokens ?? 0,
            ) || 0;
            let totalTokens = Number(
              data.totalTokens ?? data.total_tokens ?? ev.totalTokens ?? ev.total_tokens ?? 0,
            ) || 0;
            let sessionTokens = Number(
              data.sessionTokens ?? data.session_tokens ?? ev.sessionTokens ?? ev.session_tokens ?? 0,
            ) || 0;
            let lastCallContextTokens = Number(
              data.lastCallContextTokens ?? data.last_call_context_tokens ?? ev.lastCallContextTokens ?? ev.last_call_context_tokens ?? 0,
            ) || 0;
            let lastCallInputTokens = Number(
              data.lastCallInputTokens ?? data.last_call_input_tokens ?? ev.lastCallInputTokens ?? ev.last_call_input_tokens ?? 0,
            ) || 0;
            let lastCallCacheReadTokens = Number(
              data.lastCallCacheReadTokens ?? data.last_call_cache_read_tokens ??
              ev.lastCallCacheReadTokens ?? ev.last_call_cache_read_tokens ?? 0,
            ) || 0;
            let lastCallCacheWriteTokens = Number(
              data.lastCallCacheWriteTokens ?? data.last_call_cache_write_tokens ??
              ev.lastCallCacheWriteTokens ?? ev.last_call_cache_write_tokens ?? 0,
            ) || 0;
            let lastCallTotalTokens = Number(
              data.lastCallTotalTokens ?? data.last_call_total_tokens ?? ev.lastCallTotalTokens ?? ev.last_call_total_tokens ?? 0,
            ) || 0;

            if (!contextTokens && (inputTokens || cacheReadTokens || cacheWriteTokens)){
              contextTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
            }
            if (!totalTokens && (contextTokens || outputTokens)){
              totalTokens = contextTokens + outputTokens;
            }
            if (!lastCallContextTokens && (lastCallInputTokens || lastCallCacheReadTokens || lastCallCacheWriteTokens)){
              lastCallContextTokens = lastCallInputTokens + lastCallCacheReadTokens + lastCallCacheWriteTokens;
            }

            if (contextTokens > 0 || outputTokens > 0 || totalTokens > 0 || sessionTokens > 0){
              const agentIdRaw = ev.agentId;
              const agentId = agentIdRaw != null && String(agentIdRaw).trim() ? String(agentIdRaw) : 'default';
              const sessionKeyRaw = (ev.sessionKey != null ? ev.sessionKey : (ev.sessionId != null ? ev.sessionId : 'session'));
              const sessionKey = String(sessionKeyRaw || 'session');
              const sessionId = (data.sessionId != null ? String(data.sessionId) : (ev.sessionId != null ? String(ev.sessionId) : null));
              const tsMsRaw = ev.tsMs != null ? ev.tsMs : ev.ts;
              const tsNum = Number(tsMsRaw);
              const tsMs = (Number.isFinite(tsNum) && tsNum > 0) ? tsNum : nowMs();
              let model = '';
              try {
                if (Object.prototype.hasOwnProperty.call(data, 'model') && data.model != null){
                  model = String(data.model);
                } else if (Object.prototype.hasOwnProperty.call(ev, 'model') && ev.model != null){
                  model = String(ev.model);
                }
              } catch {}
              let clientTurnId = '';
              try {
                const rawClientTurnId = data.clientTurnId ?? data.client_turn_id ?? ev.clientTurnId ?? ev.client_turn_id;
                if (rawClientTurnId != null && String(rawClientTurnId).trim()){
                  clientTurnId = String(rawClientTurnId).trim();
                }
              } catch {}

              void eventStore.appendEvent({
                agentId,
                sessionKey,
                type: 'llm_usage',
                source: 'chat',
                tsMs,
                data: {
                  sessionId,
                  inputTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                  contextTokens,
                  outputTokens,
                  totalTokens,
                  lastCallInputTokens: lastCallInputTokens || undefined,
                  lastCallCacheReadTokens: lastCallCacheReadTokens || undefined,
                  lastCallCacheWriteTokens: lastCallCacheWriteTokens || undefined,
                  lastCallContextTokens: lastCallContextTokens || undefined,
                  lastCallTotalTokens: lastCallTotalTokens || undefined,
                  sessionTokens,
                  model: model || undefined,
                  clientTurnId: clientTurnId || undefined,
                },
              }).catch(() => {});

              const normalizedEv = {
                type: 'llm_usage',
                agentId,
                sessionKey,
                sessionId,
                inputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                contextTokens,
                outputTokens,
                totalTokens,
                lastCallInputTokens,
                lastCallCacheReadTokens,
                lastCallCacheWriteTokens,
                lastCallContextTokens,
                lastCallTotalTokens,
                sessionTokens,
              };
              if (model) normalizedEv.model = model;
              if (clientTurnId) normalizedEv.clientTurnId = clientTurnId;
              if (tsMs) normalizedEv.tsMs = tsMs;

              wsHub.broadcast(normalizedEv);
              return;
            }
          } catch {}
        }

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

  const server = configureLongRunningHttpServer(http.createServer(async (req, res) => {
    try {
      const { method, url } = req;
      if (!method || !url) {
        sendJson(res, 400, { ok: false, error: 'bad_request' });
        return;
      }

      const u = new URL(url, 'http://localhost');

      if (u.pathname.startsWith('/v2/')){
        if (!bypassTokenAuth && !isAuthorizedRequest(req, apiToken)){
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
      }

      if (u.pathname.startsWith('/api/')){
        if (!bypassTokenAuth && !isAuthorizedRequest(req, apiToken)){
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

      if (method === 'POST' && u.pathname === '/v2/turn-async'){
        const body = await readBodyJson(req, { maxBytes: TURN_REQUEST_MAX_BYTES }).catch((err) => {
          const msg = String(err && err.message || err || '');
          if (msg === 'body_too_large') {
            sendJson(res, 413, { ok: false, error: 'body_too_large', message: 'Request body exceeds 12 MB limit' });
            return '__handled__';
          }
          return null;
        });
        if (body === '__handled__') return;
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        const sessionIdRaw = body && body.sessionId ? String(body.sessionId) : '';
        const localToolProxy = !!(body && body.localToolProxy);
        const toolRouting = body && body.toolRouting ? body.toolRouting : undefined;
        const toolAllowlist = normalizeToolAllowlist(body && body.toolAllowlist);
        const localToolDefinitions = Array.isArray(body && body.localToolDefinitions) ? body.localToolDefinitions : [];
        const localBootstrapFiles = Array.isArray(body && body.localBootstrapFiles) ? body.localBootstrapFiles : [];
        const localAgentSignature = body && body.localAgentSignature ? String(body.localAgentSignature) : '';
        const systemPromptOverride = typeof (body && body.systemPromptOverride) === 'string' ? body.systemPromptOverride : '';
        const clientTurnId = body && body.clientTurnId ? String(body.clientTurnId).trim() : '';
        const workspaceRoot = normalizeWorkspaceRootOverride(body && (body.workspaceRoot || body.projectRootDir));
        const agentHomeRoot = normalizeAgentHomeRootOverride(body && (body.agentHomeRoot || body.agentHomeDir));
        const text = body && body.text ? String(body.text) : '';
        const attachments = normalizeChatAttachments(body && body.attachments);
        const hasAttachments = attachments.length > 0;
        if (!text && !hasAttachments){
          sendJson(res, 400, { ok: false, error: 'missing_text' });
          return;
        }
        let policy = 'restricted';
        try {
          const rawPol = body && typeof body.policy === 'string' ? body.policy : '';
          const p = String(rawPol || '').trim().toLowerCase();
          if (p === 'open' || p === 'restricted') policy = p;
        } catch {}

        let sessionId = '';
        try {
          const ws = workspaceRoot || resolveWorkspaceRoot();
          const ensuredId = await ensureSessionId({
            sessionId: sessionIdRaw || '',
            sessionKey,
            title: 'Arcana Web',
            agentId,
            workspaceRoot: ws,
          });
          sessionId = String(ensuredId || '').trim();
        } catch (e) {
          sendJson(res, 500, { ok: false, error: 'session_resolve_failed', message: String(e && e.message || e || '') });
          return;
        }
        if (!sessionId){
          sendJson(res, 500, { ok: false, error: 'session_resolve_failed' });
          return;
        }

        localProxyDebugLog('/v2/turn-async routing', {
          agentId,
          sessionKey,
          sessionId,
          localToolProxy,
          routing: summarizeToolRoutingRoutes(toolRouting),
          toolAllowlist: Array.isArray(toolAllowlist) ? toolAllowlist : [],
          localToolDefinitionsCount: localToolDefinitions.length,
          localToolDefinitionNames: localToolDefinitions.map((item) => String(item && item.name || '').trim()).filter(Boolean),
          localBootstrapFiles: localBootstrapFiles.map((item) => String(item && item.name || '').trim()).filter(Boolean),
          workspaceRoot: workspaceRoot || null,
          agentHomeRoot: agentHomeRoot || null,
        });

        const suppressBackground = String(process.env.ARCANA_GATEWAY_V2_SUPPRESS_ASYNC_TURN_BACKGROUND || '').trim() === '1';
        if (!suppressBackground) {
          setImmediate(() => {
            runChatMessage({
              agentId,
              sessionKey,
              sessionId,
              workspaceRoot,
              agentHomeRoot,
              text,
              policy,
              title: 'Arcana Web',
              sync: false,
              toolRouting,
              localToolProxy,
              toolAllowlist,
              localToolDefinitions,
              localBootstrapFiles,
              localAgentSignature,
              systemPromptOverride,
              clientTurnId,
              attachments,
            }).then((chat) => {
              if (!chat || chat.ok === false){
                emitAsyncTurnFailure({
                  agentId,
                  sessionKey,
                  sessionId,
                  error: chat && chat.error ? chat.error : 'turn_failed',
                  message: chat && chat.message ? chat.message : (chat && chat.error ? chat.error : 'turn_failed'),
                });
              }
            }).catch((e) => {
              emitAsyncTurnFailure({
                agentId,
                sessionKey,
                sessionId,
                error: 'turn_failed',
                message: String(e && e.message || e || 'turn_failed'),
              });
            });
          });
        }

        sendJson(res, 202, { ok: true, sessionId, mode: 'async' });
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

      if (method === 'POST' && u.pathname === '/v2/clear-context'){
        const body = await readBodyJson(req).catch(() => null);
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        try {
          const [chatResult, runtimeResult] = await Promise.all([
            clearChatContext({ agentId, sessionKey }).catch(() => ({ ok: false })),
            clearRuntimeSessionContext({ agentId, sessionKey }).catch(() => ({ ok: false })),
          ]);
          sendJson(res, 200, {
            ok: !!((chatResult && chatResult.ok) || (runtimeResult && runtimeResult.ok)),
            chat: chatResult || { ok: false },
            runtime: runtimeResult || { ok: false },
          });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
        }
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

        // Attempt to abort any in-progress history compaction for this session.
        // The compaction routine will broadcast a history_compact_end with aborted:true.
        let compactionAborted = false;
        try {
          const cr = requestCompactionAbort({ agentId, sessionId });
          if (cr && cr.ok !== false){ compactionAborted = true; }
        } catch {}

        // Also try to abort an interactive chat session (Gateway chat runtime)
        let chatResult = null;
        try { chatResult = await abortChat({ agentId, sessionKey, sessionId }); } catch {}
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
        const ok = (result && result.ok !== false) || compactionAborted || (chatResult && chatResult.ok);
        sendJson(res, 200, { ok, reason: result && result.reason ? result.reason : null });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/group-turn'){
        const body = await readBodyJson(req, { maxBytes: TURN_REQUEST_MAX_BYTES }).catch((err) => {
          const msg = String(err && err.message || err || '');
          if (msg === 'body_too_large') {
            sendJson(res, 413, { ok: false, error: 'body_too_large', message: 'Request body exceeds 12 MB limit' });
            return '__handled__';
          }
          return null;
        });
        if (body === '__handled__') return;
        const groupId = String(body && body.groupId ? body.groupId : '').trim();
        const text = String(body && body.text ? body.text : '');
        const attachments = normalizeChatAttachments(body && body.attachments);
        if (!groupId){
          sendJson(res, 400, { ok: false, error: 'missing_group_id' });
          return;
        }
        if (!text && attachments.length === 0){
          sendJson(res, 400, { ok: false, error: 'missing_text' });
          return;
        }
        const group = gsLoad(groupId);
        if (!group){
          sendJson(res, 404, { ok: false, error: 'not_found' });
          return;
        }
        const memberByAgentId = new Map();
        for (const member of (Array.isArray(group.members) ? group.members : [])){
          if (!member || !member.agentId) continue;
          memberByAgentId.set(String(member.agentId), member);
        }
        const mentioned = parseExplicitAgentMentions(text).filter((agentId) => memberByAgentId.has(agentId));
        let policy = 'restricted';
        try {
          const rawPol = body && typeof body.policy === 'string' ? body.policy : '';
          const p = String(rawPol || '').trim().toLowerCase();
          if (p === 'open' || p === 'restricted') policy = p;
        } catch {}
        const clientMessageId = body && Object.prototype.hasOwnProperty.call(body, 'clientMessageId')
          ? String(body.clientMessageId == null ? '' : body.clientMessageId).trim()
          : '';

        const userAppend = gsAppendEvent(groupId, {
          type: 'message',
          role: 'user',
          text,
          sender: { type: 'user' },
          source: { kind: 'user_message' },
          routing: {
            mode: 'explicit_mentions',
            mentionedAgentIds: mentioned,
            deliveredAgentIds: mentioned,
            parsedFrom: 'full_text',
          },
          clientMessageId: clientMessageId || undefined,
        });
        if (!userAppend){
          sendJson(res, 500, { ok: false, error: 'group_append_failed' });
          return;
        }
        emitGroupEventAppended(groupId, userAppend.event);

        const replies = [];
        const executedPairKeys = new Set();
        let currentStep = [];
        for (const agentId of mentioned){
          const pairKey = 'user->' + agentId;
          if (executedPairKeys.has(pairKey)) continue;
          executedPairKeys.add(pairKey);
          currentStep.push({ agentId, text, triggerEventId: userAppend.event.id || null });
        }
        let handoffHopCount = 0;
        while (currentStep.length){
          const nextStep = [];
          const nextStepTargets = new Set();
          for (const turn of currentStep){
            const agentId = String(turn && turn.agentId ? turn.agentId : '').trim();
            const turnText = String(turn && Object.prototype.hasOwnProperty.call(turn, 'text') ? turn.text : '');
            const turnMode = String(turn && turn.mode ? turn.mode : 'direct').trim() || 'direct';
            const fromAgentId = String(turn && turn.fromAgentId ? turn.fromAgentId : '').trim();
            const triggerEventId = String(turn && turn.triggerEventId ? turn.triggerEventId : '').trim();
            const handoffHop = Number(turn && turn.hop);
            if (!agentId) continue;
            const member = memberByAgentId.get(agentId);
            if (!member) continue;
            const memberSessionId = String(member.memberSessionId || '').trim();
            const memberSessionKey = String(member.memberSessionKey || memberSessionId).trim() || memberSessionId;
            let replyText = '';
            try {
              const chat = await runChatMessage({
                agentId,
                sessionKey: memberSessionKey,
                sessionId: memberSessionId || null,
                text: turnText,
                policy,
                title: group.title || 'Arcana Group',
                sync: true,
                attachments,
              });
              if (!chat || chat.ok === false){
                const errMsg = chat && chat.message ? String(chat.message) : (chat && chat.error ? String(chat.error) : 'turn_failed');
                replyText = '[error] ' + errMsg;
              } else {
                replyText = String(chat.text || '').trim() || '[no response]';
              }
            } catch (e) {
              replyText = '[error] ' + String(e && e.message ? e.message : e || 'turn_failed');
            }
            const assistantEvent = {
              type: 'message',
              role: 'assistant',
              agentId,
              text: buildGroupAssistantText(agentId, replyText),
            };
            if (turnMode === 'handoff'){
              assistantEvent.sender = { type: 'agent', agentId };
              assistantEvent.source = { kind: 'handoff', fromAgentId };
              if (triggerEventId) assistantEvent.source.triggerEventId = triggerEventId;
              assistantEvent.routing = {
                mode: 'leading_mentions',
                deliveredAgentIds: [agentId],
                parsedFrom: 'leading_mentions',
              };
              assistantEvent.handoff = {
                hop: Number.isFinite(handoffHop) && handoffHop >= 0 ? Math.trunc(handoffHop) : 0,
                fromAgentId,
                toAgentId: agentId,
              };
              if (triggerEventId) assistantEvent.handoff.triggerEventId = triggerEventId;
            } else {
              assistantEvent.sender = { type: 'agent', agentId };
              assistantEvent.source = { kind: 'agent_reply' };
              assistantEvent.routing = {
                mode: 'direct_reply',
                deliveredAgentIds: [agentId],
              };
            }
            const assistantAppend = gsAppendEvent(groupId, assistantEvent);
            if (!assistantAppend) continue;
            emitGroupEventAppended(groupId, assistantAppend.event);
            replies.push({ agentId, text: assistantAppend.event.text });
            if (handoffHopCount >= 3) continue;
            const handoffTargets = parseLeadingAgentMentionsForHandoff(assistantAppend.event.text);
            for (const targetAgentId of handoffTargets){
              if (!memberByAgentId.has(targetAgentId)) continue;
              if (targetAgentId === agentId) continue;
              if (nextStepTargets.has(targetAgentId)) continue;
              const pairKey = agentId + '->' + targetAgentId;
              if (executedPairKeys.has(pairKey)) continue;
              executedPairKeys.add(pairKey);
              nextStepTargets.add(targetAgentId);
              nextStep.push({
                agentId: targetAgentId,
                text: assistantAppend.event.text,
                mode: 'handoff',
                hop: handoffHopCount + 1,
                fromAgentId: agentId,
                triggerEventId: assistantAppend.event.id || null,
              });
            }
          }
          if (!nextStep.length || handoffHopCount >= 3) break;
          currentStep = nextStep;
          handoffHopCount += 1;
        }

        const latest = gsLoad(groupId);
        sendJson(res, 200, { ok: true, group: latest || userAppend.group, replies });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/turn'){
        const body = await readBodyJson(req, { maxBytes: TURN_REQUEST_MAX_BYTES }).catch((err) => {
          const msg = String(err && err.message || err || '');
          if (msg === 'body_too_large') {
            sendJson(res, 413, { ok: false, error: 'body_too_large', message: 'Request body exceeds 12 MB limit' });
            return '__handled__';
          }
          return null;
        });
        if (body === '__handled__') return;
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        const sessionIdRaw = body && body.sessionId ? String(body.sessionId) : '';
        const localToolProxyIntent = !!(body && (body.localToolProxy === true || Object.prototype.hasOwnProperty.call(body, 'toolRouting')));
        const localToolProxy = !!(body && body.localToolProxy);
        const toolRouting = body && body.toolRouting ? body.toolRouting : undefined;
        const toolAllowlist = normalizeToolAllowlist(body && body.toolAllowlist);
        const localToolDefinitions = Array.isArray(body && body.localToolDefinitions) ? body.localToolDefinitions : [];
        const localBootstrapFiles = Array.isArray(body && body.localBootstrapFiles) ? body.localBootstrapFiles : [];
        const localAgentSignature = body && body.localAgentSignature ? String(body.localAgentSignature) : '';
        const systemPromptOverride = typeof (body && body.systemPromptOverride) === 'string' ? body.systemPromptOverride : '';
        const clientTurnId = body && body.clientTurnId ? String(body.clientTurnId).trim() : '';
        const workspaceRoot = normalizeWorkspaceRootOverride(body && (body.workspaceRoot || body.projectRootDir));
        const agentHomeRoot = normalizeAgentHomeRootOverride(body && (body.agentHomeRoot || body.agentHomeDir));
        const text = body && body.text ? String(body.text) : '';
        const attachments = normalizeChatAttachments(body && body.attachments);
        const hasAttachments = attachments.length > 0;
        if (!text && !hasAttachments){
          sendJson(res, 400, { ok: false, error: 'missing_text' });
          return;
        }
        let policy = 'restricted';
        try {
          const rawPol = body && typeof body.policy === 'string' ? body.policy : '';
          const p = String(rawPol || '').trim().toLowerCase();
          if (p === 'open' || p === 'restricted') policy = p;
        } catch {}

        // Default to queued mode so Web turns flow through reactor/wake-agent handling.
        let queued = true;
        let modeEnv = '';
        try {
          if (body && body.queued === false) queued = false;
          modeEnv = String(process.env.ARCANA_GATEWAY_V2_TURN_MODE || '').trim().toLowerCase();
          if (modeEnv === 'direct' || modeEnv === 'sync') queued = false;
          if (modeEnv === 'queued' || modeEnv === 'reactor') queued = true;
        } catch {}
        if (localToolProxyIntent) queued = false;
        localProxyDebugLog('/v2/turn routing', {
          agentId,
          sessionKey,
          sessionIdRaw: sessionIdRaw || null,
          localToolProxyIntent,
          localToolProxy,
          queued,
          modeEnv: modeEnv || null,
          routing: summarizeToolRoutingRoutes(toolRouting),
          toolAllowlist: Array.isArray(toolAllowlist) ? toolAllowlist : [],
          toolAllowlistCount: Array.isArray(toolAllowlist) ? toolAllowlist.length : 0,
          localToolDefinitionsCount: localToolDefinitions.length,
          localToolDefinitionNames: localToolDefinitions.map((item) => String(item && item.name || '').trim()).filter(Boolean),
          localBootstrapFiles: localBootstrapFiles.map((item) => String(item && item.name || '').trim()).filter(Boolean),
          localAgentSignature: String(localAgentSignature || '').trim(),
          workspaceRoot: workspaceRoot || null,
          agentHomeRoot: agentHomeRoot || null,
        });
        if (queued){
          try {
            const ws = workspaceRoot || resolveWorkspaceRoot();
            const ensuredId = await ensureSessionId({ sessionId: sessionIdRaw || '', sessionKey, title: 'Arcana Web', agentId, workspaceRoot: ws });
            const sessionId = String(ensuredId || '').trim() || null;
            if (!hasAttachments) {
              try {
                const steer = await requestTurnSteer({ agentId, sessionKey, sessionId, text });
                if (steer && steer.ok){
                  sendJson(res, 200, { ok: true, sessionId, mode: 'steer', eventId: null });
                  return;
                }
              } catch {}
            }
            const ev = await inbox.ingestEvent({
              agentId,
              sessionKey,
              type: 'message',
              source: 'api.turn',
              data: { text, policy, sessionId, attachments: hasAttachments ? attachments : undefined },
            });
            try {
              scheduler.requestWake({ agentId, sessionKey, reason: 'turn.queued', priority: 0, delayMs: 0 });
            } catch {}
            sendJson(res, 200, { ok: true, sessionId, mode: 'queued', eventId: ev && ev.eventId ? ev.eventId : null });
            return;
          } catch (e) {
            sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
            return;
          }
        }

        const chat = await runChatMessage({ agentId, sessionKey, sessionId: sessionIdRaw || null, workspaceRoot, agentHomeRoot, text, policy, title: 'Arcana Web', sync: false, toolRouting, localToolProxy, toolAllowlist, localToolDefinitions, localBootstrapFiles, localAgentSignature, systemPromptOverride, clientTurnId, attachments });
        if (!chat || chat.ok === false){
          const errMsg = chat && chat.error ? String(chat.error) : 'turn_failed';
          const status = chat && typeof chat.status === 'number' ? chat.status : 500;
          const message = chat && typeof chat.message === 'string' ? chat.message : undefined;
          try {
            const ev = {
              type: 'error',
              agentId,
              sessionId: chat && chat.sessionId ? chat.sessionId : (sessionIdRaw || null),
              message: errMsg,
            };
            eventBus.emit('event', ev);
          } catch {}
          const body = { ok: false, error: errMsg };
          if (message) body.message = message;
          sendJson(res, status, body);
          return;
        }
        sendJson(res, 200, {
          ok: true,
          sessionId: chat.sessionId,
          mode: chat.mode || 'turn',
          ...(typeof chat.text === 'string' ? { text: chat.text } : {}),
          ...(Object.prototype.hasOwnProperty.call(chat, 'warning') && chat.warning != null ? { warning: chat.warning } : {}),
          ...(Object.prototype.hasOwnProperty.call(chat, 'logPath') && chat.logPath ? { logPath: chat.logPath } : {}),
          ...(Object.prototype.hasOwnProperty.call(chat, 'error') && chat.error ? { error: chat.error } : {}),
          ...(chat.usage ? { usage: chat.usage } : {}),
        });
        return;
      }

      if (method === 'POST' && u.pathname === '/v2/turn-sync'){
        const body = await readBodyJson(req, { maxBytes: TURN_REQUEST_MAX_BYTES }).catch((err) => {
          const msg = String(err && err.message || err || '');
          if (msg === 'body_too_large') {
            sendJson(res, 413, { ok: false, error: 'body_too_large', message: 'Request body exceeds 12 MB limit' });
            return '__handled__';
          }
          return null;
        });
        if (body === '__handled__') return;
        const agentId = body && body.agentId ? String(body.agentId) : 'default';
        const sessionKey = body && body.sessionKey ? String(body.sessionKey) : 'session';
        const sessionIdRaw = body && body.sessionId ? String(body.sessionId) : '';
        const localToolProxyIntent = !!(body && (body.localToolProxy === true || Object.prototype.hasOwnProperty.call(body, 'toolRouting')));
        const localToolProxy = !!(body && body.localToolProxy);
        const toolRouting = body && body.toolRouting ? body.toolRouting : undefined;
        const toolAllowlist = normalizeToolAllowlist(body && body.toolAllowlist);
        const localToolDefinitions = Array.isArray(body && body.localToolDefinitions) ? body.localToolDefinitions : [];
        const localBootstrapFiles = Array.isArray(body && body.localBootstrapFiles) ? body.localBootstrapFiles : [];
        const localAgentSignature = body && body.localAgentSignature ? String(body.localAgentSignature) : '';
        const systemPromptOverride = typeof (body && body.systemPromptOverride) === 'string' ? body.systemPromptOverride : '';
        const clientTurnId = body && body.clientTurnId ? String(body.clientTurnId).trim() : '';
        const workspaceRoot = normalizeWorkspaceRootOverride(body && (body.workspaceRoot || body.projectRootDir));
        const agentHomeRoot = normalizeAgentHomeRootOverride(body && (body.agentHomeRoot || body.agentHomeDir));
        const text = body && body.text ? String(body.text) : '';
        const attachments = normalizeChatAttachments(body && body.attachments);
        const hasAttachments = attachments.length > 0;
        if (!text && !hasAttachments){
          sendJson(res, 400, { ok: false, error: 'missing_text' });
          return;
        }
        let policy = 'restricted';
        try {
          const rawPol = body && typeof body.policy === 'string' ? body.policy : '';
          const p = String(rawPol || '').trim().toLowerCase();
          if (p === 'open' || p === 'restricted') policy = p;
        } catch {}

        // Optional queued mode: persist message to inbox and let the scheduler/engine run it.
        // This is more resilient to transient model/network failures because the turn becomes retryable.
        let queued = false;
        let modeEnv = '';
        try {
          if (body && body.queued === true) queued = true;
          modeEnv = String(process.env.ARCANA_GATEWAY_V2_TURN_MODE || '').trim().toLowerCase();
          if (modeEnv === 'queued' || modeEnv === 'reactor') queued = true;
        } catch {}
        if (localToolProxyIntent) queued = false;
        localProxyDebugLog('/v2/turn-sync routing', {
          agentId,
          sessionKey,
          sessionIdRaw: sessionIdRaw || null,
          localToolProxyIntent,
          localToolProxy,
          queued,
          modeEnv: modeEnv || null,
          routing: summarizeToolRoutingRoutes(toolRouting),
          toolAllowlist: Array.isArray(toolAllowlist) ? toolAllowlist : [],
          toolAllowlistCount: Array.isArray(toolAllowlist) ? toolAllowlist.length : 0,
          localToolDefinitionsCount: localToolDefinitions.length,
          localToolDefinitionNames: localToolDefinitions.map((item) => String(item && item.name || '').trim()).filter(Boolean),
          workspaceRoot: workspaceRoot || null,
          agentHomeRoot: agentHomeRoot || null,
        });
        if (queued){
          try {
            const ws = workspaceRoot || resolveWorkspaceRoot();
            const ensuredId = await ensureSessionId({ sessionId: sessionIdRaw || '', sessionKey, title: 'Arcana Web', agentId, workspaceRoot: ws });
            const sessionId = String(ensuredId || '').trim() || null;
            const ev = await inbox.ingestEvent({
              agentId,
              sessionKey,
              type: 'message',
              source: 'api.turn',
              data: { text, policy, sessionId, attachments: hasAttachments ? attachments : undefined },
            });
            try {
              scheduler.requestWake({ agentId, sessionKey, reason: 'turn.queued', priority: 0, delayMs: 0 });
            } catch {}
            sendJson(res, 200, { ok: true, sessionId, mode: 'queued', eventId: ev && ev.eventId ? ev.eventId : null });
            return;
          } catch (e) {
            sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
            return;
          }
        }

        const chat = await runChatMessage({ agentId, sessionKey, sessionId: sessionIdRaw || null, workspaceRoot, agentHomeRoot, text, policy, title: 'Arcana Web', sync: true, toolRouting, localToolProxy, toolAllowlist, localToolDefinitions, localBootstrapFiles, localAgentSignature, systemPromptOverride, clientTurnId, attachments });
        if (!chat || chat.ok === false){
          const status = chat && typeof chat.status === 'number' ? chat.status : 500;
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
          if (chat && typeof chat.message === 'string'){
            respBody.message = chat.message;
          }
          sendJson(res, status, respBody);
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

      if (method === 'GET' && u.pathname === '/api/group-sessions'){
        try {
          const workspace = String(u.searchParams.get('workspace') || '').trim();
          const groups = gsList({ workspace });
          sendJson(res, 200, { groups });
        } catch (e) {
          sendJson(res, 500, { error: 'group_list_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/group-sessions'){
        try {
          const body = await readBodyJson(req).catch(() => ({}));
          const title = String(body && body.title != null ? body.title : '').trim();
          const workspace = String(body && body.workspace != null ? body.workspace : '').trim();
          const rawMembers = Array.isArray(body && body.members) ? body.members : [];
          const members = [];
          const seen = new Set();
          for (const item of rawMembers){
            const agentId = normalizeAgentId(item);
            if (!agentId || seen.has(agentId)) continue;
            const meta = ensureAgentMetaForGroup(agentId);
            if (!meta || !meta.workspaceRoot) continue;
            const memberSession = ssCreate({ title: '', workspace, agentId, hidden: true });
            members.push({
              agentId,
              memberSessionId: memberSession.id,
              memberSessionKey: memberSession.id,
            });
            seen.add(agentId);
          }
          if (!members.length){
            sendJson(res, 400, { error: 'members_required' });
            return;
          }
          const obj = gsCreate({ title, workspace, members, events: [] });
          sendJson(res, 200, obj);
        } catch (e) {
          sendJson(res, 500, { error: 'group_create_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (u.pathname.startsWith('/api/group-sessions/')){
        const id = u.pathname.slice('/api/group-sessions/'.length);
        if (method === 'GET'){
          try {
            const obj = gsLoad(String(id || '').trim());
            if (!obj){
              sendJson(res, 404, { error: 'not_found' });
              return;
            }
            sendJson(res, 200, obj);
          } catch (e) {
            sendJson(res, 500, { error: 'group_get_failed', message: e && e.message ? String(e.message) : String(e || '') });
          }
          return;
        }
        if (method === 'DELETE'){
          try {
            let decoded = '';
            try { decoded = decodeURIComponent(String(id || '').trim()); }
            catch { decoded = String(id || '').trim(); }
            const existing = gsLoad(decoded);
            if (!existing){
              sendJson(res, 404, { error: 'not_found' });
              return;
            }
            for (const member of (Array.isArray(existing.members) ? existing.members : [])){
              try {
                ssDelete(String(member && member.memberSessionId ? member.memberSessionId : '').trim(), { agentId: member && member.agentId ? member.agentId : DEFAULT_AGENT_ID });
              } catch {}
            }
            const ok = gsDelete(decoded);
            if (!ok){
              sendJson(res, 404, { error: 'not_found' });
              return;
            }
            sendJson(res, 200, { ok: true });
          } catch (e) {
            sendJson(res, 500, { error: 'group_delete_failed', message: e && e.message ? String(e.message) : String(e || '') });
          }
          return;
        }
      }

      if (method === 'POST' && u.pathname === '/api/sessions'){
        try {
          const body = await readBodyJson(req).catch(() => ({}));
          const title = String(body && body.title != null ? body.title : '').trim();
          const workspace = String(body && body.workspace != null ? body.workspace : '').trim();
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

          const obj = ssCreate({ title, workspace, agentId });
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
          // Invalidate sessions for this agent after deletes to ensure new keys apply.
          try { await invalidateChatSessions({ agentId }); } catch {}
          try { await invalidateRuntimeSessions({ agentId }); } catch {}
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
          // Invalidate sessions depending on scope: global => all, agent => only for that agent.
          try {
            if (scope === 'global') {
              await invalidateChatSessions();
              await invalidateRuntimeSessions();
            } else {
              await invalidateChatSessions({ agentId });
              await invalidateRuntimeSessions({ agentId });
            }
          } catch {}
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
          // Global reset impacts all agents; invalidate all chat sessions.
          try { await invalidateChatSessions(); } catch {}
          try { await invalidateRuntimeSessions(); } catch {}
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
          const out = sanitizeConfig(cfg || {}) || {};

          // Best-effort: reflect whether a provider key exists in the Secrets vault.
          // (UI should not rely on plaintext `key` in config.json.)
          try {
            const prov = String(out.provider || '').trim().toLowerCase();
            if (prov) {
              const name = providerApiKeyName(prov);
              if (name) {
                const { bindings } = await secrets.listNames('');
                const b = bindings && bindings[name];
                if (b && b.hasGlobal) out.has_key = true;
              }
            }
          } catch {}

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
          const envCfg = String(process.env.ARCANA_CONFIG || '').trim();
          let pathCfg = '';
          if (envCfg) pathCfg = envCfg;
          else {
            ensureArcanaHomeDir();
            pathCfg = arcanaHomePath('config.json');
          }

          let nextCfg = {};
          try {
            if (existsSync(pathCfg)){
              const rawExisting = readFileSync(pathCfg, 'utf-8');
              const parsed = JSON.parse(rawExisting);
              if (parsed && typeof parsed === 'object') nextCfg = parsed;
            }
          } catch {}

          // provider/model/base_url: if present and empty, delete; if present and non-empty, set.
          applyStringConfigField(nextCfg, body, 'provider', { allowDeleteOnEmpty: true });
          applyStringConfigField(nextCfg, body, 'model', { allowDeleteOnEmpty: true });
          applyStringConfigField(nextCfg, body, 'base_url', { allowDeleteOnEmpty: true });
          applyStringConfigField(nextCfg, body, 'openai_api_version', { allowDeleteOnEmpty: true });
          applyStringConfigField(nextCfg, body, 'azure_api_version', { allowDeleteOnEmpty: true });
          applyStringConfigField(nextCfg, body, 'azure_deployment_name_map', { allowDeleteOnEmpty: true });

          // API key: store in Secrets (encrypted) instead of config.json
          try {
            const hasKeyField = Object.prototype.hasOwnProperty.call(body, 'key');
            const keyRaw = hasKeyField ? String(body.key || '').trim() : '';
            if (keyRaw) {
              const prov = String(body.provider || nextCfg.provider || '').trim().toLowerCase();
              if (!prov) {
                sendJson(res, 400, { error: 'provider_required_for_key', message: 'provider is required to store API key in Secrets' });
                return;
              }
              const name = providerApiKeyName(prov);
              if (!name) {
                sendJson(res, 400, { error: 'invalid_provider', message: 'Unsupported provider for Secrets key storage' });
                return;
              }
              try {
                await secrets.setText(name, keyRaw, 'global', '');
                // Remove legacy inline key fields so they never get written back.
                try { delete nextCfg.key; delete nextCfg.api_key; delete nextCfg.apiKey; } catch {}
              } catch (e) {
                const code = e && e.code;
                if (code === 'VAULT_UNINITIALIZED') { sendJson(res, 409, { error: 'vault_uninitialized' }); return; }
                if (code === 'VAULT_LOCKED') { sendJson(res, 423, { error: 'vault_locked' }); return; }
                sendJson(res, 400, { error: 'secrets_set_failed', message: e && e.message ? String(e.message) : String(e || '') });
                return;
              }
            }
          } catch {}

          // Never persist plaintext API keys in config.json when a Secrets binding exists.
          try {
            const prov = String(nextCfg.provider || '').trim().toLowerCase();
            if (prov) {
              const name = providerApiKeyName(prov);
              if (name) {
                const { bindings } = await secrets.listNames('');
                const b = bindings && bindings[name];
                if (b && b.hasGlobal) {
                  try { delete nextCfg.key; delete nextCfg.api_key; delete nextCfg.apiKey; } catch {}
                }
              }
            }
          } catch {}

          // Optional history compression settings (non-secret)
          try {
            if (Object.prototype.hasOwnProperty.call(body, 'history_compression_enabled')) {
              const enabledRaw = body.history_compression_enabled;
              let enabledVal;
              if (typeof enabledRaw === 'boolean') {
                enabledVal = enabledRaw;
              } else if (enabledRaw != null) {
                const s = String(enabledRaw).trim().toLowerCase();
                if (s) {
                  if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'none' || s === 'null') enabledVal = false;
                  else if (s === '1' || s === 'true' || s === 'yes' || s === 'on') enabledVal = true;
                }
              }
              if (typeof enabledVal === 'boolean') nextCfg.history_compression_enabled = enabledVal;
            }
          } catch {}

          try {
            if (Object.prototype.hasOwnProperty.call(body, 'history_compression_threshold_tokens')) {
              const raw = body.history_compression_threshold_tokens;
              const num = Number(raw);
              if (Number.isFinite(num) && num > 0) {
                nextCfg.history_compression_threshold_tokens = Math.floor(num);
              }
            }
          } catch {}

          try {
            if (Object.prototype.hasOwnProperty.call(body, 'history_compression_keep_user_turns')) {
              const raw = body.history_compression_keep_user_turns;
              const num = Number(raw);
              if (Number.isFinite(num) && num > 0) {
                nextCfg.history_compression_keep_user_turns = Math.floor(num);
              }
            }
          } catch {}


          try {
            if (Object.prototype.hasOwnProperty.call(body, 'history_compression_compact_instructions')) {
              const raw = body.history_compression_compact_instructions;
              const str = (raw == null) ? '' : String(raw);
              if (str.trim()) nextCfg.history_compression_compact_instructions = str;
              else { try { delete nextCfg.history_compression_compact_instructions; } catch {} }
            }
          } catch {}

          await fsp.writeFile(pathCfg, JSON.stringify(nextCfg, null, 2), 'utf-8');

          // Invalidate all chat sessions after global config/provider key updates.
          try { await invalidateChatSessions(); } catch {}
          try { await invalidateRuntimeSessions(); } catch {}

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
          const globalCfg = loadArcanaConfig();
          const rawAgentCfg = loadAgentConfig(agentHomeDir);
          const mergedCfg = mergeAgentConfigForGateway(globalCfg, rawAgentCfg);
          const cfgPath = join(agentHomeDir, 'config.json');
          if (!mergedCfg.path) mergedCfg.path = cfgPath;
          const out = sanitizeConfig(mergedCfg) || { provider: '', base_url: '', model: '', path: cfgPath, has_key: false };

          // Best-effort: reflect whether an API key exists in Secrets for the resolved provider.
          try {
            const prov = String(out.provider || '').trim().toLowerCase();
            if (prov) {
              const nameAgent = agentProviderApiKeyName(agentId, prov);
              const nameGlobal = providerApiKeyName(prov);
              const { bindings } = await secrets.listNames(agentHomeDir);
              const bAgent = nameAgent ? (bindings && bindings[nameAgent]) : null;
              const bGlobal = nameGlobal ? (bindings && bindings[nameGlobal]) : null;
              if ((bAgent && bAgent.hasAgent) || (bGlobal && (bGlobal.hasAgent || bGlobal.hasGlobal))) {
                out.has_key = true;
              }
            }
          } catch {}

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
            const baseDir = String(agentHomeDir || '').trim();
            if (baseDir){
              try { mkdirSync(baseDir, { recursive: true }); } catch {}

              let nextCfg = {};
              try {
                if (existsSync(cfgPath)){
                  const rawExisting = readFileSync(cfgPath, 'utf-8');
                  const parsed = JSON.parse(rawExisting);
                  if (parsed && typeof parsed === 'object') nextCfg = parsed;
                }
              } catch {}

              // provider/model/base_url: if present and empty, delete; if present and non-empty, set.
              applyStringConfigField(nextCfg, body, 'provider', { allowDeleteOnEmpty: true });
              applyStringConfigField(nextCfg, body, 'model', { allowDeleteOnEmpty: true });
              applyStringConfigField(nextCfg, body, 'base_url', { allowDeleteOnEmpty: true });
              applyStringConfigField(nextCfg, body, 'openai_api_version', { allowDeleteOnEmpty: true });
              applyStringConfigField(nextCfg, body, 'azure_api_version', { allowDeleteOnEmpty: true });
              applyStringConfigField(nextCfg, body, 'azure_deployment_name_map', { allowDeleteOnEmpty: true });

              // API key: store in Secrets (encrypted) instead of config.json
              try {
                const hasKeyField = Object.prototype.hasOwnProperty.call(body, 'key');
                const keyRaw = hasKeyField ? String(body.key || '').trim() : '';
                if (keyRaw) {
                  const prov = String(body.provider || nextCfg.provider || '').trim().toLowerCase();
                  if (!prov) {
                    sendJson(res, 400, { error: 'provider_required_for_key', message: 'provider is required to store API key in Secrets' });
                    return;
                  }
                  const name = agentProviderApiKeyName(agentId, prov);
                  if (!name) {
                    sendJson(res, 400, { error: 'invalid_provider', message: 'Unsupported provider for Secrets key storage' });
                    return;
                  }
                  try {
                    await secrets.setText(name, keyRaw, 'agent', agentHomeDir);
                    // Remove legacy inline key fields so they never get written back.
                    try { delete nextCfg.key; delete nextCfg.api_key; delete nextCfg.apiKey; } catch {}
                  } catch (e) {
                    const code = e && e.code;
                    if (code === 'VAULT_UNINITIALIZED') { sendJson(res, 409, { error: 'vault_uninitialized' }); return; }
                    if (code === 'VAULT_LOCKED') { sendJson(res, 423, { error: 'vault_locked' }); return; }
                    sendJson(res, 400, { error: 'secrets_set_failed', message: e && e.message ? String(e.message) : String(e || '') });
                    return;
                  }
                }
              } catch {}

              // Never persist plaintext API keys in config.json when a Secrets binding exists.
              try {
                const prov = String(nextCfg.provider || '').trim().toLowerCase();
                if (prov) {
                  const name = agentProviderApiKeyName(agentId, prov);
                  if (name) {
                    const { bindings } = await secrets.listNames(agentHomeDir);
                    const b = bindings && bindings[name];
                    if (b && b.hasAgent) {
                      try { delete nextCfg.key; delete nextCfg.api_key; delete nextCfg.apiKey; } catch {}
                    }
                  }
                }
              } catch {}

              // Optional history compression settings (non-secret)
              try {
                if (Object.prototype.hasOwnProperty.call(body, 'history_compression_enabled')) {
                  const enabledRaw = body.history_compression_enabled;
                  let enabledVal;
                  if (typeof enabledRaw === 'boolean') {
                    enabledVal = enabledRaw;
                  } else if (enabledRaw != null) {
                    const s = String(enabledRaw).trim().toLowerCase();
                    if (s) {
                      if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'none' || s === 'null') enabledVal = false;
                      else if (s === '1' || s === 'true' || s === 'yes' || s === 'on') enabledVal = true;
                    }
                  }
                  if (typeof enabledVal === 'boolean') nextCfg.history_compression_enabled = enabledVal;
                }
              } catch {}

              try {
                if (Object.prototype.hasOwnProperty.call(body, 'history_compression_threshold_tokens')) {
                  const raw = body.history_compression_threshold_tokens;
                  const num = Number(raw);
                  if (Number.isFinite(num) && num > 0) {
                    nextCfg.history_compression_threshold_tokens = Math.floor(num);
                  }
                }
              } catch {}

              try {
                if (Object.prototype.hasOwnProperty.call(body, 'history_compression_keep_user_turns')) {
                  const raw = body.history_compression_keep_user_turns;
                  const num = Number(raw);
                  if (Number.isFinite(num) && num > 0) {
                    nextCfg.history_compression_keep_user_turns = Math.floor(num);
                  }
                }
              } catch {}


              try {
                if (Object.prototype.hasOwnProperty.call(body, 'history_compression_compact_instructions')) {
                  const raw = body.history_compression_compact_instructions;
                  const str = (raw == null) ? '' : String(raw);
                  if (str.trim()) nextCfg.history_compression_compact_instructions = str;
                  else { try { delete nextCfg.history_compression_compact_instructions; } catch {} }
                }
              } catch {}

              await fsp.writeFile(cfgPath, JSON.stringify(nextCfg, null, 2), 'utf-8');
            }
          }

          // Invalidate chat sessions for this agent so provider/key changes apply immediately.
          try { await invalidateChatSessions({ agentId }); } catch {}
          try { await invalidateRuntimeSessions({ agentId }); } catch {}

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

      if (method === 'GET' && u.pathname === '/api/skills'){
        try {
          const agentIdParam = String(u.searchParams.get('agentId') || '').trim();
          const agentId = agentIdParam || DEFAULT_AGENT_ID;
          const meta = findAgentMetaGateway(agentId) || (agentId === DEFAULT_AGENT_ID ? ensureDefaultAgentExistsGateway() : null);
          const baseHome = meta && (meta.agentHomeDir || meta.agentDir) ? (meta.agentHomeDir || meta.agentDir) : arcanaHomePath('agents', agentId);
          const agentHomeDir = baseHome || arcanaHomePath('agents', agentId);
          const globalCfg = loadArcanaConfig();
          const agentCfg = loadAgentConfig(agentHomeDir);
          const mergedCfg = mergeAgentConfigForGateway(globalCfg, agentCfg);

          let ws = '';
          try {
            if (meta && meta.workspaceRoot) ws = String(meta.workspaceRoot || '');
          } catch {}
          if (!ws){
            try { ws = resolveWorkspaceRoot(); } catch { ws = process.cwd(); }
          }

          let skills = [];
          try {
            skills = loadArcanaSkills({ workspaceRoot: ws, agentHomeRoot: agentHomeDir, cfg: mergedCfg, pkgRoot: PKG_ROOT, repoRoot: REPO_ROOT }) || [];
          } catch {}

          let toolNames = [];
          try {
            let created = null;
            await runWithContext(
              { sessionId: `gateway-v2:skills:${agentId}`, agentId, agentHomeRoot: agentHomeDir, workspaceRoot: ws },
              async () => {
                created = await createArcanaSession({ workspaceRoot: ws, agentHomeRoot: agentHomeDir, agentId, execPolicy: 'restricted', bootstrapContextMode: 'lightweight' });
              },
            );
            toolNames = Array.isArray(created && created.availableToolNames) ? created.availableToolNames.slice() : [];
            try {
              const sess = created && created.session;
              if (sess && typeof sess.abort === 'function'){
                const p = sess.abort();
                if (p && typeof p.catch === 'function') p.catch(() => {});
              }
            } catch {}
          } catch {}

          const outSkills = [];
          for (const s of skills){
            try {
              const name = String(s && s.name || '').trim();
              if (!name) continue;
              const item = { name };
              try {
                if (s && s.filePath){
                  item.filePath = String(s.filePath || '');
                }
              } catch {}
              outSkills.push(item);
            } catch {}
          }

          const outTools = [];
          for (const raw of toolNames){
            try {
              const name = String(raw || '').trim();
              if (!name) continue;
              outTools.push({ name });
            } catch {}
          }

          const disabledArr = agentCfg && agentCfg.skills && Array.isArray(agentCfg.skills.disabled) ? agentCfg.skills.disabled : [];
          const disabled = [];
          try {
            const seen = new Set();
            for (const raw of disabledArr || []){
              if (typeof raw !== 'string') continue;
              const n = raw.trim();
              if (!n || seen.has(n)) continue;
              seen.add(n);
              disabled.push(n);
            }
          } catch {}

          const disabledToolsArr = agentCfg && agentCfg.tools && Array.isArray(agentCfg.tools.disabled) ? agentCfg.tools.disabled : [];
          const disabledTools = [];
          try {
            const seen = new Set();
            for (const raw of disabledToolsArr || []){
              if (typeof raw !== 'string') continue;
              const n = raw.trim();
              if (!n || seen.has(n)) continue;
              seen.add(n);
              disabledTools.push(n);
            }
          } catch {}

          sendJson(res, 200, { ok: true, skills: outSkills, disabled, tools: outTools, disabledTools });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: 'skills_list_failed', message: e && e.message ? String(e.message) : String(e || '') });
        }
        return;
      }

      if (method === 'POST' && u.pathname === '/api/skills'){
        try {
          const body = await readBodyJson(req).catch(() => null);
          if (!body || typeof body !== 'object'){
            sendJson(res, 400, { ok: false, error: 'invalid_json' });
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

          const hasDisabled = Object.prototype.hasOwnProperty.call(body, 'disabled');
          const hasDisabledTools = Object.prototype.hasOwnProperty.call(body, 'disabledTools');
          let disabled = [];
          if (hasDisabled){
            try {
              const src = Array.isArray(body.disabled) ? body.disabled : [];
              const seen = new Set();
              for (const raw of src){
                if (typeof raw !== 'string') continue;
                const n = raw.trim();
                if (!n || seen.has(n)) continue;
                seen.add(n);
                disabled.push(n);
              }
            } catch {}
          }
          let disabledTools = [];
          if (hasDisabledTools){
            try {
              const src = Array.isArray(body.disabledTools) ? body.disabledTools : [];
              const seen = new Set();
              for (const raw of src){
                if (typeof raw !== 'string') continue;
                const n = raw.trim();
                if (!n || seen.has(n)) continue;
                seen.add(n);
                disabledTools.push(n);
              }
            } catch {}
          }

          const baseDir = String(agentHomeDir || '').trim();
          if (baseDir){
            try { mkdirSync(baseDir, { recursive: true }); } catch {}

            let cfg = {};
            try {
              if (existsSync(cfgPath)){
                const rawExisting = readFileSync(cfgPath, 'utf-8');
                const parsed = JSON.parse(rawExisting);
                if (parsed && typeof parsed === 'object') cfg = parsed;
              }
            } catch {}

            if (hasDisabled){
              if (disabled.length){
                const skillsCfg = cfg.skills && typeof cfg.skills === 'object' ? cfg.skills : {};
                skillsCfg.disabled = disabled;
                cfg.skills = skillsCfg;
              } else {
                if (cfg.skills && typeof cfg.skills === 'object'){
                  try { delete cfg.skills.disabled; } catch {}
                  try {
                    if (!Object.keys(cfg.skills).length){
                      delete cfg.skills;
                    }
                  } catch {}
                }
              }
            }

            if (hasDisabledTools){
              if (disabledTools.length){
                const toolsCfg = cfg.tools && typeof cfg.tools === 'object' ? cfg.tools : {};
                toolsCfg.disabled = disabledTools;
                cfg.tools = toolsCfg;
              } else {
                if (cfg.tools && typeof cfg.tools === 'object'){
                  try { delete cfg.tools.disabled; } catch {}
                  try {
                    if (!Object.keys(cfg.tools).length){
                      delete cfg.tools;
                    }
                  } catch {}
                }
              }
            }

            await fsp.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
          }

          try {
            await refreshGatewayServerInfo();
            const ev = buildServerInfoEvent();
            if (ev) {
              try { eventBus.emit('event', ev); } catch {}
            }
          } catch {}

          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: 'skills_update_failed', message: e && e.message ? String(e.message) : String(e || '') });
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

      if (method === 'GET' && u.pathname === '/api/thinking-output'){
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
          const idxRaw = u.searchParams.get('turnIndex');
          const agentId = agentIdParam || DEFAULT_AGENT_ID;
          const idxNum = Number(idxRaw);
          const turnIndex = (Number.isFinite(idxNum) && idxNum >= 0) ? Math.floor(idxNum) : NaN;
          if (!sessionId || Number.isNaN(turnIndex)){
            sendJson(res, 400, { ok: false, error: 'missing_params' });
            return;
          }

          const bundle = readThinkingBundle({ agentId, sessionId, turnIndex });
          if (!bundle || (!bundle.meta && !bundle.thinking)){
            sendJson(res, 404, { ok: false, error: 'not_found' });
            return;
          }
          sendJson(res, 200, { ok: true, meta: bundle.meta || null, thinking: bundle.thinking || '', truncated: !!bundle.truncated });
        } catch (e) {
          try { console.error('[arcana:gateway-v2] /api/thinking-output error', e && e.stack ? e.stack : e); } catch {}
          sendJson(res, 500, { ok: false, error: 'thinking_output_failed' });
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
  }));

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    let agentId = '';
    let sessionKey = '';
    let sessionId = '';
    let groupId = '';
    let threadKind = 'session';
    let clientId = '';
    let receiveAll = false;
    try {
      const url = req && req.url ? req.url : '';
      const u = new URL(url, 'http://localhost');
      agentId = String(u.searchParams.get('agentId') || '').trim();
      sessionKey = String(u.searchParams.get('sessionKey') || '').trim();
      sessionId = String(u.searchParams.get('sessionId') || '').trim();
      groupId = String(u.searchParams.get('groupId') || '').trim();
      threadKind = String(u.searchParams.get('threadKind') || '').trim() === 'group' ? 'group' : 'session';
      clientId = String(u.searchParams.get('clientId') || '').trim();
      receiveAll = String(u.searchParams.get('receiveAll') || '').trim() === '1';
    } catch {}
    wsHub.addClient(ws, { agentId, sessionKey, sessionId, groupId, threadKind, clientId, receiveAll });
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = req && req.url ? req.url : '';
      const u = new URL(url, 'http://localhost');
      if (u.pathname !== '/v2/stream'){
        socket.destroy();
        return;
      }
      if (!bypassTokenAuth && !isAuthorizedRequest(req, apiToken)){
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
