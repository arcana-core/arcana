import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createArcanaSession } from '../src/session.js';
import { eventBus, runWithContext } from '../src/event-bus.js';
import { resolveWorkspaceRoot, ensureReadAllowed, ensureWriteAllowed, resetWorkspaceRootCache } from '../src/workspace-guard.js';
import { runDoctor } from '../src/doctor.js';
import { createSupportBundle } from '../src/support-bundle.js';
import { loadArcanaConfig } from '../src/config.js';
import {
  createSession as ssCreate,
  listSessions as ssList,
  loadSession as ssLoad,
  appendMessage as ssAppend,
  deleteSession as ssDelete,
  buildHistoryPreludeText as ssPrelude,
  saveSession as ssSave,
} from '../src/sessions-store.js';
import { arcanaHomePath, ensureArcanaHomeDir } from '../src/arcana-home.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..'); // arcana/
let workspaceRoot = null; // set on start

// Legacy per-policy sessions used by /api/chat
const sessionsByPolicy = new Map();
let pluginFiles = [];
let toolNames = [];
let model;

// Per-session (id+policy+cwd) sessions used by /api/chat2
const chatSessions = new Map();
const bridgedById = new WeakSet();

// Per-session state for event aggregation
const toolRepeatById = new Map(); // sessionId -> Map(key -> count)
const thinkStatsById = new Map(); // sessionId -> { startedAt, chars }

// Legacy global state (used by /api/chat)
const bridgedSessions = new WeakSet();
const toolRepeat = new Map();
let thinkStats = null;

// SSE clients
const clients = new Set(); // Response objects
let subagentHooked = false;

function applyExecPolicyToSession(sess, policy) {
  try {
    const desired = new Set(sess.getActiveToolNames?.() || []);
    ['read', 'grep', 'find', 'ls'].forEach((t) => desired.add(t));
    if (String(policy || '').toLowerCase() === 'open') desired.add('bash');
    else desired.delete('bash');
    desired.delete('edit');
    desired.delete('write');
    const list = Array.from(desired);
    sess.setActiveToolsByName?.(list);
    toolNames = list;
  } catch {}
}

async function ensurePolicySession(policy) {
  const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
  if (sessionsByPolicy.has(pol)) return sessionsByPolicy.get(pol);
  const created = await createArcanaSession({ cwd: workspaceRoot, execPolicy: pol });
  const sess = created.session;
  sessionsByPolicy.set(pol, sess);
  pluginFiles = created.pluginFiles || pluginFiles || [];
  toolNames = created.toolNames || toolNames || [];
  model = created.model || model || null;
  ensureEventBridge(sess);
  return sess;
}

async function ensureSessionFor(sessionId, policy, cwdForSession) {
  const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
  const wsKey = String(cwdForSession || workspaceRoot || '');
  const key = String(sessionId || 'default') + '|' + pol + '|' + wsKey;
  if (chatSessions.has(key)) return chatSessions.get(key);
  const created = await createArcanaSession({ cwd: cwdForSession || workspaceRoot, execPolicy: pol });
  const sess = created.session;
  chatSessions.set(key, sess);
  ensureEventBridgeForId(sess, sessionId);
  return sess;
}

