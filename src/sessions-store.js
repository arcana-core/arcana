import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { arcanaHomePath, ensureArcanaHomeDir } from './arcana-home.js';
import { fileURLToPath } from 'node:url';

// Simple JSON-backed chat session store.
// Schema: { id, title, workspace, agentId, createdAt, updatedAt, messages: [{ role: 'user'|'assistant', text, ts }], sessionTokens?: number }

const DEFAULT_AGENT_ID = 'default';
const SESSION_LOCK_STALE_MS = 30000; // 30s
const SESSION_LOCK_TIMEOUT_MS = 3000; // 3s

// Internal: compute arcana package root (arcana/)
function arcanaPkgRoot(){
  try { const here = fileURLToPath(new URL('.', import.meta.url)); return join(here, '..'); } catch { return process.cwd(); }
}

function normalizeAgentId(raw){
  try {
    const s = String(raw || '').trim();
    if (!s) return DEFAULT_AGENT_ID;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

// Session store directory: ~/.arcana/agents/<agentId>/sessions
function sessionsDir(agentIdRaw){
  const baseHome = ensureArcanaHomeDir();
  const agentId = normalizeAgentId(agentIdRaw);
  const d = join(baseHome, 'agents', agentId, 'sessions');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function sessionLocksDir(agentIdRaw){
  const base = sessionsDir(agentIdRaw);
  const d = join(base, '.locks');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function sessionLockPath(agentIdRaw, sessionId){
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const d = sessionLocksDir(agentIdRaw);
  return join(d, sid + '.lock');
}

function acquireSessionLock(agentIdRaw, sessionId, timeoutMs = SESSION_LOCK_TIMEOUT_MS){
  const path = sessionLockPath(agentIdRaw, sessionId);
  if (!path) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs){
    try {
      const fd = openSync(path, 'wx');
      try { closeSync(fd); } catch {}
      return path;
    } catch {}
    try {
      const st = statSync(path);
      if (Date.now() - st.mtimeMs > SESSION_LOCK_STALE_MS) {
        try { unlinkSync(path); } catch {}
      }
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return null;
}

function releaseSessionLock(lockPath){
  if (!lockPath) return;
  try { unlinkSync(lockPath); } catch {}
}

function nowIso(){ return new Date().toISOString(); }

const MAX_AUTO_TITLE_LENGTH = 32;

function deriveSessionTitleFromText(text){
  try {
    const raw = String(text || '');
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const firstLine = trimmed.split(/\r?\n/, 1)[0];
    const collapsed = firstLine.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    const asArray = Array.from(collapsed);
    if (asArray.length <= MAX_AUTO_TITLE_LENGTH) return collapsed;
    return asArray.slice(0, MAX_AUTO_TITLE_LENGTH).join('');
  } catch {
    return '';
  }
}

function slug(s){
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\-_\s]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'session';
}

function writeSessionFileAtomic(path, obj){
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  try {
    // On POSIX, renameSync will overwrite the destination atomically.
    // On Windows, renameSync fails if the destination exists, so fall back
    // to unlinking the destination and retrying the rename.
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(path); } catch {}
    // If this second rename fails, let the error propagate to the caller.
    renameSync(tmp, path);
  }
}

function saveSessionInternal(obj, normAgentId, opts){
  if (!obj || !obj.id) return false;
  obj.agentId = normAgentId;
  const touch = !opts || opts.touchUpdatedAt !== false;
  if (touch) obj.updatedAt = nowIso();
  const p = join(sessionsDir(normAgentId), obj.id + '.json');
  writeSessionFileAtomic(p, obj);
  return true;
}

export function createSession({ title, workspace, agentId } = {}){
  const t = String(title || '新会话').trim();
  const normAgentId = normalizeAgentId(agentId);
  const stamp = nowIso().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const agentSegment = normAgentId.slice(0, 40);
  const rand = randomBytes(4).toString('hex');
  const id = stamp + '--' + agentSegment + '--' + slug(t) + '--' + rand;
  const obj = {
    id,
    title: t,
    workspace: String(workspace || '').trim() || undefined,
    agentId: normAgentId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
  };
  const path = join(sessionsDir(normAgentId), id + '.json');
  writeSessionFileAtomic(path, obj);
  return obj;
}

export function listSessions(agentId){
  const normAgentId = normalizeAgentId(agentId);
  const d = sessionsDir(normAgentId);
  const out = [];
  for (const name of readdirSync(d)){
    if (!name.endsWith('.json')) continue;
    const p = join(d, name);
    try {
      const st = statSync(p);
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      const createdAt = raw.createdAt || new Date(st.ctimeMs).toISOString();
      const updatedAt = raw.updatedAt || new Date(st.mtimeMs).toISOString();
      out.push({
        id: raw.id || name.replace(/\.json$/, ''),
        title: raw.title || '新会话',
        workspace: raw.workspace || '',
        agentId: normalizeAgentId(raw.agentId || normAgentId),
        createdAt,
        updatedAt,
        last: (Array.isArray(raw.messages) && raw.messages.length) ? raw.messages[raw.messages.length - 1] : null,
      });
    } catch {}
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

export function loadSession(id, opts){
  const sid = String(id || '').trim();
  if (!sid) return null;
  const normAgentId = normalizeAgentId(opts && opts.agentId);
  const p = join(sessionsDir(normAgentId), sid + '.json');
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, 'utf-8'));
    if (!obj || typeof obj !== 'object') return null;
    const agentId = normalizeAgentId(obj.agentId || normAgentId);
    obj.agentId = agentId;
    return obj;
  } catch {
    return null;
  }
}

export function saveSession(obj, opts){
  if (!obj || !obj.id) return false;
  const normAgentId = normalizeAgentId((obj && obj.agentId) || (opts && opts.agentId));
  const lockPath = acquireSessionLock(normAgentId, obj.id);
  if (!lockPath) return false;
  try {
    return saveSessionInternal(obj, normAgentId, opts || {});
  } finally {
    releaseSessionLock(lockPath);
  }
}

export function appendMessage(sessionId, { role, text, agentId } = {}){
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const normAgentId = normalizeAgentId(agentId);
  const lockPath = acquireSessionLock(normAgentId, id);
  if (!lockPath) return null;
  try {
    const existing = loadSession(id, { agentId: normAgentId });
    const obj = existing || {
      id,
      title: '新会话',
      workspace: undefined,
      agentId: normAgentId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
    };
    obj.agentId = normalizeAgentId(obj.agentId || normAgentId);
    obj.messages = Array.isArray(obj.messages) ? obj.messages : [];
    const hadNoMessages = obj.messages.length === 0;
    const roleStr = String(role || 'user');
    const textStr = String(text || '');
    obj.messages.push({ role: roleStr, text: textStr, ts: nowIso() });

    if (hadNoMessages && String(roleStr || '').toLowerCase() === 'user'){
      const currentTitle = String(obj.title || '').trim();
      if (!currentTitle || currentTitle === '新会话'){
        const autoTitle = deriveSessionTitleFromText(textStr);
        if (autoTitle) obj.title = autoTitle;
      }
    }
    // appendMessage should always bump updatedAt
    saveSessionInternal(obj, obj.agentId, { touchUpdatedAt: true });
    return obj;
  } finally {
    releaseSessionLock(lockPath);
  }
}

export function deleteSession(id, opts){
  const sid = String(id || '').trim();
  if (!sid) return false;
  const normAgentId = normalizeAgentId(opts && opts.agentId);
  const lockPath = acquireSessionLock(normAgentId, sid);
  if (!lockPath) return false;
  try {
    const p = join(sessionsDir(normAgentId), sid + '.json');
    try { unlinkSync(p); return true; } catch { return false; }
  } finally {
    releaseSessionLock(lockPath);
  }
}

export function buildHistoryPreludeText(obj, opts){
  if (!obj) return '';

  const msgs = Array.isArray(obj.messages) ? obj.messages : [];

  // Back-compat: preserve original behavior when opts is omitted.
  if (!opts || typeof opts !== 'object'){
    if (!msgs.length) return '';
    const lines = [];
    lines.push('[Conversation History \u2014 keep for context]\n');
    for (const m of msgs){
      const role = (m.role === 'assistant' ? 'Assistant' : 'User');
      const t = String(m.text || '');
      const chunk = t.length > 3000 ? ('\u2026' + t.slice(-3000)) : t;
      lines.push(role + ': ' + chunk);
    }
    return lines.join('\n');
  }

  const summary = String(opts.summary || '').trim();
  const maxMessagesVal = Number(opts.maxMessages);
  const maxMessageCharsVal = Number(opts.maxMessageChars);
  const maxTotalCharsVal = Number(opts.maxTotalChars);

  const maxMessages = (Number.isFinite(maxMessagesVal) && maxMessagesVal > 0) ? Math.floor(maxMessagesVal) : msgs.length;
  const maxMessageChars = (Number.isFinite(maxMessageCharsVal) && maxMessageCharsVal > 0) ? Math.floor(maxMessageCharsVal) : 3000;
  const maxTotalChars = (Number.isFinite(maxTotalCharsVal) && maxTotalCharsVal > 0) ? Math.floor(maxTotalCharsVal) : 20000;

  const recent = msgs.slice(-maxMessages);

  const convLines = [];
  convLines.push('[Conversation History \u2014 keep for context]\n');
  for (const m of recent){
    const role = (m.role === 'assistant' ? 'Assistant' : 'User');
    const t = String(m.text || '');
    const chunk = t.length > maxMessageChars ? ('\u2026' + t.slice(-maxMessageChars)) : t;
    convLines.push(role + ': ' + chunk);
  }

  let out = '';
  if (summary){
    out += '[Summary]\n' + summary + '\n\n';
  }
  out += convLines.join('\n');

  if (out.length <= maxTotalChars) return out;

  // Enforce total size by dropping the oldest messages (keep newest).
  const kept = convLines.slice();
  while (kept.length > 1){
    let candidate = '';
    if (summary){
      candidate += '[Summary]\n' + summary + '\n\n';
    }
    candidate += kept.join('\n');
    if (candidate.length <= maxTotalChars) return candidate;
    kept.splice(1, 1); // drop oldest content line, keep header
  }

  out = '';
  if (summary){
    out += '[Summary]\n' + summary + '\n\n';
  }
  out += kept.join('\n');
  if (out.length > maxTotalChars) out = '\u2026' + out.slice(-maxTotalChars);
  return out;
}

export default {
  createSession,
  listSessions,
  loadSession,
  saveSession,
  appendMessage,
  deleteSession,
  buildHistoryPreludeText,
};
