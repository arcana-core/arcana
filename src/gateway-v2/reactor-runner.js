import { dirname, join } from 'node:path';

import { arcanaHomePath } from '../arcana-home.js';
import { ensureDir, nowMs } from './util.js';
import { readEventsSince } from './event-store.js';
import { getState, patchState } from './state-store.js';
import { runArcanaTask } from '../cron/arcana-task.js';

function buildLogPath(agentId, sessionKey){
  const base = arcanaHomePath('gateway-v2', 'logs');
  const safeAgent = String(agentId || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  const safeSession = String(sessionKey || 'session').replace(/[^A-Za-z0-9_-]/g, '_');
  const stamp = String(nowMs());
  return join(base, safeAgent + '__' + safeSession + '__' + stamp + '.log');
}

async function loadNewEvents({ agentId, sessionKey }){
  const aId = agentId || 'default';
  const sKey = sessionKey || 'session';
  const scope = 'reactor';

  const state = await getState({ agentId: aId, sessionKey: sKey, scope });
  const lastSeenTs = Number(state && state.value && state.value.lastSeenTs || 0) || 0;

  const events = await readEventsSince({ agentId: aId, sessionKey: sKey, sinceTs: lastSeenTs, limit: 100 });
  return { state, lastSeenTs, events };
}

function selectLatestMessageEvent(events){
  const messageEvents = events.filter((e) => e && e.type === 'message');
  if (!messageEvents.length) return { messageEvents, replyToEventId: null };

  let latest = messageEvents[0];
  for (const ev of messageEvents){
    const t = Number(ev && ev.tsMs || 0);
    const cur = Number(latest && latest.tsMs || 0);
    if (t > cur) latest = ev;
  }
  const replyToEventId = latest && latest.eventId ? String(latest.eventId || '') : null;
  return { messageEvents, replyToEventId };
}

function computeNextLastSeenTs(events, lastSeenTs){
  const maxTs = events.reduce((acc, e) => {
    const t = Number(e && e.tsMs || 0);
    return t > acc ? t : acc;
  }, lastSeenTs);
  return maxTs > lastSeenTs ? maxTs : lastSeenTs;
}

function computeBackoffMs(errorCount){
  const base = 2000; // 2s
  const cap = 60000; // 60s
  const n = Number(errorCount || 0);
  const pow = n > 0 ? Math.pow(2, Math.max(0, n - 1)) : 0;
  const raw = Math.min(cap, base * (pow || 1));
  const jitter = 0.2 * raw; // +/-20%
  const delta = (Math.random() * 2 * jitter) - jitter;
  const v = Math.max(0, Math.round(raw + delta));
  return v;
}

async function updateReactorState({ agentId, sessionKey, state, lastSeenTs, sessionId }){
  const aId = agentId || 'default';
  const sKey = sessionKey || 'session';
  const scope = 'reactor';

  const newLastSeenTs = lastSeenTs;
  const result = await patchState({
    agentId: aId,
    sessionKey: sKey,
    scope,
    expectedVersion: state.version,
    mutator: (value) => ({
      ...(value || {}),
      lastSeenTs: newLastSeenTs,
      sessionId: sessionId != null ? sessionId : ((value && value.sessionId) || null),
      lastRunAtMs: nowMs(),
    }),
  });

  return result;
}

export const reactorRunner = {
  id: 'reactor',

  async run(ctx){
    const agentId = ctx && ctx.agentId ? ctx.agentId : 'default';
    const sessionKey = ctx && ctx.sessionKey ? ctx.sessionKey : 'session';

    const { state, lastSeenTs, events } = await loadNewEvents({ agentId, sessionKey });

    if (!events.length){
      const now = nowMs();
      const nextTs = now > lastSeenTs ? now : lastSeenTs;
      await patchState({
        agentId,
        sessionKey,
        scope: 'reactor',
        expectedVersion: state.version,
        mutator: (value) => ({ ...(value || {}), lastSeenTs: nextTs }),
      });
      return { ok: true, ran: false, lastSeenTs: nextTs, outputs: [], nextWakeDelayMs: null };
    }

    const { messageEvents, replyToEventId } = selectLatestMessageEvent(events);
    const newLastSeenTs = computeNextLastSeenTs(events, lastSeenTs);

    if (!messageEvents.length){
      await updateReactorState({ agentId, sessionKey, state, lastSeenTs: newLastSeenTs, sessionId: null });
      return { ok: true, ran: false, lastSeenTs: newLastSeenTs, outputs: [], nextWakeDelayMs: null };
    }

    // Use the most recent message's policy (open|restricted) when available
    let execPolicy = undefined;
    try {
      const lastMsg = messageEvents[messageEvents.length - 1];
      const rawPol = lastMsg && lastMsg.data && lastMsg.data.policy ? String(lastMsg.data.policy) : '';
      const p = rawPol.trim().toLowerCase();
      if (p === 'open' || p === 'restricted') execPolicy = p;
    } catch {}

    const userText = messageEvents
      .map((e) => {
        const d = e && e.data;
        const t = d && d.text;
        return t ? String(t) : '';
      })
      .filter((t) => t)
      .join('\n');

    if (!userText){
      await updateReactorState({ agentId, sessionKey, state, lastSeenTs: newLastSeenTs, sessionId: null });
      return { ok: true, ran: false, lastSeenTs: newLastSeenTs, outputs: [], nextWakeDelayMs: null };
    }

    const logPath = buildLogPath(agentId, sessionKey);
    await ensureDir(dirname(logPath));

    const result = await runArcanaTask({
      prompt: userText,
      sessionId: state && state.value && state.value.sessionId ? state.value.sessionId : undefined,
      sessionKey,
      logPath,
      agentId,
      execPolicy,
    });

    const sessionId = result && result.sessionId;
    const assistantText = result && result.assistantText ? String(result.assistantText || '') : '';

    // Decide whether to advance lastSeenTs based on run result
    const ranOk = !!(result && result.ok);
    const advanceLastSeen = ranOk; // do NOT advance on error
    const nextLastSeenTs = advanceLastSeen ? newLastSeenTs : lastSeenTs;

    // Persist reactor state with error tracking and lastSeenTs/sessionId
    const prevErrorCount = Number(state && state.value && state.value.errorCount || 0) || 0;
    const newErrorCount = ranOk ? 0 : (prevErrorCount + 1);
    const now = nowMs();
    try {
      await patchState({
        agentId,
        sessionKey,
        scope: 'reactor',
        expectedVersion: state.version,
        mutator: (value) => ({
          ...(value || {}),
          lastSeenTs: nextLastSeenTs,
          sessionId: sessionId != null ? sessionId : ((value && value.sessionId) || null),
          lastRunAtMs: now,
          errorCount: newErrorCount,
          lastErrorAtMs: ranOk ? null : now,
        }),
      });
    } catch {}

    const outputs = [];
    if (assistantText){
      outputs.push({
        kind: 'assistant_message',
        text: assistantText,
        sessionId: sessionId || null,
        replyToEventId: replyToEventId || null,
      });
    }

    let nextWakeDelayMs = null;
    try {
      if (!ranOk){
        nextWakeDelayMs = computeBackoffMs(newErrorCount);
      } else if (!assistantText){
        nextWakeDelayMs = 30 * 1000;
      }
    } catch {}

    return {
      ok: ranOk,
      ran: true,
      lastSeenTs: nextLastSeenTs,
      sessionId: sessionId || null,
      outputs,
      nextWakeDelayMs,
      // Pass-through error fields if present so engine can log/broadcast
      error: result && typeof result.error !== 'undefined' ? result.error : undefined,
      errorStack: result && typeof result.errorStack === 'string' ? result.errorStack : undefined,
    };
  },
};

export async function runReactorTurn({ agentId, sessionKey, wsHub }){ // wsHub kept for backward compat
  const res = await reactorRunner.run({ agentId, sessionKey, wsHub });
  return res;
}

export default { reactorRunner, runReactorTurn };
