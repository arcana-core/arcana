import { nowMs } from '../util.js';
import { logError } from '../../util/error.js';

export function createScheduler({ wakeDelayMsDefault = 250, cronStore, trace, wsHub } = {}){
  const wakes = new Map();
  let engine = null;
  let cronTimer = null;
  let running = false;

  function setEngine(e){
    engine = e || null;
  }

  function clearWake(key){
    const entry = wakes.get(key);
    if (!entry) return;
    if (entry.timer){
      try { clearTimeout(entry.timer); } catch {}
    }
    wakes.delete(key);
  }

  function scheduleWakeTimer(key){
    const entry = wakes.get(key);
    if (!entry) return;
    const now = nowMs();
    const delay = Math.max(0, entry.dueAtMs - now);
    entry.timer = setTimeout(async () => {
      clearWake(key);
      try {
        if (engine && typeof engine.tick === 'function'){
          await engine.tick({
            agentId: entry.agentId,
            sessionKey: entry.sessionKey,
            reason: entry.reason,
            skipIfRunning: true,
          });
        }
      } catch (e) {
        try {
          logError('[arcana:gateway-v2] scheduler wake error', e);
        } catch {}
      }
    }, delay);
  }

  function requestWake(opts = {}){
    const agentId = opts.agentId || 'default';
    const sessionKey = opts.sessionKey || 'session';
    const key = agentId + '::' + sessionKey;

    const rawPriority = Number(opts.priority);
    const priority = Number.isFinite(rawPriority) ? rawPriority : 0;

    const baseDelayMs = Number(opts.delayMs);
    const delayMs = (Number.isFinite(baseDelayMs) && baseDelayMs >= 0) ? baseDelayMs : wakeDelayMsDefault;

    const now = nowMs();
    const dueAtMs = now + delayMs;
    const reason = opts.reason || 'wake';

    const existing = wakes.get(key);
    if (existing){
      const newDueAtMs = Math.min(existing.dueAtMs, dueAtMs);
      const newPriority = Math.max(existing.priority, priority);
      const changed = (newDueAtMs !== existing.dueAtMs) || (newPriority !== existing.priority) || (reason !== existing.reason);
      if (!changed) return existing;
      if (existing.timer){
        try { clearTimeout(existing.timer); } catch {}
      }
      const updated = { ...existing, dueAtMs: newDueAtMs, priority: newPriority, reason };
      wakes.set(key, updated);
      scheduleWakeTimer(key);
      if (wsHub && typeof wsHub.broadcast === 'function'){
        try {
          wsHub.broadcast({
            type: 'wake.scheduled',
            agentId,
            sessionKey,
            delayMs: Math.max(0, newDueAtMs - now),
          });
        } catch {}
      }
      return updated;
    }

    const entry = { agentId, sessionKey, priority, reason, dueAtMs, timer: null };
    wakes.set(key, entry);
    scheduleWakeTimer(key);

    if (wsHub && typeof wsHub.broadcast === 'function'){
      try {
        wsHub.broadcast({
          type: 'wake.scheduled',
          agentId,
          sessionKey,
          delayMs,
        });
      } catch {}
    }

    return entry;
  }

  async function scanCron(){
    if (!cronStore || !engine) return;
    const now = nowMs();
    let dueJobs = [];
    try {
      dueJobs = await cronStore.findDueJobs({ nowMs: now });
    } catch (e) {
      try {
        logError('[arcana:gateway-v2] cron scan error', e);
      } catch {}
      return;
    }

    if (!Array.isArray(dueJobs) || !dueJobs.length) return;

    for (const job of dueJobs){
      if (!job) continue;
      const agentId = job.agentId || 'default';
      const sessionKey = job.sessionKey || 'session';
      const priority = typeof job.priority === 'number' ? job.priority : 1;
      const reason = 'cron:' + (job.id || '');
      try {
        requestWake({ agentId, sessionKey, priority, reason, delayMs: 0 });
      } catch {}

      if (cronStore && typeof cronStore.recordRun === 'function'){
        try {
          await cronStore.recordRun(job.id, { status: 'scheduled', trigger: 'cron_due' });
        } catch {}
      }
    }
  }

  function start(){
    if (running) return;
    running = true;
    if (cronStore){
      const intervalMs = 5000;
      cronTimer = setInterval(() => {
        scanCron().catch(() => {});
      }, intervalMs);
    }
  }

  function stop(){
    running = false;
    if (cronTimer){
      try { clearInterval(cronTimer); } catch {}
      cronTimer = null;
    }
    for (const [key, entry] of wakes){
      if (entry && entry.timer){
        try { clearTimeout(entry.timer); } catch {}
      }
    }
    wakes.clear();
  }

  return { requestWake, start, stop, setEngine };
}

export default { createScheduler };
