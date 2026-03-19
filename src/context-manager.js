import { createArcanaSession } from './session.js';
import { runWithContext } from './event-bus.js';
import { loadSession, saveSession, buildHistoryPreludeText } from './sessions-store.js';

export const DEFAULT_CONTEXT_POLICY = {
  preludeMaxMessages: 60,
  preludeMaxMessageChars: 1500,
  preludeMaxTotalChars: 80000,

  keepRecentMessagesInteractive: 40,
  keepRecentMessagesCron: 50,

  summaryCharBudget: 20000,
  segmentCharBudget: 20000,

  maxOverflowRetries: 3,
  keepRecentRetrySteps: [40, 20, 10, 6],

  maxUserMessageChars: 60000,
};

export function estimateTokensFromText(text) {
  try {
    const s = String(text || '');
    const bytes = Buffer.byteLength(s, 'utf8');
    const est = Math.ceil(bytes / 4);
    return est > 0 ? est : 0;
  } catch {
    return 0;
  }
}

export function trimUserMessage(message, policy = DEFAULT_CONTEXT_POLICY) {
  const max = Number(policy && policy.maxUserMessageChars);
  if (!Number.isFinite(max) || max <= 0) return String(message || '');
  const s = String(message || '');
  if (s.length <= max) return s;
  const tail = s.slice(-max);
  return (
    '[User message truncated: exceeded ' + String(max) + ' chars; kept tail]\n\n' + tail
  );
}

export function buildSessionPrelude(sessionObj, policy = DEFAULT_CONTEXT_POLICY) {
  try {
    const p = policy || DEFAULT_CONTEXT_POLICY;
    const summaryRaw = sessionObj && typeof sessionObj.summary === 'string' ? sessionObj.summary : '';
    const summary = String(summaryRaw || '').trim();
    const msgs = sessionObj && Array.isArray(sessionObj.messages) ? sessionObj.messages : [];
    const opts = {
      summary,
      maxMessages: p.preludeMaxMessages,
      maxMessageChars: p.preludeMaxMessageChars,
      maxTotalChars: p.preludeMaxTotalChars,
    };
    return buildHistoryPreludeText({ messages: msgs }, opts) || '';
  } catch {
    return '';
  }
}

async function summarizeOlderMessages({ workspaceRoot, agentHomeDir, olderMessages, existingSummary, policy }) {
  const p = policy || DEFAULT_CONTEXT_POLICY;
  const summaryBudget = Number(p.summaryCharBudget) > 0 ? Number(p.summaryCharBudget) : 20000;
  const segmentBudget = Number(p.segmentCharBudget) > 0 ? Number(p.segmentCharBudget) : 20000;

  const created = await createArcanaSession({ workspaceRoot, agentHomeRoot: agentHomeDir, execPolicy: 'restricted' });
  const sess = created && created.session;
  if (!sess) return '';
  try { sess.setActiveToolsByName?.([]); } catch {}

  const allMessages = Array.isArray(olderMessages) ? olderMessages : [];
  if (!allMessages.length) return String(existingSummary || '').trim();

  const segments = [];
  let cur = [];
  for (const m of allMessages) {
    const next = cur.concat(m);
    const text = buildHistoryPreludeText({ messages: next }) || '';
    if (text && text.length > segmentBudget && cur.length) {
      segments.push(cur);
      cur = [m];
    } else {
      cur = next;
    }
  }
  if (cur.length) segments.push(cur);

  let last = '';
  const unsub = sess.subscribe((ev) => {
    try {
      if (ev && ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        const text = blocks
          .filter((c) => c && c.type === 'text')
          .map((c) => c.text || '')
          .join('');
        if (text) last = text;
      }
    } catch {}
  });

  try {
    let runningSummary = String(existingSummary || '').trim();
    for (const seg of segments) {
      try { await sess.newSession?.(); } catch {}
      const segText = buildHistoryPreludeText({ messages: seg }) || '';
      if (!segText) continue;
      let prompt = 'You are compressing earlier chat messages to save tokens.\n';
      prompt += 'Produce a concise summary capturing important context, decisions, and facts.\n';
      prompt += 'Do not include instructions for the assistant, only what happened.\n';
      prompt += 'Write the summary as plain text paragraphs.\n\n';
      if (runningSummary) {
        prompt += 'Existing summary (for previous history):\n' + runningSummary + '\n\n';
      }
      prompt += 'Messages to summarize:\n' + segText + '\n\n';
      prompt += 'Updated summary:';
      last = '';
      try { await sess.prompt(prompt); } catch {}
      const nextSummary = String(last || '').trim();
      if (nextSummary) runningSummary = nextSummary;
    }

    let out = String(runningSummary || '').trim();
    if (!out) return '';
    if (out.length > summaryBudget) out = out.slice(0, summaryBudget);
    return out;
  } finally {
    try { unsub && unsub(); } catch {}
  }
}

