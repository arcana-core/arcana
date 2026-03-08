const DEFAULT_COALESCE_MS = 250;
const RETRY_DELAY_MS = 1000;

let handler = null;
let handlerGeneration = 0;

const pendingByKey = new Map();
let scheduled = false;
let running = false;
let timer = null;
let timerDueAt = null;
let timerKind = null; // "normal" | "retry" | null

function normalizeId(value) {
  return value == null ? '' : String(value);
}

function makeKey(agentId, sessionId) {
  return `${agentId}::${sessionId}`;
}

function normalizeReason(reason) {
  const raw = typeof reason === 'string' ? reason.trim() : '';
  return raw || 'interval';
}

function reasonPriority(reason) {
  const r = String(reason || '').toLowerCase();
  if (r === 'retry') return 3;
  if (r === 'interval') return 2;
  return 1;
}

function queuePendingWake({ reason, agentId, sessionId, requestedAt }) {
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);
  const key = makeKey(normalizedAgentId, normalizedSessionId);

  const normalizedReason = normalizeReason(reason);
  const priority = reasonPriority(normalizedReason);
  const ts = typeof requestedAt === 'number' && Number.isFinite(requestedAt)
    ? requestedAt
    : Date.now();

  const next = {
    reason: normalizedReason,
    priority,
    requestedAt: ts,
    agentId: normalizedAgentId,
    sessionId: normalizedSessionId,
  };

  const previous = pendingByKey.get(key);
  if (!previous) {
    pendingByKey.set(key, next);
    return;
  }

  if (next.priority > previous.priority || (next.priority === previous.priority && next.requestedAt >= previous.requestedAt)) {
    pendingByKey.set(key, next);
  }
}

function schedule(coalesceMs, kind = 'normal') {
  const delayNumber = typeof coalesceMs === 'number' && Number.isFinite(coalesceMs)
    ? coalesceMs
    : DEFAULT_COALESCE_MS;
  const delay = delayNumber < 0 ? 0 : delayNumber;

  if (!handler) {
    return;
  }

  const dueAt = Date.now() + delay;

  if (timer) {
    if (timerKind === 'retry') {
      if (kind === 'normal') {
        // Do not preempt an existing retry timer with a normal wake.
        return;
      }
      // For another retry, keep the earlier one.
      if (typeof timerDueAt === 'number' && timerDueAt <= dueAt) {
        return;
      }
      clearTimeout(timer);
      timer = null;
      timerDueAt = null;
      timerKind = null;
    } else {
      // Existing normal timer: keep it if it fires sooner.
      if (typeof timerDueAt === 'number' && timerDueAt <= dueAt) {
        return;
      }
      clearTimeout(timer);
      timer = null;
      timerDueAt = null;
      timerKind = null;
    }
  }

  if (pendingByKey.size === 0) {
    return;
  }

  timerKind = kind;
  timerDueAt = dueAt;

  timer = setTimeout(async () => {
    timer = null;
    timerDueAt = null;
    timerKind = null;
    scheduled = false;

    const active = handler;
    if (!active) {
      return;
    }

    if (running) {
      // A batch is already in-flight; reschedule using the same delay/kind.
      scheduled = true;
      schedule(delay, kind);
      return;
    }

    const batch = Array.from(pendingByKey.values());
    pendingByKey.clear();
    if (batch.length === 0) {
      return;
    }

    running = true;
    try {
      for (const pending of batch) {
        const payload = {};
        if (pending.reason != null) payload.reason = pending.reason;
        if (pending.agentId != null) payload.agentId = pending.agentId;
        if (pending.sessionId != null) payload.sessionId = pending.sessionId;

        try {
          const result = await active(payload);
          if (result && result.status === 'skipped' && result.reason === 'requests_in_flight') {
            queuePendingWake({
              reason: 'retry',
              agentId: pending.agentId,
              sessionId: pending.sessionId,
            });
            schedule(RETRY_DELAY_MS, 'retry');
          }
        } catch {
          // On handler error, schedule a retry for this wake.
          queuePendingWake({
            reason: 'retry',
            agentId: pending.agentId,
            sessionId: pending.sessionId,
          });
          schedule(RETRY_DELAY_MS, 'retry');
        }
      }
    } finally {
      running = false;
      if (pendingByKey.size > 0 || scheduled) {
        schedule(delay, 'normal');
      }
    }
  }, delay);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

export function setHeartbeatWakeHandler(next) {
  if (next != null && typeof next !== 'function') {
    throw new TypeError('heartbeat wake handler must be a function or null');
  }

  handlerGeneration += 1;
  const generation = handlerGeneration;
  handler = next || null;

  if (handler) {
    // Fresh lifecycle: clear timers and reset state, but keep pending wakes.
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    timerDueAt = null;
    timerKind = null;
    running = false;
    scheduled = false;

    if (pendingByKey.size > 0) {
      schedule(DEFAULT_COALESCE_MS, 'normal');
    }
  }

  return () => {
    if (handlerGeneration !== generation) {
      return;
    }
    if (handler !== (next || null)) {
      return;
    }
    handlerGeneration += 1;
    handler = null;

    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    timerDueAt = null;
    timerKind = null;
    running = false;
    scheduled = false;
  };
}

export function requestHeartbeatNow(options = {}) {
  const { reason, agentId, sessionId, coalesceMs } = options;

  queuePendingWake({
    reason,
    agentId,
    sessionId,
  });

  const delay = typeof coalesceMs === 'number' && Number.isFinite(coalesceMs)
    ? coalesceMs
    : DEFAULT_COALESCE_MS;

  schedule(delay, 'normal');
}

export default { setHeartbeatWakeHandler, requestHeartbeatNow };
