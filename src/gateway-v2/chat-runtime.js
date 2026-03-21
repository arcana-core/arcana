import { dirname, isAbsolute, join } from 'node:path';
import { promises as fsp, readFileSync } from 'node:fs';
import { parseFrontmatter } from '@mariozechner/pi-coding-agent';
import { arcanaHomePath } from '../arcana-home.js';
import { resolveWorkspaceRoot } from '../workspace-guard.js';
import { createArcanaSession } from '../session.js';
import { ensureSessionId } from '../cron/arcana-task.js';
import { runWithContext, emit } from '../event-bus.js';
import { loadArcanaConfig, loadAgentConfig } from '../config.js';
import {
  loadSession as ssLoad,
  appendMessage as ssAppend,
  saveSession as ssSave,
  buildHistoryPreludeText,
} from '../sessions-store.js';
import {
  DEFAULT_CONTEXT_POLICY,
  buildSessionPrelude,
  trimUserMessage,
  estimateTokensFromText,
  compactSessionByUserTurns,
} from '../context-manager.js';
import { buildErrorStack } from '../util/error.js';
import { nowMs, ensureDir } from './util.js';
import { persistToolMetaToDisk, persistToolResultToDisk, scheduleAppendToolStream } from '../tool-output-store.js';
import { mergeStreamingText } from '../streaming-text.js';

// Long-lived chat sessions keyed by agentId|sessionId|policy|workspaceRoot
const chatSessions = new Map();

const DEFAULT_AGENT_ID = 'default';

const MAX_LOG_JSON_CHARS = 8000;
const MAX_PROMPT_LOG_CHARS = 8000;
const MAX_PROMPT_LOG_CHARS_FULL = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_ITEMS = 16;
const MAX_DIAGNOSTIC_STRING_CHARS = 512;

function truthyEnv(name){
  try {
    if (!name) return false;
    const src = typeof process !== 'undefined' && process && process.env ? process.env : null;
    if (!src || !Object.prototype.hasOwnProperty.call(src, name)) return false;
    const raw = src[name];
    if (raw == null) return false;
    const v = String(raw).trim().toLowerCase();
    if (!v) return false;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === 'none' || v === 'null') return false;
    return true;
  } catch {
    return false;
  }
}

function truncateStringForLog(value, maxLen){
  try {
    const s = String(value == null ? '' : value);
    const limit = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : MAX_DIAGNOSTIC_STRING_CHARS;
    if (s.length <= limit) return s;
    if (limit <= 16) return s.slice(0, limit);
    return s.slice(0, limit - 12) + '...[truncated]';
  } catch {
    return '';
  }
}

function safeJsonForLog(value, maxLen){
  let json = '';
  try {
    json = JSON.stringify(value);
  } catch {
    try {
      json = JSON.stringify(String(value));
    } catch {
      json = '"[unserializable]"';
    }
  }
  const limit = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : MAX_LOG_JSON_CHARS;
  if (json.length > limit){
    const suffix = '... (truncated)';
    const headLen = Math.max(0, limit - suffix.length);
    json = json.slice(0, headLen) + suffix;
  }
  return json;
}

function asciiSafeBody(text){
  try {
    const s = String(text || '');
    const forceAscii = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_ASCII_ONLY');
    let out = '';
    for (let i = 0; i < s.length; i += 1){
      const ch = s[i];
      const code = ch.charCodeAt(0);
      if (code === 0x0a || code === 0x0d || code === 0x09){
        out += ch;
        continue;
      }
      if (forceAscii){
        // Legacy behavior: keep only ASCII printable characters and common whitespace.
        if (code >= 0x20 && code <= 0x7e){
          out += ch;
        } else {
          out += '?';
        }
        continue;
      }

      // UTF-8-friendly behavior: preserve all Unicode characters except control
      // characters (other than newline, carriage return and tab) which are
      // replaced with '?' to avoid corrupting log consumers.
      if ((code >= 0x00 && code < 0x20) || code === 0x7f){
        out += '?';
      } else {
        out += ch;
      }
    }
    return out;
  } catch {
    return String(text || '');
  }
}

function sanitizeId(s){
  try {
    const v = String(s == null ? '' : s).trim();
    if (!v) return 'default';
    const safe = v.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || 'default';
  } catch {
    return 'default';
  }
}

function buildChatLogPath(agentId, sessionKey, sessionId){
  try {
    const safeAgent = sanitizeId(agentId || DEFAULT_AGENT_ID);
    const rawKey = (sessionKey && String(sessionKey).trim()) || (sessionId && String(sessionId).trim()) || 'session';
    const safeKey = sanitizeId(rawKey);
    const dir = arcanaHomePath('gateway-v2', 'logs');
    const ts = nowMs();
    const file = safeAgent + '__chat__' + safeKey + '__' + ts + '.log';
    return join(dir, file);
  } catch {
    const dir = arcanaHomePath('gateway-v2', 'logs');
    const ts = nowMs();
    return join(dir, 'default__chat__session__' + ts + '.log');
  }
}

// Chat logs are written as UTF-8 text. By default, all Unicode characters
// are preserved in the log body and only control characters (except \n, \r,
// and \t) are replaced with '?'. To force the legacy ASCII-only behavior
// where all non-ASCII characters are replaced with '?', set the environment
// variable ARCANA_GATEWAY_V2_CHAT_LOG_ASCII_ONLY=1.
//
// Minimal self-check examples:
// - Default mode: "\u4f60\u597d\n" stays "\u4f60\u597d\n" in logs.
// - ASCII-only mode (env=1): "\u4f60\u597d\n" becomes "??\n".
async function writeChatLog({ logPath, headerLines, promptText, includePrompt, errorStack, stats, diagnostics, promptMaxChars, modelRequest, includeModelRequest, modelRequestMaxChars }){
  if (!logPath) return null;
  try {
    const dir = dirname(logPath);
    if (dir) await ensureDir(dir);
  } catch {}

  const lines = [];
  try {
    if (Array.isArray(headerLines)){
      for (const line of headerLines){
        lines.push(String(line == null ? '' : line));
      }
    }
  } catch {}

  try {
    if (stats && typeof stats === 'object'){
      lines.push('');
      lines.push('stats: ' + safeJsonForLog(stats, MAX_LOG_JSON_CHARS));
    }
  } catch {}

  try {
    if (diagnostics && typeof diagnostics === 'object'){
      const keys = Object.keys(diagnostics);
      if (keys.length){
        lines.push('');
        lines.push('diagnostics: ' + safeJsonForLog(diagnostics, MAX_LOG_JSON_CHARS));
      }
    }
  } catch {}

  try {
    if (errorStack){
      lines.push('');
      lines.push('error_stack:');
      lines.push(String(errorStack || ''));
    }
  } catch {}

  try {
    if (includePrompt && promptText){
      lines.push('');
      lines.push('prompt:');
      const promptSafe = truncateStringForLog(promptText, promptMaxChars || MAX_PROMPT_LOG_CHARS);
      lines.push(String(promptSafe || ''));
    }
  } catch {}

  try {
    if (includeModelRequest && modelRequest){
      lines.push('');
      lines.push('model_request:');
      const maxLen = modelRequestMaxChars || MAX_PROMPT_LOG_CHARS;
      const reqSafe = safeJsonForLog(modelRequest, maxLen);
      lines.push(String(reqSafe || ''));
    }
  } catch {}

  const body = asciiSafeBody(lines.join('\n') + '\n');
  try {
    await fsp.writeFile(logPath, body, 'utf8');
  } catch {}
  return logPath;
}

