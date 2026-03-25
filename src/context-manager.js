import { createArcanaSession } from './session.js';
import { runWithContext } from './event-bus.js';
import { loadSession, saveSession, buildHistoryPreludeText } from './sessions-store.js';

export const DEFAULT_CONTEXT_POLICY = {
  preludeMaxMessages: 60,
  preludeMaxMessageChars: 1500,
  preludeMaxTotalChars: 80000,
  preludeKeepRecentUserTurns: 10,

  keepRecentMessagesInteractive: 40,
  keepRecentMessagesCron: 50,

  summaryCharBudget: 20000,
  segmentCharBudget: 20000,

  maxOverflowRetries: 3,
  keepRecentRetrySteps: [40, 20, 10, 6],

  maxUserMessageChars: 60000,
};

// Track active history compactions by agent+session so they can be aborted
// from /v2/abort or a timeout. Value is a function that aborts the current
// compaction's underlying LLM session and cancels any active tool host call.
const _activeCompactions = new Map();
function _compactionKey(agentId, sessionId){
  try{
    const a = (agentId==null? 'default' : String(agentId)).trim() || 'default';
    const sid = String(sessionId||'').trim();
    return a + '::' + sid;
  } catch { return 'default::'; }
}
export function requestCompactionAbort({ agentId, sessionId } = {}){
  try {
    const key = _compactionKey(agentId, sessionId);
    const fn = _activeCompactions.get(key);
    if (!fn) return { ok: false, reason: 'no_active_compaction' };
    try { fn(); } catch {}
    return { ok: true };
  } catch { return { ok: false } }
}

function sliceMessagesByRecentUserTurns(messages, keepRecentUserTurns){
  const msgs = Array.isArray(messages) ? messages : [];
  const keepNum = Number(keepRecentUserTurns);
  const keepTurns = (Number.isFinite(keepNum) && keepNum > 0) ? Math.floor(keepNum) : 0;

  if (!msgs.length || !keepTurns){
    return { older: [], recent: msgs, keepTurns: 0, userTurns: 0 };
  }

  let idx = 0;
  let userCount = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1){
    const m = msgs[i];
    if (m && m.role === 'user'){
      userCount += 1;
      if (userCount === keepTurns){
        idx = i;
        break;
      }
    }
  }

  if (userCount === 0){
    return { older: [], recent: msgs, keepTurns: 0, userTurns: 0 };
  }

  if (userCount < keepTurns){
    return { older: [], recent: msgs, keepTurns: userCount, userTurns: userCount };
  }

  const older = msgs.slice(0, idx);
  const recent = msgs.slice(idx);
  return { older, recent, keepTurns, userTurns: userCount };
}

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

export function buildSessionPrelude(sessionObj, policy = DEFAULT_CONTEXT_POLICY, opts) {
  try {
    const p = policy || DEFAULT_CONTEXT_POLICY;
    const summaryRaw = sessionObj && typeof sessionObj.summary === 'string' ? sessionObj.summary : '';
    const summary = String(summaryRaw || '').trim();
    let msgs = sessionObj && Array.isArray(sessionObj.messages) ? sessionObj.messages : [];

    // Determine how many recent user turns to keep.
    // Explicit opts override; otherwise use policy default (10).
    let keepTurns = Number(p.preludeKeepRecentUserTurns) || 10;
    if (opts && typeof opts === 'object'){
      const keepTurnsRaw = opts.keepRecentUserTurns;
      const keepNum = Number(keepTurnsRaw);
      if (Number.isFinite(keepNum) && keepNum > 0){
        keepTurns = Math.floor(keepNum);
      }
    }

    // Always slice to the most recent N user turns so the prelude stays bounded,
    // even when sessions-store retains the full untruncated message history.
    const sliced = sliceMessagesByRecentUserTurns(msgs, keepTurns);
    if (sliced && Array.isArray(sliced.recent)){
      msgs = sliced.recent;
    }

    const preludeOpts = {
      summary,
      maxMessages: p.preludeMaxMessages,
      maxMessageChars: p.preludeMaxMessageChars,
      maxTotalChars: p.preludeMaxTotalChars,
    };

    return buildHistoryPreludeText({ messages: msgs }, preludeOpts) || '';
  } catch {
    return '';
  }
}

