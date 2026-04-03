import { createArcanaSession } from './session.js';
import { runWithContext } from './event-bus.js';
import { loadSession, saveSession, buildHistoryPreludeText } from './sessions-store.js';
import { loadArcanaConfig, loadAgentConfig } from './config.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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


function readHistoryCompressionCompactionInstructions(agentHomeDir){
  try {
    const base = String(agentHomeDir || '').trim();

    // Preferred: ~/.arcana/agents/<agentId>/compression.md
    // This avoids polluting config.json and is easy to edit/share.
    if (base) {
      try {
        const p = join(base, 'compression.md');
        if (existsSync(p)) {
          const raw = readFileSync(p, 'utf-8');
          const text = String(raw || '').trim();
          if (text) {
            return text.length > 20000 ? text.slice(0, 20000) : text;
          }
        }
      } catch {}
    }

    // Fallbacks (legacy / debugging)
    // Precedence: env override > agent config > global config
    const env = String(process.env.ARCANA_HISTORY_COMPRESSION_COMPACT_INSTRUCTIONS || '').trim();
    if (env) return env.length > 20000 ? env.slice(0, 20000) : env;

    const agentCfg = loadAgentConfig(agentHomeDir);
    const globalCfg = loadArcanaConfig();
    const key = 'history_compression_compact_instructions';

    let val = '';
    try {
      if (agentCfg && typeof agentCfg === 'object' && Object.prototype.hasOwnProperty.call(agentCfg, key)) {
        const raw = agentCfg[key];
        if (typeof raw === 'string' && raw.trim()) val = raw.trim();
      }
    } catch {}

    if (!val) {
      try {
        if (globalCfg && typeof globalCfg === 'object' && Object.prototype.hasOwnProperty.call(globalCfg, key)) {
          const raw = globalCfg[key];
          if (typeof raw === 'string' && raw.trim()) val = raw.trim();
        }
      } catch {}
    }

    if (val && val.length > 20000) val = val.slice(0, 20000);
    return String(val || '').trim();
  } catch {
    return '';
  }
}



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


const COMPACTION_NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- Tool calls will be rejected and will waste the turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const COMPACTION_RENDER_DEFAULTS = {
  user: { head: 1200, tail: 1200, max: 2400 },
  assistant: { head: 1200, tail: 1200, max: 2400 },
  // Tool/system outputs tend to have critical headers + stack tails.
  tool: { head: 1800, tail: 1800, max: 3600, keyLines: 18 },
  system: { head: 1400, tail: 1400, max: 2800, keyLines: 12 },
  default: { head: 1200, tail: 1200, max: 2400 },
};

function formatCompactionSummary(raw) {
  try {
    let s = String(raw || '').trim();
    if (!s) return '';

    // Strip analysis section — it improves quality but is not useful as memory.
    s = s.replace(/<analysis>[\s\S]*?<\/analysis>/, '').trim();

    // Prefer explicit <summary>...</summary> if present.
    const m = s.match(/<summary>([\s\S]*?)<\/summary>/);
    if (m) s = String(m[1] || '').trim();

    // Normalize whitespace.
    s = s.replace(/\n\n+/g, '\n\n').trim();
    return s;
  } catch {
    return '';
  }
}