function normalizeAgentId(raw){
  try {
    const s = String(raw == null ? '' : raw).trim();
    return s || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function buildChatKey({ agentId, sessionId, policy, workspaceRoot }){
  try {
    const aid = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const sid = String(sessionId || 'default').trim() || 'default';
    const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
    const ws = String(workspaceRoot || '').trim() || '';
    return aid + '|' + sid + '|' + pol + '|' + ws;
  } catch {
    return 'default|default|restricted|';
  }
}

async function ensureChatSession({ sessionId, agentId, policy }){
  const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
  const sid = String(sessionId || '').trim();
  const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';

  // Resolve workspaceRoot from session store when possible
  let ws = '';
  let sessionObj = null;
  try {
    if (sid) sessionObj = ssLoad(sid, { agentId: effectiveAgentId });
  } catch {}
  try {
    if (sessionObj && sessionObj.workspace) ws = String(sessionObj.workspace || '');
  } catch {}
  if (!ws){
    try { ws = resolveWorkspaceRoot(); } catch { ws = process.cwd(); }
  }
  const agentHomeDir = arcanaHomePath('agents', effectiveAgentId);
  const key = buildChatKey({ agentId: effectiveAgentId, sessionId: sid || 'default', policy: pol, workspaceRoot: ws });
  const existing = chatSessions.get(key);
  if (existing && existing.session){
    return existing;
  }

  let created = null;
  await runWithContext(
    { sessionId: sid || 'default', agentId: effectiveAgentId, agentHomeRoot: agentHomeDir, workspaceRoot: ws },
    async () => {
      created = await createArcanaSession({ workspaceRoot: ws, agentHomeRoot: agentHomeDir, execPolicy: pol });
    },
  );
  if (!created || !created.session){
    throw new Error('chat_session_create_failed');
  }
  const record = {
    session: created.session,
    toolHost: created.toolHost || null,
    model: created.model || null,
    agentId: effectiveAgentId,
    agentHomeDir,
    workspaceRoot: ws,
    sessionId: sid || 'default',
    skillToolMap: created.skillToolMap || new Map(),
  };

  attachChatEventBridge(record, sid || 'default');
  chatSessions.set(key, record);
  return record;
}


function normalizeUsageObject(raw){
  try {
    if (!raw || typeof raw !== 'object') return null;
    let input = Number(
      raw.inputTokens ??
      raw.input_tokens ??
      raw.prompt_tokens ??
      raw.promptTokens ??
      raw.input ??
      raw.prompt ??
      0
    ) || 0;
    let output = Number(
      raw.outputTokens ??
      raw.output_tokens ??
      raw.completion_tokens ??
      raw.completionTokens ??
      raw.output ??
      0
    ) || 0;
    let total = Number(
      raw.totalTokens ??
      raw.total_tokens ??
      raw.total ??
      0
    ) || 0;
    if (!Number.isFinite(input) || input < 0) input = 0;
    if (!Number.isFinite(output) || output < 0) output = 0;
    if (!Number.isFinite(total) || total < 0) total = 0;
    if (!total && (input || output)) total = input + output;
    input = input ? Math.floor(input) : 0;
    output = output ? Math.floor(output) : 0;
    total = total ? Math.floor(total) : 0;
    if (!input && !output && !total) return null;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  } catch {
    return null;
  }
}

// Extract a normalized usage object from a tool_execution_end event, if present.
function extractUsageFromToolEvent(ev){
  try {
    if (!ev || !ev.result) return null;
    const r = ev.result;
    const candidates = [];
    if (r && typeof r === 'object'){
      if (r.details && r.details.usage) candidates.push(r.details.usage);
      if (r.usage) candidates.push(r.usage);
      if (r.response && r.response.usage) candidates.push(r.response.usage);
      if (r.result && r.result.usage) candidates.push(r.result.usage);
    }
    for (const raw of candidates){
      const norm = normalizeUsageObject(raw);
      if (norm) return norm;
    }
    return null;
  } catch {
    return null;
  }
}
function extractUsageTotals(u){
  let ctx = 0;
  let out = 0;
  let tot = 0;
  try {
    if (u && typeof u === 'object'){
      const input = Number(u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.input ?? u.prompt ?? 0) || 0;
      const output = Number(u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? u.output ?? 0) || 0;
      const cacheRead = Number(u.cacheRead ?? u.cache_read_input_tokens ?? u.cacheReadTokens ?? 0) || 0;
      const cacheWrite = Number(u.cacheWrite ?? u.cache_creation_input_tokens ?? u.cacheWriteTokens ?? 0) || 0;
      // Treat context tokens as everything that contributes to the request context
      ctx = input + cacheRead + cacheWrite;
      out = output;
      tot = Number(u.totalTokens ?? u.total_tokens ?? u.total ?? 0) || 0;
      if (!tot) tot = ctx + out;
    }
  } catch {}
  if (!Number.isFinite(tot) || tot < 0) tot = 0;
  if (!Number.isFinite(ctx) || ctx < 0) ctx = 0;
  if (!Number.isFinite(out) || out < 0) out = 0;
  return { contextTokens: ctx, outputTokens: out, totalTokens: tot };
}

function extractUsageFromAssistantMessage(msg, extractUsageTotalsFn){
  try {
    if (!msg || typeof msg !== 'object') return null;
    const candidates = [];
    const push = (raw) => {
      if (raw && typeof raw === 'object') candidates.push(raw);
    };
    push(msg.usage);
    if (msg.response && typeof msg.response === 'object'){
      push(msg.response.usage);
    }
    if (msg.result && typeof msg.result === 'object'){
      push(msg.result.usage);
    }
    if (msg.meta && typeof msg.meta === 'object'){
      push(msg.meta.usage);
      if (msg.meta.response && typeof msg.meta.response === 'object'){
        push(msg.meta.response.usage);
      }
      if (msg.meta.raw && typeof msg.meta.raw === 'object'){
        push(msg.meta.raw.usage);
      }
    }
    if (msg.raw && typeof msg.raw === 'object'){
      push(msg.raw.usage);
      if (msg.raw.response && typeof msg.raw.response === 'object'){
        push(msg.raw.response.usage);
      }
    }
    if (msg.providerResponse && typeof msg.providerResponse === 'object'){
      push(msg.providerResponse.usage);
    }
    if (!candidates.length) return null;
    const fn = typeof extractUsageTotalsFn === 'function' ? extractUsageTotalsFn : extractUsageTotals;
    let best = null;
    let bestTotals = null;
    let bestScore = -1;
    for (const raw of candidates){
      let totals;
      try { totals = fn(raw); } catch { totals = null; }
      if (!totals || typeof totals !== 'object') continue;
      const ctx = Number(totals.contextTokens || 0) || 0;
      const out = Number(totals.outputTokens || 0) || 0;
      let score = Number(totals.totalTokens || 0) || 0;
      if (!score) score = ctx + out;
      if (!Number.isFinite(score) || score <= 0) continue;
      if (score > bestScore){
        bestScore = score;
        best = raw;
        bestTotals = totals;
      }
    }
    if (!bestTotals) return null;
    return { usage: best, totals: bestTotals };
  } catch {
    return null;
  }
}


function buildModelDiagnostics(model){
  try {
    if (!model || typeof model !== 'object') return null;
    const provider = model.provider != null ? String(model.provider) : '';
    const id = model.id != null ? String(model.id) : (model.model != null ? String(model.model) : '');
    const baseUrl = model.baseUrl != null ? String(model.baseUrl) : (model.base_url != null ? String(model.base_url) : (model.baseURL != null ? String(model.baseURL) : ''));
    const labelCore = provider ? (provider + ':' + id) : id;
    const label = labelCore || '';
    const out = {};
    if (provider) out.provider = provider;
    if (id) out.id = id;
    if (baseUrl) out.baseUrl = baseUrl;
    if (label) out.label = label;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function isErrorLikeEventType(t){
  try {
    if (!t) return false;
    const s = String(t).toLowerCase();
    if (!s) return false;
    if (s === 'error' || s === 'exception') return true;
    if (s === 'abort' || s === 'aborted') return true;
    if (s === 'timeout') return true;
    if (s.includes('error')) return true;
    if (s.includes('rate_limit') || s.includes('rate-limit')) return true;
    if (s.includes('content_filter') || s.includes('content-filter')) return true;
    if (s.includes('blocked')) return true;
    if (s.includes('overloaded')) return true;
    return false;
  } catch {
    return false;
  }
}

function extractErrorEventSummary(ev, t){
  try {
    const summary = { type: String(t || '') };
    let reason = '';
    try {
      if (ev && typeof ev === 'object'){
        const eAny = ev;
        let raw = null;
        if (Object.prototype.hasOwnProperty.call(eAny, 'error') && eAny.error != null){
          const errVal = eAny.error;
          if (errVal && typeof errVal === 'object'){
            if (typeof errVal.message === 'string' && errVal.message){
              raw = errVal.message;
            } else if (typeof errVal.error === 'string' && errVal.error){
              raw = errVal.error;
            } else if (typeof errVal.code === 'string' && errVal.code){
              raw = errVal.code;
            } else {
              raw = safeJsonForLog(errVal, MAX_DIAGNOSTIC_STRING_CHARS);
            }
          } else {
            raw = errVal;
          }
        }
        if (raw == null && Object.prototype.hasOwnProperty.call(eAny, 'reason') && eAny.reason != null){
          raw = eAny.reason;
        }
        if (raw == null && Object.prototype.hasOwnProperty.call(eAny, 'message') && eAny.message != null){
          raw = eAny.message;
        }
        if (raw == null && Object.prototype.hasOwnProperty.call(eAny, 'code') && eAny.code != null){
          raw = eAny.code;
        }
        if (raw != null){
          reason = truncateStringForLog(raw, MAX_DIAGNOSTIC_STRING_CHARS);
        }
        if (typeof eAny.status === 'number' && Number.isFinite(eAny.status)) summary.status = eAny.status;
      }
    } catch {}
    if (reason) summary.reason = reason;
    if (!summary.reason && summary.status == null && !summary.type) return null;
    return summary;
  } catch {
    return null;
  }
}

function extractAssistantMessageMeta(msg){
  try {
    if (!msg || typeof msg !== 'object') return null;
    const meta = {};
    const scalarKeys = ['id', 'role', 'model', 'provider', 'index', 'created', 'response_id'];
    for (const k of scalarKeys){
      if (Object.prototype.hasOwnProperty.call(msg, k) && msg[k] != null){
        const v = msg[k];
        meta[k] = typeof v === 'string' ? truncateStringForLog(v, MAX_DIAGNOSTIC_STRING_CHARS) : v;
      }
    }
    const reasonKeys = ['finishReason', 'finish_reason', 'stopReason', 'stop_reason', 'endReason', 'end_reason', 'status', 'statusText', 'status_text', 'code'];
    for (const k of reasonKeys){
      if (Object.prototype.hasOwnProperty.call(msg, k) && msg[k] != null){
        const v = msg[k];
        if (k === 'status') meta.status = v;
        else meta[k] = truncateStringForLog(v, MAX_DIAGNOSTIC_STRING_CHARS);
      }
    }
    try {
      const usageInfo = extractUsageFromAssistantMessage(msg, extractUsageTotals);
      if (usageInfo && usageInfo.usage){
        const norm = normalizeUsageObject(usageInfo.usage);
        if (norm) meta.usage = norm;
      }
    } catch {}
    try {
      const err = msg.error;
      if (err && typeof err === 'object'){
        const errMeta = {};
        const errKeys = ['type', 'code', 'message'];
        for (const k of errKeys){
          if (Object.prototype.hasOwnProperty.call(err, k) && err[k] != null){
            const v = err[k];
            errMeta[k] = typeof v === 'string' ? truncateStringForLog(v, MAX_DIAGNOSTIC_STRING_CHARS) : v;
          }
        }
        if (Object.keys(errMeta).length) meta.error = errMeta;
      } else if (typeof err === 'string'){
        meta.error = truncateStringForLog(err, MAX_DIAGNOSTIC_STRING_CHARS);
      }
    } catch {}
    try {
      if (Object.prototype.hasOwnProperty.call(msg, 'errorMessage') && msg.errorMessage != null){
        const v = msg.errorMessage;
        meta.errorMessage = truncateStringForLog(v, MAX_DIAGNOSTIC_STRING_CHARS);
      }
    } catch {}
    return Object.keys(meta).length ? meta : null;
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

function isRetryableCompletionError(err, finishReason, stopReason){
  try {
    // Non-retryable completion reasons  check first
    for (const r of [finishReason, stopReason]){
      if (!r) continue;
      const s = String(r).toLowerCase();
      if (s.includes('content_filter') || s.includes('content-filter') || s.includes('blocked')) return false;
    }
    // Retryable completion reasons
    for (const r of [finishReason, stopReason]){
      if (!r) continue;
      const s = String(r).toLowerCase();
      if (s.includes('overloaded') || s.includes('rate_limit') || s.includes('rate-limit') || s.includes('timeout')) return true;
    }
    // Check exception
    if (err){
      const status = typeof err.status === 'number' ? err.status : (typeof err.statusCode === 'number' ? err.statusCode : 0);
      if (status === 429 || (status >= 500 && status <= 599)) return true;
      const msg = String(err.message || err || '').toLowerCase();
      if (msg.includes('overloaded') || msg.includes('rate_limit') || msg.includes('rate-limit') || msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('socket hang up') || msg.includes('fetch failed')) return true;
      // Generic 'error' finishReason + thrown exception  likely transient
      for (const r of [finishReason, stopReason]){
        if (r && String(r).toLowerCase() === 'error') return true;
      }
    }
    return false;
  } catch { return false; }
}

function buildDiagnosticsPayload({ record, finishReason, stopReason, completionErrorReason, assistantMessageMeta, diagnosticEvents }){
  try {
    const diag = {};
    try {
      const modelInfo = record && record.model ? buildModelDiagnostics(record.model) : null;
      if (modelInfo) diag.model = modelInfo;
    } catch {}
    if (finishReason){
      diag.finishReason = String(finishReason);
    }
    if (stopReason){
      diag.stopReason = String(stopReason);
    }
    if (completionErrorReason){
      diag.completionErrorReason = String(completionErrorReason);
    }
    if (assistantMessageMeta && typeof assistantMessageMeta === 'object'){
      diag.assistantMessage = assistantMessageMeta;
    }
    if (diagnosticEvents && Array.isArray(diagnosticEvents) && diagnosticEvents.length){
      const items = diagnosticEvents.slice(0, MAX_DIAGNOSTIC_ITEMS).map((ev, idx) => {
        if (ev && typeof ev === 'object') return ev;
        return { index: idx, value: truncateStringForLog(ev, MAX_DIAGNOSTIC_STRING_CHARS) };
      });
      if (items.length) diag.events = items;
    }
    return Object.keys(diag).length ? diag : null;
  } catch {
    return null;
  }
}

function attachChatEventBridge(record, sessionId){
  const sess = record && record.session;
  if (!sess || typeof sess.subscribe !== 'function') return;
  if (sess.__arcana_chat_bridged) return;
  sess.__arcana_chat_bridged = true;

  const agentId = record.agentId;
  const agentHomeDir = record.agentHomeDir;
  const workspaceRoot = record.workspaceRoot;

  // Per-session usage totals for llm_usage
  let runContextTokens = 0;
  let runOutputTokens = 0;
  let runTotalTokens = 0;
  // Last single LLM call values (for per-card display)
  let lastCallContextTokens = 0;
  let lastCallTotalTokens = 0;


  function normalizeMediaRef(raw){
    if (!raw) return '';
    let s = String(raw || '').trim();
    if (!s) return '';
    const mdMatch = s.match(/^\[[^\]]*]\(([^)]+)\)/);
    if (mdMatch && mdMatch[1]){
      s = mdMatch[1].trim();
    } else {
      const first = s[0];
      const last = s[s.length - 1];
      if (!(first && first === last && (first === '"' || first === '\'' || first === '`'))){
        s = s.split(/\s+/)[0];
      }
    }
    const strip = new Set(['\'', '"', '`', '(', ')', '[', ']', '<', '>', ',', ';']);
    while (s.length && strip.has(s[0])){
      s = s.slice(1).trimStart();
    }
    while (s.length && strip.has(s[s.length - 1])){
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

  const mediaRefsSeen = new Set();
  let assistantRawText = '';
  let lastAssistantTextEmitted = '';

  sess.subscribe((ev) => {
    try {
      if (!ev) return;
      const t = ev.type ? String(ev.type) : '';

      if (t === 'turn_start'){
        try { emit({ type: 'turn_start', sessionId, agentId }); } catch {}
        return;
      }

      if (t === 'turn_end'){
        try { emit({ type: 'turn_end', sessionId, agentId }); } catch {}
        return;
      }

      const base = ev && typeof ev === 'object' && !ev.sessionId ? { ...ev, sessionId } : ev;

      if (t === 'tool_execution_start'){
        try { persistToolMetaToDisk({ agentId, sessionId, toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args || {} }); } catch {}
        try { emit(base); } catch {}

        // Best-effort auto-activation of skill-scoped tools when reading a SKILL.md
        try {
          const toolName = ev && ev.toolName;
          const args = ev && ev.args;
          const rawPath = args && typeof args.path === 'string' ? args.path : '';
          if (toolName === 'read' && rawPath && /\bSKILL\.md$/i.test(String(rawPath))){
            let absPath = '';
            try {
              const p = String(rawPath);
              absPath = isAbsolute(p) ? p : join(workspaceRoot || process.cwd(), p);
            } catch {}

            if (absPath){
              try {
                const text = readFileSync(absPath, 'utf-8');
                let frontmatter = null;
                try {
                  const parsed = parseFrontmatter(text) || {};
                  frontmatter = parsed && parsed.frontmatter ? parsed.frontmatter : null;
                } catch {}

                const skillName = frontmatter && frontmatter.name ? String(frontmatter.name) : '';
                let toolNames = [];

                try {
                  if (skillName && record && record.skillToolMap instanceof Map){
                    const fromMap = record.skillToolMap.get(skillName) || [];
                    if (Array.isArray(fromMap) && fromMap.length){
                      toolNames = fromMap.filter((n)=> typeof n === 'string' && n.trim());
                    }
                  }
                } catch {}

                if (!toolNames || !toolNames.length){
                  try {
                    const arc = frontmatter && frontmatter.arcana;
                    const arr = Array.isArray(arc && arc.tools) ? arc.tools : [];
                    const names = [];
                    for (const tDef of arr){
                      if (!tDef || !tDef.name) continue;
                      const n = String(tDef.name || '').trim();
                      if (n) names.push(n);
                    }
                    toolNames = names;
                  } catch {}
                }

                if (toolNames && toolNames.length && sess && typeof sess.setActiveToolsByName === 'function'){
                  const desired = new Set();
                  try {
                    const current = typeof sess.getActiveToolNames === 'function' ? (sess.getActiveToolNames() || []) : [];
                    if (Array.isArray(current)){
                      for (const n of current){
                        if (typeof n !== 'string') continue;
                        const trimmed = n.trim();
                        if (!trimmed) continue;
                        desired.add(trimmed);
                      }
                    }
                  } catch {}

                  for (const n of toolNames){
                    if (typeof n !== 'string') continue;
                    const trimmed = n.trim();
                    if (!trimmed) continue;
                    desired.add(trimmed);
                  }

                  const list = Array.from(desired);
                  try { sess.setActiveToolsByName(list); } catch {}
                  try { emit({ type: 'tools_active', tools: list, sessionId, agentId }); } catch {}
                }
              } catch {}
            }
          }
        } catch {}
        return;
      }

      if (t === 'tool_execution_update'){
        try {
          const raw = (typeof ev.partialResult !== 'undefined') ? ev.partialResult : ev.update;
          if (raw && typeof raw === 'object'){
            const stream = String(raw.stream || '').toLowerCase();
            const chunkVal = raw.chunk;
            if ((stream === 'stdout' || stream === 'stderr') && typeof chunkVal === 'string'){
              try { scheduleAppendToolStream({ agentId, sessionId, toolCallId: ev.toolCallId, stream, chunk: chunkVal }); } catch {}
            }
          }
        } catch {}
        try { emit(base); } catch {}
        return;
      }

      if (t === 'tool_execution_end'){
        let payload = base;
        try {
          const usage = extractUsageFromToolEvent(ev);
          if (usage && typeof usage.totalTokens === 'number' && usage.totalTokens > 0){
            payload = base && typeof base === 'object' ? { ...base, usage, usageSource: 'tool' } : { type: 'tool_execution_end', usage, usageSource: 'tool', sessionId };
          }
        } catch {}
        try { emit(payload); } catch {}
        try { persistToolResultToDisk({ agentId, sessionId, event: ev }); } catch {}
        return;
      }

      if (t === 'thinking_start' || t === 'thinking_delta' || t === 'thinking_end'){
        try { emit(base); } catch {}
        return;
      }

      if (t === 'error'){
        const payload = base && typeof base === 'object' ? { ...base, agentId } : { type: 'error', sessionId, agentId };
        try { emit(payload); } catch {}
        return;
      }

      if (t === 'message_update' && ev.message && ev.message.role === 'assistant'){
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        const rawText = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
        assistantRawText = mergeStreamingText(assistantRawText, rawText);
        const extracted = extractMediaFromAssistantText(assistantRawText);
        const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
        const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
        if (cleanText && cleanText !== lastAssistantTextEmitted){
          lastAssistantTextEmitted = cleanText;
          try { emit({ type: 'assistant_text', text: cleanText, sessionId, agentId }); } catch {}
        }
        if (mediaRefs.length){
          for (const raw of mediaRefs){
            const ref = normalizeMediaRef(raw);
            if (!ref || mediaRefsSeen.has(ref)) continue;
            mediaRefsSeen.add(ref);
            try { emit({ type: 'assistant_image', url: ref, mime: 'image/*', sessionId, agentId }); } catch {}
          }
        }
      }

      if (t === 'message_end' && ev.message && ev.message.role === 'assistant'){
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const rawText = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          assistantRawText = mergeStreamingText(assistantRawText, rawText);
          const extracted = extractMediaFromAssistantText(assistantRawText);
          const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
          const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
          if (cleanText && cleanText !== lastAssistantTextEmitted){
            lastAssistantTextEmitted = cleanText;
            try { emit({ type: 'assistant_text', text: cleanText, sessionId, agentId }); } catch {}
          }
          if (cleanText){
            try { ssAppend(sessionId, { role: 'assistant', text: cleanText, agentId }); } catch {}
          }
          if (mediaRefs.length){
            for (const raw of mediaRefs){
              const ref = normalizeMediaRef(raw);
              if (!ref || mediaRefsSeen.has(ref)) continue;
              mediaRefsSeen.add(ref);
              try { emit({ type: 'assistant_image', url: ref, mime: 'image/*', sessionId, agentId }); } catch {}
            }
          }
        } catch {}

        const usageInfo = extractUsageFromAssistantMessage(ev.message, extractUsageTotals);
        const totals = usageInfo && usageInfo.totals;
        if (totals){
          if (typeof totals.contextTokens === 'number' && totals.contextTokens > 0){
            runContextTokens += totals.contextTokens;
          }
          if (typeof totals.outputTokens === 'number' && totals.outputTokens > 0){
            runOutputTokens += totals.outputTokens;
          }
          if (typeof totals.totalTokens === 'number' && totals.totalTokens > 0){
            runTotalTokens += totals.totalTokens;
          }
          // Track last single LLM call values for per-card display
          lastCallContextTokens = (typeof totals.contextTokens === 'number' && totals.contextTokens > 0) ? totals.contextTokens : 0;
          lastCallTotalTokens = (typeof totals.totalTokens === 'number' && totals.totalTokens > 0) ? totals.totalTokens : 0;
          // Emit per-call usage so frontend can update the current LLM card
          try {
            emit({
              type: 'llm_call_usage',
              sessionId,
              agentId,
              contextTokens: lastCallContextTokens,
              totalTokens: lastCallTotalTokens,
            });
          } catch {}
        }


        assistantRawText = '';
      }
    } catch {}
  });

  // Attach a helper so callers can drain usage per completed turn
  sess.__arcana_chat_usage = {
    reset(){ runContextTokens = 0; runOutputTokens = 0; runTotalTokens = 0; lastCallContextTokens = 0; lastCallTotalTokens = 0; },
    snapshot(){ return { contextTokens: runContextTokens, outputTokens: runOutputTokens, totalTokens: runTotalTokens, lastCallContextTokens, lastCallTotalTokens }; },
  };
}

async function runPromptWithSteer({ record, sessionId, sessionKey, message, prelude, isSteer }){
  const sess = record.session;
  const toolHost = record.toolHost;
  const agentId = record.agentId;
  const agentHomeDir = record.agentHomeDir;
  const workspaceRoot = record.workspaceRoot;
  const model = record.model || null;

  // Only inject prelude when pi-agent-core has no internal context.
  // Once the agent has processed at least one turn, it keeps its own
  // tool-call history — injecting the prelude again would double-count.
  let usePrelude = '';
  try {
    const agentMessages = sess.agent && sess.agent.state && sess.agent.state.messages;
    if (!agentMessages || agentMessages.length === 0) {
      usePrelude = prelude || '';
    }
  } catch {
    usePrelude = prelude || '';
  }
  const payloadMsg = (usePrelude ? usePrelude + '\n\n' : '') + '[Current Question]\n' + message;
  const usageHelper = sess.__arcana_chat_usage;
  if (usageHelper) usageHelper.reset();

  const ctx = { sessionId, sessionKey, agentId, agentHomeRoot: agentHomeDir, workspaceRoot };

  if (isSteer){
    try { toolHost && toolHost.cancelActiveCall && toolHost.cancelActiveCall(); } catch {}
    await runWithContext(ctx, () => sess.prompt(payloadMsg, { streamingBehavior: 'steer', expandPromptTemplates: true }));
    try { emit({ type: 'steer_enqueued', sessionId, agentId, text: message }); } catch {}
    return { ok: true, mode: 'steer', text: '' };
  }

  // --- Retry configuration ---
  const _retryMaxRaw = Number(process.env.ARCANA_COMPLETION_MAX_RETRIES);
  const _retryMax = (Number.isFinite(_retryMaxRaw) && _retryMaxRaw >= 0) ? _retryMaxRaw : 2;
  const maxAttempts = _retryMax + 1; // default 3 total attempts
  const defaultRetryDelayMs = 5000;
  const _retryDelayRaw = Number(process.env.ARCANA_COMPLETION_RETRY_DELAY_MS);
  const retryDelayMs = (Number.isFinite(_retryDelayRaw) && _retryDelayRaw >= 0) ? Math.max(_retryDelayRaw, defaultRetryDelayMs) : defaultRetryDelayMs;

  let lastAssistantText = '';
  let out = '';
  let thinkingChars = 0;
  let toolCalls = 0;
  const assistantBlockTypes = new Set();
  let finishReason = '';
  let stopReason = '';
  let sawAssistantText = false;
  let diagnosticEvents = [];
  let assistantMessageMeta = null;
  let promptError = null;

  for (let _attempt = 1; _attempt <= maxAttempts; _attempt++){
    // Reset tracking vars for each attempt
    lastAssistantText = ''; out = ''; thinkingChars = 0; toolCalls = 0;
    assistantBlockTypes.clear(); finishReason = ''; stopReason = '';
    sawAssistantText = false; diagnosticEvents = []; assistantMessageMeta = null;
    promptError = null;

    const unsub = sess.subscribe((ev) => {
      try {
        const t = ev && ev.type ? String(ev.type) : '';

        if (t && isErrorLikeEventType(t)){
          if (diagnosticEvents.length < MAX_DIAGNOSTIC_ITEMS){
            const summary = extractErrorEventSummary(ev, t);
            if (summary) diagnosticEvents.push(summary);
          }
        }

        if (t === 'thinking_delta'){
          try {
            const src = (ev && Object.prototype.hasOwnProperty.call(ev, 'delta')) ? ev.delta : (ev && Object.prototype.hasOwnProperty.call(ev, 'text')) ? ev.text : ev;
            let size = 0;
            if (typeof src === 'string') size = src.length;
            else if (src != null) size = JSON.stringify(src).length;
            if (size > 0 && Number.isFinite(size)) thinkingChars += size;
          } catch {}
        }

        if (t === 'tool_execution_start'){
          toolCalls += 1;
        }

        if (t === 'message_start' && ev.message && ev.message.role === 'assistant'){
          out = '';
        }

        if (t === 'message_update' && ev.message && ev.message.role === 'assistant'){
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text){
            out = mergeStreamingText(out, text);
            sawAssistantText = true;
          }
        }

        if (t === 'message_end' && ev.message && ev.message.role === 'assistant'){
          const msg = ev.message;
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text){
            out = mergeStreamingText(out, text);
            lastAssistantText = out;
            sawAssistantText = true;
          }
          for (const blk of blocks){
            if (!blk || typeof blk.type !== 'string') continue;
            assistantBlockTypes.add(blk.type);
          }
          try {
            if (!finishReason){
              const fr = msg.finishReason || msg.finish_reason || msg.stopReason || msg.stop_reason || msg.endReason || '';
              if (fr) finishReason = String(fr);
            }
          } catch {}
          try {
            if (!stopReason){
              const sr = msg.stopReason || msg.stop_reason || msg.finishReason || msg.finish_reason || '';
              if (sr) stopReason = String(sr);
            }
          } catch {}
          try {
            const meta = extractAssistantMessageMeta(msg);
            if (meta) assistantMessageMeta = meta;
          } catch {}
        }
      } catch {}
    });
    try {
      await runWithContext(ctx, () => sess.prompt(payloadMsg));
    } catch (e) {
      promptError = e;
    } finally {
      try { unsub && unsub(); } catch {}
    }

    // Determine if this attempt had an error
    const _completionErr = isCompletionErrorReason(finishReason) ? finishReason : (isCompletionErrorReason(stopReason) ? stopReason : '');
    const _hasError = !!(promptError || _completionErr);
    if (!_hasError) break; // success

    const _retryable = isRetryableCompletionError(promptError, finishReason, stopReason);
    if (!_retryable || _attempt >= maxAttempts) break; // final failure or non-retryable

    try { console.warn('[arcana:gateway-v2] completion retry attempt=%d/%d delay=%dms reason=%s', _attempt, maxAttempts, retryDelayMs, promptError ? String(promptError.message || promptError).slice(0, 200) : _completionErr); } catch {}
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));

    // Reset usage helper for next attempt
    if (usageHelper) usageHelper.reset();
  }

  const usage = sess.__arcana_chat_usage ? sess.__arcana_chat_usage.snapshot() : { contextTokens: 0, outputTokens: 0, totalTokens: 0 };
  let sessionTokensTotal = 0;
  let sessionObjForTokens = null;
  try {
    sessionObjForTokens = ssLoad(sessionId, { agentId });
    if (sessionObjForTokens && typeof sessionObjForTokens.sessionTokens === 'number' && sessionObjForTokens.sessionTokens > 0){
      sessionTokensTotal = sessionObjForTokens.sessionTokens;
    }
    const delta = (usage && typeof usage.totalTokens === 'number' && usage.totalTokens > 0) ? usage.totalTokens : 0;
    if (delta > 0){
      sessionTokensTotal += delta;
      if (sessionObjForTokens && typeof sessionObjForTokens === 'object'){
        sessionObjForTokens.sessionTokens = sessionTokensTotal;
        try { ssSave(sessionObjForTokens, { agentId, touchUpdatedAt:false }); } catch {}
      }
    }
  } catch {}
  let usageModelLabel = '';
  try {
    const srcModel = (record && record.model) || model;
    const modelInfo = srcModel ? buildModelDiagnostics(srcModel) : null;
    if (modelInfo && modelInfo.label){
      usageModelLabel = String(modelInfo.label);
    }
  } catch {}
  if (usage && (usage.totalTokens > 0 || usage.contextTokens > 0 || usage.outputTokens > 0 || sessionTokensTotal > 0)){
    try {
      const ev = {
        type: 'llm_usage',
        sessionId,
        sessionKey,
        agentId,
        contextTokens: usage.contextTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        lastCallContextTokens: usage.lastCallContextTokens || 0,
        lastCallTotalTokens: usage.lastCallTotalTokens || 0,
        sessionTokens: sessionTokensTotal,
        tsMs: nowMs(),
      };
      if (usageModelLabel) ev.model = usageModelLabel;
      emit(ev);
    } catch {}
  }


  const completionErrorReason = isCompletionErrorReason(finishReason) ? finishReason : (isCompletionErrorReason(stopReason) ? stopReason : '');
  const diagnostics = buildDiagnosticsPayload({ record: { ...record, model }, finishReason, stopReason, completionErrorReason, assistantMessageMeta, diagnosticEvents });

  // Optional model_request logging
  let modelRequest = null;
  try {
    if (record && record.session && (truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST') || truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL'))){
      const sess = record.session;
      const ctx = sess.__arcana_last_llm_context || null;
      const payload = sess.__arcana_last_provider_payload || null;
      if (ctx || payload){
        modelRequest = { context: ctx || null, providerPayload: payload || null };
      }
    }
  } catch {}

  if (promptError){
    let msg = '';
    try {
      const e = promptError;
      if (e && typeof e === 'object'){
        const parts = [];
        if (e.message) parts.push(String(e.message));
        if (typeof e.code !== 'undefined') parts.push('code=' + String(e.code));
        if (typeof e.status !== 'undefined') parts.push('status=' + String(e.status));
        if (!parts.length){
          try { msg = JSON.stringify(e); }
          catch { msg = String(e); }
        } else {
          msg = parts.join(' ');
        }
      } else {
        msg = String(e || '') || 'agent_prompt_failed';
      }
    } catch {
      msg = 'agent_prompt_failed';
    }
    if (!msg) msg = 'agent_prompt_failed';
    const stack = buildErrorStack(promptError, { maxDepth: 8, cap: 8000 });
    let logPath = null;
    try {
      const lp = buildChatLogPath(agentId, sessionKey, sessionId);
      const headerLines = [
        '[arcana:gateway-v2] prompt_error',
        'timeMs=' + nowMs(),
        'agentId=' + String(agentId),
        'sessionId=' + String(sessionId),
        'sessionKey=' + String(sessionKey || ''),
        'error=' + msg,
      ];
      const stats = {
        thinkingChars,
        toolCalls,
        assistantBlockTypes: Array.from(assistantBlockTypes),
        finishReason: finishReason || null,
        stopReason: stopReason || null,
        sawAssistantText: sawAssistantText === true,
        sessionTokensTotal,
        usageContextTokens: usage.contextTokens,
        usageOutputTokens: usage.outputTokens,
        usageTotalTokens: usage.totalTokens,
      };
      const promptEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT');
      const promptFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT_FULL');
      const includePrompt = promptEnv || promptFullEnv;
      const promptText = payloadMsg;
      const promptMaxChars = promptFullEnv ? MAX_PROMPT_LOG_CHARS_FULL : MAX_PROMPT_LOG_CHARS;
      const reqEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST');
      const reqFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL');
      const includeModelRequest = !!(modelRequest && (reqEnv || reqFullEnv));
      const modelRequestMaxChars = reqFullEnv ? MAX_PROMPT_LOG_CHARS_FULL : MAX_PROMPT_LOG_CHARS;
      await writeChatLog({ logPath: lp, headerLines, promptText, includePrompt, errorStack: stack, stats, diagnostics, promptMaxChars, modelRequest, includeModelRequest, modelRequestMaxChars });
      logPath = lp;
    } catch {}
    try {
      const msgWithLog = logPath ? (msg + ' (log: ' + logPath + ')') : msg;
      emit({ type: 'error', sessionId, agentId, message: msgWithLog, stack });
    } catch {}
    return { ok: false, mode: 'turn', error: msg, text: lastAssistantText || out, logPath };
  }

  const finalText = lastAssistantText || out;
  let warning = null;
  let logPath = null;

  if (completionErrorReason){
    let reasonShort = '';
    try { reasonShort = truncateStringForLog(completionErrorReason, 128); } catch {}

    // Try to surface provider error details (message/code/status) from assistantMessageMeta/diagnosticEvents.
    const detailParts = [];
    try {
      if (assistantMessageMeta && typeof assistantMessageMeta === 'object'){
        if (assistantMessageMeta.errorMessage){
          detailParts.push(String(assistantMessageMeta.errorMessage));
        }
        const err = assistantMessageMeta.error;
        if (err){
          if (typeof err === 'string'){
            detailParts.push(err);
          } else if (typeof err === 'object'){
            if (err.message) detailParts.push(String(err.message));
            if (err.type) detailParts.push('type=' + String(err.type));
            if (err.code) detailParts.push('code=' + String(err.code));
          }
        }
        if (assistantMessageMeta.status != null){
          detailParts.push('status=' + String(assistantMessageMeta.status));
        }
      }
      if (!detailParts.length && Array.isArray(diagnosticEvents) && diagnosticEvents.length){
        const first = diagnosticEvents[0];
        if (first && typeof first === 'object'){
          if (first.reason) detailParts.push(String(first.reason));
          if (first.type && !first.reason) detailParts.push('type=' + String(first.type));
          if (first.status != null) detailParts.push('status=' + String(first.status));
        } else if (first != null){
          detailParts.push(String(first));
        }
      }
    } catch {}

    const coreParts = [];
    if (reasonShort || completionErrorReason) coreParts.push(String(reasonShort || completionErrorReason));
    for (const p of detailParts){ if (p) coreParts.push(p); }
    let core = coreParts.join(' | ');

    // Fallback: if we still only have a generic "error", embed diagnostics JSON
    try {
      const coreLower = String(core || '').trim().toLowerCase();
      if ((!coreLower || coreLower === 'error') && diagnostics){
        const diagText = safeJsonForLog(diagnostics, MAX_DIAGNOSTIC_STRING_CHARS);
        if (diagText){
          core = core ? (core + ' | ' + diagText) : diagText;
        }
      }
    } catch {}

    try {
      const lp = buildChatLogPath(agentId, sessionKey, sessionId);
      const headerLines = [
        '[arcana:gateway-v2] completion_error',
        'timeMs=' + nowMs(),
        'agentId=' + String(agentId),
        'sessionId=' + String(sessionId),
        'sessionKey=' + String(sessionKey || ''),
        'reason=' + String(reasonShort || completionErrorReason || ''),
      ];
      const stats = {
        thinkingChars,
        toolCalls,
        assistantBlockTypes: Array.from(assistantBlockTypes),
        finishReason: finishReason || null,
        stopReason: stopReason || null,
        sawAssistantText: sawAssistantText === true,
        sessionTokensTotal,
        usageContextTokens: usage.contextTokens,
        usageOutputTokens: usage.outputTokens,
        usageTotalTokens: usage.totalTokens,
      };
      const promptEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT');
      const promptFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT_FULL');
      const includePrompt = promptEnv || promptFullEnv;
      const promptText = payloadMsg;
      const promptMaxChars = promptFullEnv ? MAX_PROMPT_LOG_CHARS_FULL : MAX_PROMPT_LOG_CHARS;
      const reqEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST');
      const reqFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL');
      const includeModelRequest = !!(modelRequest && (reqEnv || reqFullEnv));
      const modelRequestMaxChars = reqFullEnv ? MAX_PROMPT_LOG_CHARS_FULL : MAX_PROMPT_LOG_CHARS;
      await writeChatLog({ logPath: lp, headerLines, promptText, includePrompt, errorStack: null, stats, diagnostics, promptMaxChars, modelRequest, includeModelRequest, modelRequestMaxChars });
      logPath = lp;
    } catch {}
    try {
      const msgCore = core || (reasonShort || completionErrorReason || '');
      const msg = 'completion_error: ' + msgCore;
      const msgWithLog = logPath ? (msg + ' (log: ' + logPath + ')') : msg;
      emit({ type: 'error', sessionId, agentId, message: msgWithLog });
    } catch {}
    const errCore = core || (reasonShort || completionErrorReason || '');
    return { ok: false, mode: 'turn', error: 'completion_error: ' + errCore, text: lastAssistantText || out, logPath };
  }

  if (!finalText && !sawAssistantText){
    try {
      const lp = buildChatLogPath(agentId, sessionKey, sessionId);
      const headerLines = [
        '[arcana:gateway-v2] empty_completion',
        'timeMs=' + nowMs(),
        'agentId=' + String(agentId),
        'sessionId=' + String(sessionId),
        'sessionKey=' + String(sessionKey || ''),
      ];
      const stats = {
        thinkingChars,
        toolCalls,
        assistantBlockTypes: Array.from(assistantBlockTypes),
        finishReason: finishReason || null,
        stopReason: stopReason || null,
        sawAssistantText: sawAssistantText === true,
        sessionTokensTotal,
        usageContextTokens: usage.contextTokens,
        usageOutputTokens: usage.outputTokens,
        usageTotalTokens: usage.totalTokens,
      };
      const promptEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT');
      const promptFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT_FULL');
      const includePrompt = promptEnv || promptFullEnv;
      const promptText = payloadMsg;
      const promptMaxChars = promptFullEnv ? MAX_PROMPT_LOG_CHARS_FULL : MAX_PROMPT_LOG_CHARS;
      const reqEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST');
      const reqFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL');
      const includeModelRequest = !!(modelRequest && (reqEnv || reqFullEnv));
      const modelRequestMaxChars = reqFullEnv ? MAX_PROMPT_LOG_CHARS_FULL : MAX_PROMPT_LOG_CHARS;
      await writeChatLog({ logPath: lp, headerLines, promptText, includePrompt, errorStack: null, stats, diagnostics, promptMaxChars, modelRequest, includeModelRequest, modelRequestMaxChars });
      logPath = lp;
      warning = 'empty_completion';
      try {
        const msg = 'empty_completion' + (logPath ? ' (log: ' + logPath + ')' : '');
        emit({ type: 'error', sessionId, agentId, message: msg });
      } catch {}
    } catch {}
  }

  if (warning){
    return { ok: true, mode: 'turn', text: '', warning, logPath };
  }
  return { ok: true, mode: 'turn', text: finalText };
}