function ensureEventBridgeForId(sess, sessionId) {
  if (!sess || bridgedById.has(sess)) return;
  bridgedById.add(sess);
  // Hook subagent event bus once so codex/subagent streaming logs also reach SSE listeners
  if (!subagentHooked) {
    subagentHooked = true;
    try {
      eventBus.on('event', (ev) => {
        broadcast(ev);
      });
    } catch {}
  }
  sess.subscribe((ev) => {
    try {
      // Tool repeat aggregation (per-session)
      if (ev.type === 'tool_execution_start') {
        try {
          const key = ev.toolName + '|' + (function (o) {
            try { return JSON.stringify(o, Object.keys(o).sort()); } catch { try { return JSON.stringify(o); } catch { return String(o); } }
          })(ev.args || {});
          const map = toolRepeatById.get(sessionId) || new Map();
          const n = (map.get(key) || 0) + 1; map.set(key, n); toolRepeatById.set(sessionId, map);
          if (n > 1) broadcast({ type: 'tool_repeat', toolName: ev.toolName, args: ev.args || {}, count: n, sessionId });
        } catch {}
        // Forward original start event with sessionId for filtering on the client
        broadcast({ type: 'tool_execution_start', toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args || {}, sessionId });
      }

      // Forward updates/ends tagged with sessionId
      if (ev.type === 'tool_execution_update') {
        try { broadcast({ type: 'tool_execution_update', toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args || {}, partialResult: ev.partialResult, sessionId }); } catch {}
      }
      if (ev.type === 'tool_execution_end') {
        try { broadcast({ type: 'tool_execution_end', toolCallId: ev.toolCallId, toolName: ev.toolName, result: ev.result, isError: ev.isError, error: ev.error, sessionId }); } catch {}
      }

      // Turn lifecycle
      if (ev.type === 'turn_start') broadcast({ type: 'turn_start', sessionId });
      if (ev.type === 'turn_end') broadcast({ type: 'turn_end', sessionId });

      // Thinking lifecycle (per-session)
      if (ev.type === 'thinking_start') {
        thinkStatsById.set(sessionId, { startedAt: Date.now(), chars: 0 });
        broadcast({ type: 'thinking_start', sessionId });
      }
      if (ev.type === 'thinking_delta') {
        const st = thinkStatsById.get(sessionId);
        if (st) {
          try {
            const size = JSON.stringify(ev.delta || ev).length;
            st.chars += size;
            broadcast({ type: 'thinking_progress', chars: st.chars, sessionId });
          } catch {}
        }
      }
      if (ev.type === 'thinking_end') {
        const st = thinkStatsById.get(sessionId);
        if (st) {
          const tookMs = Date.now() - st.startedAt;
          broadcast({ type: 'thinking_end', chars: st.chars, tookMs, sessionId });
          thinkStatsById.delete(sessionId);
        } else {
          broadcast({ type: 'thinking_end', sessionId });
        }
      }

      // Assistant streaming (text/images)
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) broadcast({ type: 'assistant_text', text, sessionId });
          for (const c of blocks) {
            if (!c || c.type !== 'image') continue;
            const mime = c.mime || c.mimeType || c.MIMEType || 'image/png';
            let url = c.image_url || c.url || '';
            if (!url && c.data) url = 'data:' + mime + ';base64,' + c.data;
            if (url) broadcast({ type: 'assistant_image', url, mime, sessionId });
          }
        } catch {}
      }
    } catch {}
  });
}

function ensureEventBridge(sess) {
  if (!sess || bridgedSessions.has(sess)) return;
  bridgedSessions.add(sess);
  sess.subscribe((ev) => {
    try {
      if (ev.type === 'tool_execution_start') {
        const key = ev.toolName + '|' + (function (o) { try { return JSON.stringify(o, Object.keys(o).sort()); } catch { try { return JSON.stringify(o); } catch { return String(o); } } })(ev.args || {});
        const n = (toolRepeat.get(key) || 0) + 1; toolRepeat.set(key, n);
        if (n > 1) broadcast({ type: 'tool_repeat', toolName: ev.toolName, args: ev.args || {}, count: n });
      }
      if (ev.type === 'thinking_start') { thinkStats = { startedAt: Date.now(), chars: 0 }; broadcast({ type: 'thinking_start' }); }
      if (ev.type === 'thinking_delta') { if (thinkStats) { const size = JSON.stringify(ev.delta || ev).length; thinkStats.chars += size; broadcast({ type: 'thinking_progress', chars: thinkStats.chars }); } }
      if (ev.type === 'thinking_end') { if (thinkStats) { const tookMs = Date.now() - thinkStats.startedAt; broadcast({ type: 'thinking_end', chars: thinkStats.chars, tookMs }); thinkStats = null; } else { broadcast({ type: 'thinking_end' }); } }
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) broadcast({ type: 'assistant_text', text });
          for (const c of blocks) {
            if (!c || c.type !== 'image') continue;
            const mime = c.mime || c.mimeType || c.MIMEType || 'image/png';
            let url = c.image_url || c.url || '';
            if (!url && c.data) url = 'data:' + mime + ';base64,' + c.data;
            if (url) broadcast({ type: 'assistant_image', url, mime });
          }
        } catch {}
      }
    } catch {}
    if (!subagentHooked) {
      subagentHooked = true; try { eventBus.on('event', (ev2) => { broadcast(ev2); }); } catch {}
    }
    broadcast(ev);
  });
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}
function send(res, payload) { try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch {} }
function broadcast(ev) { for (const res of clients) send(res, ev); }

