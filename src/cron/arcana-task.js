import { createArcanaSession } from '../session.js';
import { resolveWorkspaceRoot } from '../workspace-guard.js';
import { createSession, listSessions, appendMessage, loadSession, saveSession, buildHistoryPreludeText } from '../sessions-store.js';
import { resolveSessionIdForKey, setSessionIdForKey } from '../session-key-store.js';
import { createWriteStream } from 'node:fs';
import { arcanaHomePath } from '../arcana-home.js';
import { getContext, runWithContext, emit } from '../event-bus.js';
import { DEFAULT_CONTEXT_POLICY, compactSession } from '../context-manager.js';
import { buildErrorStack } from '../util/error.js';
import { mergeStreamingText } from '../streaming-text.js';

const ASSISTANT_STREAM_MAX_CHARS = (()=>{
  try {
    const raw = process.env.ARCANA_ASSISTANT_STREAM_MAX_CHARS;
    if (!raw) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  } catch { return 0; }
})();

function tailLines(text, max=100){
  const lines = String(text||'').split('\n');
  return lines.slice(Math.max(0, lines.length - max)).join('\n');
}

function normalizeMediaRef(raw){
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  const mdMatch = s.match(/^\[[^\]]*]\(([^)]+)\)/);
  if (mdMatch && mdMatch[1]) {
    s = mdMatch[1].trim();
  } else {
    const first = s[0];
    const last = s[s.length - 1];
    if (!(first && first === last && (first === '"' || first === '\'' || first === '`'))){
      s = s.split(/\s+/)[0];
    }
  }
  const strip = new Set(['\'','"','`','(',')','[',']','<','> ',',',';']);
  while (s.length && strip.has(s[0])) {
    s = s.slice(1).trimStart();
  }
  while (s.length && strip.has(s[s.length - 1])) {
    s = s.slice(0, -1).trimEnd();
  }
  return s;
}