export async function runChatMessage({ agentId: rawAgentId, sessionKey, sessionId: rawSessionId, text: rawText, policy: rawPolicy, title, sync }){
  const agentId = normalizeAgentId(rawAgentId || DEFAULT_AGENT_ID);
  const policy = String(rawPolicy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
  const trimmed = trimUserMessage(String(rawText || '').trim(), DEFAULT_CONTEXT_POLICY);
  if (!trimmed){
    return { ok: false, error: 'missing_text' };
  }

  const ws = resolveWorkspaceRoot();
  const agentHomeDir = arcanaHomePath('agents', agentId);
  const ensuredId = await ensureSessionId({ sessionId: rawSessionId, sessionKey, title: title || 'Arcana Web', agentId, workspaceRoot: ws });
  const sessionId = String(ensuredId || '').trim();
  if (!sessionId){
    return { ok: false, error: 'session_resolve_failed' };
  }

  // Load session history object for prelude & persistence
  let historyObj = null;
  try { historyObj = ssLoad(sessionId, { agentId }); } catch {}
  if (historyObj){
    let changed = false;
    const existingAgentRaw = historyObj.agentId != null ? String(historyObj.agentId) : '';
    const existingAgent = existingAgentRaw.trim();
    if (existingAgent && existingAgent !== agentId){
      return { ok: false, error: 'agent_mismatch' };
    }
    if (!existingAgent){
      historyObj.agentId = agentId;
      changed = true;
    }
    if (changed){
      try { ssSave(historyObj, { agentId }); } catch {}
    }
  }

  // Optional history compaction based on configured thresholds, before appending
  try {
    if (historyObj && Array.isArray(historyObj.messages) && historyObj.messages.length){
      const globalCfg = loadArcanaConfig();
      const agentCfg = loadAgentConfig(agentHomeDir);

      function readCompressionKey(key){
        let val;
        try {
          if (agentCfg && typeof agentCfg === 'object' && Object.prototype.hasOwnProperty.call(agentCfg, key)){
            const raw = agentCfg[key];
            if (raw != null){
              if (typeof raw === 'string'){
                if (raw.trim() !== '') val = raw;
              } else {
                val = raw;
              }
            }
          }
          if (val === undefined && globalCfg && typeof globalCfg === 'object' && Object.prototype.hasOwnProperty.call(globalCfg, key)){
            const raw = globalCfg[key];
            if (raw != null){
              if (typeof raw === 'string'){
                if (raw.trim() !== '') val = raw;
              } else {
                val = raw;
              }
            }
          }
        } catch {}
        return val;
      }

      const enabledRaw = readCompressionKey('history_compression_enabled');
      let historyCompressionEnabled = true;
      if (typeof enabledRaw === 'boolean'){
        historyCompressionEnabled = enabledRaw;
      } else if (enabledRaw != null){
        const s = String(enabledRaw).trim().toLowerCase();
        if (s){
          if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'none' || s === 'null') historyCompressionEnabled = false;
          else if (s === '1' || s === 'true' || s === 'yes' || s === 'on') historyCompressionEnabled = true;
        }
      }

      const thresholdDefault = 100000;
      const thresholdRaw = readCompressionKey('history_compression_threshold_tokens');
      let thresholdTokens = thresholdDefault;
      const thresholdNum = Number(thresholdRaw);
      if (Number.isFinite(thresholdNum) && thresholdNum > 0){
        thresholdTokens = Math.floor(thresholdNum);
      }

      const keepDefault = 10;
      const keepRaw = readCompressionKey('history_compression_keep_user_turns');
      let keepUserTurns = keepDefault;
      const keepNum = Number(keepRaw);
      if (Number.isFinite(keepNum) && keepNum > 0){
        keepUserTurns = Math.floor(keepNum);
      }

      if (historyCompressionEnabled && thresholdTokens > 0 && keepUserTurns > 0){
        const historyText = buildHistoryPreludeText(historyObj) || '';
        const summaryTextRaw = historyObj && typeof historyObj.summary === 'string' ? historyObj.summary : '';
        const summaryText = String(summaryTextRaw || '').trim();
        let combinedText = historyText;
        if (summaryText){
          combinedText = summaryText + '\n\n' + historyText;
        }
        const estimatedTokens = estimateTokensFromText(combinedText);

        if (estimatedTokens > thresholdTokens){
          let userTurns = 0;
          try {
            const msgs = Array.isArray(historyObj.messages) ? historyObj.messages : [];
            for (const m of msgs){
              if (m && m.role === 'user') userTurns += 1;
            }
          } catch {}

          if (userTurns > 0){
            let keepTurns = keepUserTurns;
            if (userTurns < keepTurns){
              keepTurns = Math.min(5, userTurns);
            }

            if (keepTurns > 0){
              await compactSessionByUserTurns({
                sessionId,
                agentId,
                workspaceRoot: ws,
                agentHomeDir,
                keepRecentUserTurns: keepTurns,
                policy: DEFAULT_CONTEXT_POLICY,
                broadcast(ev){
                  try {
                    if (!ev || typeof ev !== 'object') return;
                    emit({ ...ev, sessionId, agentId, sessionKey });
                  } catch {}
                },
                reason: 'threshold',
              });

              try { historyObj = ssLoad(sessionId, { agentId }); } catch {}
            }
          }
        }
      }
    }
  } catch {}

  const record = await ensureChatSession({ sessionId, agentId, policy });
  const session = record.session;

  // Build prelude before appending current user message
  const prelude = buildSessionPrelude(historyObj, DEFAULT_CONTEXT_POLICY);

  // Persist user message
  ssAppend(sessionId, { role: 'user', text: trimmed, agentId });

  const isSteer = !!(session && session.isStreaming);
  const result = await runPromptWithSteer({ record, sessionId, sessionKey, message: trimmed, prelude, isSteer });

  if (!sync){
    return { ok: result.ok !== false, mode: result.mode, sessionId, error: result.error, warning: result.warning, logPath: result.logPath };
  }

  const assistantText = result.text || '';
  return { ok: result.ok !== false, mode: result.mode, sessionId, text: assistantText, error: result.error, warning: result.warning, logPath: result.logPath };
}