async function handleEvents(req, res) {
  await ensurePolicySession('restricted');
  res.writeHead(200, sseHeaders());
  clients.add(res);
  const modelLabel = model ? (model.provider + ':' + model.id + (model.baseUrl ? (' @ ' + model.baseUrl) : '')) : '<auto>';
  send(res, { type: 'server_info', model: modelLabel, tools: toolNames, plugins: pluginFiles, workspace: workspaceRoot });
  req.on('close', () => { try { clients.delete(res); } catch {} });
}

// Legacy single-session endpoint
async function handleChat(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const message = String(body.message || '').trim();
    const policy = String(body.policy || '').toLowerCase() === 'open' ? 'open' : 'restricted';
    if (!message) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_message' })); return; }
    const sess = await ensurePolicySession(policy);
    applyExecPolicyToSession(sess, policy);
    let out = '';
    const unsub = sess.subscribe((ev) => {
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const text = (Array.isArray(ev.message.content) ? ev.message.content : []).filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) out = text;
        } catch {}
      }
    });
    try { await sess.prompt(message); } catch {}
    try { unsub && unsub(); } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ text: out }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server_error', message: e?.message || String(e) }));
  }
}

// Concurrent + persistent endpoint
async function handleChat2(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const message = String(body.message || '').trim();
    const policy = String(body.policy || '').toLowerCase() === 'open' ? 'open' : 'restricted';
    let sessionId = String(body.sessionId || '').trim();
    if (!message) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_message' })); return; }
    if (!sessionId) { const created = ssCreate({ title: '新会话' }); sessionId = created.id; }

    // Load session object and determine its workspace
    const obj0 = ssLoad(sessionId);
    const ws = (obj0 && obj0.workspace) ? String(obj0.workspace) : workspaceRoot;
    if (obj0 && !obj0.workspace) { try { obj0.workspace = ws; ssSave(obj0); } catch {} }

    const sess = await ensureSessionFor(sessionId, policy, ws);
    applyExecPolicyToSession(sess, policy);

    // Persist user message and build context prelude
    ssAppend(sessionId, { role: 'user', text: message });
    const obj = ssLoad(sessionId);
    const prelude = ssPrelude(obj);
    const payloadMsg = (prelude ? prelude + '\n\n' : '') + '[Current Question]\n' + message;

    let out = '';
    let lastAssistantText = '';
    let persistedCount = 0;
    const seenTexts = new Set();
    const unsub = sess.subscribe((ev) => {
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) out = text;
        } catch {}
      }
      if (ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) {
            lastAssistantText = text;
            if (!seenTexts.has(text)) {
              ssAppend(sessionId, { role: 'assistant', text });
              seenTexts.add(text);
              persistedCount++;
            }
          }
        } catch {}
      }
    });

    try { await runWithContext({ sessionId, workspaceRoot: ws }, () => sess.prompt(payloadMsg)); } catch {}
    try { unsub && unsub(); } catch {}

    // Fallback persistence
    if (lastAssistantText) {
      try {
        const cur = ssLoad(sessionId);
        const msgs = (cur && Array.isArray(cur.messages)) ? cur.messages : [];
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        if (persistedCount === 0 || !last || last.role !== 'assistant' || String(last.text || '') !== String(lastAssistantText)) {
          ssAppend(sessionId, { role: 'assistant', text: lastAssistantText });
          persistedCount++;
        }
      } catch {}
    }

    const respText = lastAssistantText || out;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ text: respText }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server_error', message: e?.message || String(e) }));
  }
}

