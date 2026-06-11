import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
  unlinkSync, renameSync, openSync, closeSync, appendFileSync, readSync, fstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { arcanaHomePath, ensureArcanaHomeDir } from './arcana-home.js';
import { fileURLToPath } from 'node:url';
import { loadSessionMeta } from './session-meta-store.js';

// Chat session store, split into two files per session:
//   <sid>.json   - small metadata snapshot { id, title, workspace, agentId,
//                  hidden?, createdAt, updatedAt, summary?, ... } (no messages)
//   <sid>.jsonl  - append-only message log, one JSON object per line:
//                  { role, text, ts, mediaRefs?, itemId? }
//
// Appending a message is a single O_APPEND write: no lock, no full-file
// rewrite, and atomic across processes. Whole-object writes (saveSession,
// used by compaction/meta updates) are rare and take a non-blocking lockfile.
//
// Legacy combined files ({ ...meta, messages: [...] } in <sid>.json) are read
// transparently and migrated to the split layout on first write.

const DEFAULT_AGENT_ID = 'default';
const SESSION_LOCK_STALE_MS = 30000; // 30s
const SESSION_LOCK_ATTEMPTS = 5;
const SESSION_SCHEMA_VERSION = 2;
const TAIL_READ_BYTES = 262144; // 256KB

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

function sessionMetaPath(agentIdRaw, sessionId){
  return join(sessionsDir(agentIdRaw), String(sessionId) + '.json');
}

