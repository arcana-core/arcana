import { createArcanaSession } from '../session.js';
import { resolveWorkspaceRoot, ensureReadAllowed } from '../workspace-guard.js';
import { createSession, listSessions, appendMessage, loadSession, saveSession, buildHistoryPreludeText } from '../sessions-store.js';
import { resolveSessionIdForKey, setSessionIdForKey } from '../session-key-store.js';
import { createWriteStream, promises as fsp } from 'node:fs';
import { arcanaHomePath } from '../arcana-home.js';
import { getContext, runWithContext, emit } from '../event-bus.js';
import { loadArcanaConfig, loadAgentConfig } from '../config.js';
import { DEFAULT_CONTEXT_POLICY, buildSessionPrelude, compactSession, compactSessionByUserTurns } from '../context-manager.js';
import { buildErrorStack } from '../util/error.js';
import { mergeStreamingText, mergeTextBlocks } from '../streaming-text.js';
import { normalizeChatAttachments, extractAttachmentImages, attachmentsToMediaRefs } from '../gateway-v2/chat-attachments.js';

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

export function withTaskStreamRouting(event, { sessionId, sessionKey, agentId } = {}){
  if (!event || typeof event !== 'object') return event;
  const out = { ...event };
  const sid = String(sessionId || '').trim();
  const skey = String(sessionKey || '').trim();
  const aid = String(agentId || '').trim();
  if (sid && !String(out.sessionId || '').trim()) out.sessionId = sid;
  if (skey && !String(out.sessionKey || '').trim()) out.sessionKey = skey;
  if (aid && !String(out.agentId || '').trim()) out.agentId = aid;
  return out;
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
    const mediaMatch = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)?MEDIA\s*[:：]\s*(.*)$/);
    if (mediaMatch){
      const raw = mediaMatch[1] || '';
      const ref = normalizeMediaRef(raw);
      if (ref) mediaRefs.push(ref);
      continue;
    }
    outLines.push(line);
  }
  return { text: outLines.join('\n'), mediaRefs };
}

function detectUserPromptImageMime(filePath){
  try {
    const lower = String(filePath || '').trim().toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
  } catch {}
  return '';
}

async function extractUserPromptImages(message, ctx, attachments){
  const rawMessage = String(message || '');
  const attachmentImages = extractAttachmentImages(attachments);
  if (!rawMessage) return { cleanedMessage: '', images: attachmentImages };

  const lines = rawMessage.split(/\r?\n/);
  const keptLines = [];
  const imageRefs = [];

  for (const line of lines){
    const trimmedLine = String(line || '').trim();
    let matchedPrefix = false;
    let imageRef = '';

    if (/^image\s*:/i.test(trimmedLine)){
      matchedPrefix = true;
      imageRef = trimmedLine.replace(/^image\s*:/i, '').trim();
    } else if (trimmedLine.startsWith('看图:')){
      matchedPrefix = true;
      imageRef = trimmedLine.slice('看图:'.length).trim();
    }

    if (!matchedPrefix){
      keptLines.push(line);
      continue;
    }

    if (!imageRef){
      const err = new Error('Image reference is missing a file path');
      err.code = 'INVALID_IMAGE_REFERENCE';
      throw err;
    }

    imageRefs.push(imageRef);
  }

  if (!imageRefs.length){
    return { cleanedMessage: rawMessage, images: attachmentImages };
  }

  const images = [];
  for (const imageRef of imageRefs){
    const filePath = ctx
      ? await runWithContext(ctx, () => ensureReadAllowed(imageRef))
      : ensureReadAllowed(imageRef);
    const mimeType = detectUserPromptImageMime(filePath);
    if (!mimeType){
      const err = new Error('Unsupported image type: ' + imageRef);
      err.code = 'UNSUPPORTED_IMAGE_TYPE';
      throw err;
    }
    const data = await fsp.readFile(filePath);
    images.push({ type: 'image', data: data.toString('base64'), mimeType });
  }
  if (attachmentImages.length) images.push(...attachmentImages);

  return {
    cleanedMessage: keptLines.join('\n'),
    images,
  };
}

function buildBoundedHistoryPrelude(sessionObj, keepRecentUserTurns){
  if (!sessionObj) return '';
  const keepNum = Number(keepRecentUserTurns);
  if (Number.isFinite(keepNum) && keepNum > 0) {
    return buildSessionPrelude(sessionObj, DEFAULT_CONTEXT_POLICY, { keepRecentUserTurns: Math.floor(keepNum) }) || '';
  }
  return buildSessionPrelude(sessionObj, DEFAULT_CONTEXT_POLICY) || '';
}

