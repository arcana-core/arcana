import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceRoot, ensureReadAllowed, ensureWriteAllowed } from '../workspace-guard.js';
import { getContext, runWithContext } from '../event-bus.js';

const DEFAULT_AGENT_ID = 'default';

const DEFAULT_STATE = {
  targets: [],
};

function nowMs() { return Date.now(); }

function normalizeAgentId(raw) {
  try {
    const s = String(raw || '').trim();
    if (!s) return DEFAULT_AGENT_ID;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function normalizeSessionKey(raw) {
  try {
    const s = String(raw || '').trim();
    if (!s) return null;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    if (!safe) return null;
    return safe;
  } catch {
    return null;
  }
}

function withWorkspaceRoot(workspaceRoot, fn) {
  if (typeof fn !== 'function') return undefined;
  if (!workspaceRoot) return fn();
  const cur = getContext?.() || {};
  const ctx = { ...cur, workspaceRoot };
  return runWithContext ? runWithContext(ctx, fn) : fn();
}

function resolveWorkspaceRootForOptions(options) {
  const optRoot = options && options.workspaceRoot;
  if (!optRoot) return resolveWorkspaceRoot();
  return withWorkspaceRoot(optRoot, () => resolveWorkspaceRoot());
}

function ensureReadInWorkspace(path, workspaceRoot) {
  return withWorkspaceRoot(workspaceRoot, () => ensureReadAllowed(path));
}

function ensureWriteInWorkspace(path, workspaceRoot) {
  return withWorkspaceRoot(workspaceRoot, () => ensureWriteAllowed(path));
}

function resolveAgentContext(options = {}) {
  const ctx = getContext?.() || {};
  const workspaceRoot = resolveWorkspaceRootForOptions(options);
  const agentIdRaw = options.agentId || ctx.agentId || DEFAULT_AGENT_ID;
  const agentId = normalizeAgentId(agentIdRaw);
  return { workspaceRoot, agentId };
}

function ensureHeartbeatBaseDir(workspaceRoot, agentId) {
  const base = join(workspaceRoot, '.arcana', 'agents', agentId, 'heartbeat');
  if (!existsSync(base)) mkdirSync(ensureWriteInWorkspace(base, workspaceRoot), { recursive: true });
  return base;
}

function statePath(options = {}) {
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureHeartbeatBaseDir(workspaceRoot, agentId);
  return { workspaceRoot, agentId, path: join(baseDir, 'targets.json') };
}

function readState(options = {}) {
  const { workspaceRoot, path } = statePath(options);
  try {
    const raw = readFileSync(ensureReadInWorkspace(path, workspaceRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.targets)) {
      return {
        targets: parsed.targets.map((t) => ({ ...t })),
      };
    }
  } catch {}
  return { ...DEFAULT_STATE, targets: [] };
}

function writeState(options = {}, state) {
  const { workspaceRoot, path } = statePath(options);
  const payload = state && typeof state === 'object' ? state : DEFAULT_STATE;
  const data = JSON.stringify(payload, null, 2);
  writeFileSync(ensureWriteInWorkspace(path, workspaceRoot), data, 'utf-8');
}

function ensureTarget(state, sessionKey) {
  const skey = normalizeSessionKey(sessionKey);
  if (!skey) return null;
  const targets = state.targets || [];
  let t = targets.find((x) => x && (x.sessionKey === skey || x.sessionId === skey));
  if (!t) {
    t = {
      sessionKey: skey,
      sessionId: skey,
      enabled: true,
      ackMaxChars: undefined,
      intervalMs: undefined,
      lastRunAtMs: null,
      lastStatus: undefined,
      lastReason: undefined,
      lastError: undefined,
    };
    targets.push(t);
    state.targets = targets;
  } else {
    if (!t.sessionKey) t.sessionKey = skey;
    t.sessionId = t.sessionKey;
  }
  return t;
}

export function getHeartbeatTarget({ agentId, sessionId, sessionKey, workspaceRoot } = {}) {
  const key = sessionKey != null ? sessionKey : sessionId;
  const opts = { agentId, workspaceRoot };
  const state = readState(opts);
  const t = ensureTarget(state, key);
  if (!t) return null;
  writeState(opts, state);
  return { ...t };
}

export function setHeartbeatEnabled({ agentId, sessionId, sessionKey, workspaceRoot, enabled } = {}) {
  const key = sessionKey != null ? sessionKey : sessionId;
  const opts = { agentId, workspaceRoot };
  const state = readState(opts);
  const t = ensureTarget(state, key);
  if (!t) return null;
  t.enabled = enabled !== false;
  writeState(opts, state);
  return { ...t };
}

export function updateHeartbeatAfterRun({
  agentId,
  sessionKey,
  sessionId,
  workspaceRoot,
  reason,
  runStatus,
  runReason,
  startedAtMs,
  finishedAtMs,
  error,
} = {}) {
  const opts = { agentId, workspaceRoot };
  const state = readState(opts);
  const key = sessionKey != null ? sessionKey : sessionId;
  const t = ensureTarget(state, key);
  if (!t) return null;
  t.lastRunAtMs = typeof finishedAtMs === 'number' && Number.isFinite(finishedAtMs) ? finishedAtMs : nowMs();
  t.lastStatus = runStatus || t.lastStatus || undefined;
  t.lastReason = runReason || reason || t.lastReason || undefined;
  t.lastError = error ? String(error) : undefined;
  writeState(opts, state);
  return { ...t };
}

export function listHeartbeatTargets({ workspaceRoot } = {}) {
  const root = resolveWorkspaceRootForOptions({ workspaceRoot });
  const out = [];
  try {
    const agentsDir = join(root, '.arcana', 'agents');
    if (!existsSync(agentsDir)) return out;
    for (const name of readdirSync(agentsDir)) {
      const agentId = normalizeAgentId(name);
      try {
        const state = readState({ workspaceRoot: root, agentId });
        for (const t of state.targets || []) {
          if (!t) continue;
          const key = t.sessionKey || t.sessionId;
          const skey = normalizeSessionKey(key);
          if (!skey) continue;
          out.push({
            workspaceRoot: root,
            agentId,
            sessionKey: skey,
            sessionId: skey,
            enabled: t.enabled !== false,
            lastRunAtMs: typeof t.lastRunAtMs === 'number' ? t.lastRunAtMs : null,
            lastStatus: t.lastStatus || undefined,
            lastReason: t.lastReason || undefined,
          });
        }
      } catch {}
    }
  } catch {}
  return out;
}

export default {
  getHeartbeatTarget,
  setHeartbeatEnabled,
  updateHeartbeatAfterRun,
  listHeartbeatTargets,
};
