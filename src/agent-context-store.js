import { existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '../node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js';
import { arcanaHomePath, ensureArcanaHomeDir } from './arcana-home.js';
import { loadSessionMeta, saveSessionMeta } from './session-meta-store.js';

const DEFAULT_AGENT_ID = 'default';
const DEFAULT_MAX_CONTEXTS = 200;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_KEEP_ARCHIVED_GENERATIONS = 1;

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
    return s.replace(/[^A-Za-z0-9_-]/g, '_');
  } catch {
    return '';
  }
}

function ensureDir(dir){
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function contextDir(agentId){
  ensureArcanaHomeDir();
  return ensureDir(arcanaHomePath('agents', normalizeAgentId(agentId), 'contexts'));
}

export function contextArchiveDir(agentId){
  return ensureDir(join(contextDir(agentId), 'archive'));
}

export function contextFilePath({ agentId, sessionId } = {}){
  const sid = normalizeSessionId(sessionId);
  if (!sid) return '';
  return join(contextDir(agentId), sid + '.jsonl');
}

function readPositiveInt(raw, fallback){
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function resolveContextStorePolicy(config = {}){
  const cfg = config && typeof config === 'object' ? config : {};
  const nested = cfg.agent_context_cache && typeof cfg.agent_context_cache === 'object'
    ? cfg.agent_context_cache
    : {};
  return {
    diskMaxContexts: readPositiveInt(
      nested.disk_max_sessions ?? nested.diskMaxSessions ?? process.env.ARCANA_CONTEXT_DISK_MAX_SESSIONS,
      DEFAULT_MAX_CONTEXTS,
    ),
    diskMaxBytes: readPositiveInt(
      nested.disk_max_bytes ?? nested.diskMaxBytes ?? process.env.ARCANA_CONTEXT_DISK_MAX_BYTES,
      DEFAULT_MAX_BYTES,
    ),
    keepArchivedGenerations: readPositiveInt(
      nested.disk_keep_archived_generations ?? nested.diskKeepArchivedGenerations ?? process.env.ARCANA_CONTEXT_KEEP_ARCHIVED_GENERATIONS,
      DEFAULT_KEEP_ARCHIVED_GENERATIONS,
    ),
  };
}

export function openContextSessionManager({ agentId, sessionId, workspaceRoot } = {}){
  const contextPath = contextFilePath({ agentId, sessionId });
  if (!contextPath) return { sessionManager: null, contextPath: '' };
  const dir = contextDir(agentId);
  const sessionManager = SessionManager.open(contextPath, dir);
  try {
    const header = sessionManager.getHeader && sessionManager.getHeader();
    if (header && workspaceRoot && !header.cwd) header.cwd = String(workspaceRoot || '');
  } catch {}
  return { sessionManager, contextPath };
}

function makeTextMessage(role, text){
  const r = String(role || 'user').trim();
  const safeRole = r === 'assistant' ? 'assistant' : 'user';
  return {
    role: safeRole,
    content: [{ type: 'text', text: String(text || '') }],
    timestamp: Date.now(),
  };
}

function sliceMessagesByRecentUserTurns(messages, keepRecentUserTurns){
  const msgs = Array.isArray(messages) ? messages : [];
  const keep = readPositiveInt(keepRecentUserTurns, 0);
  if (!msgs.length || keep <= 0) return [];
  let idx = 0;
  let users = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1){
    if (msgs[i] && msgs[i].role === 'user'){
      users += 1;
      if (users === keep){
        idx = i;
        break;
      }
    }
  }
  if (!users) return msgs.slice(-Math.min(msgs.length, keep * 2));
  if (users < keep) return msgs.slice();
  return msgs.slice(idx);
}

function forceRewriteSessionManager(sessionManager){
  try {
    if (sessionManager && typeof sessionManager._rewriteFile === 'function'){
      sessionManager._rewriteFile();
      return true;
    }
  } catch {}
  return false;
}

function archivePathForContext(agentId, sessionId){
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sid = normalizeSessionId(sessionId) || 'session';
  return join(contextArchiveDir(agentId), sid + '--' + stamp + '.jsonl');
}

function pruneArchive(agentId, sessionId, keepArchivedGenerations){
  const keep = readPositiveInt(keepArchivedGenerations, DEFAULT_KEEP_ARCHIVED_GENERATIONS);
  const dir = contextArchiveDir(agentId);
  const sid = normalizeSessionId(sessionId);
  if (!sid) return;
  let entries = [];
  try {
    entries = readdirSync(dir)
      .filter((name) => name.startsWith(sid + '--') && name.endsWith('.jsonl'))
      .map((name) => {
        const p = join(dir, name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(p).mtimeMs; } catch {}
        return { path: p, mtimeMs };
      })
      .sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  } catch {
    entries = [];
  }
  for (const entry of entries.slice(Math.max(0, keep))){
    try { unlinkSync(entry.path); } catch {}
  }
}

export function pruneContextStore({ agentId, config, activeSessionIds } = {}){
  const policy = resolveContextStorePolicy(config);
  const active = new Set(Array.isArray(activeSessionIds) ? activeSessionIds.map((id) => normalizeSessionId(id)).filter(Boolean) : []);
  const dir = contextDir(agentId);
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const p = join(dir, name);
        const sid = name.replace(/\.jsonl$/, '');
        let st = null;
        try { st = statSync(p); } catch {}
        return { path: p, sessionId: sid, mtimeMs: st ? st.mtimeMs : 0, size: st ? st.size : 0 };
      })
      .filter((entry) => entry.path && !active.has(entry.sessionId))
      .sort((a, b) => Number(a.mtimeMs || 0) - Number(b.mtimeMs || 0));
  } catch {
    return { removed: 0, bytesRemoved: 0 };
  }

  let totalBytes = 0;
  try {
    for (const name of readdirSync(dir)){
      if (!name.endsWith('.jsonl')) continue;
      try { totalBytes += statSync(join(dir, name)).size; } catch {}
    }
  } catch {}

  let activeFileCount = 0;
  try {
    activeFileCount = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length;
  } catch {}

  let removed = 0;
  let bytesRemoved = 0;
  for (const file of files){
    const overCount = policy.diskMaxContexts > 0 && activeFileCount > policy.diskMaxContexts;
    const overBytes = policy.diskMaxBytes > 0 && totalBytes > policy.diskMaxBytes;
    if (!overCount && !overBytes) break;
    try {
      unlinkSync(file.path);
      removed += 1;
      bytesRemoved += Number(file.size || 0);
      totalBytes -= Number(file.size || 0);
      activeFileCount -= 1;
    } catch {}
  }
  return { removed, bytesRemoved };
}