function dropTrailingDuplicateUserMessage(sessionObj, userPrompt){
  try {
    if (!sessionObj || typeof sessionObj !== 'object') return sessionObj;
    const promptText = String(userPrompt || '').trim();
    if (!promptText) return sessionObj;
    const messages = Array.isArray(sessionObj.messages) ? sessionObj.messages : [];
    if (!messages.length) return sessionObj;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') return sessionObj;
    const lastText = String(last.text || '').trim();
    if (!lastText || lastText !== promptText) return sessionObj;
    return {
      ...sessionObj,
      messages: messages.slice(0, -1),
    };
  } catch {
    return sessionObj;
  }
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

function extractUsageFromToolEvent(ev){
  try {
    const candidates = [];
    const push = (value) => {
      if (value && typeof value === 'object') candidates.push(value);
    };
    if (ev && typeof ev === 'object'){
      push(ev.usage);
      push(ev.result && ev.result.usage);
      push(ev.result && ev.result.response && ev.result.response.usage);
      push(ev.response && ev.response.usage);
      push(ev.details && ev.details.usage);
      push(ev.details && ev.details.response && ev.details.response.usage);
    }
    let best = null;
    let bestTotal = 0;
    for (const candidate of candidates){
      const totals = extractUsageTotals(candidate);
      const total = Number(totals.totalTokens || 0) || 0;
      const context = Number(totals.contextTokens || 0) || 0;
      if (total > bestTotal || (!best && (total > 0 || context > 0))){
        best = totals;
        bestTotal = total;
      }
    }
    return best;
  } catch {
    return null;
  }
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

function normalizeErrorMessage(value, maxLen = 1200){
  try {
    if (value == null) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    const limit = Number(maxLen);
    if (!Number.isFinite(limit) || limit <= 0) return raw;
    if (raw.length <= limit) return raw;
    return raw.slice(0, Math.max(1, limit - 3)) + '...';
  } catch {
    return '';
  }
}

function isAbortLikeMessage(value){
  try {
    const s = String(value || '').trim().toLowerCase();
    if (!s) return false;
    return s === 'aborted' || s === 'abort' || s === 'cancelled' || s === 'canceled' || s.includes('aborted') || s.includes('cancelled') || s.includes('canceled');
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

function getCompressionThresholdTokens(agentHomeDir) {
  try {
    const globalCfg = loadArcanaConfig();
    const agentCfg = loadAgentConfig(agentHomeDir);
    if (agentCfg && typeof agentCfg === 'object') {
      const raw = agentCfg.history_compression_threshold_tokens;
      if (raw != null) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
    }
    if (globalCfg && typeof globalCfg === 'object') {
      const raw = globalCfg.history_compression_threshold_tokens;
      if (raw != null) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
    }
  } catch {}
  return null;
}

function getCompressionEnabled(agentHomeDir) {
  try {
    const globalCfg = loadArcanaConfig();
    const agentCfg = loadAgentConfig(agentHomeDir);
    const resolveValue = (cfg) => {
      if (!cfg || typeof cfg !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(cfg, 'history_compression_enabled')) return undefined;
      return cfg.history_compression_enabled;
    };
    const raw = resolveValue(agentCfg) ?? resolveValue(globalCfg);
    if (typeof raw === 'boolean') return raw;
    if (raw != null) {
      const s = String(raw).trim().toLowerCase();
      if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'none' || s === 'null') return false;
      if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    }
  } catch {}
  return true;
}

function getCompressionKeepUserTurns(agentHomeDir) {
  try {
    const globalCfg = loadArcanaConfig();
    const agentCfg = loadAgentConfig(agentHomeDir);
    const resolveValue = (cfg) => {
      if (!cfg || typeof cfg !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(cfg, 'history_compression_keep_user_turns')) return undefined;
      return cfg.history_compression_keep_user_turns;
    };
    const raw = resolveValue(agentCfg) ?? resolveValue(globalCfg);
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {}
  return 10;
}

function isContextOverflowError(err, finishReason, stopReason, errorMessage){
  try {
    const reasons = [finishReason, stopReason].filter(Boolean).map((r) => String(r).toLowerCase());
    for (const r of reasons){
      if (!r) continue;
      if (r.includes('context_length') || r.includes('context-length')) return true;
      if (r.includes('max_context') || r.includes('max-context')) return true;
      if (r.includes('context window') || r.includes('context_window')) return true;
      if (r.includes('token limit') || r.includes('too many tokens')) return true;
      if (r.includes('input too long') || r.includes('prompt too long')) return true;
      if (r.includes('exceeds') && r.includes('context')) return true;
    }
    if (errorMessage){
      const em = String(errorMessage).toLowerCase();
      if (em.includes('context_length') || em.includes('context-length') || em.includes('context length')) return true;
      if (em.includes('max_context') || em.includes('max-context') || em.includes('maximum context')) return true;
      if (em.includes('context window') || em.includes('context_window')) return true;
      if (em.includes('token limit') || em.includes('too many tokens')) return true;
      if (em.includes('input too long') || em.includes('prompt too long') || em.includes('prompt is too long')) return true;
      if (em.includes('exceeds') && (em.includes('context') || em.includes('maximum') || em.includes('limit'))) return true;
      if (em.includes('input token count') && em.includes('exceeds')) return true;
      if (em.includes('maximum prompt length')) return true;
      if (em.includes('reduce the length')) return true;
      if (em.includes('context window exceeds limit')) return true;
      if (em.includes('exceeded model token limit')) return true;
      if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(errorMessage)) return true;
      if (/\b413\b/.test(errorMessage)) return true;
    }
    if (err){
      const status = typeof err.status === 'number' ? err.status : (typeof err.statusCode === 'number' ? err.statusCode : 0);
      const code = String(err.code || err.type || '').toLowerCase();
      const msg = String(err.message || err || '').toLowerCase();
      if (status === 413) return true;
      if (code.includes('context_length') || code.includes('max_context') || code.includes('prompt_too_long')) return true;
      if (msg.includes('maximum context') || msg.includes('context length') || msg.includes('context window')) return true;
      if (msg.includes('prompt too long') || msg.includes('input too long') || msg.includes('too many tokens')) return true;
      if (msg.includes('prompt is too long')) return true;
      if (msg.includes('input token count') && msg.includes('exceeds')) return true;
      if (msg.includes('maximum prompt length')) return true;
      if (msg.includes('reduce') && msg.includes('length') && (msg.includes('context') || msg.includes('tokens'))) return true;
    }
  } catch {}
  return false;
}

const activeTurnsByKey = new Map();
const runtimeSessionsByKey = new Map();

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

function buildRuntimeSessionKey(agentId, sessionKey, sessionId, execPolicy, workspaceRoot){
  try {
    const a = (agentId == null ? '' : String(agentId)).trim() || 'default';
    const sk = (sessionKey == null ? '' : String(sessionKey)).trim();
    const sid = (sessionId == null ? '' : String(sessionId)).trim();
    const pol = String(execPolicy || 'restricted').trim().toLowerCase() === 'open' ? 'open' : 'restricted';
    const ws = (workspaceRoot == null ? '' : String(workspaceRoot)).trim();
    return [a, sk || sid || 'default', sid || 'default', pol, ws].join('|');
  } catch {
    return 'default|default|default|restricted|';
  }
}

function buildRetryContinuationPrompt(){
  return [
    '[Retry Previous Turn]',
    'The previous response was interrupted by a timeout or transient failure.',
    'Continue from the current conversation state and finish answering the pending user request.',
    'Do not restart from scratch.',
    'Do not repeat content that is already complete unless necessary for coherence.',
  ].join('\n');
}

async function disposeRuntimeSessionRecord(record){
  if (!record) return;
  try { record.toolHost && record.toolHost.cancelActiveCall && record.toolHost.cancelActiveCall(); } catch {}
  try {
    if (record.session && typeof record.session.abort === 'function'){
      const p = record.session.abort();
      if (p && typeof p.catch === 'function') await p.catch(() => {});
    }
  } catch {}
}

async function ensureRuntimeSessionRecord({ agentId, sessionKey, sessionId, workspaceRoot, agentHomeRoot, execPolicy, forceRecreate }){
  const key = buildRuntimeSessionKey(agentId, sessionKey, sessionId, execPolicy, workspaceRoot);
  if (forceRecreate) {
    const existing = runtimeSessionsByKey.get(key);
    if (existing) {
      await disposeRuntimeSessionRecord(existing);
      runtimeSessionsByKey.delete(key);
    }
  }

  for (const [entryKey, entry] of runtimeSessionsByKey.entries()){
    if (!entry || entryKey === key) continue;
    if (entry.agentId !== agentId) continue;
    if (String(entry.sessionId || '') !== String(sessionId || '')) continue;
    if (String(entry.sessionKey || '') !== String(sessionKey || '')) continue;
    if (String(entry.workspaceRoot || '') !== String(workspaceRoot || '')) continue;
    await disposeRuntimeSessionRecord(entry);
    runtimeSessionsByKey.delete(entryKey);
  }

  const cached = runtimeSessionsByKey.get(key);
  if (cached && cached.session) return cached;

  const created = await createArcanaSession({ workspaceRoot, agentHomeRoot, execPolicy });
  if (!created || !created.session) throw new Error('runtime_session_create_failed');

  const record = {
    key,
    agentId,
    sessionKey: String(sessionKey || ''),
    sessionId: String(sessionId || ''),
    workspaceRoot,
    agentHomeRoot,
    execPolicy: String(execPolicy || 'restricted').trim().toLowerCase() === 'open' ? 'open' : 'restricted',
    session: created.session,
    toolHost: created.toolHost || null,
  };
  runtimeSessionsByKey.set(key, record);
  return record;
}

export async function invalidateRuntimeSessions({ agentId } = {}){
  const targetAgentId = String(agentId || '').trim();
  const keys = [];
  for (const [key, entry] of runtimeSessionsByKey.entries()){
    if (!entry) continue;
    if (targetAgentId && String(entry.agentId || '') !== targetAgentId) continue;
    keys.push(key);
  }
  for (const key of keys){
    const entry = runtimeSessionsByKey.get(key);
    await disposeRuntimeSessionRecord(entry);
    runtimeSessionsByKey.delete(key);
  }
  return { ok: true, cleared: keys.length };
}

export async function clearRuntimeSessionContext({ agentId, sessionKey, sessionId } = {}){
  const targetAgentId = String(agentId || '').trim() || 'default';
  const targetSessionKey = String(sessionKey || '').trim();
  const targetSessionId = String(sessionId || '').trim();
  const keys = [];
  for (const [key, entry] of runtimeSessionsByKey.entries()){
    if (!entry) continue;
    if (String(entry.agentId || '') !== targetAgentId) continue;
    if (targetSessionId && String(entry.sessionId || '') !== targetSessionId) continue;
    if (targetSessionKey && String(entry.sessionKey || '') !== targetSessionKey) continue;
    keys.push(key);
  }
  for (const key of keys){
    const entry = runtimeSessionsByKey.get(key);
    await disposeRuntimeSessionRecord(entry);
    runtimeSessionsByKey.delete(key);
  }
  return { ok: keys.length > 0, cleared: keys.length };
}

export function requestTurnAbort({ agentId, sessionKey, sessionId } = {}){
  const key = buildTurnKey(agentId, sessionKey, sessionId);
  const turn = activeTurnsByKey.get(key);
  if (!turn || typeof turn.abort !== 'function') return { ok: false, reason: 'no_active_turn' };
  try { turn.abort(); } catch {}
  return { ok: true };
}

export async function requestTurnSteer({ agentId, sessionKey, sessionId, text } = {}){
  const key = buildTurnKey(agentId, sessionKey, sessionId);
  const turn = activeTurnsByKey.get(key);
  if (!turn || typeof turn.steer !== 'function') return { ok: false, reason: 'no_active_turn' };
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, reason: 'missing_text' };
  try {
    await turn.steer(msg);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e || 'steer_failed') };
  }
}