function extractMediaFromAssistantText(text){
  const mediaRefs = [];
  if (!text) return { text: '', mediaRefs };
  const lines = String(text || '').split(/\r?\n/);
  let inFence = false;
  const outLines = [];
  for (const line of lines){
    const trimmed = line.trim();
    if (trimmed.startsWith('```')){
      const count = (line.match(/```/g) || []).length;
      if (count % 2 === 1) inFence = !inFence;
      outLines.push(line);
      continue;
    }
    if (inFence){
      outLines.push(line);
      continue;
    }
    if (trimmed.startsWith('MEDIA:')){
      const idx = line.indexOf('MEDIA:');
      const raw = idx >= 0 ? line.slice(idx + 6) : '';
      const ref = normalizeMediaRef(raw);
      if (ref) mediaRefs.push(ref);
      continue;
    }
    outLines.push(line);
  }
  return { text: outLines.join('\n'), mediaRefs };
}

function buildBoundedHistoryPrelude(sessionObj){
  if (!sessionObj) return '';
  const summaryRaw = typeof sessionObj.summary === 'string' ? sessionObj.summary : '';
  const summary = String(summaryRaw || '').trim();
  const msgs = Array.isArray(sessionObj.messages) ? sessionObj.messages : [];
  if (!msgs.length && !summary) return '';
  const preludeObj = { messages: msgs };
  return buildHistoryPreludeText(preludeObj, {
    summary,
    maxMessages: DEFAULT_CONTEXT_POLICY.preludeMaxMessages,
    maxMessageChars: DEFAULT_CONTEXT_POLICY.preludeMaxMessageChars,
    maxTotalChars: DEFAULT_CONTEXT_POLICY.preludeMaxTotalChars,
  }) || '';
}

export async function ensureSessionId({ sessionId, sessionKey, title, agentId, workspaceRoot }){
  const t = String(title || '').trim();
  const id = String(sessionId || '').trim();
  const key = sessionKey != null ? String(sessionKey).trim() : '';
  const ws = String(workspaceRoot || '').trim() || resolveWorkspaceRoot();
  const agent = agentId;

  let resolvedId = '';

  if (id) {
    try {
      const s = loadSession(id, { agentId: agent });
      if (s && s.id) {
        resolvedId = String(s.id);
      }
    } catch {}
  }

  if (!resolvedId && key) {
    try {
      const fromKey = await resolveSessionIdForKey({
        agentId: agent,
        sessionKey: key,
        title: t || 'Arcana Cron',
        workspaceRoot: ws,
      });
      if (fromKey && fromKey.sessionId) {
        resolvedId = String(fromKey.sessionId);
      }
    } catch {}
  }

  if (!resolvedId && t) {
    try {
      const arr = listSessions(agent);
      const hit = arr.find((s)=> String(s.title || '').trim().toLowerCase() === t.toLowerCase());
      if (hit && hit.id) {
        resolvedId = String(hit.id);
      }
    } catch {}
  }

  if (!resolvedId) {
    const created = createSession({ title: t || 'Arcana Cron', workspace: ws, agentId: agent });
    if (created && created.id) {
      resolvedId = String(created.id);
    }
  }

  if (resolvedId && id && key) {
    try {
      await setSessionIdForKey({ agentId: agent, sessionKey: key, sessionId: resolvedId });
    } catch {}
  }

  return resolvedId;
}

function extractUsageTotals(u){
  let ctx = 0;
  let out = 0;
  let tot = 0;
  try {
    if (u && typeof u === 'object'){
      ctx = Number(u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.input ?? u.prompt ?? 0) || 0;
      out = Number(u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? u.output ?? 0) || 0;
      tot = Number(u.totalTokens ?? u.total_tokens ?? u.total ?? 0) || 0;
    }
  } catch {}
  if (!tot) tot = ctx + out;
  if (!Number.isFinite(tot) || tot < 0) tot = 0;
  if (!Number.isFinite(ctx) || ctx < 0) ctx = 0;
  if (!Number.isFinite(out) || out < 0) out = 0;
  return { contextTokens: ctx, outputTokens: out, totalTokens: tot };
}

function isCompletionErrorReason(reason){
  try {
    if (!reason) return false;
    const s = String(reason).trim().toLowerCase();
    if (!s) return false;
    if (s === 'error') return true;
    if (s.includes('error')) return true;
    if (s.includes('rate_limit') || s.includes('rate-limit')) return true;
    if (s.includes('timeout')) return true;
    if (s.includes('overloaded')) return true;
    if (s.includes('content_filter') || s.includes('content-filter')) return true;
    if (s.includes('blocked')) return true;
    return false;
  } catch {
    return false;
  }
}

async function summarizeSessionChunk({ workspaceRoot, agentHomeRoot, existingSummary, olderMessages }){
  try {
    const { session } = await createArcanaSession({ workspaceRoot, agentHomeRoot });
    try { session.setActiveToolsByName?.([]); } catch {}
    let summaryText = '';
    const unsub = session.subscribe((ev)=>{
      try {
        if (ev && ev.type === 'message_end' && ev.message && ev.message.role === 'assistant'){
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c)=> c && c.type === 'text').map((c)=> c.text || '').join('');
          if (text) summaryText = text;
        }
      } catch {}
    });
    const historyObj = { messages: Array.isArray(olderMessages) ? olderMessages : [] };
    const historyText = buildHistoryPreludeText(historyObj) || '';
    let prompt = 'You are summarizing earlier chat messages for long-term memory.\n';
    prompt += 'Produce a concise summary capturing important context, decisions, and facts.\n';
    prompt += 'Do not include instructions for the assistant, only what happened.\n\n';
    if (existingSummary && String(existingSummary).trim()){
      prompt += 'Existing summary (for previous history):\n';
      prompt += String(existingSummary).trim() + '\n\n';
    }
    prompt += 'Messages to summarize:\n';
    prompt += historyText + '\n\n';
    prompt += 'Updated summary:';
    try { await session.prompt(prompt); } catch {}
    try { unsub && unsub(); } catch {}
    const final = String(summaryText || '').trim();
    if (final) return final;
    return existingSummary || '';
  } catch {
    return existingSummary || '';
  }
}

async function compactSessionIfNeeded({ sessionId, agentId, workspaceRoot, agentHomeRoot, deltaTokens }){
  try {
    const thresholdTokens = 200000;
    const fallbackBytes = 600000;
    const keepRecentMessages = 50;

    let sessionObj = loadSession(sessionId, { agentId });
    if (!sessionObj) return;

    const prevTokensNum = Number(sessionObj.sessionTokens);
    let baseTokens = (Number.isFinite(prevTokensNum) && prevTokensNum > 0) ? prevTokensNum : 0;
    const deltaNum = Number(deltaTokens);
    if (Number.isFinite(deltaNum) && deltaNum > 0) baseTokens += deltaNum;
    const sessionTokens = baseTokens > 0 ? baseTokens : 0;
    if (sessionTokens > 0) sessionObj.sessionTokens = sessionTokens;

    let shouldCompact = false;
    if (sessionTokens > 0){
      if (sessionTokens > thresholdTokens) shouldCompact = true;
    } else {
      const historyText = buildHistoryPreludeText(sessionObj) || '';
      const summaryText = typeof sessionObj.summary === 'string' ? sessionObj.summary : '';
      const combinedText = historyText + summaryText;
      const byteLen = Buffer.byteLength(combinedText, 'utf8');
      if (byteLen > fallbackBytes) shouldCompact = true;
    }

    if (!shouldCompact){
      if (sessionTokens !== prevTokensNum){
        saveSession(sessionObj, { agentId });
      }
      return;
    }

    const msgs = Array.isArray(sessionObj.messages) ? sessionObj.messages : [];
    if (!msgs.length){
      sessionObj.sessionTokens = sessionTokens;
      saveSession(sessionObj, { agentId });
      return;
    }

    const keep = keepRecentMessages > 0 ? keepRecentMessages : 50;
    if (msgs.length <= keep){
      sessionObj.sessionTokens = sessionTokens;
      saveSession(sessionObj, { agentId });
      return;
    }

    const splitIndex = msgs.length - keep;
    const older = msgs.slice(0, splitIndex);
    const recent = msgs.slice(splitIndex);

    // Shared compaction logic persists the summary and keeps recent messages.
    await compactSession({
      sessionId,
      agentId,
      workspaceRoot,
      agentHomeDir: agentHomeRoot,
      keepRecentMessages: keep,
      policy: DEFAULT_CONTEXT_POLICY,
      reason: 'cron_threshold',
    });

    // Reset tracked session tokens after compaction.
    sessionObj = loadSession(sessionId, { agentId }) || sessionObj;
  } catch {
    // best-effort only
  }
}

const activeTurnsByKey = new Map();

function buildTurnKey(agentId, sessionKey, sessionId){
  try {
    const a = (agentId == null ? '' : String(agentId)).trim() || 'default';
    const sk = (sessionKey == null ? '' : String(sessionKey)).trim();
    const sid = (sessionId == null ? '' : String(sessionId)).trim();
    const key = sk || sid || 'default';
    return a + '::' + key;
  } catch {
    return 'default::default';
  }
}

export function requestTurnAbort({ agentId, sessionKey, sessionId } = {}){
  const key = buildTurnKey(agentId, sessionKey, sessionId);
  const fn = activeTurnsByKey.get(key);
  if (!fn) return { ok: false, reason: 'no_active_turn' };
  try { fn(); } catch {}
  return { ok: true };
}

export async function runArcanaTask({ prompt, sessionId, sessionKey, title, logPath, agentId, timeoutMs, execPolicy }){
  const ctx = getContext?.() || null;
  const rawTimeout = Number(timeoutMs);
  const effectiveTimeoutMs = (Number.isFinite(rawTimeout) && rawTimeout > 0) ? rawTimeout : 0;
  const workspaceRoot = (ctx && ctx.workspaceRoot) ? ctx.workspaceRoot : resolveWorkspaceRoot();
  const effectiveAgentId = agentId || (ctx && ctx.agentId) || 'default';
  const sid = await ensureSessionId({ sessionId, sessionKey, title, agentId: effectiveAgentId, workspaceRoot });
  const startedAtMs = Date.now();
  const agentHomeRoot = arcanaHomePath('agents', effectiveAgentId);
  const log = createWriteStream(logPath, { flags: 'w' });
  const header = 'Arcana cron run at ' + (new Date(startedAtMs).toISOString()) + '\n' + 'sessionId: ' + sid + '\n' + 'agentId: ' + effectiveAgentId + '\n';
  try { log.write(header + '\n'); } catch {}

  let textBuffer = '';
  const mediaRefsSeen = new Set();
  const userPrompt = String(prompt||'');

  try { emit({ type: 'turn_start', sessionId: sid }); } catch {}

  try {
    let historyPrelude = '';
    try {
      const existing = loadSession(sid, { agentId: effectiveAgentId });
      historyPrelude = buildBoundedHistoryPrelude(existing);
    } catch {}

    appendMessage(sid, { role: 'user', text: userPrompt, agentId: effectiveAgentId });
    const currentQuestion = '[Current Question]\n' + userPrompt;
    const finalPrompt = historyPrelude ? (historyPrelude + '\n\n' + currentQuestion) : currentQuestion;

    const timing = await runWithContext(
      { sessionId: sid, agentId: effectiveAgentId, agentHomeRoot, workspaceRoot },
      async () => {
        const { session, toolHost } = await createArcanaSession({ workspaceRoot, agentHomeRoot, execPolicy });
        const turnKey = buildTurnKey(effectiveAgentId, sessionKey, sid);
        const abortFn = () => {
          try { toolHost && toolHost.cancelActiveCall && toolHost.cancelActiveCall(); } catch {}
          try { if (session && typeof session.abort === 'function') { const p = session.abort(); if (p && typeof p.catch === 'function') p.catch(() => {}); } } catch {}
        };
        try { activeTurnsByKey.set(turnKey, abortFn); } catch {}
        let runTokens = 0;
        let runContextTokens = 0;
        let runOutputTokens = 0;
        let hasEmittedAssistantText = false;
        let timeoutHandle = null;
        let timedOut = false;
        let finishReason = '';
        let stopReason = '';
        const unsub = session.subscribe((ev)=>{
          try {
            if (!ev) return;
            if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant'){
              const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
              const rawText = blocks.filter((c)=> c && c.type === 'text').map((c)=> c.text || '').join('');
              if (rawText){
                textBuffer = mergeStreamingText(textBuffer, rawText, { maxLen: ASSISTANT_STREAM_MAX_CHARS });
              }

              const extracted = extractMediaFromAssistantText(textBuffer);
              const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
              const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];

              if (cleanText){
                try { emit({ type: 'assistant_text', text: cleanText, sessionId: sid }); } catch {}
                hasEmittedAssistantText = true;
              }
              if (mediaRefs.length){
                for (const raw of mediaRefs){
                  const ref = normalizeMediaRef(raw);
                  if (!ref || mediaRefsSeen.has(ref)) continue;
                  mediaRefsSeen.add(ref);
                  try { emit({ type: 'assistant_image', url: ref, mime: 'image/*', sessionId: sid }); } catch {}
                }
              }
            }
            if (ev && ev.type === 'message_end' && ev.message && ev.message.role === 'assistant'){
              const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
              const rawText = blocks.filter((c)=> c && c.type === 'text').map((c)=> c.text || '').join('');
              if (rawText){
                textBuffer = mergeStreamingText(textBuffer, rawText, { maxLen: ASSISTANT_STREAM_MAX_CHARS });
              }

              const extracted = extractMediaFromAssistantText(textBuffer);
              const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
              const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];

              if (cleanText && !hasEmittedAssistantText){
                try { emit({ type: 'assistant_text', text: cleanText, sessionId: sid }); } catch {}
                hasEmittedAssistantText = true;
              }
              if (mediaRefs.length){
                for (const raw of mediaRefs){
                  const ref = normalizeMediaRef(raw);
                  if (!ref || mediaRefsSeen.has(ref)) continue;
                  mediaRefsSeen.add(ref);
                  try { emit({ type: 'assistant_image', url: ref, mime: 'image/*', sessionId: sid }); } catch {}
                }
              }

              const u = ev.message && ev.message.usage;
              const totals = extractUsageTotals(u);
              if (totals){
                if (typeof totals.totalTokens === 'number' && totals.totalTokens > 0){
                  runTokens += totals.totalTokens;
                }
                if (typeof totals.contextTokens === 'number' && totals.contextTokens > 0){
                  runContextTokens += totals.contextTokens;
                }
                if (typeof totals.outputTokens === 'number' && totals.outputTokens > 0){
                  runOutputTokens += totals.outputTokens;
                }
              }
              try {
                const msg = ev.message;
                if (msg){
                  if (!finishReason){
                    const fr = msg.finishReason || msg.finish_reason || msg.stopReason || msg.stop_reason || msg.endReason || '';
                    if (fr) finishReason = String(fr);
                  }
                  if (!stopReason){
                    const sr = msg.stopReason || msg.stop_reason || msg.finishReason || msg.finish_reason || '';
                    if (sr) stopReason = String(sr);
                  }
                }
              } catch {}
            }
            if (ev.type === 'tool_execution_start' || ev.type === 'tool_execution_update' || ev.type === 'tool_execution_end' || ev.type === 'thinking_start' || ev.type === 'thinking_delta' || ev.type === 'thinking_end'){
              const payload = (ev && typeof ev === 'object' && !ev.sessionId) ? { ...ev, sessionId: sid } : ev;
              try { emit(payload); } catch {}
            }
          } catch {}
        });
        try {
          if (effectiveTimeoutMs > 0) {
            const timeoutPromise = new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => {
                timedOut = true;
                try { toolHost && toolHost.cancelActiveCall && toolHost.cancelActiveCall(); } catch {}
                reject(new Error('timeout'));
              }, effectiveTimeoutMs);
            });
            await Promise.race([session.prompt(finalPrompt), timeoutPromise]);
          } else {
            await session.prompt(finalPrompt);
          }
        } finally {
          if (timeoutHandle) {
            try { clearTimeout(timeoutHandle); } catch {}
          }
          try { unsub && unsub(); } catch {}
          try { activeTurnsByKey.delete(buildTurnKey(effectiveAgentId, sessionKey, sid)); } catch {}
        }
        const finishedAtMs = Date.now();
        const completionErrorReason = isCompletionErrorReason(finishReason) ? finishReason : (isCompletionErrorReason(stopReason) ? stopReason : '');
        return { finishedAtMs, runTokens, runContextTokens, runOutputTokens, timedOut, finishReason, stopReason, completionErrorReason };
      }
    );

    const finishedAtMs = timing && typeof timing.finishedAtMs === 'number' ? timing.finishedAtMs : Date.now();
    const runTokens = timing && typeof timing.runTokens === 'number' ? timing.runTokens : 0;
    const runContextTokens = timing && typeof timing.runContextTokens === 'number' ? timing.runContextTokens : 0;
    const runOutputTokens = timing && typeof timing.runOutputTokens === 'number' ? timing.runOutputTokens : 0;
    const deltaTokens = runTokens;
    const didTimeout = !!(timing && timing.timedOut);
    const completionErrorReason = timing && typeof timing.completionErrorReason === 'string' ? timing.completionErrorReason : '';

    if (!didTimeout && !completionErrorReason) {
      appendMessage(sid, { role: 'assistant', text: textBuffer, agentId: effectiveAgentId });
    }

    try {
      await compactSessionIfNeeded({ sessionId: sid, agentId: effectiveAgentId, workspaceRoot, agentHomeRoot, deltaTokens });
    } catch {}

    try {
      log.write('Prompt:\n' + userPrompt + '\n\n');
      if (historyPrelude) log.write('History Prelude:\n' + historyPrelude + '\n\n');
      log.write('Assistant:\n' + textBuffer + '\n');
    } catch {}

    let sessionTokensTotal = 0;
    try {
      const objAfter = loadSession(sid, { agentId: effectiveAgentId });
      if (objAfter && typeof objAfter.sessionTokens === 'number' && objAfter.sessionTokens > 0){
        sessionTokensTotal = objAfter.sessionTokens;
      }
    } catch {}

    try {
      if (runTokens > 0 || runContextTokens > 0 || runOutputTokens > 0 || sessionTokensTotal > 0){
        emit({ type: 'llm_usage', sessionId: sid, agentId: effectiveAgentId, contextTokens: runContextTokens, outputTokens: runOutputTokens, totalTokens: runTokens, sessionTokens: sessionTokensTotal });
      }
    } catch {}

    if (completionErrorReason){
      const errMsg = 'completion_error: ' + String(completionErrorReason || '');
      try {
        emit({ type: 'error', sessionId: sid, agentId: effectiveAgentId, message: errMsg });
      } catch {}
      try {
        emit({ type: 'turn_error', sessionId: sid, agentId: effectiveAgentId, error: errMsg, startedAtMs, finishedAtMs });
      } catch {}
      return {
        ok: false,
        sessionId: sid,
        error: errMsg,
        startedAtMs,
        finishedAtMs,
        outputTail: tailLines(textBuffer),
        assistantText: textBuffer,
      };
    }

    return {
      ok: true,
      sessionId: sid,
      startedAtMs,
      finishedAtMs,
      outputTail: tailLines(textBuffer),
      assistantText: textBuffer,
    };
  } catch (e) {
    const finishedAtMs = Date.now();
    const msg = String(e?.message || e || '');
    const code = (msg === 'timeout') ? 'timeout' : (msg || 'error');

    const fullStack = buildErrorStack(e);
    const cap = 8000;
    const boundedStack = typeof fullStack === 'string' ? (fullStack.length > cap ? fullStack.slice(0, cap) : fullStack) : '';

    try {
      log.write('Error: ' + code + '\n');
      if (fullStack) log.write('Stack:\n' + fullStack + '\n');
    } catch {}

    try {
      emit({ type: 'turn_error', sessionId: sid, agentId: effectiveAgentId, error: code, errorStack: boundedStack, startedAtMs, finishedAtMs });
    } catch {}

    return {
      ok: false,
      sessionId: sid,
      error: code,
      errorStack: boundedStack,
      startedAtMs,
      finishedAtMs,
      outputTail: tailLines(textBuffer),
      assistantText: textBuffer,
    };
  } finally {
    try { emit({ type: 'turn_end', sessionId: sid }); } catch {}
    try { log.end(); } catch {}
  }
}

export default { runArcanaTask, requestTurnAbort };