async function handleLocalFile(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams.get('path') || '';
    const sid = String(url.searchParams.get('sessionId') || '').trim();
    const obj = sid ? ssLoad(sid) : null;
    const ws = (obj && obj.workspace) ? String(obj.workspace) : workspaceRoot;
    const filePath = runWithContext({ sessionId: sid || undefined, workspaceRoot: ws }, () => ensureReadAllowed(p));
    const data = await readFile(filePath);
    const type = extname(filePath).toLowerCase();
    const ct = type === '.png' ? 'image/png' : type === '.jpg' || type === '.jpeg' ? 'image/jpeg' : type === '.webp' ? 'image/webp' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) {
    res.writeHead(404).end('Not Found');
  }
}

function sanitizeConfig(cfg) {
  if (!cfg) return null;
  const out = { provider: cfg.provider || '', base_url: cfg.base_url || '', model: cfg.model || '', path: cfg.path || '' };
  out.has_key = !!cfg.key || !!cfg.api_key || !!cfg.apiKey;
  delete out.key; delete out.api_key; delete out.apiKey;
  return out;
}

function resetSessions() { try { sessionsByPolicy.clear(); chatSessions.clear(); } catch {} }

async function handleDoctor(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const sid = String(url.searchParams.get('sessionId') || '').trim();
    const obj = sid ? ssLoad(sid) : null;
    const ws = (obj && obj.workspace) ? String(obj.workspace) : workspaceRoot;
    const result = await runWithContext({ sessionId: sid || undefined, workspaceRoot: ws }, () => runDoctor({ cwd: ws }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'doctor_failed', message: e?.message || String(e) }));
  }
}

async function handleSupportBundle(req, res) {
  try {
    const bufs = []; for await (const c of req) bufs.push(c);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf-8')) : {};
    const sid = String(body.sessionId || '').trim();
    const obj = sid ? ssLoad(sid) : null;
    const ws = (obj && obj.workspace) ? String(obj.workspace) : workspaceRoot;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDirRaw = join(ws, 'artifacts', 'support-' + stamp);
    const outDir = runWithContext({ sessionId: sid || undefined, workspaceRoot: ws }, () => ensureWriteAllowed(outDirRaw));
    const { dir, tarPath } = await createSupportBundle({ outDir, cwd: ws });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, dir, tarPath: tarPath || '' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'support_bundle_failed', message: e?.message || String(e) }));
  }
}

async function handleGetConfig(req, res) {
  try { const cfg = loadArcanaConfig(); const out = sanitizeConfig(cfg || {}); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(out || {})); }
  catch { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({})); }
}

async function handlePostConfig(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const provider = String(body.provider || '').trim();
    const modelId = String(body.model || '').trim();
    const baseUrl = String(body.base_url || '').trim();
    const key = String(body.key || '').trim();
    const cfgObj = { provider, model: modelId, base_url: baseUrl };
    if (key) cfgObj.key = key;

    const envCfg = String(process.env.ARCANA_CONFIG || '').trim();
    let path = '';
    if (envCfg) {
      path = envCfg; // honor explicit ARCANA_CONFIG path as-is
    } else {
      try { ensureArcanaHomeDir(); } catch {}
      path = arcanaHomePath('config.json');
    }

    await writeFile(path, JSON.stringify(cfgObj, null, 2), 'utf-8');
    resetSessions();
    broadcast({ type: 'server_info', model: '', tools: toolNames, plugins: pluginFiles, workspace: workspaceRoot });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'config_write_failed', message: e?.message || String(e) }));
  }
}

// Sessions CRUD
async function handleListSessions(req, res) {
  try { const items = ssList(); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ sessions: items })); }
  catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'list_failed', message: e?.message || String(e) })); }
}

async function handleCreateSession(req, res) {
  try {
    const bufs = []; for await (const c of req) bufs.push(c);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf-8')) : {};
    const title = String(body.title || '新会话').trim();
    const workspace = String(body.workspace || '').trim();
    if (!workspace) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workspace_required' })); return; }
    // Validate directory exists and canonicalize
    if (!existsSync(workspace)) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workspace_invalid' })); return; }
    let canonical = '';
    try { canonical = realpathSync(workspace); } catch { canonical = workspace; }
    try { const st = statSync(canonical); if (!st.isDirectory()) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workspace_invalid' })); return; } } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workspace_invalid' })); return; }
    const obj = ssCreate({ title, workspace: canonical });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'create_failed', message: e?.message || String(e) }));
  }
}

