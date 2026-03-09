import { loadAgentsSnapshot } from '../agents-snapshot.js';
import { loadHeartbeatConfigForAgent } from './config.js';
import { runHeartbeatOnce } from './run-once.js';
import { setHeartbeatWakeHandler, requestHeartbeatNow } from './wake.js';

const DEFAULT_INTERVAL_MS = 1800000; // 30 minutes, matching OpenClaw default

function nowMs() {
  return Date.now();
}

function parseIntervalMsFromConfig(config) {
  if (!config || typeof config !== 'object') {
    return DEFAULT_INTERVAL_MS;
  }

  const raw = config.every;

  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const m = /^([0-9]+)\s*([smh])$/i.exec(trimmed);
    if (m) {
      const value = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (Number.isFinite(value) && value > 0) {
        if (unit === 's') return value * 1000;
        if (unit === 'm') return value * 60 * 1000;
        if (unit === 'h') return value * 60 * 60 * 1000;
      }
    }

    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber;
    }
  }

  return DEFAULT_INTERVAL_MS;
}

async function defaultLoadAgents() {
  const snapshot = await loadAgentsSnapshot();
  const results = [];

  for (const meta of snapshot) {
    if (!meta || !meta.agentId) continue;
    const agentId = String(meta.agentId);

    let config = null;
    try {
      config = await loadHeartbeatConfigForAgent(agentId);
    } catch {
      config = null;
    }

    if (!config || typeof config !== 'object') {
      continue;
    }

    if (config.enabled === false) {
      continue;
    }

    const intervalMs = parseIntervalMsFromConfig(config);
    results.push({ agentId, intervalMs });
  }

  return results;
}