async function summarizeOlderMessages({ workspaceRoot, agentHomeDir, olderMessages, existingSummary, policy, agentId, sessionId }) {
  // Enforce a hard 3 minute cap across the entire compaction run and support
  // external aborts via requestCompactionAbort.
  const p = policy || DEFAULT_CONTEXT_POLICY;
  const summaryBudget = Number(p.summaryCharBudget) > 0 ? Number(p.summaryCharBudget) : 20000;
  const segmentBudget = Number(p.segmentCharBudget) > 0 ? Number(p.segmentCharBudget) : 20000;

  const created = await createArcanaSession({ workspaceRoot, agentHomeRoot: agentHomeDir, execPolicy: 'restricted', agentId });
  const sess = created && created.session;
  if (!sess) return '';
  try { sess.setActiveToolsByName?.([]); } catch {}
  const toolHost = created && created.toolHost ? created.toolHost : null;

  // If nothing to summarize, return existing summary as an object before registration.
  const allMessages = Array.isArray(olderMessages) ? olderMessages : [];
  if (!allMessages.length) {
    const text = String(existingSummary || '').trim();
    return { text, aborted: false, timedOut: false };
  }

  // Register abort handler for this compaction instance
  const key = _compactionKey(agentId, sessionId);
  let aborted = false; let timedOut = false;
  const __abortRejects = new Set();
  const abortFn = () => {
    try { aborted = true; } catch {}
    try { toolHost && toolHost.cancelActiveCall && toolHost.cancelActiveCall(); } catch {}
    try { if (sess && typeof sess.abort === 'function'){ const p = sess.abort(); if (p && typeof p.catch === 'function') p.catch(()=>{}); } } catch {}
    try { __abortRejects.forEach((rej)=>{ try { rej(new Error('aborted')); } catch {} }); } catch {}
  };
  try { _activeCompactions.set(key, abortFn); } catch {}

  let unsub = null;
  try {
    // Build segments within a size budget
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

    // Stream back assistant output to capture the final text
    let last = '';
    unsub = sess.subscribe((ev) => {
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

    let runningSummary = String(existingSummary || '').trim();
    const deadlineMs = Date.now() + 180000; // 3 minutes overall
    for (const seg of segments) {
      if (aborted || timedOut) break;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0){ timedOut = true; abortFn(); break; }
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
      let timer = null;
      let localAbortReject = null;
      try {
        const timeoutP = new Promise((_, reject)=>{
          timer = setTimeout(()=>{ try { timedOut = true; } catch {} abortFn(); reject(new Error('timeout')); }, Math.max(1, remainingMs));
        });
        const abortP = new Promise((_, reject)=>{ localAbortReject = reject; __abortRejects.add(reject); });
        await Promise.race([ sess.prompt(prompt), timeoutP, abortP ]);
      } catch {}
      finally {
        try { if (timer) clearTimeout(timer); } catch {}
        try { if (localAbortReject) __abortRejects.delete(localAbortReject); } catch {}
      }

      const nextSummary = String(last || '').trim();
      if (nextSummary) runningSummary = nextSummary;
    }

    let out = String(runningSummary || '').trim();
    // If aborted or timed out, treat as no-summary so callers broadcast an error end.
    if (aborted || timedOut) return { text: '', aborted, timedOut };
    if (!out) return { text: '', aborted, timedOut };
    if (out.length > summaryBudget) out = out.slice(0, summaryBudget);
    return { text: out, aborted, timedOut };
  } finally {
    try { unsub && unsub(); } catch {}
    try { _activeCompactions.delete(key); } catch {}
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
  // Only summarize messages not yet covered by the existing summary.
  const summaryWatermark = (typeof obj.summaryUpToIndex === 'number' && obj.summaryUpToIndex > 0) ? obj.summaryUpToIndex : 0;
  const olderStart = Math.min(summaryWatermark, splitIndex);
  const older = msgs.slice(olderStart, splitIndex);
  if (!older.length) return { compacted: false };

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
        agentId,
        sessionId: sid,
      });
    });
  } catch {
    summary = '';
  }

  let aborted = false; let timedOut = false; let text = '';
  if (summary && typeof summary === 'object'){
    try { text = String(summary.text || '').trim(); } catch { text = ''; }
    aborted = !!summary.aborted; timedOut = !!summary.timedOut;
  } else {
    text = String(summary || '').trim();
  }

  if (!text) {
    // If summary generation failed but we're in an overflow situation,
    // still truncate messages to allow the session to continue.
    // A placeholder summary is better than a stuck/broken session.
    if (reason === 'overflow' || reason === 'pre_prompt_context_overflow') {
      const fallbackSummary = '(Earlier conversation was truncated to recover from context overflow. Summary generation failed.)';
      obj.summary = (obj.summary ? obj.summary + '\n\n' : '') + fallbackSummary;
      obj.summaryUpToIndex = splitIndex;
      obj.sessionTokens = 0;
      try { saveSession(obj, { agentId }); } catch {}
      try {
        if (typeof broadcast === 'function') {
          broadcast({ type: 'history_compact_end', sessionId: sid, agentId, keepRecentMessages: keep, compacted: true, fallback: true });
        }
      } catch {}
      return { compacted: true, keepRecentMessages: keep, summary: fallbackSummary, fallback: true };
    }
    try {
      if (typeof broadcast === 'function') {
        broadcast({ type: 'history_compact_end', sessionId: sid, agentId, keepRecentMessages: keep, compacted: false, aborted: !!aborted, timedOut: !!timedOut });
      }
    } catch {}
    return { compacted: false, aborted: !!aborted, timedOut: !!timedOut };
  }

  obj.summary = text;
  obj.summaryUpToIndex = splitIndex;
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

  const sliced = sliceMessagesByRecentUserTurns(msgs, keepTurns);
  // Only summarize messages not yet covered by existing summary.
  const summaryWatermark = (typeof obj.summaryUpToIndex === 'number' && obj.summaryUpToIndex > 0) ? obj.summaryUpToIndex : 0;
  const olderAll = sliced.older;
  const older = summaryWatermark > 0 ? olderAll.slice(summaryWatermark) : olderAll;

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
        agentId,
        sessionId: sid,
      });
    });
  } catch {
    summary = '';
  }

  let aborted = false; let timedOut = false; let text = '';
  if (summary && typeof summary === 'object'){
    try { text = String(summary.text || '').trim(); } catch { text = ''; }
    aborted = !!summary.aborted; timedOut = !!summary.timedOut;
  } else {
    text = String(summary || '').trim();
  }

  if (!text) {
    try {
      if (typeof broadcast === 'function') {
        broadcast({
          type: 'history_compact_end',
          sessionId: sid,
          agentId,
          keepRecentUserTurns: keepTurns,
          compacted: false,
          aborted: !!aborted,
          timedOut: !!timedOut,
        });
      }
    } catch {}
    return { compacted: false, aborted: !!aborted, timedOut: !!timedOut };
  }

  obj.summary = text;
  obj.summaryUpToIndex = olderAll.length;
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
  requestCompactionAbort,
};
