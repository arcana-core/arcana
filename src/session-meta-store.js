import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arcanaHomePath } from './arcana-home.js';

const DEFAULT_AGENT_ID = 'default';

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

function normalizeSessionId(raw){
  try {
    const s = String(raw || '').trim();
    if (!s) return '';
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe;
  } catch {
    return '';
  }
}

function metaDir(agentIdRaw){
  const agentId = normalizeAgentId(agentIdRaw);
  return arcanaHomePath('agents', agentId, 'sessions_meta');
}

function metaPath(sessionIdRaw, agentIdRaw){
  const sid = normalizeSessionId(sessionIdRaw);
  if (!sid) return null;
  const agentId = normalizeAgentId(agentIdRaw);
  return arcanaHomePath('agents', agentId, 'sessions_meta', sid + '.json');
}

export function loadSessionMeta(sessionId, { agentId } = {}){
  const p = metaPath(sessionId, agentId);
  if (!p) return null;
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveSessionMeta(sessionId, meta, { agentId } = {}){
  const sid = normalizeSessionId(sessionId);
  if (!sid) return false;
  const p = metaPath(sid, agentId);
  if (!p) return false;
  const dir = metaDir(agentId);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort directory creation
  }
  try {
    writeFileSync(p, JSON.stringify(meta || {}, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export default {
  loadSessionMeta,
  saveSessionMeta,
};