export function rotateContextAfterCompaction({
  agentId,
  sessionId,
  workspaceRoot,
  historyObj,
  keepRecentUserTurns,
  config,
} = {}){
  const sid = normalizeSessionId(sessionId);
  if (!sid) return { ok: false, reason: 'missing_sessionId' };

  const targetPath = contextFilePath({ agentId, sessionId: sid });
  if (!targetPath) return { ok: false, reason: 'missing_context_path' };
  const dir = contextDir(agentId);
  const tmpPath = targetPath + '.next';
  const archivePath = archivePathForContext(agentId, sid);
  const policy = resolveContextStorePolicy(config);

  try { unlinkSync(tmpPath); } catch {}

  const manager = SessionManager.open(tmpPath, dir);
  try {
    const header = manager.getHeader && manager.getHeader();
    if (header && workspaceRoot) header.cwd = String(workspaceRoot || '');
  } catch {}
  const summary = String(historyObj && historyObj.summary || '').trim();
  const recent = sliceMessagesByRecentUserTurns(
    historyObj && Array.isArray(historyObj.messages) ? historyObj.messages : [],
    keepRecentUserTurns,
  );

  let firstKeptEntryId = null;
  for (const msg of recent){
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const text = String(msg.text || '');
    if (!text) continue;
    const id = manager.appendMessage(makeTextMessage(role, text));
    if (!firstKeptEntryId) firstKeptEntryId = id;
  }
  if (summary){
    manager.appendCompaction(summary, firstKeptEntryId, 0, { source: 'arcana_context_rotation' }, true);
  }
  forceRewriteSessionManager(manager);

  const hadPrevious = existsSync(targetPath);
  if (hadPrevious){
    try { renameSync(targetPath, archivePath); } catch { try { unlinkSync(targetPath); } catch {} }
  }
  renameSync(tmpPath, targetPath);

  pruneArchive(agentId, sid, policy.keepArchivedGenerations);
  pruneContextStore({ agentId, config, activeSessionIds: [sid] });

  try {
    const meta = loadSessionMeta(sid, { agentId }) || {};
    const generation = readPositiveInt(meta.contextGeneration, 0) + 1;
    saveSessionMeta(sid, {
      ...meta,
      contextPath: targetPath,
      contextGeneration: generation,
      compactedAt: new Date().toISOString(),
      retainedUserTurns: readPositiveInt(keepRecentUserTurns, 0),
      previousContextPath: hadPrevious ? archivePath : '',
    }, { agentId });
  } catch {}

  return { ok: true, contextPath: targetPath, archivedPath: hadPrevious ? archivePath : '', retainedMessages: recent.length };
}

export function forceFlushContextSession(session){
  try {
    const manager = session && session.sessionManager;
    return forceRewriteSessionManager(manager);
  } catch {
    return false;
  }
}

export function deleteContextFile({ agentId, sessionId } = {}){
  const p = contextFilePath({ agentId, sessionId });
  if (!p) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export default {
  contextDir,
  contextFilePath,
  openContextSessionManager,
  pruneContextStore,
  resolveContextStorePolicy,
  rotateContextAfterCompaction,
  forceFlushContextSession,
  deleteContextFile,
};