async function handleGetSession(req, res, id) {
  try { const obj = ssLoad(String(id || '').trim()); if (!obj) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' })); return; } res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj)); }
  catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'get_failed', message: e?.message || String(e) })); }
}

// DELETE /api/sessions/:id
async function handleDeleteSession(req, res, id) {
  try {
    let decoded = '';
    try { decoded = decodeURIComponent(String(id || '').trim()); } catch { decoded = String(id || '').trim(); }
    const ok = ssDelete(decoded);
    if (!ok) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' })); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'delete_failed', message: e?.message || String(e) }));
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname;
  if (path === '/' || path === '/chat') path = '/index.html';
  const filePath = join(projectRoot, 'web', path.replace(/^\/+/, ''));
  try {
    const data = await readFile(filePath);
    const type = extname(filePath);
    const ct = type === '.html' ? 'text/html; charset=utf-8'
      : type === '.css' ? 'text/css'
      : type === '.js' ? 'text/javascript'
      : type === '.json' ? 'application/json; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

function createRequestHandler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // CORS for dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(200).end(); return; }

    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, plugins: (pluginFiles?.length || 0) })); return; }
    if (req.method === 'GET' && url.pathname === '/api/events') { await handleEvents(req, res); return; }

    // Legacy chat
    if (req.method === 'POST' && url.pathname === '/api/chat') { await handleChat(req, res); return; }

    // Concurrent chat + persistence
    if (req.method === 'POST' && url.pathname === '/api/chat2') { await handleChat2(req, res); return; }

    // Sessions CRUD
    if (req.method === 'GET' && url.pathname === '/api/sessions') { await handleListSessions(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/sessions') { await handleCreateSession(req, res); return; }
    if (url.pathname.startsWith('/api/sessions/')) {
      const id = url.pathname.slice('/api/sessions/'.length);
      if (req.method === 'GET') { await handleGetSession(req, res, id); return; }
      if (req.method === 'DELETE') { await handleDeleteSession(req, res, id); return; }
    }

    // Utilities
    if (req.method === 'GET' && url.pathname === '/api/local-file') { await handleLocalFile(req, res); return; }
    if (req.method === 'GET' && url.pathname === '/api/doctor') { await handleDoctor(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/support-bundle') { await handleSupportBundle(req, res); return; }
    if (req.method === 'GET' && url.pathname === '/api/config') { await handleGetConfig(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/config') { await handlePostConfig(req, res); return; }

    await serveStatic(req, res);
  };
}

export async function startArcanaWebServer({ port, workspaceRoot: wsRoot } = {}) {
  if (wsRoot) { process.env.ARCANA_WORKSPACE = String(wsRoot); try { resetWorkspaceRootCache(); } catch {} }
  workspaceRoot = resolveWorkspaceRoot();

  const server = http.createServer(createRequestHandler());
  const desiredPort = typeof port === 'number' ? port : (process.env.PORT ? Number(process.env.PORT) : 5678);
  await new Promise((resolve) => { server.listen(desiredPort, () => resolve()); });
  const bound = server.address();
  const actualPort = bound && typeof bound.port === 'number' ? bound.port : desiredPort;
  console.log('[arcana:web] http://localhost:' + actualPort + '  (plugins: ' + (pluginFiles ? pluginFiles.length : 0) + ')');
  return { server, port: actualPort };
}

// CLI entry:
const isDirectRun = (() => { try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();
if (isDirectRun) {
  const p = process.env.PORT ? Number(process.env.PORT) : 5678;
  // Force a stable workspace root when launched directly from CLI.
  const ws = process.env.ARCANA_WORKSPACE && String(process.env.ARCANA_WORKSPACE).trim()
    ? String(process.env.ARCANA_WORKSPACE).trim()
    : process.cwd();
  startArcanaWebServer({ port: p, workspaceRoot: ws }).catch((e) => { console.error('[arcana:web] failed to start:', e?.stack || e); process.exit(1); });
}