export async function compactSession({
  sessionId,
  agentId,
  workspaceRoot,
  agentHomeDir,
  keepRecentMessages,
  policy = DEFAULT_CONTEXT_POLICY,
  broadcast,
  reason,
} = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return { compacted: false };

  const keepNum = Number(keepRecentMessages);
  const keep = Number.isFinite(keepNum) && keepNum > 0 ? Math.floor(keepNum) : Number(policy.keepRecentMessagesInteractive) || 40;

  const obj = loadSession(sid, { agentId });
  const msgs = obj && Array.isArray(obj.messages) ? obj.messages : [];
  if (!obj || msgs.length <= keep) return { compacted: false };

  const splitIndex = msgs.length - keep;
  const older = msgs.slice(0, splitIndex);
  const recent = msgs.slice(splitIndex);

  try {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'history_compact_start', sessionId: sid, agentId, keepRecentMessages: keep, reason: String(reason || '') });
    }
  } catch {}

  const ctx = { sessionId: sid, agentId, workspaceRoot, agentHomeRoot: agentHomeDir };

  let summary = '';
  try {
    summary = await runWithContext(ctx, async () => {
      const existingSummary = obj && typeof obj.summary === 'string' ? obj.summary : '';
      return summarizeOlderMessages({
        workspaceRoot,
        agentHomeDir,
        olderMessages: older,
        existingSummary,
        policy,
      });
    });
  } catch {
    summary = '';
  }

  const text = String(summary || '').trim();
  if (!text) {
    try {
      if (typeof broadcast === 'function') {
        broadcast({ type: 'history_compact_end', sessionId: sid, agentId, keepRecentMessages: keep, compacted: false });
      }
    } catch {}
    return { compacted: false };
  }

  obj.summary = text;
  obj.messages = recent;
  obj.sessionTokens = 0;
  try { saveSession(obj, { agentId }); } catch {}

  try {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'history_compact_end', sessionId: sid, agentId, keepRecentMessages: keep, compacted: true });
    }
  } catch {}

  return { compacted: true, keepRecentMessages: keep, summary: text };
}

export async function compactSessionByUserTurns({
  sessionId,
  agentId,
  workspaceRoot,
  agentHomeDir,
  keepRecentUserTurns,
  policy = DEFAULT_CONTEXT_POLICY,
  broadcast,
  reason,
} = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return { compacted: false };

  const keepNum = Number(keepRecentUserTurns);
  const keepTurns = Number.isFinite(keepNum) && keepNum > 0 ? Math.floor(keepNum) : 0;
  if (!keepTurns) return { compacted: false };

  const obj = loadSession(sid, { agentId });
  const msgs = obj && Array.isArray(obj.messages) ? obj.messages : [];
  if (!obj || !msgs.length) return { compacted: false };

  let idx = 0;
  let userCount = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m && m.role === 'user') {
      userCount += 1;
      if (userCount === keepTurns) {
        idx = i;
        break;
      }
    }
  }
  if (userCount < keepTurns) idx = 0;

  const older = msgs.slice(0, idx);
  const recent = msgs.slice(idx);

  if (!older.length) return { compacted: false };

  try {
    if (typeof broadcast === 'function') {
      broadcast({
        type: 'history_compact_start',
        sessionId: sid,
        agentId,
        keepRecentUserTurns: keepTurns,
        reason: String(reason || ''),
      });
    }
  } catch {}

  const ctx = { sessionId: sid, agentId, workspaceRoot, agentHomeRoot: agentHomeDir };

  let summary = '';
  try {
    summary = await runWithContext(ctx, async () => {
      const existingSummary = obj && typeof obj.summary === 'string' ? obj.summary : '';
      return summarizeOlderMessages({
        workspaceRoot,
        agentHomeDir,
        olderMessages: older,
        existingSummary,
        policy,
      });
    });
  } catch {
    summary = '';
  }

  const text = String(summary || '').trim();
  if (!text) {
    try {
      if (typeof broadcast === 'function') {
        broadcast({
          type: 'history_compact_end',
          sessionId: sid,
          agentId,
          keepRecentUserTurns: keepTurns,
          compacted: false,
        });
      }
    } catch {}
    return { compacted: false };
  }

  obj.summary = text;
  obj.messages = recent;
  obj.sessionTokens = 0;
  try { saveSession(obj, { agentId }); } catch {}

  try {
    if (typeof broadcast === 'function') {
      broadcast({
        type: 'history_compact_end',
        sessionId: sid,
        agentId,
        keepRecentUserTurns: keepTurns,
        compacted: true,
      });
    }
  } catch {}

  return { compacted: true, keepRecentUserTurns: keepTurns, summary: text };
}

export async function ensurePreludeForPrompt({ sessionId, agentId, workspaceRoot, agentHomeDir, policy = DEFAULT_CONTEXT_POLICY } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  const obj = loadSession(sid, { agentId });
  return buildSessionPrelude(obj, policy);
}

export default {
  DEFAULT_CONTEXT_POLICY,
  estimateTokensFromText,
  trimUserMessage,
  buildSessionPrelude,
  compactSession,
  compactSessionByUserTurns,
  ensurePreludeForPrompt,
};
