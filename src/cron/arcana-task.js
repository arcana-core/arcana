import { createArcanaSession } from '../session.js';
import { resolveWorkspaceRoot } from '../workspace-guard.js';
import { createSession, listSessions, appendMessage, loadSession, saveSession, buildHistoryPreludeText } from '../sessions-store.js';
import { createWriteStream } from 'node:fs';
import { arcanaHomePath } from '../arcana-home.js';
import { getContext, runWithContext, emit } from '../event-bus.js';
import { loadCronSettings } from './store.js';

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
  const maxMessages = 30;
  const maxChars = 20000;
  const summaryRaw = typeof sessionObj.summary === 'string' ? sessionObj.summary : '';
  const summary = summaryRaw.trim();

  const msgs = Array.isArray(sessionObj.messages) ? sessionObj.messages : [];
  let historyText = '';
  if (msgs.length){
    const trimmed = { ...sessionObj, messages: msgs.slice(-maxMessages) };
    historyText = buildHistoryPreludeText(trimmed) || '';
  }

  let summaryPrefix = '';
  if (summary){
    summaryPrefix = '[Summary]\n' + summary + '\n\n';
  }

  let text = '';

  if (summaryPrefix && historyText){
    const remaining = maxChars - summaryPrefix.length;
    if (remaining <= 0){
      text = summaryPrefix.slice(-maxChars);
    } else {
      const boundedHistory = historyText.length > remaining ? historyText.slice(-remaining) : historyText;
      text = summaryPrefix + boundedHistory;
    }
  } else {
    text = summaryPrefix + historyText;
    if (text.length > maxChars) text = text.slice(-maxChars);
  }

  return text;
}

function ensureSessionId({ sessionId, title, agentId, workspaceRoot }){
  const t = String(title||'').trim();
  const id = String(sessionId||'').trim();
  const ws = String(workspaceRoot || '').trim() || resolveWorkspaceRoot();
  const agent = agentId;
  if (id) {
    const s = loadSession(id, { agentId: agent });
    if (s) return s.id;
  }
  if (t) {
    try {
      const arr = listSessions(agent);
      const hit = arr.find((s)=> String(s.title||'').trim().toLowerCase() === t.toLowerCase());
      if (hit) return hit.id;
    } catch {}
    const created = createSession({ title: t, workspace: ws, agentId: agent });
    return created.id;
  }
  const created = createSession({ title: 'Arcana Cron', workspace: ws, agentId: agent });
  return created.id;
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
    const settings = loadCronSettings({ workspaceRoot, agentId }) || {};
    const comp = settings && settings.compaction && typeof settings.compaction === 'object' ? settings.compaction : {};
    const thresholdTokensRaw = comp.thresholdTokens;
    const fallbackBytesRaw = comp.fallbackBytes;
    const fallbackCharsLegacyRaw = comp.fallbackChars;
    const keepRecentRaw = comp.keepRecentMessages;
    const thresholdTokensVal = Number(thresholdTokensRaw);
    const fallbackBytesVal = Number(fallbackBytesRaw);
    const fallbackCharsLegacyVal = Number(fallbackCharsLegacyRaw);
    const keepRecentVal = Number(keepRecentRaw);
    const thresholdTokens = (Number.isFinite(thresholdTokensVal) && thresholdTokensVal > 0) ? thresholdTokensVal : 200000;
    let fallbackBytes = (Number.isFinite(fallbackBytesVal) && fallbackBytesVal > 0) ? fallbackBytesVal : 600000;
    if ((!fallbackBytes || fallbackBytes <= 0) && Number.isFinite(fallbackCharsLegacyVal) && fallbackCharsLegacyVal > 0) fallbackBytes = fallbackCharsLegacyVal;
    const keepRecentMessages = (Number.isFinite(keepRecentVal) && keepRecentVal > 0) ? keepRecentVal : 50;

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

    const existingSummary = typeof sessionObj.summary === 'string' ? sessionObj.summary : '';

    const updatedSummary = await summarizeSessionChunk({ workspaceRoot, agentHomeRoot, existingSummary, olderMessages: older });
    const finalSummary = String(updatedSummary || '').trim() || existingSummary || '';

    sessionObj.summary = finalSummary;
    sessionObj.messages = recent;
    sessionObj.sessionTokens = 0;

    saveSession(sessionObj, { agentId });
  } catch {
    // best-effort only
  }
}

export async function runArcanaTask({ prompt, sessionId, title, logPath, agentId, timeoutMs }){
  const ctx = getContext?.() || null;
  const rawTimeout = Number(timeoutMs);
  const effectiveTimeoutMs = (Number.isFinite(rawTimeout) && rawTimeout > 0) ? rawTimeout : 0;
  const workspaceRoot = (ctx && ctx.workspaceRoot) ? ctx.workspaceRoot : resolveWorkspaceRoot();
  const effectiveAgentId = agentId || (ctx && ctx.agentId) || 'default';
  const sid = ensureSessionId({ sessionId, title, agentId: effectiveAgentId, workspaceRoot });
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
        const { session, toolHost } = await createArcanaSession({ workspaceRoot, agentHomeRoot });
        let runTokens = 0;
        let timeoutHandle = null;
        let timedOut = false;
        const unsub = session.subscribe((ev)=>{
          try {
            if (!ev) return;
            if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant'){
              const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
              const rawText = blocks.filter((c)=> c && c.type === 'text').map((c)=> c.text || '').join('');
              if (rawText){
                textBuffer = String(rawText).slice(-20000);
              }

              const extracted = extractMediaFromAssistantText(rawText);
              const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
              const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];

              if (cleanText){
                try { emit({ type: 'assistant_text', text: cleanText, sessionId: sid }); } catch {}
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
              const u = ev.message && ev.message.usage;
              const totals = extractUsageTotals(u);
              if (totals && typeof totals.totalTokens === 'number' && totals.totalTokens > 0){
                runTokens += totals.totalTokens;
              }
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
        }
        const finishedAtMs = Date.now();
        return { finishedAtMs, runTokens, timedOut };
      }
    );

    const finishedAtMs = timing && typeof timing.finishedAtMs === 'number' ? timing.finishedAtMs : Date.now();
    const deltaTokens = timing && typeof timing.runTokens === 'number' ? timing.runTokens : 0;
    const didTimeout = !!(timing && timing.timedOut);

    if (!didTimeout) {
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
    try { log.write('Error: ' + code + '\n'); } catch {}
    return {
      ok: false,
      sessionId: sid,
      error: code,
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

export default { runArcanaTask };