function sessionMessagesPath(agentIdRaw, sessionId){
  return join(sessionsDir(agentIdRaw), String(sessionId) + '.jsonl');
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

// Non-blocking lockfile acquisition: a handful of immediate attempts with
// stale-lock cleanup. Never sleeps — the previous implementation parked the
// whole event loop with Atomics.wait while contending, freezing every other
// request in the process.
function tryAcquireSessionLock(agentIdRaw, sessionId){
  const path = sessionLockPath(agentIdRaw, sessionId);
  if (!path) return null;
  for (let attempt = 0; attempt < SESSION_LOCK_ATTEMPTS; attempt += 1){
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

function writeFileAtomic(path, content){
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf-8');
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

function normalizeMessageRecord(raw){
  if (!raw || typeof raw !== 'object') return null;
  const message = {
    role: String(raw.role || 'user'),
    text: typeof raw.text === 'string' ? raw.text : String(raw.text || ''),
    ts: raw.ts ? String(raw.ts) : nowIso(),
  };
  if (Array.isArray(raw.mediaRefs)){
    const refs = raw.mediaRefs
      .map((ref) => typeof ref === 'string' ? ref.trim() : '')
      .filter(Boolean);
    if (refs.length) message.mediaRefs = refs;
  }
  const itemId = String(raw.itemId || '').trim();
  if (itemId) message.itemId = itemId;
  return message;
}

function serializeMessages(messages){
  const arr = Array.isArray(messages) ? messages : [];
  let out = '';
  for (const raw of arr){
    const message = normalizeMessageRecord(raw);
    if (!message) continue;
    out += JSON.stringify(message) + '\n';
  }
  return out;
}

function readMessagesFile(path){
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')){
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A partially written trailing line (crash mid-append) parses as garbage;
    // skip it rather than failing the whole load.
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {}
  }
  return out;
}

function readLastMessage(path){
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (!size) return null;
    const len = Math.min(size, TAIL_READ_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1){
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') return obj;
      } catch {}
      // The oldest line in the tail window may be cut off; ignore it.
      if (i === 0 && size > len){
        const all = readMessagesFile(path);
        return all.length ? all[all.length - 1] : null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { if (fd != null) closeSync(fd); } catch {}
  }
}

function readMetaFile(path){
  try {
    if (!existsSync(path)) return null;
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    return (obj && typeof obj === 'object') ? obj : null;
  } catch {
    return null;
  }
}

function stripMessagesFromMeta(obj){
  const meta = { ...obj };
  delete meta.messages;
  meta.schema = SESSION_SCHEMA_VERSION;
  return meta;
}

function isLegacyCombined(meta, messagesPath){
  return !!(meta && Array.isArray(meta.messages)) && !existsSync(messagesPath);
}

// Move a legacy combined file to the split layout. Caller decides locking.
function migrateLegacySession(meta, metaPath, messagesPath){
  const messages = Array.isArray(meta.messages) ? meta.messages : [];
  // Write the message log first: if we crash before the meta rewrite, the
  // .jsonl copy wins on the next read and nothing is lost.
  writeFileAtomic(messagesPath, serializeMessages(messages));
  writeFileAtomic(metaPath, JSON.stringify(stripMessagesFromMeta(meta), null, 2));
}

function applySessionMetaFields(target, sessionId, agentId){
  if (!target || !sessionId) return target;
  try {
    const meta = loadSessionMeta(sessionId, { agentId });
    if (!meta || typeof meta !== 'object') return target;
    if (meta.sessionKey != null) target.sessionKey = String(meta.sessionKey || '');
    if (meta.sessionSource != null) target.sessionSource = String(meta.sessionSource || '');
    if (meta.workspaceRoot != null) target.workspaceRoot = String(meta.workspaceRoot || '');
  } catch {}
  return target;
}

function freshestUpdatedAt(meta, messagesPath){
  let updatedAt = meta && meta.updatedAt ? String(meta.updatedAt) : '';
  try {
    const st = statSync(messagesPath);
    const fileIso = new Date(st.mtimeMs).toISOString();
    if (!updatedAt || fileIso > updatedAt) updatedAt = fileIso;
  } catch {}
  return updatedAt;
}

export function createSession({ title, workspace, agentId, hidden } = {}){
  const t = String(title == null ? '' : title).trim();
  const normAgentId = normalizeAgentId(agentId);
  const stamp = nowIso().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const agentSegment = normAgentId.slice(0, 40);
  const rand = randomBytes(4).toString('hex');
  const id = stamp + '--' + agentSegment + '--' + slug(t) + '--' + rand;
  const meta = {
    id,
    title: t,
    workspace: String(workspace || '').trim() || undefined,
    agentId: normAgentId,
    hidden: hidden === true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    schema: SESSION_SCHEMA_VERSION,
  };
  writeFileAtomic(sessionMetaPath(normAgentId, id), JSON.stringify(meta, null, 2));
  return { ...meta, messages: [] };
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
      if (raw && raw.hidden === true) continue;
      const sid = raw.id || name.replace(/\.json$/, '');
      const messagesPath = sessionMessagesPath(normAgentId, sid);
      const createdAt = raw.createdAt || new Date(st.ctimeMs).toISOString();
      const updatedAt = freshestUpdatedAt(raw, messagesPath) || new Date(st.mtimeMs).toISOString();
      const titleRaw = (raw && typeof raw.title === 'string') ? String(raw.title).trim() : '';
      let last = null;
      if (existsSync(messagesPath)){
        last = readLastMessage(messagesPath);
      } else if (Array.isArray(raw.messages) && raw.messages.length){
        last = raw.messages[raw.messages.length - 1];
      }
      const item = applySessionMetaFields({
        id: sid,
        title: titleRaw,
        workspace: raw.workspace || '',
        agentId: normalizeAgentId(raw.agentId || normAgentId),
        createdAt,
        updatedAt,
        last,
      }, sid, normalizeAgentId(raw.agentId || normAgentId));
      out.push(item);
    } catch {}
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

export function loadSession(id, opts){
  const sid = String(id || '').trim();
  if (!sid) return null;
  const normAgentId = normalizeAgentId(opts && opts.agentId);
  const metaPath = sessionMetaPath(normAgentId, sid);
  const meta = readMetaFile(metaPath);
  if (!meta) return null;
  const messagesPath = sessionMessagesPath(normAgentId, sid);
  const obj = { ...meta };
  if (existsSync(messagesPath)){
    obj.messages = readMessagesFile(messagesPath);
  } else {
    obj.messages = Array.isArray(meta.messages) ? meta.messages : [];
  }
  const agentId = normalizeAgentId(obj.agentId || normAgentId);
  obj.agentId = agentId;
  obj.hidden = obj.hidden === true;
  const updatedAt = freshestUpdatedAt(meta, messagesPath);
  if (updatedAt) obj.updatedAt = updatedAt;
  applySessionMetaFields(obj, sid, agentId);
  return obj;
}

export function saveSession(obj, opts){
  if (!obj || !obj.id) return false;
  const normAgentId = normalizeAgentId((obj && obj.agentId) || (opts && opts.agentId));
  const lockPath = tryAcquireSessionLock(normAgentId, obj.id);
  if (!lockPath) return false;
  try {
    obj.agentId = normAgentId;
    const touch = !opts || opts.touchUpdatedAt !== false;
    if (touch) obj.updatedAt = nowIso();
    const metaPath = sessionMetaPath(normAgentId, obj.id);
    const messagesPath = sessionMessagesPath(normAgentId, obj.id);
    // Whole-object saves (compaction, meta edits) rewrite both files; the hot
    // per-message path is appendMessage below and never does this.
    if (Array.isArray(obj.messages)){
      writeFileAtomic(messagesPath, serializeMessages(obj.messages));
    }
    writeFileAtomic(metaPath, JSON.stringify(stripMessagesFromMeta(obj), null, 2));
    return true;
  } finally {
    releaseSessionLock(lockPath);
  }
}

export function appendMessage(sessionId, { role, text, agentId, mediaRefs, itemId } = {}){
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const normAgentId = normalizeAgentId(agentId);
  const metaPath = sessionMetaPath(normAgentId, id);
  const messagesPath = sessionMessagesPath(normAgentId, id);

  let meta = readMetaFile(metaPath);
  if (!meta){
    meta = {
      id,
      title: '',
      workspace: undefined,
      agentId: normAgentId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      schema: SESSION_SCHEMA_VERSION,
    };
    writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));
  } else if (isLegacyCombined(meta, messagesPath)){
    const lockPath = tryAcquireSessionLock(normAgentId, id);
    if (lockPath){
      try { migrateLegacySession(meta, metaPath, messagesPath); } finally { releaseSessionLock(lockPath); }
      meta = readMetaFile(metaPath) || meta;
    }
    // If the lock was contended, fall through: the append below still lands in
    // the .jsonl, which wins over the embedded copy on the next migration.
  }

  const message = normalizeMessageRecord({ role, text, ts: nowIso(), mediaRefs, itemId });
  if (!message) return null;

  // Idempotent per item: the streaming bridge and the post-turn fallback may
  // both persist the same assistant item; one row wins.
  if (message.itemId){
    const last = readLastMessage(messagesPath);
    if (last && String(last.itemId || '') === message.itemId){
      return { id, agentId: normalizeAgentId(meta.agentId || normAgentId), deduped: true };
    }
  }

  let hadNoMessages = true;
  try {
    const st = statSync(messagesPath);
    hadNoMessages = st.size === 0;
  } catch {}
  if (hadNoMessages && Array.isArray(meta.messages) && meta.messages.length){
    hadNoMessages = false;
  }

  appendFileSync(messagesPath, JSON.stringify(message) + '\n', 'utf-8');

  if (hadNoMessages && message.role.toLowerCase() === 'user'){
    const currentTitle = String(meta.title || '').trim();
    const isLegacyUntitled = (currentTitle === '新会话' || currentTitle === 'New session');
    if (!currentTitle || isLegacyUntitled){
      const autoTitle = deriveSessionTitleFromText(message.text);
      if (autoTitle){
        meta.title = autoTitle;
        meta.updatedAt = nowIso();
        try { writeFileAtomic(metaPath, JSON.stringify(stripMessagesFromMeta(meta), null, 2)); } catch {}
      }
    }
  }

  return { id, agentId: normalizeAgentId(meta.agentId || normAgentId), appended: true };
}

export function upsertLastMessage(sessionId, { role, text, agentId } = {}){
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const normAgentId = normalizeAgentId(agentId);
  const obj = loadSession(id, { agentId: normAgentId }) || {
    id,
    title: '',
    workspace: undefined,
    agentId: normAgentId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
  };
  obj.messages = Array.isArray(obj.messages) ? obj.messages : [];
  const roleStr = String(role || 'assistant');
  const textStr = String(text || '');
  const last = obj.messages.length ? obj.messages[obj.messages.length - 1] : null;
  if (last && last.role === roleStr){
    last.text = textStr;
  } else {
    obj.messages.push({ role: roleStr, text: textStr, ts: nowIso() });
  }
  return saveSession(obj, { agentId: normAgentId }) ? obj : null;
}

export function deleteSession(id, opts){
  const sid = String(id || '').trim();
  if (!sid) return false;
  const normAgentId = normalizeAgentId(opts && opts.agentId);
  const lockPath = tryAcquireSessionLock(normAgentId, sid);
  if (!lockPath) return false;
  try {
    const metaPath = sessionMetaPath(normAgentId, sid);
    const messagesPath = sessionMessagesPath(normAgentId, sid);
    try { unlinkSync(messagesPath); } catch {}
    try { unlinkSync(metaPath); return true; } catch { return false; }
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
    lines.push('[Conversation History — keep for context]\n');
    for (const m of msgs){
      let role = 'User';
      if (m.role === 'assistant') role = 'Assistant';
      else if (m.role === 'tool') role = 'Tool';
      else if (m.role === 'system') role = 'System';
      const t = String(m.text || '');
      const chunk = t.length > 3000 ? ('…' + t.slice(-3000)) : t;
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
  convLines.push('[Conversation History — keep for context]\n');
  for (const m of recent){
    let role = 'User';
    if (m.role === 'assistant') role = 'Assistant';
    else if (m.role === 'tool') role = 'Tool';
    else if (m.role === 'system') role = 'System';
    const t = String(m.text || '');
    const chunk = t.length > maxMessageChars ? ('…' + t.slice(-maxMessageChars)) : t;
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
  if (out.length > maxTotalChars) out = '…' + out.slice(-maxTotalChars);
  return out;
}

export default {
  createSession,
  listSessions,
  loadSession,
  saveSession,
  appendMessage,
  upsertLastMessage,
  deleteSession,
  buildHistoryPreludeText,
};
