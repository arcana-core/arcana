import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { arcanaHomePath, ensureArcanaHomeDir } from './arcana-home.js';
import { fileURLToPath } from 'node:url';

// Simple JSON-backed chat session store.
// Schema: { id, title, workspace, agentId, createdAt, updatedAt, messages: [{ role: 'user'|'assistant', text, ts }], sessionTokens?: number }

const DEFAULT_AGENT_ID = 'default';

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

export function createSession({ title, workspace, agentId } = {}){
  const t = String(title || '新会话').trim();
  const stamp = nowIso().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const id = stamp + '--' + slug(t);
  const normAgentId = normalizeAgentId(agentId);
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
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8');
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
  obj.agentId = normAgentId;
  obj.updatedAt = nowIso();
  const p = join(sessionsDir(normAgentId), obj.id + '.json');
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
  return true;
}

export function appendMessage(sessionId, { role, text, agentId } = {}){
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const normAgentId = normalizeAgentId(agentId);
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
  saveSession(obj, { agentId: obj.agentId });
  return obj;
}

export function deleteSession(id, opts){
  const sid = String(id || '').trim();
  if (!sid) return false;
  const normAgentId = normalizeAgentId(opts && opts.agentId);
  const p = join(sessionsDir(normAgentId), sid + '.json');
  try { unlinkSync(p); return true; } catch { return false; }
}

export function buildHistoryPreludeText(obj){
  if (!obj || !Array.isArray(obj.messages) || !obj.messages.length) return '';
  const lines = [];
  lines.push('[Conversation History — keep for context]\n');
  for (const m of obj.messages){
    const role = (m.role === 'assistant' ? 'Assistant' : 'User');
    const t = String(m.text || '');
    const chunk = t.length > 3000 ? ('…' + t.slice(-3000)) : t;
    lines.push(role + ': ' + chunk);
  }
  return lines.join('\n');
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
