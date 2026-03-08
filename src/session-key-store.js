import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { arcanaHomePath, ensureArcanaHomeDir } from './arcana-home.js';
import { resolveWorkspaceRoot } from './workspace-guard.js';
import { createSession, loadSession } from './sessions-store.js';

const DEFAULT_AGENT_ID = 'default';

function normalizeAgentId(raw) {
  try {
    const s = String(raw ?? '').trim();
    if (!s) return DEFAULT_AGENT_ID;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function normalizeSessionKey(raw) {
  try {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    return s;
  } catch {
    return null;
  }
}

function computeSafeKey(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;
  let base = key.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!base) base = 'key';
  if (base.length > 80) base = base.slice(0, 80);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return base + '__' + hash;
}

function ensureSessionKeyDir(agentIdRaw) {
  const agentId = normalizeAgentId(agentIdRaw);
  ensureArcanaHomeDir();
  const dir = arcanaHomePath('agents', agentId, 'session-keys');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { agentId, dir };
}

function mappingFilePath(agentIdRaw, sessionKeyRaw) {
  const key = normalizeSessionKey(sessionKeyRaw);
  if (!key) return null;
  const safeKey = computeSafeKey(key);
  if (!safeKey) return null;
  const { agentId, dir } = ensureSessionKeyDir(agentIdRaw);
  const filePath = join(dir, safeKey + '.json');
  return { agentId, sessionKey: key, safeKey, filePath };
}

function readMapping(agentIdRaw, sessionKeyRaw) {
  const info = mappingFilePath(agentIdRaw, sessionKeyRaw);
  if (!info) return null;
  const { filePath } = info;
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const sessionId = parsed.sessionId != null ? String(parsed.sessionId).trim() : '';
    if (!sessionId) return null;
    return {
      agentId: parsed.agentId || info.agentId,
      sessionKey: parsed.sessionKey || info.sessionKey,
      sessionId,
      safeKey: parsed.safeKey || info.safeKey,
    };
  } catch {
    return null;
  }
}

function writeMapping(agentIdRaw, sessionKeyRaw, sessionIdRaw) {
  const info = mappingFilePath(agentIdRaw, sessionKeyRaw);
  if (!info) return null;
  const { agentId, sessionKey, safeKey, filePath } = info;
  const sessionId = String(sessionIdRaw || '').trim();
  if (!sessionId) return null;
  const now = new Date().toISOString();
  let createdAt = now;
  try {
    if (existsSync(filePath)) {
      const prevRaw = readFileSync(filePath, 'utf-8');
      const prev = JSON.parse(prevRaw);
      if (prev && typeof prev === 'object' && prev.createdAt) {
        createdAt = String(prev.createdAt);
      }
    }
  } catch {
    // ignore previous mapping errors; treat as fresh
  }

  const payload = {
    agentId,
    sessionKey,
    safeKey,
    sessionId,
    createdAt,
    updatedAt: now,
  };

  try {
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // best-effort only
  }

  return payload;
}

export async function getSessionIdForKey({ agentId, sessionKey } = {}) {
  const mapping = readMapping(agentId, sessionKey);
  if (!mapping) return null;
  const id = String(mapping.sessionId || '').trim();
  return id || null;
}

export async function setSessionIdForKey({ agentId, sessionKey, sessionId } = {}) {
  const payload = writeMapping(agentId, sessionKey, sessionId);
  if (!payload) return null;
  return {
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    sessionId: payload.sessionId,
  };
}

export async function resolveSessionIdForKey({ agentId, sessionKey, title, workspaceRoot } = {}) {
  const normAgentId = normalizeAgentId(agentId);
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return {
      agentId: normAgentId,
      sessionKey: null,
      sessionId: null,
      created: false,
    };
  }

  const existingId = await getSessionIdForKey({ agentId: normAgentId, sessionKey: key });
  if (existingId) {
    const loaded = loadSession(existingId, { agentId: normAgentId });
    if (loaded && loaded.id) {
      return {
        agentId: normAgentId,
        sessionKey: key,
        sessionId: loaded.id,
        created: false,
      };
    }
  }

  const ws = String(workspaceRoot || '').trim() || resolveWorkspaceRoot();
  const t = String(title || '').trim() || 'Arcana Session';
  const created = createSession({ title: t, workspace: ws, agentId: normAgentId });
  const sid = created && created.id ? created.id : null;
  if (sid) {
    await setSessionIdForKey({ agentId: normAgentId, sessionKey: key, sessionId: sid });
  }

  return {
    agentId: normAgentId,
    sessionKey: key,
    sessionId: sid,
    created: true,
  };
}

export default {
  normalizeAgentId,
  normalizeSessionKey,
  getSessionIdForKey,
  setSessionIdForKey,
  resolveSessionIdForKey,
};