export function startHeartbeatRunner({ loadAgents, onLog } = {}) {
  const loadAgentsFn = typeof loadAgents === 'function' ? loadAgents : defaultLoadAgents;

  let stopped = false;
  let stateByAgentId = new Map();
  let timer = null;
  let nextTimerDueMs = null;
  let updating = false;
  let pendingUpdate = false;

  async function refreshAgents() {
    if (stopped) return;
    if (updating) {
      pendingUpdate = true;
      return;
    }

    updating = true;
    try {
      const loaded = await loadAgentsFn();
      const now = nowMs();
      const nextState = new Map();

      if (Array.isArray(loaded)) {
        for (const entry of loaded) {
          if (!entry || !entry.agentId) continue;
          const agentId = String(entry.agentId);
          const intervalMs = typeof entry.intervalMs === 'number' && Number.isFinite(entry.intervalMs) && entry.intervalMs > 0
            ? entry.intervalMs
            : DEFAULT_INTERVAL_MS;

          const prev = stateByAgentId.get(agentId) || {};
          const nextDueMs = typeof prev.nextDueMs === 'number' && Number.isFinite(prev.nextDueMs)
            ? prev.nextDueMs
            : now + intervalMs;

          nextState.set(agentId, {
            intervalMs,
            nextDueMs,
            lastRunMs: typeof prev.lastRunMs === 'number' ? prev.lastRunMs : null,
            lastStatus: prev.lastStatus ?? null,
            lastReason: prev.lastReason ?? null,
          });
        }
      }

      stateByAgentId = nextState;
      scheduleTick();
    } finally {
      updating = false;
      if (pendingUpdate && !stopped) {
        pendingUpdate = false;
        await refreshAgents();
      }
    }
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    nextTimerDueMs = null;
  }

  async function fireDueAgents() {
    if (stopped) return;

    const now = nowMs();
    const dueAgentIds = [];

    for (const [agentId, state] of stateByAgentId.entries()) {
      if (typeof state.nextDueMs === 'number' && state.nextDueMs <= now) {
        dueAgentIds.push(agentId);
      }
    }

    if (dueAgentIds.length === 0) {
      scheduleTick();
      return;
    }

    for (const agentId of dueAgentIds) {
      const state = stateByAgentId.get(agentId);
      if (!state) continue;
      const intervalMs = typeof state.intervalMs === 'number' && Number.isFinite(state.intervalMs) && state.intervalMs > 0
        ? state.intervalMs
        : DEFAULT_INTERVAL_MS;

      state.nextDueMs = now + intervalMs;
      stateByAgentId.set(agentId, state);

      requestHeartbeatNow({ reason: 'interval', agentId });
    }

    scheduleTick();
  }

  function scheduleTick() {
    if (stopped) return;

    clearTimer();

    let soonest = Infinity;
    for (const state of stateByAgentId.values()) {
      if (typeof state.nextDueMs === 'number' && Number.isFinite(state.nextDueMs) && state.nextDueMs < soonest) {
        soonest = state.nextDueMs;
      }
    }

    if (!Number.isFinite(soonest)) {
      return;
    }

    const now = nowMs();
    const delay = Math.max(0, soonest - now);
    nextTimerDueMs = now + delay;

    timer = setTimeout(() => {
      timer = null;
      nextTimerDueMs = null;
      fireDueAgents().catch(() => {});
    }, delay);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  const initialLoadPromise = refreshAgents();

  const disposeWakeHandler = setHeartbeatWakeHandler(async ({ agentId, sessionId, sessionKey, reason } = {}) => {
    const safeAgentId = agentId == null ? '' : String(agentId);
    const safeSessionKey = sessionKey == null ? '' : String(sessionKey);
    const safeSessionId = sessionId == null ? '' : String(sessionId);
    const startedAtMs = nowMs();

    let result;
    try {
      result = await runHeartbeatOnce({
        agentId: safeAgentId,
        sessionId: safeSessionId || undefined,
        sessionKey: safeSessionKey || undefined,
        reason,
      });
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error);
      result = {
        status: 'error',
        reason: message,
        agentId: safeAgentId || null,
        sessionId: safeSessionId || null,
      };
    }

    const finishedAtMs = nowMs();

    const prev = stateByAgentId.get(safeAgentId) || {};
    const intervalMs = typeof prev.intervalMs === 'number' && Number.isFinite(prev.intervalMs) && prev.intervalMs > 0
      ? prev.intervalMs
      : DEFAULT_INTERVAL_MS;

    const nextState = {
      intervalMs,
      nextDueMs: typeof prev.nextDueMs === 'number' && Number.isFinite(prev.nextDueMs)
        ? prev.nextDueMs
        : finishedAtMs + intervalMs,
      lastRunMs: finishedAtMs,
      lastStatus: result && result.status ? String(result.status) : 'unknown',
      lastReason: result && result.reason != null ? String(result.reason) : (prev.lastReason ?? null),
      };

    if (safeAgentId) {
      stateByAgentId.set(safeAgentId, nextState);
    }

    if (typeof onLog === 'function') {
      try {
          await onLog({
            ...result,
            agentId: result && result.agentId != null ? result.agentId : (safeAgentId || null),
          sessionId: result && result.sessionId != null ? result.sessionId : (safeSessionId || null),
          reason: reason ?? (result ? result.reason : undefined),
            startedAtMs,
          finishedAtMs,
        });
      } catch {
        // Ignore logging errors.
      }
    }

    return result;
  });

  async function stop() {
    if (stopped) return;
    stopped = true;

    clearTimer();

    try {
      disposeWakeHandler();
    } catch {
      // ignore
    }

    try {
      await initialLoadPromise;
    } catch {
      // ignore
    }
  }

  function status() {
    const agents = {};
    for (const [agentId, state] of stateByAgentId.entries()) {
      agents[agentId] = { ...state };
    }
    return {
      stopped,
      nextDueMs: nextTimerDueMs,
      agents,
    };
  }

  async function update() {
    if (stopped) return;
    await refreshAgents();
  }

  return { stop, status, update };
}

// Backwards-compatible wrapper matching the previous serveLoop API.
export async function serveLoop({ intervalMs, workspaceRoot, onResult, shouldContinue } = {}) { // eslint-disable-line no-unused-vars
  const loadAgents = async () => {
    const snapshot = await loadAgentsSnapshot();
    const agents = [];

    for (const meta of snapshot) {
      if (!meta || !meta.agentId) continue;
      const agentId = String(meta.agentId);

      let config = null;
      try {
        config = await loadHeartbeatConfigForAgent(agentId);
      } catch {
        config = null;
      }

      if (!config || typeof config !== 'object') continue;
      if (config.enabled === false) continue;

      let resolvedInterval = parseIntervalMsFromConfig(config);
      if (typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0) {
        resolvedInterval = intervalMs;
      }

      agents.push({ agentId, intervalMs: resolvedInterval });
    }

    return agents;
  };

  const runner = startHeartbeatRunner({
    loadAgents,
    async onLog(res) {
      if (typeof onResult === 'function') {
        try {
          await onResult(res);
        } catch {
          // ignore
        }
      }
    },
  });

  const shouldContinueFn = typeof shouldContinue === 'function' ? shouldContinue : () => true;

  while (shouldContinueFn()) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await runner.stop();
}

export default { startHeartbeatRunner, serveLoop };
