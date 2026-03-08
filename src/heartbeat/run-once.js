import { createArcanaSession } from '../session.js';
import { runWithContext } from '../event-bus.js';
import { arcanaHomePath } from '../arcana-home.js';
import { appendMessage } from '../sessions-store.js';
import { acquireSessionTurnLock, releaseSessionTurnLock } from '../cron/store.js';
import { loadAgentsSnapshot } from '../agents-snapshot.js';
import { loadHeartbeatConfigForAgent } from './config.js';
import { readAgentHeartbeatFile, isHeartbeatFileEffectivelyEmpty } from './heartbeat-file.js';
import { peekSystemEvents, ackSystemEvents } from '../system-events/store.js';
import { stripHeartbeatAck } from './ack.js';
import { updateHeartbeatAfterRun } from './store.js';

function normalizeId(value) {
  return value != null ? String(value).trim() : '';
}

function parseTimeToMinutes(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (!parts || parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23) return null;
  if (m < 0 || m > 59) return null;
  return h * 60 + m;
}

function isNowWithinActiveHours(spec) {
  if (typeof spec !== 'string') return true;
  const trimmed = spec.trim();
  if (!trimmed) return true;
  const rangeParts = trimmed.split('-');
  if (!rangeParts || rangeParts.length !== 2) return true;

  const startMinutes = parseTimeToMinutes(rangeParts[0].trim());
  const endMinutes = parseTimeToMinutes(rangeParts[1].trim());
  if (startMinutes == null || endMinutes == null) return true;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function buildEventsSummary(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return 'There are no pending system events.\n';
  }

  let text = 'Pending system events (oldest first):\n';
  for (const record of events) {
    if (!record) continue;
    const idStr = typeof record.id === 'number' ? String(record.id) : '';
    const ev = record.event;
    let summary = '';

    const topText = typeof record.text === 'string' ? record.text.trim() : '';
    if (topText) {
      summary = topText;
    } else if (ev && typeof ev === 'object') {
      const typeStr = ev.type != null ? String(ev.type).trim() : '';
      const kindStr = ev.kind != null ? String(ev.kind).trim() : '';
      const textStr = ev.text != null ? String(ev.text).trim() : '';
      summary = typeStr || kindStr || textStr;
      if (!summary) {
        try {
          summary = JSON.stringify(ev);
        } catch {
          summary = String(ev);
        }
      }
    } else if (ev != null) {
      try {
        summary = JSON.stringify(ev);
      } catch {
        summary = String(ev);
      }
    }

    if (!summary) {
      summary = '(no details)';
    }

    const topContextKey = typeof record.contextKey === 'string' ? record.contextKey : '';
    const eventContextKey = ev && typeof ev === 'object' && typeof ev.contextKey === 'string' ? ev.contextKey : '';
    const contextKey = topContextKey || eventContextKey;
    if (contextKey) {
      summary = `[${contextKey}] ${summary}`;
    }

    if (summary.length > 200) summary = summary.slice(0, 200) + '...';
    text += `- [${idStr}] ${summary}\n`;
  }
  return text;
}

function classifyEventKind(record) {
  const ev = record && record.event ? record.event : {};
  const topContextKey = record && typeof record.contextKey === 'string' ? record.contextKey : '';
  const eventContextKey = typeof ev.contextKey === 'string' ? ev.contextKey : '';

  if (topContextKey.startsWith('cron:') || eventContextKey.startsWith('cron:')) {
    return 'cron';
  }

  const kindRaw = (ev.kind || ev.type || ev.source || '').toString().toLowerCase();
  if (kindRaw === 'exec') return 'exec';
  if (kindRaw === 'cron') return 'cron';
  return 'other';
}

