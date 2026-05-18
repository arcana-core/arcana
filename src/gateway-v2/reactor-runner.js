import { dirname, join } from 'node:path';

import { arcanaHomePath } from '../arcana-home.js';
import { ensureDir, nowMs } from './util.js';
import { readEventsSince } from './event-store.js';
import { getState, patchState } from './state-store.js';
import { runArcanaTask } from '../cron/arcana-task.js';
import { normalizeChatAttachments } from './chat-attachments.js';

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

function sortMessageEvents(events){
  return events.slice().sort((a, b) => {
    const ta = Number(a && a.tsMs || 0);
    const tb = Number(b && b.tsMs || 0);
    if (ta !== tb) return ta - tb;
    const ea = String(a && a.eventId || '');
    const eb = String(b && b.eventId || '');
    return ea.localeCompare(eb);
  });
}

function renderMergedUserText(messageEvents){
  const sorted = sortMessageEvents(Array.isArray(messageEvents) ? messageEvents : []);
  const texts = sorted
    .map((event) => {
      const text = event && event.data && event.data.text != null ? String(event.data.text) : '';
      return text.trim();
    })
    .filter(Boolean);

  if (!texts.length) return '';
  if (texts.length === 1) return texts[0];
  return texts.join('\n\n[Follow-up]\n');
}

function selectPendingMessageBatch(events){
  const messageEvents = events.filter((e) => e && e.type === 'message');
  if (!messageEvents.length) {
    return {
      messageEvents: [],
      latestMessageEvent: null,
      mergedText: '',
      mergedAttachments: [],
      replyToEventId: null,
      processedThroughTs: 0,
    };
  }

  const sorted = sortMessageEvents(messageEvents);
  const latest = sorted[sorted.length - 1];
  const mergedAttachments = sorted.flatMap((event) => normalizeChatAttachments(event && event.data && event.data.attachments));
  const latestTs = Number(latest && latest.tsMs || 0) || 0;
  const processedThroughTs = events.reduce((acc, ev) => {
    const ts = Number(ev && ev.tsMs || 0);
    if (ts > latestTs) return acc;
    return ts > acc ? ts : acc;
  }, 0);
  const replyToEventId = latest && latest.eventId ? String(latest.eventId || '') : null;
  return {
    messageEvents: sorted,
    latestMessageEvent: latest,
    mergedText: renderMergedUserText(sorted),
    mergedAttachments,
    replyToEventId,
    processedThroughTs,
  };
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

function normalizeErrorMessage(value){
  try {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
    if (value && typeof value.code === 'string' && value.code.trim()) return value.code.trim();
    if (value != null) {
      const s = String(value).trim();
      if (s) return s;
    }
  } catch {}
  return 'arcana_task_failed';
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
      return { ok: true, completed: true, ran: false, lastSeenTs: nextTs, outputs: [], nextWakeDelayMs: null };
    }

    const {
      messageEvents,
      latestMessageEvent,
      mergedText,
      mergedAttachments,
      replyToEventId,
      processedThroughTs,
    } = selectPendingMessageBatch(events);
    const newLastSeenTs = computeNextLastSeenTs(events, lastSeenTs);

    if (!latestMessageEvent){
      await updateReactorState({ agentId, sessionKey, state, lastSeenTs: newLastSeenTs, sessionId: null });
      return { ok: true, completed: true, ran: false, lastSeenTs: newLastSeenTs, outputs: [], nextWakeDelayMs: null };
    }

    // Use the most recent message's policy (open|restricted) when available.
    let execPolicy = undefined;
    try {
      const rawPol = latestMessageEvent && latestMessageEvent.data && latestMessageEvent.data.policy ? String(latestMessageEvent.data.policy) : '';
      const p = rawPol.trim().toLowerCase();
      if (p === 'open' || p === 'restricted') execPolicy = p;
    } catch {}

    const attachments = normalizeChatAttachments(mergedAttachments);
    const userText = String(mergedText || '').trim() || (attachments.length ? 'See attached image.' : '');

    if (!userText){
      const nextSeenTs = processedThroughTs > 0 ? processedThroughTs : newLastSeenTs;
      await updateReactorState({ agentId, sessionKey, state, lastSeenTs: nextSeenTs, sessionId: null });
      return { ok: true, completed: true, ran: false, lastSeenTs: nextSeenTs, outputs: [], nextWakeDelayMs: null };
    }

    const logPath = buildLogPath(agentId, sessionKey);
    await ensureDir(dirname(logPath));
    const messageEventId = latestMessageEvent && latestMessageEvent.eventId ? String(latestMessageEvent.eventId || '') : '';
    const retryingSameEvent = !!(
      messageEventId
      && state
      && state.value
      && typeof state.value.activeEventId === 'string'
      && String(state.value.activeEventId || '') === messageEventId
    );

    try {
      await patchState({
        agentId,
        sessionKey,
        scope: 'reactor',
        expectedVersion: state.version,
        mutator: (value) => ({
          ...(value || {}),
          activeEventId: messageEventId || null,
        }),
      });
    } catch {}

    const result = await runArcanaTask({
      prompt: userText,
      sessionId: state && state.value && state.value.sessionId ? state.value.sessionId : undefined,
      sessionKey,
      logPath,
      agentId,
      execPolicy,
      retryingEventId: retryingSameEvent ? messageEventId : '',
      attachments,
    });

    const sessionId = result && result.sessionId;
    const assistantText = result && result.assistantText ? String(result.assistantText || '') : '';

    // Only consume the inbox message when we actually produced a visible assistant result.
    // For `ok + no output`, keep the merged batch pending so wake-agent retries the same turn.
    const ranOk = !!(result && result.ok);
    const hasAssistantOutput = !!assistantText;
    const advanceLastSeen = ranOk && hasAssistantOutput; // do NOT advance on error or no-output recovery turns
    const consumeThroughTs = processedThroughTs > 0
      ? processedThroughTs
      : (
        messageEvents.reduce((acc, event) => {
          const ts = Number(event && event.tsMs || 0);
          return ts > acc ? ts : acc;
        }, 0) || lastSeenTs
      );
    const nextLastSeenTs = advanceLastSeen ? consumeThroughTs : lastSeenTs;

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
          activeEventId: advanceLastSeen ? null : (messageEventId || ((value && value.activeEventId) || null)),
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
      completed: !!(result && result.completed),
      aborted: !!(result && result.aborted),
      ran: true,
      lastSeenTs: nextLastSeenTs,
      processedThroughTs: consumeThroughTs,
      sessionId: sessionId || null,
      outputs,
      nextWakeDelayMs,
      // Pass-through error fields if present so engine can log/broadcast
      error: result && typeof result.error !== 'undefined' ? result.error : undefined,
      errorMessage: ranOk ? '' : normalizeErrorMessage(result && (result.errorMessage || result.error)),
      errorStack: result && typeof result.errorStack === 'string' ? result.errorStack : undefined,
    };
  },
};

export async function runReactorTurn({ agentId, sessionKey, wsHub }){ // wsHub kept for backward compat
  const res = await reactorRunner.run({ agentId, sessionKey, wsHub });
  return res;
}

export default { reactorRunner, runReactorTurn };