export async function abortChat({ agentId: rawAgentId, sessionKey, sessionId: rawSessionId }){
  const agentId = normalizeAgentId(rawAgentId || DEFAULT_AGENT_ID);
  let sessionId = String(rawSessionId || '').trim();
  if (!sessionId && sessionKey){
    try {
      const ws = resolveWorkspaceRoot();
      const ensuredId = await ensureSessionId({ sessionId: '', sessionKey, title: 'Arcana Web', agentId, workspaceRoot: ws });
      sessionId = String(ensuredId || '').trim();
    } catch {}
  }
  if (!sessionId){
    return { ok: false, reason: 'missing_sessionId' };
  }

  let aborted = false;
  for (const rec of chatSessions.values()){
    if (!rec || rec.agentId !== agentId) continue;
    if (String(rec.sessionId || '') !== sessionId) continue;
    try { rec.toolHost && rec.toolHost.cancelActiveCall && rec.toolHost.cancelActiveCall(); } catch {}
    try {
      if (rec.session && typeof rec.session.abort === 'function'){
        const p = rec.session.abort();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {}
    aborted = true;
  }

  if (aborted){
    try { emit({ type: 'abort_done', sessionId, agentId }); } catch {}
    return { ok: true };
  }
  return { ok: false, reason: 'no_active_session' };
}

export async function clearChatContext({ agentId: rawAgentId, sessionKey, sessionId: rawSessionId }){
  const agentId = normalizeAgentId(rawAgentId || DEFAULT_AGENT_ID);
  let sessionId = String(rawSessionId || '').trim();
  if (!sessionId && sessionKey){
    try {
      const resolvedId = await getSessionIdForKey({ agentId, sessionKey });
      if (resolvedId) sessionId = String(resolvedId || '').trim();
    } catch {}
  }
  if (!sessionId) return { ok: false, reason: 'missing_sessionId' };

  let cleared = false;
  for (const rec of chatSessions.values()){
    if (!rec || rec.agentId !== agentId) continue;
    if (String(rec.sessionId || '') !== sessionId) continue;
    try {
      if (rec.session && rec.session.agent && typeof rec.session.agent.clearMessages === 'function'){
        rec.session.agent.clearMessages();
        cleared = true;
      }
    } catch {}
  }
  return { ok: cleared };
}

export default { runChatMessage, abortChat, clearChatContext };