export async function runArcanaTask({ prompt, sessionId, sessionKey, title, logPath, agentId, timeoutMs, execPolicy, retryingEventId, attachments: rawAttachments }){
  const ctx = getContext?.() || null;
  const rawTimeout = Number(timeoutMs);
  const effectiveTimeoutMs = (Number.isFinite(rawTimeout) && rawTimeout > 0) ? rawTimeout : 0;
  const workspaceRoot = (ctx && ctx.workspaceRoot) ? ctx.workspaceRoot : resolveWorkspaceRoot();
  const effectiveAgentId = agentId || (ctx && ctx.agentId) || 'default';
  const effectiveExecPolicy = String(execPolicy || 'restricted').trim().toLowerCase() === 'open' ? 'open' : 'restricted';
  const sid = await ensureSessionId({ sessionId, sessionKey, title, agentId: effectiveAgentId, workspaceRoot });
  const startedAtMs = Date.now();
  const agentHomeRoot = arcanaHomePath('agents', effectiveAgentId);
  const log = createWriteStream(logPath, { flags: 'w' });
  const header = 'Arcana cron run at ' + (new Date(startedAtMs).toISOString()) + '\n' + 'sessionId: ' + sid + '\n' + 'agentId: ' + effectiveAgentId + '\n';
  try { log.write(header + '\n'); } catch {}

  let userPrompt = String(prompt||'');
  const attachments = normalizeChatAttachments(rawAttachments);
  const historyCompressionEnabled = getCompressionEnabled(agentHomeRoot);
  const compressionThresholdTokens = getCompressionThresholdTokens(agentHomeRoot) || 100000;
  const compressionKeepUserTurns = getCompressionKeepUserTurns(agentHomeRoot);
  const maxOverflowRetries = Number(DEFAULT_CONTEXT_POLICY.maxOverflowRetries) > 0 ? Math.floor(Number(DEFAULT_CONTEXT_POLICY.maxOverflowRetries)) : 3;
  let textBuffer = '';
  const routeStreamEvent = (event) => withTaskStreamRouting(event, {
    sessionId: sid,
    sessionKey,
    agentId: effectiveAgentId,
  });

  try { emit(routeStreamEvent({ type: 'turn_start' })); } catch {}

  try {
    const promptPayload = await extractUserPromptImages(
      userPrompt,
      { sessionId: sid, sessionKey, agentId: effectiveAgentId, agentHomeRoot, workspaceRoot },
      attachments,
    );
    const promptImages = Array.isArray(promptPayload && promptPayload.images) ? promptPayload.images : [];
    userPrompt = String(promptPayload && promptPayload.cleanedMessage || '').trim();
    if (!userPrompt && promptImages.length) {
      userPrompt = 'See attached image.';
    }
    if (!retryingEventId){
      const userMediaRefs = attachmentsToMediaRefs(attachments);
      appendMessage(sid, { role: 'user', text: userPrompt, agentId: effectiveAgentId, mediaRefs: userMediaRefs });
    }
    let overflowAttempt = 0;
    let forceRecreate = false;
    let finalResult = null;
    let lastPromptPrelude = '';

    const loadPreludeSource = () => {
      try {
        const existingSession = loadSession(sid, { agentId: effectiveAgentId });
        return dropTrailingDuplicateUserMessage(existingSession, userPrompt);
      } catch {
        return null;
      }
    };

    const buildPreludeForSource = (source) => {
      const summary = source && typeof source.summary === 'string' ? String(source.summary || '').trim() : '';
      if (summary && historyCompressionEnabled && compressionKeepUserTurns > 0) {
        return buildBoundedHistoryPrelude(source, compressionKeepUserTurns);
      }
      return buildBoundedHistoryPrelude(source);
    };

    const compactAndRecreate = async (reason) => {
      if (!historyCompressionEnabled || compressionKeepUserTurns <= 0) return { compacted: false };
      const compacted = await compactSessionByUserTurns({
        sessionId: sid,
        agentId: effectiveAgentId,
        workspaceRoot,
        agentHomeDir: agentHomeRoot,
        keepRecentUserTurns: compressionKeepUserTurns,
        policy: DEFAULT_CONTEXT_POLICY,
        reason,
      });
      if (compacted && compacted.compacted === true) {
        forceRecreate = true;
      }
      return compacted;
    };

    while (overflowAttempt <= maxOverflowRetries) {
      textBuffer = '';
      const mediaRefsSeen = new Set();
      const record = await runWithContext(
        { sessionId: sid, sessionKey, agentId: effectiveAgentId, agentHomeRoot, workspaceRoot },
        () => ensureRuntimeSessionRecord({
          agentId: effectiveAgentId,
          sessionKey,
          sessionId: sid,
          workspaceRoot,
          agentHomeRoot,
          execPolicy: effectiveExecPolicy,
          forceRecreate,
        }),
      );
      forceRecreate = false;

      try {
        const liveUsage = (record.session && typeof record.session.getContextUsage === 'function')
          ? record.session.getContextUsage()
          : null;
        const liveTokens = Number(liveUsage && liveUsage.tokens || 0) || 0;
        if (historyCompressionEnabled && compressionThresholdTokens > 0 && compressionKeepUserTurns > 0 && liveTokens > compressionThresholdTokens) {
          const compacted = await compactAndRecreate('pre_prompt_threshold');
          if (compacted && compacted.compacted === true) {
            overflowAttempt += 1;
            continue;
          }
        }
      } catch {}

      const preludeSource = loadPreludeSource();
      let historyPrelude = '';
      let hasInternalAgentMessages = false;
      try {
        const agentMessages = record.session && record.session.agent && record.session.agent.state && Array.isArray(record.session.agent.state.messages)
          ? record.session.agent.state.messages
          : [];
        hasInternalAgentMessages = agentMessages.length > 0;
        if (!agentMessages.length) {
          historyPrelude = buildPreludeForSource(preludeSource);
        }
      } catch {
        historyPrelude = buildPreludeForSource(preludeSource);
      }
      lastPromptPrelude = historyPrelude;

      const currentQuestion = '[Current Question]\n' + userPrompt;
      const retryContinuation = buildRetryContinuationPrompt();
      let finalPrompt = historyPrelude ? (historyPrelude + '\n\n' + currentQuestion) : currentQuestion;
      if (retryingEventId && hasInternalAgentMessages){
        finalPrompt = retryContinuation;
      }

      const timing = await runWithContext(
        { sessionId: sid, sessionKey, agentId: effectiveAgentId, agentHomeRoot, workspaceRoot },
        async () => {
          const session = record.session;
          const toolHost = record.toolHost;
          const turnKey = buildTurnKey(effectiveAgentId, sessionKey, sid);
          const turnCtx = { sessionId: sid, sessionKey, agentId: effectiveAgentId, agentHomeRoot, workspaceRoot };
          const abortFn = () => {
            try { toolHost && toolHost.cancelActiveCall && toolHost.cancelActiveCall(); } catch {}
            try {
              if (session && typeof session.abort === 'function') {
                const p = session.abort();
                if (p && typeof p.catch === 'function') p.catch(() => {});
              }
            } catch {}
          };
          const steerFn = async (text) => {
            const steerText = String(text || '').trim();
            if (!steerText) return;
            try {
              await runWithContext(
                turnCtx,
                () => session.prompt(steerText, { streamingBehavior: 'steer', expandPromptTemplates: true }),
              );
            } catch (e) {
              throw e instanceof Error ? e : new Error(String(e || 'steer_failed'));
            }
            try { emit({ type: 'steer_enqueued', sessionId: sid, agentId: effectiveAgentId, text: steerText }); } catch {}
          };
          try { activeTurnsByKey.set(turnKey, { abort: abortFn, steer: steerFn }); } catch {}

          let runTokens = 0;
          let runContextTokens = 0;
          let runOutputTokens = 0;
          let lastCallContextTokens = 0;
          let lastCallTotalTokens = 0;
          let lastAssistantTextEmitted = '';
          let timeoutHandle = null;
          let timedOut = false;
          let finishReason = '';
          let stopReason = '';
          let lastAssistantErrorMessage = '';
          let promptError = null;

          const unsub = session.subscribe((ev)=>{
            try {
              if (!ev) return;
              if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant'){
                try {
                  const em = normalizeErrorMessage(ev.message.errorMessage || ev.message.error || '');
                  if (em) lastAssistantErrorMessage = em;
                } catch {}
                const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
                const rawText = mergeTextBlocks(blocks);
                if (rawText){
                  textBuffer = mergeStreamingText(textBuffer, rawText, { maxLen: ASSISTANT_STREAM_MAX_CHARS });
                }
                const extracted = extractMediaFromAssistantText(textBuffer);
                const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
                const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
                if (cleanText && cleanText !== lastAssistantTextEmitted){
                  try { emit(routeStreamEvent({ type: 'assistant_text', text: cleanText })); } catch {}
                  lastAssistantTextEmitted = cleanText;
                }
                if (mediaRefs.length){
                  for (const raw of mediaRefs){
                    const ref = normalizeMediaRef(raw);
                    if (!ref || mediaRefsSeen.has(ref)) continue;
                    mediaRefsSeen.add(ref);
                    try { emit(routeStreamEvent({ type: 'assistant_image', url: ref, mime: 'image/*' })); } catch {}
                  }
                }
              }
              if (ev.type === 'message_end' && ev.message && ev.message.role === 'assistant'){
                try {
                  const em = normalizeErrorMessage(ev.message.errorMessage || ev.message.error || '');
                  if (em) lastAssistantErrorMessage = em;
                } catch {}
                const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
                const rawText = mergeTextBlocks(blocks);
                if (rawText){
                  textBuffer = mergeStreamingText(textBuffer, rawText, { maxLen: ASSISTANT_STREAM_MAX_CHARS });
                }
                const extracted = extractMediaFromAssistantText(textBuffer);
                const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
                const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
                if (cleanText && cleanText !== lastAssistantTextEmitted){
                  try { emit(routeStreamEvent({ type: 'assistant_text', text: cleanText })); } catch {}
                  lastAssistantTextEmitted = cleanText;
                }
                if (mediaRefs.length){
                  for (const raw of mediaRefs){
                    const ref = normalizeMediaRef(raw);
                    if (!ref || mediaRefsSeen.has(ref)) continue;
                    mediaRefsSeen.add(ref);
                    try { emit(routeStreamEvent({ type: 'assistant_image', url: ref, mime: 'image/*' })); } catch {}
                  }
                }
                const u = ev.message && ev.message.usage;
                const totals = extractUsageTotals(u);
                if (totals){
                  if (typeof totals.totalTokens === 'number' && totals.totalTokens > 0) runTokens += totals.totalTokens;
                  if (typeof totals.contextTokens === 'number' && totals.contextTokens > 0) runContextTokens += totals.contextTokens;
                  if (typeof totals.outputTokens === 'number' && totals.outputTokens > 0) runOutputTokens += totals.outputTokens;
                  lastCallContextTokens = (typeof totals.contextTokens === 'number' && totals.contextTokens > 0) ? totals.contextTokens : 0;
                  lastCallTotalTokens = (typeof totals.totalTokens === 'number' && totals.totalTokens > 0) ? totals.totalTokens : 0;
                  try {
                    emit({
                      type: 'llm_call_usage',
                      sessionId: sid,
                      agentId: effectiveAgentId,
                      contextTokens: lastCallContextTokens,
                      totalTokens: lastCallTotalTokens,
                    });
                  } catch {}
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
                let payload = routeStreamEvent(ev && typeof ev === 'object' ? ev : {});
                if (ev.type === 'tool_execution_end'){
                  try {
                    const usage = extractUsageFromToolEvent(ev);
                    if (usage && (usage.totalTokens > 0 || usage.contextTokens > 0 || usage.outputTokens > 0)){
                      payload = payload && typeof payload === 'object'
                        ? { ...payload, usage, contextTokens: usage.contextTokens, outputTokens: usage.outputTokens }
                        : routeStreamEvent({ type: 'tool_execution_end', usage, contextTokens: usage.contextTokens, outputTokens: usage.outputTokens });
                    }
                  } catch {}
                }
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
              const promptOpts = { expandPromptTemplates: true };
              if (promptImages.length) promptOpts.images = promptImages;
              await Promise.race([session.prompt(finalPrompt, promptOpts), timeoutPromise]);
            } else {
              const promptOpts = { expandPromptTemplates: true };
              if (promptImages.length) promptOpts.images = promptImages;
              await session.prompt(finalPrompt, promptOpts);
            }
          } catch (e) {
            promptError = e;
          } finally {
            if (timeoutHandle) {
              try { clearTimeout(timeoutHandle); } catch {}
            }
            try { unsub && unsub(); } catch {}
            try { activeTurnsByKey.delete(buildTurnKey(effectiveAgentId, sessionKey, sid)); } catch {}
          }

          const finishedAtMs = Date.now();
          const completionErrorReason = isCompletionErrorReason(finishReason) ? finishReason : (isCompletionErrorReason(stopReason) ? stopReason : '');
          const overflow = isContextOverflowError(promptError, finishReason, stopReason, lastAssistantErrorMessage);
          return {
            finishedAtMs,
            runTokens,
            runContextTokens,
            runOutputTokens,
            lastCallContextTokens,
            lastCallTotalTokens,
            timedOut,
            finishReason,
            stopReason,
            completionErrorReason,
            lastAssistantErrorMessage,
            promptError,
            overflow,
          };
        }
      );

      const finishedAtMs = timing && typeof timing.finishedAtMs === 'number' ? timing.finishedAtMs : Date.now();
      const runTokens = timing && typeof timing.runTokens === 'number' ? timing.runTokens : 0;
      const runContextTokens = timing && typeof timing.runContextTokens === 'number' ? timing.runContextTokens : 0;
      const runOutputTokens = timing && typeof timing.runOutputTokens === 'number' ? timing.runOutputTokens : 0;
      const lastCallContextTokens = timing && typeof timing.lastCallContextTokens === 'number' ? timing.lastCallContextTokens : 0;
      const lastCallTotalTokens = timing && typeof timing.lastCallTotalTokens === 'number' ? timing.lastCallTotalTokens : 0;
      const didTimeout = !!(timing && timing.timedOut);
      const completionErrorReason = timing && typeof timing.completionErrorReason === 'string' ? timing.completionErrorReason : '';
      const completionErrorDetail = normalizeErrorMessage(timing && timing.lastAssistantErrorMessage ? timing.lastAssistantErrorMessage : '');
      const promptError = timing && timing.promptError ? timing.promptError : null;
      const overflow = !!(timing && timing.overflow);

      if (overflow && overflowAttempt < maxOverflowRetries) {
        const compacted = await compactAndRecreate('overflow');
        if (compacted && compacted.compacted === true) {
          overflowAttempt += 1;
          continue;
        }
      }

      if (promptError) {
        throw promptError;
      }

      let sessionTokensTotal = 0;
      try {
        const objAfter = loadSession(sid, { agentId: effectiveAgentId }) || {};
        const prevTokens = Number(objAfter.sessionTokens || 0);
        const nextTokens = (Number.isFinite(prevTokens) && prevTokens > 0 ? prevTokens : 0) + (runTokens > 0 ? runTokens : 0);
        if (nextTokens > 0) {
          objAfter.sessionTokens = nextTokens;
          saveSession(objAfter, { agentId: effectiveAgentId });
          sessionTokensTotal = nextTokens;
        } else if (Number.isFinite(prevTokens) && prevTokens > 0) {
          sessionTokensTotal = prevTokens;
        }
      } catch {}

      if (!didTimeout && !completionErrorReason) {
        appendMessage(sid, { role: 'assistant', text: textBuffer, agentId: effectiveAgentId });
      }

      try {
        log.write('Prompt:\n' + userPrompt + '\n\n');
        if (lastPromptPrelude) log.write('History Prelude:\n' + lastPromptPrelude + '\n\n');
        log.write('Assistant:\n' + textBuffer + '\n');
      } catch {}

      try {
        if (runTokens > 0 || runContextTokens > 0 || runOutputTokens > 0 || sessionTokensTotal > 0){
	          emit({
	            type: 'llm_usage',
	            sessionId: sid,
	            sessionKey,
	            agentId: effectiveAgentId,
	            contextTokens: runContextTokens,
            outputTokens: runOutputTokens,
            totalTokens: runTokens,
            lastCallContextTokens,
            lastCallTotalTokens,
            sessionTokens: sessionTokensTotal,
          });
        }
      } catch {}

      if (completionErrorReason){
        const reasonText = String(completionErrorReason || '').trim() || 'error';
        const errMsg = completionErrorDetail
          ? ('completion_error: ' + reasonText + ' | ' + completionErrorDetail)
          : ('completion_error: ' + reasonText);
        try {
          emit(routeStreamEvent({ type: 'error', message: errMsg }));
        } catch {}
        try {
          emit(routeStreamEvent({ type: 'turn_error', error: errMsg, errorMessage: completionErrorDetail || reasonText, startedAtMs, finishedAtMs }));
        } catch {}
        finalResult = {
          ok: false,
          completed: true,
          sessionId: sid,
          error: errMsg,
          errorMessage: completionErrorDetail || reasonText,
          startedAtMs,
          finishedAtMs,
          outputTail: tailLines(textBuffer),
          assistantText: textBuffer,
        };
      } else {
        finalResult = {
          ok: true,
          completed: true,
          sessionId: sid,
          startedAtMs,
          finishedAtMs,
          outputTail: tailLines(textBuffer),
          assistantText: textBuffer,
        };
      }
      break;
    }

    if (finalResult) return finalResult;
    throw new Error('run_arcana_task_no_result');
  } catch (e) {
    const finishedAtMs = Date.now();
    const msg = String(e?.message || e || '');
    const code = (msg === 'timeout') ? 'timeout' : (msg || 'error');
    const aborted = isAbortLikeMessage(code);

    const fullStack = buildErrorStack(e);
    const cap = 8000;
    const boundedStack = typeof fullStack === 'string' ? (fullStack.length > cap ? fullStack.slice(0, cap) : fullStack) : '';

    try {
      log.write('Error: ' + code + '\n');
      if (fullStack) log.write('Stack:\n' + fullStack + '\n');
    } catch {}

    if (!aborted){
      try {
        emit(routeStreamEvent({ type: 'turn_error', error: code, errorStack: boundedStack, startedAtMs, finishedAtMs }));
      } catch {}
    }

    return {
      ok: false,
      completed: false,
      aborted,
      sessionId: sid,
      error: code,
      errorStack: boundedStack,
      startedAtMs,
      finishedAtMs,
      outputTail: tailLines(textBuffer),
      assistantText: textBuffer,
    };
  } finally {
    try { emit(routeStreamEvent({ type: 'turn_end' })); } catch {}
    try { log.end(); } catch {}
  }
}

export default {
  runArcanaTask,
  requestTurnAbort,
  requestTurnSteer,
  invalidateRuntimeSessions,
  clearRuntimeSessionContext,
};