function extractKeyLines(text, limit = 16) {
  try {
    const s = String(text || '');
    if (!s) return [];
    const lines = s.split(/\r?\n/);
    const re = /(error|exception|traceback|stack|failed|failure|fatal|warn|warning|timeout|timed out|abort|aborted|cancel|cancelled|refused|ENOENT|EACCES|ECONN|429|500|502|503|504)/i;
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      if (re.test(line)) {
        out.push(line.length > 500 ? (line.slice(0, 500) + '…') : line);
        if (out.length >= limit) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

function summarizeJsonShape(text) {
  try {
    const s = String(text || '').trim();
    if (!s) return '';
    if (!(s.startsWith('{') || s.startsWith('['))) return '';
    // Avoid pathological costs on giant blobs.
    if (s.length > 50000) return '';
    const v = JSON.parse(s);
    if (Array.isArray(v)) {
      return 'JSON array (length ' + String(v.length) + ')';
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      const head = keys.slice(0, 30).join(', ');
      return 'JSON object keys: ' + head + (keys.length > 30 ? ', …' : '');
    }
    return '';
  } catch {
    return '';
  }
}

function sliceHeadTail(text, headChars, tailChars, maxChars) {
  const s = String(text || '');
  if (!s) return '';

  const max = Number(maxChars);
  const head = Number(headChars);
  const tail = Number(tailChars);

  if (Number.isFinite(max) && max > 0 && s.length <= max) return s;

  const h = Number.isFinite(head) && head > 0 ? Math.floor(head) : 0;
  const t = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 0;

  if (h <= 0 && t <= 0) {
    const keep = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2000;
    return '…' + s.slice(-keep);
  }

  if (h + t >= s.length) return s;

  let out = '';
  if (h > 0) out += s.slice(0, h);
  out += '\n…\n';
  if (t > 0) out += s.slice(-t);

  if (Number.isFinite(max) && max > 0 && out.length > max) {
    return '…' + out.slice(-max);
  }

  return out;
}

function renderMessageForCompaction(m, renderOpts = COMPACTION_RENDER_DEFAULTS) {
  try {
    const roleRaw = m && m.role != null ? String(m.role) : 'user';
    const role = roleRaw === 'assistant' || roleRaw === 'tool' || roleRaw === 'system' ? roleRaw : 'user';
    const label = role === 'assistant' ? 'Assistant' : role === 'tool' ? 'Tool' : role === 'system' ? 'System' : 'User';

    const textRaw = m && Object.prototype.hasOwnProperty.call(m, 'text') ? m.text : '';
    const text = String(textRaw || '');

    const opt = (renderOpts && renderOpts[role]) ? renderOpts[role] : (renderOpts.default || COMPACTION_RENDER_DEFAULTS.default);

    const jsonShape = summarizeJsonShape(text);
    const keyLines = (role === 'tool' || role === 'system') ? extractKeyLines(text, Number(opt && opt.keyLines) > 0 ? Number(opt.keyLines) : 16) : [];

    let prefix = '';
    if (jsonShape) prefix += '[' + jsonShape + ']\n';
    if (keyLines && keyLines.length) {
      prefix += '[Key lines]\n' + keyLines.join('\n') + '\n\n';
    }

    const body = sliceHeadTail(text, opt.head, opt.tail, opt.max);
    const combined = String((prefix + body) || '').trim();

    // Keep formatting stable; double newlines separate messages.
    return label + ': ' + combined;
  } catch {
    return '';
  }
}

function renderMessagesForCompaction(messages, renderOpts) {
  const msgs = Array.isArray(messages) ? messages : [];
  const parts = [];
  parts.push('[Conversation History — keep for context]\n');
  for (const m of msgs) {
    const line = renderMessageForCompaction(m, renderOpts);
    if (line) parts.push(line);
  }
  return parts.join('\n\n');
}

function splitIntoSegmentsForCompaction(messages, segmentBudget, renderOpts) {
  const msgs = Array.isArray(messages) ? messages : [];
  const budgetNum = Number(segmentBudget);
  const budget = (Number.isFinite(budgetNum) && budgetNum > 2000) ? Math.floor(budgetNum) : 20000;

  const segments = [];
  let cur = [];
  let curLen = 0;

  for (const m of msgs) {
    const rendered = renderMessageForCompaction(m, renderOpts);
    const addLen = (rendered ? rendered.length : 0) + 2;

    if (cur.length && (curLen + addLen) > budget) {
      segments.push(cur);
      cur = [m];
      curLen = addLen;
      continue;
    }

    cur.push(m);
    curLen += addLen;
  }

  if (cur.length) segments.push(cur);
  return segments;
}

function shrinkRenderOpts(renderOpts, factor = 0.6) {
  try {
    const f = Number(factor);
    const ff = (Number.isFinite(f) && f > 0 && f < 1) ? f : 0.6;
    const src = renderOpts || COMPACTION_RENDER_DEFAULTS;
    const out = { ...src };
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (!v || typeof v !== 'object') continue;
      out[k] = {
        ...v,
        head: Math.max(200, Math.floor(Number(v.head || 0) * ff)),
        tail: Math.max(200, Math.floor(Number(v.tail || 0) * ff)),
        max: Math.max(600, Math.floor(Number(v.max || 0) * ff)),
      };
    }
    return out;
  } catch {
    return renderOpts || COMPACTION_RENDER_DEFAULTS;
  }
}

function buildCompactionPrompt({ runningSummary, segmentText, summaryBudget, customInstructions }) {
  const budget = Number(summaryBudget);
  const maxChars = (Number.isFinite(budget) && budget > 2000) ? Math.floor(budget) : 20000;

  let prompt = COMPACTION_NO_TOOLS_PREAMBLE + `You are performing HISTORY COMPRESSION for a coding assistant session.

Goal: update the running summary so future turns can continue the work with minimal loss.
- Do NOT invent details not present in the transcript.
- Prefer exact file paths, commands, configuration keys, and error messages when available.
- Capture user intent/constraints, key decisions, important facts, files touched, errors+fixes, and open TODOs.
- Keep the summary under ~${maxChars} characters.

Output format (required):
<analysis>...your scratchpad...</analysis>
<summary>...the actual summary...</summary>

<summary> must include these sections:
## User intent & constraints
## Key technical context / decisions
## Files / commands / errors (high signal)
## Open tasks / next steps

`;

  if (customInstructions && String(customInstructions).trim()) {
    prompt += `Additional instructions:
${String(customInstructions).trim()}

`;
  }

  if (runningSummary) {
    prompt += `Existing summary (earlier history):
${runningSummary}

`;
  }

  prompt += `New messages to integrate:
${segmentText}

Updated summary:`;
  return prompt;
}

async function maybeRecompactSummary({ sess, runningSummary, summaryBudget, remainingMs, abortP, timeoutP }) {
  try {
    const budget = Number(summaryBudget);
    const maxChars = (Number.isFinite(budget) && budget > 2000) ? Math.floor(budget) : 20000;
    const target = Math.max(4000, Math.floor(maxChars * 0.6));
    if (!runningSummary || runningSummary.length <= Math.floor(maxChars * 0.85)) return runningSummary;

    let prompt = COMPACTION_NO_TOOLS_PREAMBLE + `The existing summary has grown too large. Rewrite it to be shorter while preserving key technical details.
Keep it under ~${target} characters.
Do not add new information.

Output format: <analysis>...</analysis> then <summary>...</summary>.

Summary to rewrite:
${runningSummary}

Rewritten summary:`;

    // Reset streaming capture by starting a fresh session.
    try { await sess.newSession?.(); } catch {}

    let last = '';
    const unsub = sess.subscribe((ev) => {
      try {
        if (ev && ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) last = text;
        }
      } catch {}
    });

    try {
      const ms = Math.max(1, Number(remainingMs) || 1);
      // Create a local timeout for this sub-call.
      let timer = null;
      const localTimeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      });
      try { localTimeoutP.catch(()=>{}); } catch {}
      try {
        const promptP = sess.prompt(prompt);
        try { promptP.catch(()=>{}); } catch {}
        await Promise.race([ promptP, localTimeoutP, abortP ]);
      } finally {
        try { if (timer) clearTimeout(timer); } catch {}
      }

      const next = formatCompactionSummary(last);
      if (next && next.length <= maxChars) return next;
      if (next) return next.slice(0, maxChars);
      return runningSummary;
    } catch {
      return runningSummary;
    } finally {
      try { unsub && unsub(); } catch {}
    }
  } catch {
    return runningSummary;
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

  const customInstructions = readHistoryCompressionCompactionInstructions(agentHomeDir);
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
    try { __abortRejects.clear(); } catch {}
  };
  try { _activeCompactions.set(key, abortFn); } catch {}

  try {
    const renderOpts = COMPACTION_RENDER_DEFAULTS;
    const segments = splitIntoSegmentsForCompaction(allMessages, segmentBudget, renderOpts);

    // Stream back assistant output to capture the final text
    let last = '';
    const unsub = sess.subscribe((ev) => {
      try {
        if (ev && ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) last = text;
        }
      } catch {}
    });

    try {
      let runningSummary = String(existingSummary || '').trim();
      const deadlineMs = Date.now() + 180000; // 3 minutes overall

      for (const seg of segments) {
        if (aborted || timedOut) break;

        // If the summary is bloating, proactively recompact it so the next prompt
        // doesn't spend most of the budget on 'existing summary'.
        const remainingMs0 = deadlineMs - Date.now();
        if (remainingMs0 <= 0){ timedOut = true; abortFn(); break; }

        // Create per-segment abort + overall timeout promises.
        let timer = null;
        let localAbortReject = null;
        const remainingMs = remainingMs0;
        const timeoutP = new Promise((_, reject)=>{
          timer = setTimeout(()=>{ try { timedOut = true; } catch {} abortFn(); reject(new Error('timeout')); }, Math.max(1, remainingMs));
        });
        const abortP = new Promise((_, reject)=>{ localAbortReject = reject; __abortRejects.add(reject); });
        try { timeoutP.catch(()=>{}); } catch {}
        try { abortP.catch(()=>{}); } catch {}
        let updated = false;
        try {
          try {
            runningSummary = await maybeRecompactSummary({ sess, runningSummary, summaryBudget, remainingMs, abortP, timeoutP });
          } catch {}

          let segMessages = Array.isArray(seg) ? seg : [];
          let localRender = renderOpts;

          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (aborted || timedOut) break;

            try { await sess.newSession?.(); } catch {}

            const segText = renderMessagesForCompaction(segMessages, localRender) || '';
            if (!segText) break;

            const prompt = buildCompactionPrompt({ runningSummary, segmentText: segText, summaryBudget, customInstructions });

            last = '';
            try {
              const promptP = sess.prompt(prompt);
              try { promptP.catch(()=>{}); } catch {}
              await Promise.race([ promptP, timeoutP, abortP ]);
            } catch {}

            const nextRaw = String(last || '').trim();
            const next = formatCompactionSummary(nextRaw);
            if (next) {
              runningSummary = next;
              updated = true;
              break;
            }

            // Retry escape hatches: first shrink the segment by dropping oldest
            // messages; if already tiny, shrink per-message head/tail windows.
            if (segMessages.length > 2) {
              const drop = Math.max(1, Math.floor(segMessages.length * 0.2));
              segMessages = segMessages.slice(drop);
            } else {
              localRender = shrinkRenderOpts(localRender, 0.6);
            }
          }

          if (!updated) {
            continue;
          }

          // Hard cap to avoid runaway growth.
          if (runningSummary && runningSummary.length > summaryBudget) {
            runningSummary = runningSummary.slice(0, summaryBudget);
          }
        } finally {
          try { if (timer) clearTimeout(timer); } catch {}
          try { if (localAbortReject) __abortRejects.delete(localAbortReject); } catch {}
        }
      }

      let out = String(runningSummary || '').trim();
      if (aborted || timedOut) return { text: '', aborted, timedOut };
      if (!out) return { text: '', aborted, timedOut };
      if (out.length > summaryBudget) out = out.slice(0, summaryBudget);
      return { text: out, aborted, timedOut };
    } finally {
      try { unsub && unsub(); } catch {}
    }
  } finally {
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