function buildHeartbeatPrompt({ events, heartbeatText, triggerReason, targetSessionId }) {
  const all = Array.isArray(events) ? events : [];
  const execEvents = [];
  const cronEvents = [];
  const otherEvents = [];
  for (const r of all) {
    const kind = classifyEventKind(r);
    if (kind === 'exec') execEvents.push(r);
    else if (kind === 'cron') cronEvents.push(r);
    else otherEvents.push(r);
  }

  const nowIso = new Date().toISOString();
  const baseReason = triggerReason || (execEvents.length ? 'exec' : (cronEvents.length ? 'cron' : 'interval'));

  let prompt = '';
  prompt += 'You are the Arcana workspace heartbeat agent.\n';
  prompt += 'Current time (ISO): ' + nowIso + '.\n';
  if (targetSessionId) prompt += 'Target session id: ' + targetSessionId + '.\n';
  prompt += 'Reason for this heartbeat: ' + baseReason + '.\n\n';

  if (execEvents.length) {
    prompt += 'Recent exec-related system events (oldest first):\n';
    prompt += buildEventsSummary(execEvents) + '\n\n';
  } else if (cronEvents.length) {
    prompt += 'Recent cron-related system events (oldest first):\n';
    prompt += buildEventsSummary(cronEvents) + '\n\n';
  } else if (all.length) {
    prompt += 'Recent system events (oldest first):\n';
    prompt += buildEventsSummary(all) + '\n\n';
  } else {
    prompt += 'There are no pending system events.\n\n';
  }

  if (typeof heartbeatText === 'string' && heartbeatText.trim()) {
    prompt += 'HEARTBEAT.md contents:\n';
    prompt += heartbeatText.trim() + '\n\n';
  } else {
    prompt += 'HEARTBEAT.md is empty or missing.\n\n';
  }

  prompt += 'If there is nothing important to report or no action is needed, respond exactly with: HEARTBEAT_OK.\n';
  prompt += 'If you do have something to say, you may optionally start with HEARTBEAT_OK on the first line, then add a concise message for the human on following lines.\n';

  return prompt;
}

async function resolveAgentMeta(requestedAgentId) {
  const snapshot = await loadAgentsSnapshot();
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    return { meta: null, reason: 'no_agents' };
  }

  const requested = normalizeId(requestedAgentId);
  let meta = null;

  if (requested) {
    meta = snapshot.find((a) => a && a.agentId === requested) || null;
    if (!meta) return { meta: null, reason: 'agent_not_found' };
  } else if (snapshot.length === 1) {
    meta = snapshot[0];
  } else {
    meta = snapshot.find((a) => a && a.agentId === 'default') || null;
    if (!meta) return { meta: null, reason: 'agent_required' };
  }

  if (!meta || !meta.workspaceRoot) {
    return { meta: null, reason: 'missing_workspace_root' };
  }

  return { meta, reason: null };
}

export async function runHeartbeatOnce({ agentId, sessionId, reason, workspaceRoot, ackMaxChars } = {}) {
  const requestedAgentId = normalizeId(agentId);
  const requestedSessionId = normalizeId(sessionId);
  const triggerReason = normalizeId(reason);
  const requestedWorkspaceRoot = normalizeId(workspaceRoot);

  const startedAtMs = Date.now();

  let effectiveAgentId = requestedAgentId;
  let targetSessionId = requestedSessionId;
  let effectiveWorkspaceRoot = requestedWorkspaceRoot;
  let lockPath = null;
  let lockOptions = null;

  let pendingEvents = [];
  let lastEventId = null;

  function recordRunResult(result, errorForStore) {
    const finishedAtMs = Date.now();
    try {
      const safeResult = result || {};
      const runStatus = safeResult.status || undefined;
      const runReason = typeof safeResult.reason === 'string' ? safeResult.reason : undefined;
      const storeAgentId = safeResult.agentId != null ? safeResult.agentId : (effectiveAgentId || null);
      const storeSessionId = safeResult.sessionId != null ? safeResult.sessionId : (targetSessionId || null);

      updateHeartbeatAfterRun({
        agentId: storeAgentId,
        sessionId: storeSessionId,
        workspaceRoot: effectiveWorkspaceRoot,
        reason: triggerReason || undefined,
        runStatus,
        runReason,
        startedAtMs,
        finishedAtMs,
        error: errorForStore,
      });
    } catch {
      // Ignore heartbeat store update failures.
    }
    return result;
  }

  try {
    const { meta, reason: metaReason } = await resolveAgentMeta(effectiveAgentId);
    if (!meta) {
      return recordRunResult({
        status: 'skipped',
        reason: metaReason || 'agent_unavailable',
        agentId: effectiveAgentId || null,
        sessionId: targetSessionId || null,
      });
    }

    effectiveAgentId = meta.agentId;
    if (!effectiveWorkspaceRoot) effectiveWorkspaceRoot = normalizeId(meta.workspaceRoot);

    let heartbeatConfig = null;
    try {
      heartbeatConfig = await loadHeartbeatConfigForAgent(effectiveAgentId);
    } catch {
      heartbeatConfig = null;
    }

    if (!targetSessionId && heartbeatConfig && typeof heartbeatConfig === 'object') {
      const cfgSession =
        typeof heartbeatConfig.targetSessionId === 'string'
          ? heartbeatConfig.targetSessionId
          : typeof heartbeatConfig.sessionId === 'string'
          ? heartbeatConfig.sessionId
          : '';
      targetSessionId = normalizeId(cfgSession);
    }

    if (!targetSessionId) {
      return recordRunResult({
        status: 'skipped',
        reason: 'missing_target_session',
        agentId: effectiveAgentId,
        sessionId: null,
      });
    }

    if (triggerReason === 'interval' && heartbeatConfig && typeof heartbeatConfig === 'object') {
      const rawActive = typeof heartbeatConfig.activeHours === 'string' ? heartbeatConfig.activeHours : '';
      if (rawActive && !isNowWithinActiveHours(rawActive)) {
        return recordRunResult({
          status: 'skipped',
          reason: 'quiet_hours',
          agentId: effectiveAgentId,
          sessionId: targetSessionId,
        });
      }
    }

    let effectiveAckMax = (typeof ackMaxChars === 'number' && Number.isFinite(ackMaxChars) && ackMaxChars > 0) ? ackMaxChars : undefined;
    if (!effectiveAckMax && heartbeatConfig && typeof heartbeatConfig === 'object') {
      const rawAck = Number(heartbeatConfig.ackMaxChars || heartbeatConfig.ack_max_chars);
      if (Number.isFinite(rawAck) && rawAck > 0) effectiveAckMax = rawAck;
    }
    if (!effectiveAckMax) effectiveAckMax = 30;

    lockOptions = { agentId: effectiveAgentId, workspaceRoot: effectiveWorkspaceRoot };
    try {
      lockPath = acquireSessionTurnLock(targetSessionId, lockOptions);
    } catch {
      return recordRunResult({
        status: 'error',
        reason: 'acquire_turn_lock_failed',
        agentId: effectiveAgentId,
        sessionId: targetSessionId,
      }, 'acquire_turn_lock_failed');
    }

    if (!lockPath) {
      return recordRunResult({
        status: 'skipped',
        reason: 'requests_in_flight',
        agentId: effectiveAgentId,
        sessionId: targetSessionId,
      });
    }

    try {
      pendingEvents = await peekSystemEvents({
        agentId: effectiveAgentId,
        sessionId: targetSessionId,
        workspaceRoot: effectiveWorkspaceRoot,
        limit: 20,
      });
    } catch {
      return recordRunResult({
        status: 'error',
        reason: 'peek_system_events_failed',
        agentId: effectiveAgentId,
        sessionId: targetSessionId,
      }, 'peek_system_events_failed');
    }

    if (Array.isArray(pendingEvents) && pendingEvents.length > 0) {
      const last = pendingEvents[pendingEvents.length - 1];
      if (last && typeof last.id === 'number') {
        lastEventId = last.id;
      }
    }

    const hasCronContext = Array.isArray(pendingEvents) && pendingEvents.some((record) => {
      if (!record) return false;
      const topKey = typeof record.contextKey === 'string' ? record.contextKey : '';
      const ev = record.event && typeof record.event === 'object' ? record.event : {};
      const evKey = typeof ev.contextKey === 'string' ? ev.contextKey : '';
      return topKey.startsWith('cron:') || evKey.startsWith('cron:');
    });

    let heartbeatExists = false;
    let heartbeatEmpty = false;
    let heartbeatText = '';
    try {
      const hbText = await readAgentHeartbeatFile(effectiveAgentId, effectiveWorkspaceRoot);
      if (typeof hbText === 'string') {
        heartbeatExists = true;
        heartbeatText = hbText;
        heartbeatEmpty = isHeartbeatFileEffectivelyEmpty(hbText);
      }
    } catch {
      // Best-effort only; treat failures as "no heartbeat file".
    }

    if (triggerReason === 'interval' && pendingEvents.length === 0 && heartbeatExists && heartbeatEmpty) {
      return recordRunResult({
        status: 'skipped',
        reason: 'empty_heartbeat_file',
        agentId: effectiveAgentId,
        sessionId: targetSessionId,
      });
    }

    const prompt = buildHeartbeatPrompt({
      events: pendingEvents,
      heartbeatText,
      triggerReason,
      targetSessionId,
    });

    const heartbeatSessionId = 'agent:arcana:heartbeat:' + Date.now();
    const agentHomeRoot = arcanaHomePath('agents', effectiveAgentId);
    let assistantText = '';

    await runWithContext(
      { sessionId: heartbeatSessionId, agentId: effectiveAgentId, agentHomeRoot, workspaceRoot: effectiveWorkspaceRoot },
      async () => {
        const { session } = await createArcanaSession({
          workspaceRoot: effectiveWorkspaceRoot,
          agentHomeRoot,
          sessionId: heartbeatSessionId,
          bootstrapContextMode: 'heartbeat_light',
        });

        if (!session || typeof session.prompt !== 'function') {
          throw new Error('heartbeat_session_unavailable');
        }

        const unsub = session.subscribe?.((ev) => {
          try {
            if (!ev) return;
            if (ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
              const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
              const text = blocks
                .filter((c) => c && c.type === 'text')
                .map((c) => c.text || '')
                .join('');
              if (text) {
                assistantText = String(text);
              }
            }
          } catch {
            // Ignore event handling errors.
          }
        });

        try {
          await session.prompt(prompt);
        } finally {
          try {
            if (typeof unsub === 'function') {
              unsub();
            }
          } catch {
            // ignore
          }
        }
      },
    );

    const rawAssistant = assistantText == null ? '' : String(assistantText);
    const { text: strippedText, isAckOnly } = stripHeartbeatAck(rawAssistant, { token: 'HEARTBEAT_OK', ackMaxChars: effectiveAckMax });

    let delivered = false;
    if (!isAckOnly) {
      const body = strippedText.trim();
      if (body) {
        const payload = '[heartbeat]\n\n' + body;
        try {
          appendMessage(targetSessionId, { role: 'assistant', text: payload, agentId: effectiveAgentId });
          delivered = true;
        } catch {
          // Best-effort delivery; keep delivered=false on failure.
        }
      }
    }

    if (lastEventId != null && delivered) {
      try {
        await ackSystemEvents({ agentId: effectiveAgentId, sessionId: targetSessionId, workspaceRoot: effectiveWorkspaceRoot, upToId: lastEventId });
      } catch {
        // Ack failures should not flip status to failed; heartbeat already ran.
      }
    }

    return recordRunResult({
      status: 'ok',
      reason: triggerReason || '',
      agentId: effectiveAgentId,
      sessionId: targetSessionId,
      delivered,
      assistantText: rawAssistant,
      eventsProcessed: Array.isArray(pendingEvents) ? pendingEvents.length : 0,
    });
  } catch (error) {
    const message = error && error.message ? String(error.message) : 'error';
    return recordRunResult({
      status: 'error',
      reason: message,
      agentId: effectiveAgentId || null,
      sessionId: targetSessionId || null,
    }, message);
  } finally {
    if (lockPath && lockOptions) {
      try {
        releaseSessionTurnLock(lockPath, lockOptions);
      } catch {
        // ignore
      }
    }
  }
}

export default { runHeartbeatOnce };
