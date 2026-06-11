import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp, readFileSync } from 'node:fs';
import { parseFrontmatter } from '@mariozechner/pi-coding-agent';
import { arcanaHomePath } from '../arcana-home.js';
import { resolveWorkspaceRoot, ensureReadAllowed } from '../workspace-guard.js';
import { getSessionIdForKey } from '../session-key-store.js';
import { createArcanaSession, normalizeSystemPromptOverride, summarizeInjectedLocalToolDefinitionsForDebug } from '../session.js';
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
import { nextEventSeq, newTurnId, newItemId } from './events.js';
import { resolveToolRoute } from '../tool-routing.js';
import { persistToolMetaToDisk, persistToolResultToDisk, scheduleAppendToolStream } from '../tool-output-store.js';
import { thinkingStart, appendThinkingDelta, thinkingEnd } from '../thinking-output-store.js';
import { mergeStreamingText, mergeTextBlocks } from '../streaming-text.js';
import { normalizeChatAttachments, extractAttachmentImages, attachmentsToMediaRefs } from './chat-attachments.js';
import {
  deleteContextFile,
  forceFlushContextSession,
  openContextSessionManager,
  pruneContextStore,
  rotateContextAfterCompaction,
} from '../agent-context-store.js';

// Long-lived chat sessions keyed by agentId|sessionKey|sessionId|policy|workspaceRoot|agentHomeRoot
const chatSessions = new Map();
let localProxyWsHub = null;
const pendingLocalToolCalls = new Map();
const recentResolvedLocalToolCalls = new Map();
const RECENT_LOCAL_TOOL_RESULT_TTL_MS = 10 * 60 * 1000;
const ARCANA_LOCAL_PROXY_DEBUG = (() => {
  try {
    const raw = String(process.env.ARCANA_LOCAL_PROXY_DEBUG || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  } catch {
    return false;
  }
})();

const ARCANA_CHAT_CONTEXT_DEBUG = (() => {
  try {
    const raw = String(process.env.ARCANA_CHAT_CONTEXT_DEBUG || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  } catch {
    return false;
  }
})();

function localProxyDebugLog(...args){
  if (!ARCANA_LOCAL_PROXY_DEBUG) return;
  try {
    console.log('[arcana:chat-runtime:local-proxy:debug]', ...args);
  } catch {}
}

function rememberResolvedLocalToolCall(callId){
  try {
    const key = String(callId || '').trim();
    if (!key) return;
    const cutoff = nowMs() - RECENT_LOCAL_TOOL_RESULT_TTL_MS;
    for (const [id, ts] of recentResolvedLocalToolCalls.entries()) {
      if (Number(ts) < cutoff) recentResolvedLocalToolCalls.delete(id);
    }
    recentResolvedLocalToolCalls.set(key, nowMs());
  } catch {}
}

function wasRecentlyResolvedLocalToolCall(callId){
  try {
    const key = String(callId || '').trim();
    if (!key) return false;
    const ts = Number(recentResolvedLocalToolCalls.get(key));
    if (!Number.isFinite(ts)) return false;
    if (nowMs() - ts > RECENT_LOCAL_TOOL_RESULT_TTL_MS) {
      recentResolvedLocalToolCalls.delete(key);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function chatContextDebugLog(...args){
  if (!ARCANA_CHAT_CONTEXT_DEBUG) return;
  try {
    console.log('[arcana:chat-runtime:context:debug]', ...args);
  } catch {}
}

function createLocalToolCallId(){
  try {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return 'ltp_' + ts + '_' + rand;
  } catch {
    return 'ltp_' + String(Date.now());
  }
}

export function attachLocalToolProxyHub(hub){
  localProxyWsHub = hub || null;
}

export function normalizeWorkspaceRootOverride(rawWorkspaceRoot){
  try {
    let value = String(rawWorkspaceRoot || '').trim();
    if (!value) return '';
    if (value.startsWith('file://')) value = fileURLToPath(value);
    if (!isAbsolute(value)) return '';
    return resolve(value);
  } catch {
    return '';
  }
}

export function normalizeAgentHomeRootOverride(rawAgentHomeRoot){
  try {
    let value = String(rawAgentHomeRoot || '').trim();
    if (!value) return '';
    if (value.startsWith('file://')) value = fileURLToPath(value);
    if (!isAbsolute(value)) return '';
    return resolve(value);
  } catch {
    return '';
  }
}

export function handleLocalToolProxyMessage(msg){
  try {
    if (!msg || typeof msg !== 'object') return false;
    if (String(msg.type || '') === 'local_tool_heartbeat') {
      return handleLocalToolProxyHeartbeat(msg);
    }
    if (String(msg.type || '') !== 'local_tool_result') return false;
    const callId = String(msg.callId || '').trim();
    if (!callId) {
      localProxyDebugLog('local_tool_result unmatched', { reason: 'missing_callId' });
      return false;
    }
    const pending = pendingLocalToolCalls.get(callId);
    if (!pending) {
      if (wasRecentlyResolvedLocalToolCall(callId)) {
        localProxyDebugLog('local_tool_result duplicate_resolved', {
          callId,
          sessionKey: String(msg.sessionKey || '').trim() || null,
          agentId: String(msg.agentId || '').trim() || null,
        });
        return true;
      }
      localProxyDebugLog('local_tool_result unmatched', {
        reason: 'pending_miss',
        callId,
        sessionKey: String(msg.sessionKey || '').trim() || null,
        agentId: String(msg.agentId || '').trim() || null,
      });
      return false;
    }

    const msgSessionKey = String(msg.sessionKey || '').trim();
    if (pending.sessionKey && msgSessionKey && msgSessionKey !== pending.sessionKey) {
      pendingLocalToolCalls.delete(callId);
      try { if (pending.timeout) clearTimeout(pending.timeout); } catch {}
      const err = new Error('local_tool_proxy_session_mismatch');
      err.code = 'local_tool_proxy_session_mismatch';
      err.callId = callId;
      err.expectedSessionKey = pending.sessionKey;
      err.receivedSessionKey = msgSessionKey;
      try { pending.reject(err); } catch {}
      localProxyDebugLog('local_tool_result unmatched', {
        reason: 'session_mismatch',
        callId,
        expectedSessionKey: pending.sessionKey,
        receivedSessionKey: msgSessionKey,
      });
      return true;
    }
    const msgAgentId = String(msg.agentId || '').trim();
    if (pending.agentId && msgAgentId && msgAgentId !== pending.agentId) {
      pendingLocalToolCalls.delete(callId);
      try { if (pending.timeout) clearTimeout(pending.timeout); } catch {}
      const err = new Error('local_tool_proxy_agent_mismatch');
      err.code = 'local_tool_proxy_agent_mismatch';
      err.callId = callId;
      err.expectedAgentId = pending.agentId;
      err.receivedAgentId = msgAgentId;
      try { pending.reject(err); } catch {}
      localProxyDebugLog('local_tool_result unmatched', {
        reason: 'agent_mismatch',
        callId,
        expectedAgentId: pending.agentId,
        receivedAgentId: msgAgentId,
      });
      return true;
    }

    pendingLocalToolCalls.delete(callId);
    rememberResolvedLocalToolCall(callId);
    try { if (pending.timeout) clearTimeout(pending.timeout); } catch {}
    try {
      pending.resolve(msg);
    } catch {}
    localProxyDebugLog('local_tool_result matched', {
      callId,
      sessionKey: msgSessionKey || pending.sessionKey || null,
      agentId: msgAgentId || pending.agentId || null,
      ok: msg.ok !== false,
    });
    return true;
  } catch {
    return false;
  }
}

export function handleLocalToolProxyHeartbeat(msg){
  try {
    if (!msg || typeof msg !== 'object') return false;
    if (String(msg.type || '') !== 'local_tool_heartbeat') return false;
    const callId = String(msg.callId || '').trim();
    if (!callId) return false;
    const pending = pendingLocalToolCalls.get(callId);
    if (!pending) {
      localProxyDebugLog('local_tool_heartbeat unmatched', { callId });
      return false;
    }
    const msgSessionKey = String(msg.sessionKey || '').trim();
    if (pending.sessionKey && msgSessionKey && msgSessionKey !== pending.sessionKey) {
      localProxyDebugLog('local_tool_heartbeat session_mismatch', {
        callId,
        expectedSessionKey: pending.sessionKey,
        receivedSessionKey: msgSessionKey,
      });
      return true;
    }
    const msgAgentId = String(msg.agentId || '').trim();
    if (pending.agentId && msgAgentId && msgAgentId !== pending.agentId) {
      localProxyDebugLog('local_tool_heartbeat agent_mismatch', {
        callId,
        expectedAgentId: pending.agentId,
        receivedAgentId: msgAgentId,
      });
      return true;
    }
    pending.lastHeartbeatMs = nowMs();
    pending.heartbeatCount = (Number(pending.heartbeatCount) || 0) + 1;
    try {
      emitCanonicalToolExecutionUpdate({
        agentId: pending.agentId || msgAgentId || DEFAULT_AGENT_ID,
        sessionKey: pending.sessionKey || msgSessionKey,
        sessionId: pending.sessionId || '',
        toolCallId: callId,
        toolName: pending.toolName || String(msg.tool || '').trim(),
        update: {
          type: 'heartbeat',
          heartbeatCount: pending.heartbeatCount,
          tsMs: Number.isFinite(Number(msg.tsMs)) ? Number(msg.tsMs) : nowMs(),
        },
      });
    } catch {}
    localProxyDebugLog('local_tool_heartbeat matched', {
      callId,
      tool: pending.toolName || null,
      heartbeatCount: pending.heartbeatCount,
    });
    return true;
  } catch {
    return false;
  }
}

export function cancelLocalToolProxyCallsForClient({ agentId, sessionKey, clientId, reason } = {}){
  const targetAgentId = String(agentId || '').trim();
  const targetSessionKey = String(sessionKey || '').trim();
  const targetClientId = String(clientId || '').trim();
  let cancelled = 0;
  for (const [callId, pending] of Array.from(pendingLocalToolCalls.entries())) {
    const pendingAgentId = String(pending && pending.agentId || '').trim();
    const pendingSessionKey = String(pending && pending.sessionKey || '').trim();
    const pendingClientId = String(pending && pending.clientId || '').trim();
    if (targetAgentId && pendingAgentId && pendingAgentId !== targetAgentId) continue;
    if (targetSessionKey && pendingSessionKey && pendingSessionKey !== targetSessionKey) continue;
    if (targetClientId && pendingClientId && pendingClientId !== targetClientId) continue;
    pendingLocalToolCalls.delete(callId);
    try { if (pending.timeout) clearTimeout(pending.timeout); } catch {}
    const err = new Error('local_tool_proxy_client_disconnected');
    err.code = 'local_tool_proxy_client_disconnected';
    err.callId = callId;
    err.toolName = pending && pending.toolName ? pending.toolName : '';
    err.sessionKey = pendingSessionKey;
    err.agentId = pendingAgentId;
    err.clientId = pendingClientId;
    err.reason = String(reason || 'client_disconnected');
    try { pending.reject(err); } catch {}
    cancelled += 1;
    localProxyDebugLog('local_tool_request cancelled_on_disconnect', {
      callId,
      tool: err.toolName || null,
      sessionKey: pendingSessionKey || null,
      agentId: pendingAgentId || null,
      clientId: pendingClientId || null,
      reason: err.reason,
    });
  }
  return cancelled;
}

function emitCanonicalToolExecutionStart({ agentId, sessionKey, sessionId, toolCallId, toolName, args } = {}){
  try {
    const event = {
      type: 'tool_execution_start',
      source: 'local_tool_proxy',
      toolCallId,
      callId: toolCallId,
      toolName,
      args: args || {},
    };
    emit(withSessionStreamRouting(event, {
      sessionId,
      sessionKey,
      agentId,
    }));
    try {
      persistToolMetaToDisk({
        agentId,
        sessionId,
        toolCallId,
        toolName,
        args: args || {},
      });
    } catch {}
    return true;
  } catch {}
  return false;
}

function emitCanonicalToolExecutionUpdate({ agentId, sessionKey, sessionId, toolCallId, toolName, update } = {}){
  try {
    const event = {
      type: 'tool_execution_update',
      source: 'local_tool_proxy',
      toolCallId,
      callId: toolCallId,
      toolName,
      update: update || {},
    };
    emit(withSessionStreamRouting(event, { sessionId, sessionKey, agentId }));
    return true;
  } catch {}
  return false;
}

function emitCanonicalToolExecutionEnd({ agentId, sessionKey, sessionId, toolCallId, toolName, args, resultMsg, error } = {}){
  try {
    const hasError = !!error || !!(resultMsg && resultMsg.ok === false);
    const event = {
      type: 'tool_execution_end',
      source: 'local_tool_proxy',
      toolCallId,
      callId: toolCallId,
      toolName,
      args: args || {},
      isError: hasError,
    };
    if (resultMsg && Object.prototype.hasOwnProperty.call(resultMsg, 'result')) {
      event.result = resultMsg.result;
    } else if (resultMsg != null) {
      event.result = resultMsg;
    }
    if (hasError) {
      const rawError = error || (resultMsg && (resultMsg.error || resultMsg.message)) || 'local_tool_proxy_error';
      event.error = rawError instanceof Error
        ? { message: rawError.message, code: rawError.code || undefined }
        : rawError;
    }
    const routed = withSessionStreamRouting(event, {
      sessionId,
      sessionKey,
      agentId,
    });
    emit(routed);
    try {
      persistToolResultToDisk({
        agentId,
        sessionId,
        event: routed,
      });
    } catch {}
    return true;
  } catch {}
  return false;
}

export async function requestLocalToolExecution({ agentId, sessionKey, sessionId, toolName, args, route, timeoutMs } = {}){
  if (!localProxyWsHub || typeof localProxyWsHub.broadcast !== 'function'){
    throw new Error('local_tool_proxy_unavailable');
  }

  const callId = createLocalToolCallId();
  const effectiveTimeoutMs = normalizeLocalToolProxyTimeoutMs(timeoutMs);
  const transportPayload = {
    type: 'local_tool_request',
    callId,
    agentId: String(agentId || DEFAULT_AGENT_ID),
    sessionKey: String(sessionKey || '').trim(),
    tool: String(toolName || '').trim(),
    args: (args && typeof args === 'object') ? args : {},
    route: route != null ? route : null,
    timeoutMs: effectiveTimeoutMs,
    tsMs: nowMs(),
  };
  localProxyDebugLog('local_tool_request dispatch', {
    callId,
    tool: transportPayload.tool,
    sessionKey: transportPayload.sessionKey || null,
    agentId: transportPayload.agentId || null,
    timeoutMs: effectiveTimeoutMs,
  });

  let resultMsg;
  const toolExecutionContext = {
    agentId: transportPayload.agentId,
    sessionKey: transportPayload.sessionKey,
    sessionId: String(sessionId || '').trim(),
    toolCallId: transportPayload.callId,
    toolName: transportPayload.tool,
    args: transportPayload.args || {},
  };
  emitCanonicalToolExecutionStart(toolExecutionContext);
  try {
    resultMsg = await new Promise((resolve, reject) => {
      const timeout = effectiveTimeoutMs > 0
        ? setTimeout(() => {
          try { pendingLocalToolCalls.delete(callId); } catch {}
          const err = new Error('local_tool_proxy_timeout');
          err.code = 'local_tool_proxy_timeout';
          err.callId = callId;
          err.toolName = transportPayload.tool;
          err.sessionKey = transportPayload.sessionKey || '';
          reject(err);
        }, effectiveTimeoutMs)
        : null;
      pendingLocalToolCalls.set(callId, {
        resolve,
        reject,
        timeout,
        toolName: transportPayload.tool,
        createdAtMs: nowMs(),
        lastHeartbeatMs: null,
        heartbeatCount: 0,
        sessionKey: String(sessionKey || '').trim(),
        agentId: String(agentId || DEFAULT_AGENT_ID),
        sessionId: String(sessionId || '').trim(),
        clientId: route && route.clientId != null ? String(route.clientId || '').trim() : '',
      });
      try {
        const delivered = localProxyWsHub.broadcast(transportPayload);
        if (typeof delivered === 'number' && delivered <= 0){
          try { pendingLocalToolCalls.delete(callId); } catch {}
          try { clearTimeout(timeout); } catch {}
          const err = new Error('local_tool_proxy_no_client');
          err.code = 'local_tool_proxy_no_client';
          err.callId = callId;
          err.toolName = transportPayload.tool;
          err.sessionKey = transportPayload.sessionKey || '';
          reject(err);
        }
      } catch (err) {
        pendingLocalToolCalls.delete(callId);
        try { clearTimeout(timeout); } catch {}
        reject(err instanceof Error ? err : new Error(String(err || 'local_tool_proxy_send_failed')));
      }
    });
    localProxyDebugLog('local_tool_request completion', {
      callId,
      tool: transportPayload.tool,
      sessionKey: transportPayload.sessionKey || null,
      agentId: transportPayload.agentId || null,
      ok: !resultMsg || resultMsg.ok !== false,
    });
  } catch (err) {
    emitCanonicalToolExecutionEnd({ ...toolExecutionContext, resultMsg: null, error: err });
    localProxyDebugLog('local_tool_request error', {
      callId,
      tool: transportPayload.tool,
      sessionKey: transportPayload.sessionKey || null,
      agentId: transportPayload.agentId || null,
      error: String((err && err.message) || err || 'local_tool_proxy_error'),
    });
    throw err;
  }

  if (!resultMsg || typeof resultMsg !== 'object'){
    emitCanonicalToolExecutionEnd({ ...toolExecutionContext, resultMsg, error: null });
    return resultMsg;
  }
  emitCanonicalToolExecutionEnd({ ...toolExecutionContext, resultMsg, error: null });
  if (resultMsg.ok === false){
    const errorCode = resultMsg.error;
    const errorText = String(
      resultMsg.message ||
      (
        resultMsg.error &&
        typeof resultMsg.error === 'object' &&
        resultMsg.error.message
      ) ||
      resultMsg.error ||
      'local_tool_proxy_error'
    );
    const err = new Error(errorText);
    if (errorCode != null) err.code = errorCode;
    if (Object.prototype.hasOwnProperty.call(resultMsg, 'details')) err.details = resultMsg.details;
    err.resultMsg = resultMsg;
    if (Object.prototype.hasOwnProperty.call(resultMsg, 'error')) err.error = resultMsg.error;
    throw err;
  }
  if (Object.prototype.hasOwnProperty.call(resultMsg, 'result')){
    return resultMsg.result;
  }
  return resultMsg;
}

// Invalidate cached chat sessions so provider changes take effect immediately.
// If `agentId` is provided, only sessions for that agent are evicted; otherwise all.
export async function invalidateChatSessions({ agentId: rawAgentId } = {}){
  let removed = 0;
  try {
    const target = String(rawAgentId == null ? '' : rawAgentId).trim();
    const matchAll = !target;
    const normalizedTarget = matchAll ? '' : normalizeAgentId(target);

    const keysToDelete = [];
    for (const [key, rec] of chatSessions.entries()){
      try {
        const recAgentId = rec && rec.agentId ? String(rec.agentId) : '';
        if (!matchAll && recAgentId !== normalizedTarget) continue;
        try { rec.toolHost && rec.toolHost.cancelActiveCall && rec.toolHost.cancelActiveCall(); } catch {}
        try {
          if (rec.session && typeof rec.session.abort === 'function'){
            const p = rec.session.abort();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
        } catch {}
        keysToDelete.push(key);
      } catch {}
    }
    for (const k of keysToDelete){
      try { if (chatSessions.delete(k)) removed += 1; } catch {}
    }
  } catch {}
  return { ok: true, removed };
}

const DEFAULT_AGENT_ID = 'default';

const MAX_LOG_JSON_CHARS = 8000;
const MAX_PROMPT_LOG_CHARS = 8000;
const MAX_PROMPT_LOG_CHARS_FULL = 2 * 1024 * 1024;
const DEFAULT_ALL_FULL_LOG_MAX_CHARS = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_ITEMS = 16;
const MAX_DIAGNOSTIC_STRING_CHARS = 512;
const DEFAULT_LOCAL_TOOL_PROXY_TIMEOUT_MS = 0;
const MIN_LOCAL_TOOL_PROXY_TIMEOUT_MS = 100;
const MAX_LOCAL_TOOL_PROXY_TIMEOUT_MS = 10 * 60 * 1000;

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

function chatLogAllFullEnabled(){
  return truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_ALL_FULL');
}

function fullChatLogMaxChars(){
  try {
    const raw = Number(process.env.ARCANA_GATEWAY_V2_CHAT_LOG_FULL_MAX_CHARS);
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  } catch {}
  return chatLogAllFullEnabled() ? DEFAULT_ALL_FULL_LOG_MAX_CHARS : MAX_PROMPT_LOG_CHARS_FULL;
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

function roughByteLength(value){
  try {
    return Buffer.byteLength(String(value == null ? '' : value), 'utf8');
  } catch {
    return String(value == null ? '' : value).length;
  }
}

function classifyCapturePath(pathName, value){
  const pathLower = String(pathName || '').toLowerCase();
  const text = typeof value === 'string' ? value : '';
  const textHead = text.slice(0, 64).toLowerCase();
  if (textHead.startsWith('data:image/')) return 'data_image';
  if (textHead.startsWith('data:')) return 'data_url';
  if (pathLower.includes('image') || pathLower.includes('images')) return 'image';
  if (pathLower.includes('tool')) return 'tool';
  if (pathLower.includes('content') || pathLower.includes('message') || pathLower.includes('prompt')) return 'message';
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length > 4096) return 'base64_like';
  return 'text';
}

export function buildChatCaptureSummary({ modelRequest, promptText, stats, diagnostics } = {}){
  const rows = [];
  const categoryBytes = new Map();
  function addRow(pathName, value, typeHint){
    const text = typeof value === 'string' ? value : safeJsonForLog(value, 2048);
    const chars = String(text || '').length;
    const bytes = roughByteLength(text);
    const category = typeHint || classifyCapturePath(pathName, value);
    rows.push({
      path: String(pathName || '$'),
      category,
      chars,
      bytes,
      preview: truncateStringForLog(text, 160),
    });
    categoryBytes.set(category, (categoryBytes.get(category) || 0) + bytes);
  }
  function walk(value, pathName, depth){
    if (value == null) return;
    if (typeof value === 'string'){
      addRow(pathName, value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean'){
      addRow(pathName, String(value), 'scalar');
      return;
    }
    if (depth > 12){
      addRow(pathName, value, 'object');
      return;
    }
    if (Array.isArray(value)){
      if (value.length === 0) return;
      value.forEach((item, index) => walk(item, `${pathName}[${index}]`, depth + 1));
      return;
    }
    if (typeof value === 'object'){
      const keys = Object.keys(value);
      if (!keys.length) return;
      for (const key of keys){
        walk(value[key], pathName === '$' ? `$.${key}` : `${pathName}.${key}`, depth + 1);
      }
    }
  }
  if (promptText) addRow('prompt', promptText, 'prompt');
  walk(modelRequest, 'modelRequest', 0);
  const topItems = rows
    .slice()
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 80);
  return {
    version: 1,
    generatedAtMs: nowMs(),
    totals: {
      itemCount: rows.length,
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      chars: rows.reduce((sum, row) => sum + row.chars, 0),
    },
    categoryBytes: Object.fromEntries(Array.from(categoryBytes.entries()).sort((a, b) => b[1] - a[1])),
    stats: stats || null,
    diagnostics: diagnostics || null,
    topItems,
  };
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

function normalizeLocalToolProxyTimeoutMs(value){
  const raw = value != null && value !== ''
    ? value
    : process.env.ARCANA_LOCAL_PROXY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOCAL_TOOL_PROXY_TIMEOUT_MS;
  return Math.min(MAX_LOCAL_TOOL_PROXY_TIMEOUT_MS, Math.max(MIN_LOCAL_TOOL_PROXY_TIMEOUT_MS, Math.floor(parsed)));
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
async function writeChatLog({ logPath, headerLines, promptText, includePrompt, errorStack, stats, diagnostics, promptMaxChars, modelRequest, includeModelRequest, modelRequestMaxChars, captureSummary }){
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
  if (captureSummary){
    try {
      const summaryPath = `${logPath}.summary.json`;
      const summary = buildChatCaptureSummary({
        modelRequest,
        promptText: includePrompt ? promptText : '',
        stats,
        diagnostics,
      });
      await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    } catch {}
  }
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

function buildChatKey({ agentId, sessionKey, sessionId, policy, workspaceRoot, agentHomeRoot }){
  try {
    const aid = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const sKey = String(sessionKey || '').trim() || '';
    const sid = String(sessionId || 'default').trim() || 'default';
    const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
    const ws = String(workspaceRoot || '').trim() || '';
    const home = String(agentHomeRoot || '').trim() || '';
    return aid + '|' + sKey + '|' + sid + '|' + pol + '|' + ws + '|' + home;
  } catch {
    return 'default||default|restricted||';
  }
}

function releaseChatSessionRecord(record){
  try {
    if (!record || !record.cacheKey) return false;
    const current = chatSessions.get(record.cacheKey);
    if (current !== record) return false;
    const sess = record.session;
    try { forceFlushContextSession(sess); } catch {}
    try {
      if (sess && sess.isStreaming) return false;
    } catch {}
    chatSessions.delete(record.cacheKey);
    return true;
  } catch {
    return false;
  }
}

function reloadSessionRuntimeFromContext(session, contextPath){
  try {
    if (!session || !contextPath) return false;
    const manager = session.sessionManager;
    if (manager && typeof manager.setSessionFile === 'function'){
      manager.setSessionFile(contextPath);
    }
    const context = manager && typeof manager.buildSessionContext === 'function'
      ? manager.buildSessionContext()
      : null;
    const messages = context && Array.isArray(context.messages) ? context.messages : [];
    const agent = session.agent;
    if (agent && typeof agent.replaceMessages === 'function'){
      agent.replaceMessages(messages);
      return true;
    }
  } catch {}
  return false;
}

function resetSessionRuntimeMessages(session){
  try {
    const agent = session && session.agent ? session.agent : null;
    if (agent && typeof agent.replaceMessages === 'function'){
      agent.replaceMessages([]);
      return true;
    }
  } catch {}
  return false;
}

function stableStringify(value){
  const seen = new Set();
  const walk = (input) => {
    if (input === null) return 'null';
    const t = typeof input;
    if (t === 'string') return JSON.stringify(input);
    if (t === 'number'){
      if (Number.isFinite(input)) return String(input);
      return JSON.stringify(String(input));
    }
    if (t === 'boolean') return input ? 'true' : 'false';
    if (t === 'bigint') return JSON.stringify(input.toString() + 'n');
    if (t === 'undefined') return '"__undefined__"';
    if (t === 'function') return '"__function__"';
    if (t === 'symbol') return JSON.stringify(String(input));
    if (Array.isArray(input)){
      return '[' + input.map((entry) => walk(entry)).join(',') + ']';
    }
    if (input && t === 'object'){
      if (seen.has(input)) return '"__circular__"';
      seen.add(input);
      const keys = Object.keys(input).sort();
      const parts = [];
      for (const key of keys){
        const val = input[key];
        if (typeof val === 'undefined') continue;
        parts.push(JSON.stringify(key) + ':' + walk(val));
      }
      seen.delete(input);
      return '{' + parts.join(',') + '}';
    }
    return JSON.stringify(input);
  };
  return walk(value);
}

function buildToolRoutingSignature(toolRouting){
  try {
    if (!toolRouting) return '';
    return stableStringify(toolRouting);
  } catch {
    return '';
  }
}

function normalizeToolAllowlist(toolAllowlist){
  if (!Array.isArray(toolAllowlist)) return [];
  const out = [];
  const seen = new Set();
  for (const item of toolAllowlist){
    if (typeof item !== 'string') continue;
    const name = item.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  out.sort();
  return out;
}

function buildToolAllowlistSignature(toolAllowlist){
  try {
    const normalized = normalizeToolAllowlist(toolAllowlist);
    if (!normalized.length) return '';
    return stableStringify(normalized);
  } catch {
    return '';
  }
}

export function buildLocalToolDefinitionsSignature(localToolDefinitions){
  try {
    if (!Array.isArray(localToolDefinitions) || !localToolDefinitions.length) return '';
    const normalized = [];
    const seen = new Set();
    for (const item of localToolDefinitions){
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name || '').trim().toLowerCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const description = typeof item.description === 'string' ? item.description.trim() : '';
      const parameters = item.parameters && typeof item.parameters === 'object' ? item.parameters : null;
      normalized.push({
        name,
        ...(description ? { description } : {}),
        ...(parameters ? { parameters } : {}),
      });
    }
    if (!normalized.length) return '';
    normalized.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return stableStringify(normalized);
  } catch {
    return '';
  }
}

export function buildLocalAgentSignature(localAgentSignature){
  try {
    const value = String(localAgentSignature || '').trim();
    return value ? value.slice(0, 256) : '';
  } catch {
    return '';
  }
}

export function buildSystemPromptOverrideSignature(systemPromptOverride){
  try {
    const value = normalizeSystemPromptOverride(systemPromptOverride);
    return value ? stableStringify({ systemPromptOverride: value }) : '';
  } catch {
    return '';
  }
}

export function estimateProjectedPromptTokens({ liveContextTokens, preludeText, promptMessage } = {}){
  try {
    const promptText = '[Current Question]\n' + String(promptMessage || '');
    const promptTokens = estimateTokensFromText(promptText);
    const liveNum = Number(liveContextTokens);
    const liveTokens = Number.isFinite(liveNum) && liveNum > 0 ? Math.floor(liveNum) : 0;
    if (liveTokens > 0){
      return {
        tokens: liveTokens + promptTokens,
        baseTokens: liveTokens,
        promptTokens,
        source: 'live_context_plus_prompt',
      };
    }

    const baseTokens = estimateTokensFromText(String(preludeText || ''));
    return {
      tokens: baseTokens + promptTokens,
      baseTokens,
      promptTokens,
      source: 'prelude_plus_prompt',
    };
  } catch {
    return {
      tokens: 0,
      baseTokens: 0,
      promptTokens: 0,
      source: 'unknown',
    };
  }
}

async function ensureChatSession({ sessionId, sessionKey, agentId, policy, workspaceRoot, agentHomeRoot, toolRouting, localToolProxy, toolAllowlist, localToolDefinitions, localBootstrapFiles, localAgentSignature, systemPromptOverride }){
  const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
  const sid = String(sessionId || '').trim();
  const sessionKeyNormalized = String(sessionKey || '').trim();
  const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
  const localToolProxyEnabled = !!localToolProxy;
  const effectiveSystemPromptOverride = localToolProxyEnabled ? normalizeSystemPromptOverride(systemPromptOverride) : '';
  const systemPromptOverrideSignature = buildSystemPromptOverrideSignature(effectiveSystemPromptOverride);
  const toolRoutingSignature = buildToolRoutingSignature(toolRouting);
  const normalizedToolAllowlist = normalizeToolAllowlist(toolAllowlist);
  const toolAllowlistSignature = buildToolAllowlistSignature(normalizedToolAllowlist);
  const localToolDefinitionsSignature = buildLocalToolDefinitionsSignature(localToolDefinitions);
  const effectiveLocalAgentSignature = buildLocalAgentSignature(localAgentSignature);
  const localToolDefinitionsDebug = summarizeInjectedLocalToolDefinitionsForDebug(localToolDefinitions);

  // Resolve workspaceRoot from explicit request first, then session store.
  let ws = normalizeWorkspaceRootOverride(workspaceRoot);
  let sessionObj = null;
  try {
    if (sid) sessionObj = ssLoad(sid, { agentId: effectiveAgentId });
  } catch {}
  try {
    if (!ws && sessionObj && sessionObj.workspaceRoot) ws = String(sessionObj.workspaceRoot || '');
    if (!ws && sessionObj && sessionObj.workspace) ws = String(sessionObj.workspace || '');
  } catch {}
  if (!ws){
    try { ws = resolveWorkspaceRoot(); } catch { ws = process.cwd(); }
  }
  const agentHomeDir = normalizeAgentHomeRootOverride(agentHomeRoot) || arcanaHomePath('agents', effectiveAgentId);
  const globalCfg = loadArcanaConfig();
  const agentCfg = loadAgentConfig(agentHomeDir);
  const contextConfig = {
    ...(globalCfg && typeof globalCfg === 'object' ? globalCfg : {}),
    ...(agentCfg && typeof agentCfg === 'object' ? agentCfg : {}),
  };
  const key = buildChatKey({
    agentId: effectiveAgentId,
    sessionKey: sessionKeyNormalized,
    sessionId: sid || 'default',
    policy: pol,
    workspaceRoot: ws,
    agentHomeRoot: agentHomeDir,
  });
  const existing = chatSessions.get(key);
  if (existing && existing.session){
    const existingLocalToolProxyEnabled = !!existing.localToolProxyEnabled;
    const existingToolRoutingSignature = (typeof existing.toolRoutingSignature === 'string') ? existing.toolRoutingSignature : '';
    const existingToolAllowlistSignature = (typeof existing.toolAllowlistSignature === 'string') ? existing.toolAllowlistSignature : '';
    const existingLocalToolDefinitionsSignature = (typeof existing.localToolDefinitionsSignature === 'string') ? existing.localToolDefinitionsSignature : '';
    const existingLocalAgentSignature = (typeof existing.localAgentSignature === 'string') ? existing.localAgentSignature : '';
    const existingSystemPromptOverrideSignature = (typeof existing.systemPromptOverrideSignature === 'string') ? existing.systemPromptOverrideSignature : '';
    const localToolProxyChanged = existingLocalToolProxyEnabled !== localToolProxyEnabled;
    const toolRoutingChanged = existingToolRoutingSignature !== toolRoutingSignature;
    const toolAllowlistChanged = existingToolAllowlistSignature !== toolAllowlistSignature;
    const localToolDefinitionsChanged = existingLocalToolDefinitionsSignature !== localToolDefinitionsSignature;
    const localAgentChanged = existingLocalAgentSignature !== effectiveLocalAgentSignature;
    const systemPromptOverrideChanged = existingSystemPromptOverrideSignature !== systemPromptOverrideSignature;
    const compatible = (
      !localToolProxyChanged &&
      !toolRoutingChanged &&
      !toolAllowlistChanged &&
      !localToolDefinitionsChanged &&
      !localAgentChanged &&
      !systemPromptOverrideChanged
    );
    localProxyDebugLog('ensureChatSession cache check', {
      agentId: effectiveAgentId,
      sessionKey: sessionKeyNormalized || null,
      sessionId: sid || 'default',
      agentHomeRoot: agentHomeDir,
      compatible,
      localToolProxyEnabled,
      existingLocalToolProxyEnabled,
      toolRoutingChanged,
      toolAllowlistChanged,
      localToolDefinitionsChanged,
      localAgentChanged,
      systemPromptOverrideChanged,
      localToolDefinitions: localToolDefinitionsDebug,
    });
    if (compatible){
      if (sessionKeyNormalized){
        try { existing.sessionKey = sessionKeyNormalized; } catch {}
      }
      return existing;
    }

    // Requested tool routing/proxy config changed; evict stale cached session.
    try { existing.toolHost && existing.toolHost.cancelActiveCall && existing.toolHost.cancelActiveCall(); } catch {}
    try {
      if (existing.session && typeof existing.session.abort === 'function'){
        const p = existing.session.abort();
        if (p && typeof p.catch === 'function') await p.catch(() => {});
      }
    } catch {}
    try { chatSessions.delete(key); } catch {}
    localProxyDebugLog('ensureChatSession stale eviction', {
      agentId: effectiveAgentId,
      sessionKey: sessionKeyNormalized || null,
      sessionId: sid || 'default',
      reason: 'local_proxy_tool_routing_or_allowlist_changed',
      localToolProxyChanged,
      toolRoutingChanged,
      toolAllowlistChanged,
      localToolDefinitionsChanged,
      localAgentChanged,
      systemPromptOverrideChanged,
      localToolDefinitions: localToolDefinitionsDebug,
    });
  }

  let created = null;
  const localToolProxyInvoke = localToolProxyEnabled
    ? async ({ toolName, args, route } = {}) => {
      return await requestLocalToolExecution({
        agentId: effectiveAgentId,
        sessionKey: sessionKeyNormalized,
        sessionId: sid || 'default',
        toolName,
        args,
        route,
      });
    }
    : undefined;
  const contextStore = openContextSessionManager({
    agentId: effectiveAgentId,
    sessionId: sid || 'default',
    workspaceRoot: ws,
  });
  await runWithContext(
    { sessionId: sid || 'default', agentId: effectiveAgentId, agentHomeRoot: agentHomeDir, workspaceRoot: ws },
    async () => {
      created = await createArcanaSession({
        workspaceRoot: ws,
        agentHomeRoot: agentHomeDir,
        execPolicy: pol,
        agentId: effectiveAgentId,
        enforceToolRouting: true,
        toolAllowlist: normalizedToolAllowlist,
        localToolDefinitions: Array.isArray(localToolDefinitions) ? localToolDefinitions : [],
        localBootstrapFiles: Array.isArray(localBootstrapFiles) ? localBootstrapFiles : [],
        ...(effectiveSystemPromptOverride ? { systemPromptOverride: effectiveSystemPromptOverride } : {}),
        ...(contextStore.sessionManager ? { sessionManager: contextStore.sessionManager } : {}),
        ...(localToolProxyInvoke ? { localToolProxyInvoke } : {}),
        ...(toolRouting ? { toolRouting } : {}),
      });
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
    sessionKey: sessionKeyNormalized,
    localToolProxyEnabled,
    toolRouting: toolRouting || null,
    injectedLocalToolNames: new Set(
      (Array.isArray(localToolDefinitions) ? localToolDefinitions : [])
        .map((d) => (d && typeof d.name === 'string') ? d.name.trim() : '')
        .filter(Boolean),
    ),
    toolRoutingSignature,
    toolAllowlistSignature,
    localToolDefinitionsSignature,
    localAgentSignature: effectiveLocalAgentSignature,
    systemPromptOverrideSignature,
    skillToolMap: created.skillToolMap || new Map(),
    cacheKey: key,
    contextPath: contextStore.contextPath || '',
    contextConfig,
  };
  try {
    if (record.session){
      record.session.__arcana_context_file = contextStore.contextPath || '';
      record.session.__arcana_context_config = contextConfig;
    }
  } catch {}

  localProxyDebugLog('ensureChatSession created', {
    agentId: effectiveAgentId,
    sessionKey: sessionKeyNormalized || null,
    sessionId: sid || 'default',
    agentHomeRoot: agentHomeDir,
    localToolProxyEnabled,
    toolAllowlistCount: normalizedToolAllowlist.length,
    localAgentSignature: effectiveLocalAgentSignature,
    systemPromptOverrideActive: !!effectiveSystemPromptOverride,
    localToolDefinitions: localToolDefinitionsDebug,
  });
  attachChatEventBridge(record, sid || 'default');
  chatSessions.set(key, record);
  try {
    pruneContextStore({
      agentId: effectiveAgentId,
      config: contextConfig,
      activeSessionIds: Array.from(chatSessions.values())
        .filter((rec) => rec && rec.agentId === effectiveAgentId)
        .map((rec) => rec.sessionId),
    });
  } catch {}
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
    let cacheRead = Number(
      raw.cacheReadTokens ??
      raw.cache_read_tokens ??
      raw.cacheRead ??
      raw.cache_read ??
      raw.cache_read_input_tokens ??
      raw.cachedInputTokens ??
      raw.cached_input_tokens ??
      raw.input_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens ??
      0
    ) || 0;
    let cacheWrite = Number(
      raw.cacheWriteTokens ??
      raw.cache_write_tokens ??
      raw.cacheWrite ??
      raw.cache_write ??
      raw.cache_creation_input_tokens ??
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
    if (cacheRead > 0 && (raw.input_tokens_details?.cached_tokens != null || raw.prompt_tokens_details?.cached_tokens != null)) {
      input = Math.max(0, input - cacheRead);
    }
    let total = Number(
      raw.totalTokens ??
      raw.total_tokens ??
      raw.total ??
      0
    ) || 0;
    if (!Number.isFinite(input) || input < 0) input = 0;
    if (!Number.isFinite(cacheRead) || cacheRead < 0) cacheRead = 0;
    if (!Number.isFinite(cacheWrite) || cacheWrite < 0) cacheWrite = 0;
    if (!Number.isFinite(output) || output < 0) output = 0;
    if (!Number.isFinite(total) || total < 0) total = 0;
    if (!total && (input || output || cacheRead || cacheWrite)) total = input + cacheRead + cacheWrite + output;
    input = input ? Math.floor(input) : 0;
    cacheRead = cacheRead ? Math.floor(cacheRead) : 0;
    cacheWrite = cacheWrite ? Math.floor(cacheWrite) : 0;
    output = output ? Math.floor(output) : 0;
    total = total ? Math.floor(total) : 0;
    if (!input && !output && !cacheRead && !cacheWrite && !total) return null;
    return { inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output, totalTokens: total };
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
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let ctx = 0;
  let out = 0;
  let tot = 0;
  try {
    if (u && typeof u === 'object'){
      let input = Number(u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.input ?? u.prompt ?? 0) || 0;
      const output = Number(u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? u.output ?? 0) || 0;
      const cacheRead = Number(
        u.cacheReadTokens ??
        u.cache_read_tokens ??
        u.cacheRead ??
        u.cache_read ??
        u.cache_read_input_tokens ??
        u.cachedInputTokens ??
        u.cached_input_tokens ??
        u.input_tokens_details?.cached_tokens ??
        u.prompt_tokens_details?.cached_tokens ??
        0
      ) || 0;
      const cacheWrite = Number(u.cacheWriteTokens ?? u.cache_write_tokens ?? u.cacheWrite ?? u.cache_write ?? u.cache_creation_input_tokens ?? 0) || 0;
      if (cacheRead > 0 && (u.input_tokens_details?.cached_tokens != null || u.prompt_tokens_details?.cached_tokens != null)) {
        input = Math.max(0, input - cacheRead);
      }
      inputTokens = input;
      cacheReadTokens = cacheRead;
      cacheWriteTokens = cacheWrite;
      // Treat context tokens as everything that contributes to the request context
      ctx = input + cacheRead + cacheWrite;
      out = output;
      tot = Number(u.totalTokens ?? u.total_tokens ?? u.total ?? 0) || 0;
      if (!tot) tot = ctx + out;
    }
  } catch {}
  if (!Number.isFinite(tot) || tot < 0) tot = 0;
  if (!Number.isFinite(inputTokens) || inputTokens < 0) inputTokens = 0;
  if (!Number.isFinite(cacheReadTokens) || cacheReadTokens < 0) cacheReadTokens = 0;
  if (!Number.isFinite(cacheWriteTokens) || cacheWriteTokens < 0) cacheWriteTokens = 0;
  if (!Number.isFinite(ctx) || ctx < 0) ctx = 0;
  if (!Number.isFinite(out) || out < 0) out = 0;
  return {
    inputTokens: Math.floor(inputTokens),
    cacheReadTokens: Math.floor(cacheReadTokens),
    cacheWriteTokens: Math.floor(cacheWriteTokens),
    contextTokens: Math.floor(ctx),
    outputTokens: Math.floor(out),
    totalTokens: Math.floor(tot),
  };
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

function hasRealTokenUsage(usage){
  try {
    if (!usage || typeof usage !== 'object') return false;
    const contextTokens = Number(usage.contextTokens || 0) || 0;
    const outputTokens = Number(usage.outputTokens || 0) || 0;
    const totalTokens = Number(usage.totalTokens || 0) || 0;
    return contextTokens > 0 || outputTokens > 0 || totalTokens > 0;
  } catch {
    return false;
  }
}

export function isRequiredBillingUsageMissing(record, usage){
  try {
    const requiresUsage = !!(record && record.localToolProxyEnabled) || truthyEnv('ARCANA_REQUIRE_LLM_USAGE');
    if (!requiresUsage) return false;
    return !hasRealTokenUsage(usage);
  } catch {
    return false;
  }
}

export function selectUsageSnapshot(primary, observed){
  try {
    const primaryUsage = (primary && typeof primary === 'object') ? primary : null;
    const observedUsage = (observed && typeof observed === 'object') ? observed : null;
    const primaryHasUsage = hasRealTokenUsage(primaryUsage);
    const observedHasUsage = hasRealTokenUsage(observedUsage);
    if (!primaryHasUsage && observedHasUsage) return observedUsage;
    if (primaryHasUsage && !observedHasUsage) return primaryUsage;
    if (!primaryHasUsage && !observedHasUsage) {
      return primaryUsage || observedUsage || { contextTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    const primaryTotal = Number(primaryUsage.totalTokens || 0) || 0;
    const observedTotal = Number(observedUsage.totalTokens || 0) || 0;
    return observedTotal > primaryTotal ? observedUsage : primaryUsage;
  } catch {
    return primary || observed || { contextTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
}

export function buildLlmUsageEvent({ usage, sessionId, sessionKey, agentId, sessionTokens, model, clientTurnId, tsMs } = {}){
  try {
    const inputTokens = Number(usage && usage.inputTokens || 0) || 0;
    const cacheReadTokens = Number(usage && usage.cacheReadTokens || 0) || 0;
    const cacheWriteTokens = Number(usage && usage.cacheWriteTokens || 0) || 0;
    const contextTokens = Number(usage && usage.contextTokens || 0) || 0;
    const outputTokens = Number(usage && usage.outputTokens || 0) || 0;
    const totalTokens = Number(usage && usage.totalTokens || 0) || 0;
    const sessionTokensTotal = Number(sessionTokens || 0) || 0;
    if (contextTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return null;
    const ev = {
      type: 'llm_usage',
      sessionId,
      sessionKey,
      agentId,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      contextTokens,
      outputTokens,
      totalTokens,
      lastCallInputTokens: Number(usage && usage.lastCallInputTokens || 0) || 0,
      lastCallCacheReadTokens: Number(usage && usage.lastCallCacheReadTokens || 0) || 0,
      lastCallCacheWriteTokens: Number(usage && usage.lastCallCacheWriteTokens || 0) || 0,
      lastCallContextTokens: Number(usage && usage.lastCallContextTokens || 0) || 0,
      lastCallTotalTokens: Number(usage && usage.lastCallTotalTokens || 0) || 0,
      sessionTokens: sessionTokensTotal,
      tsMs: Number(tsMs || 0) || nowMs(),
    };
    if (model) ev.model = String(model);
    if (clientTurnId) ev.clientTurnId = String(clientTurnId);
    return ev;
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
function _getCompressionThresholdTokens(agentHomeDir) {
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
    return null;
  } catch { return null; }
}

function _getCompressionEnabled(agentHomeDir) {
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
      if (s) {
        if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'none' || s === 'null') return false;
        if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
      }
    }
    return true;
  } catch {
    return true;
  }
}

function _getCompressionKeepUserTurns(agentHomeDir) {
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
    return 10;
  } catch {
    return 10;
  }
}

function _getLiveContextTokensForCompression(sess, historyObj, keepRecentUserTurns, promptMessage) {
  try {
    const agentMessages = sess && sess.agent && sess.agent.state && Array.isArray(sess.agent.state.messages)
      ? sess.agent.state.messages
      : [];
    if (agentMessages.length > 0 && sess && typeof sess.getContextUsage === 'function') {
      const ctxUsage = sess.getContextUsage();
      const tokens = Number(ctxUsage && ctxUsage.tokens);
      if (Number.isFinite(tokens) && tokens > 0) {
        return estimateProjectedPromptTokens({
          liveContextTokens: tokens,
          promptMessage,
        });
      }
    }

    const summaryTextRaw = historyObj && typeof historyObj.summary === 'string' ? historyObj.summary : '';
    const summaryText = String(summaryTextRaw || '').trim();
    let preludeText = '';
    if (summaryText && keepRecentUserTurns > 0) {
      preludeText = buildSessionPrelude(
        historyObj,
        DEFAULT_CONTEXT_POLICY,
        { keepRecentUserTurns },
      ) || '';
    } else {
      preludeText = buildSessionPrelude(historyObj, DEFAULT_CONTEXT_POLICY) || '';
    }
    return estimateProjectedPromptTokens({
      preludeText,
      promptMessage,
    });
  } catch {
    return estimateProjectedPromptTokens({ promptMessage: '' });
  }
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
    // Check the errorMessage from the assistant message (pi-agent-core puts overflow details here)
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
      if (status === 413) return true; // payload too large
      if (code.includes('context_length') || code.includes('max_context') || code.includes('prompt_too_long')) return true;
      if (msg.includes('maximum context') || msg.includes('context length') || msg.includes('context window')) return true;
      if (msg.includes('prompt too long') || msg.includes('input too long') || msg.includes('too many tokens')) return true;
      if (msg.includes('prompt is too long')) return true;
      if (msg.includes('input token count') && msg.includes('exceeds')) return true;
      if (msg.includes('maximum prompt length')) return true;
      if (msg.includes('reduce') && msg.includes('length') && (msg.includes('context') || msg.includes('tokens'))) return true;
    }
    return false;
  } catch { return false; }
}

function getEventToolCallId(ev){
  try {
    const direct = String((ev && (ev.toolCallId || ev.callId || ev.id)) || '').trim();
    return direct || '';
  } catch {
    return '';
  }
}

export function withSessionStreamRouting(event, { sessionId, sessionKey, agentId } = {}){
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

async function compactInternalHistoryAndRebuildPrelude({
  session,
  sessionId,
  sessionKey,
  agentId,
  workspaceRoot,
  agentHomeDir,
  message,
  keepRecentUserTurns,
  reason,
}) {
  const keepTurnsNum = Number(keepRecentUserTurns);
  const keepTurns = Number.isFinite(keepTurnsNum) && keepTurnsNum > 0 ? Math.floor(keepTurnsNum) : 0;
  if (!keepTurns) return '';
  chatContextDebugLog('compaction:start', {
    sessionId,
    agentId,
    reason: String(reason || ''),
    keepRecentUserTurns: keepTurns,
  });

  const compactResult = await compactSessionByUserTurns({
    sessionId,
    agentId,
    workspaceRoot,
    agentHomeDir,
    keepRecentUserTurns: keepTurns,
    policy: DEFAULT_CONTEXT_POLICY,
    broadcast(ev){
      try {
        if (!ev || typeof ev !== 'object') return;
        emit({ ...ev, sessionId, agentId, sessionKey });
      } catch {}
    },
    reason: String(reason || ''),
  });
  chatContextDebugLog('compaction:result', {
    sessionId,
    agentId,
    reason: String(reason || ''),
    keepRecentUserTurns: keepTurns,
    compacted: !!(compactResult && compactResult.compacted === true),
  });
  if (!compactResult || compactResult.compacted !== true){
    return '';
  }

  try {
    let histForRotation = null;
    try { histForRotation = ssLoad(sessionId, { agentId }); } catch {}
    const contextPath = session && session.__arcana_context_file ? String(session.__arcana_context_file || '') : '';
    if (contextPath){
      const rotated = rotateContextAfterCompaction({
        agentId,
        sessionId,
        workspaceRoot,
        historyObj: histForRotation,
        keepRecentUserTurns: keepTurns,
        config: session.__arcana_context_config || null,
      });
      if (rotated && rotated.ok && reloadSessionRuntimeFromContext(session, rotated.contextPath)){
        chatContextDebugLog('compaction:context-rotated', {
          sessionId,
          agentId,
          reason: String(reason || ''),
          contextPath: rotated.contextPath,
          archivedPath: rotated.archivedPath || '',
          retainedMessages: rotated.retainedMessages || 0,
        });
        return '';
      }
    }
  } catch {}

  try {
    if (!resetSessionRuntimeMessages(session) && session && typeof session.newSession === 'function'){
      const p = session.newSession();
      if (p && typeof p.then === 'function') await p;
    }
  } catch {}

  let hist = null;
  try { hist = ssLoad(sessionId, { agentId }); } catch {}
  try {
    if (hist && Array.isArray(hist.messages) && hist.messages.length){
      const lastIdx = hist.messages.length - 1;
      const last = hist.messages[lastIdx];
      if (last && last.role === 'user'){
        const lastText = String(last.text || '').trim();
        const msgTrim = String(message || '').trim();
        if (lastText && msgTrim && lastText === msgTrim){
          hist.messages = hist.messages.slice(0, -1);
        }
      }
    }
  } catch {}

  try {
    const rebuiltPrelude = buildSessionPrelude(hist, DEFAULT_CONTEXT_POLICY, { keepRecentUserTurns: keepTurns }) || '';
    chatContextDebugLog('compaction:rebuilt-prelude', {
      sessionId,
      agentId,
      reason: String(reason || ''),
      keepRecentUserTurns: keepTurns,
      preludeChars: rebuiltPrelude.length,
      summaryChars: hist && typeof hist.summary === 'string' ? hist.summary.length : 0,
      storedMessages: hist && Array.isArray(hist.messages) ? hist.messages.length : 0,
    });
    return rebuiltPrelude;
  } catch {
    return '';
  }
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

export function extractMediaFromAssistantText(text){
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

function dedupeNormalizedMediaRefs(refs){
  const seen = new Set();
  const out = [];
  const arr = Array.isArray(refs) ? refs : [];
  for (const raw of arr){
    const ref = normalizeMediaRef(raw);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

export function attachChatEventBridge(record, sessionId){
  const sess = record && record.session;
  if (!sess || typeof sess.subscribe !== 'function') return;
  if (sess.__arcana_chat_bridged) return;
  sess.__arcana_chat_bridged = true;

  const agentId = record.agentId;
  const agentHomeDir = record.agentHomeDir;
  const workspaceRoot = record.workspaceRoot;
  // NOTE: this used to be an undeclared identifier inside this function. Every
  // bridge emit referencing it threw a swallowed ReferenceError, so the bridge
  // never actually delivered turn_start/turn_end/assistant_text/tool events —
  // downstream code compensated with force-re-emits (duplicate source).
  // Refreshed per event because ensureChatSession may rebind the record's
  // sessionKey when a cached session is reused under a different key.
  let sessionKey = String((record && record.sessionKey) || '');

  // Tools routed through the local tool proxy emit their own canonical
  // tool_execution_* events (source: 'local_tool_proxy') with a proxy callId.
  // Forwarding the SDK-side events for the same call would render two tool
  // cards, so the bridge skips them.
  function isProxiedLocalToolEvent(toolName){
    if (!record || record.localToolProxyEnabled !== true) return false;
    const name = String(toolName || '').trim();
    if (!name) return false;
    try {
      if (record.injectedLocalToolNames && record.injectedLocalToolNames.has(name)) return true;
    } catch {}
    try {
      const route = resolveToolRoute(record.toolRouting, name);
      if (route && route.execution === 'local') return true;
    } catch {}
    return false;
  }

  // Per-session usage totals for llm_usage
  let runInputTokens = 0;
  let runCacheReadTokens = 0;
  let runCacheWriteTokens = 0;
  let runContextTokens = 0;
  let runOutputTokens = 0;
  let runTotalTokens = 0;
  // Last single LLM call values (for per-card display)
  let lastCallInputTokens = 0;
  let lastCallCacheReadTokens = 0;
  let lastCallCacheWriteTokens = 0;
  let lastCallContextTokens = 0;
  let lastCallTotalTokens = 0;


  const mediaRefsSeen = new Set();
  let assistantRawText = '';
  let lastAssistantTextEmitted = '';
  // Item-lifecycle protocol state: one itemId per assistant message so the
  // client can render each message in its own bubble and dedupe re-delivery.
  let currentTurnId = '';
  let currentAssistantItemId = '';

  function emitItemEvent(event){
    try {
      const payload = withSessionStreamRouting({ ...event }, { sessionId, sessionKey, agentId });
      if (currentTurnId && !payload.turnId) payload.turnId = currentTurnId;
      payload.seq = nextEventSeq(sessionId);
      emit(payload);
    } catch {}
  }

  sess.subscribe((ev) => {
    try {
      if (!ev) return;
      const t = ev.type ? String(ev.type) : '';
      sessionKey = String((record && record.sessionKey) || '');

      if (t === 'turn_start'){
        // Maintain a stable, per-session turnIndex counter in-memory during the
        // gateway process lifetime. This enables THINK/LLM cards to align with
        // persisted thinking text and tool actions.
        const key = String(sessionId || 'default');
        if (!sess.__turnIndexBySession) sess.__turnIndexBySession = new Map();
        const cur = sess.__turnIndexBySession.get(key);
        const next = (typeof cur === 'number' && cur >= 0) ? (cur + 1) : 0;
        sess.__turnIndexBySession.set(key, next);
        currentTurnId = newTurnId();
        currentAssistantItemId = '';
        try { record.__arcana_currentTurnId = currentTurnId; } catch {}
        try { forceFlushContextSession(sess); } catch {}
        emitItemEvent({ type: 'turn_start' });
        return;
      }

      if (t === 'turn_end'){
        const key = String(sessionId || 'default');
        const idx = (sess.__turnIndexBySession && sess.__turnIndexBySession.get) ? sess.__turnIndexBySession.get(key) : undefined;
        try { record.__arcana_turnEndCount = (Number(record.__arcana_turnEndCount) || 0) + 1; } catch {}
        emitItemEvent({ type: 'turn_end' });
        currentAssistantItemId = '';
        return;
      }

      const eventToolCallId = getEventToolCallId(ev);
      const baseRaw = withSessionStreamRouting(ev, { sessionId, sessionKey, agentId });
      const base = (
        baseRaw &&
        typeof baseRaw === 'object' &&
        eventToolCallId &&
        !String(baseRaw.toolCallId || '').trim()
      )
        ? { ...baseRaw, toolCallId: eventToolCallId }
        : baseRaw;

      if (t === 'tool_execution_start'){
        try { forceFlushContextSession(sess); } catch {}
        if (isProxiedLocalToolEvent(ev.toolName)) return;
        try { persistToolMetaToDisk({ agentId, sessionId, toolCallId: eventToolCallId, toolName: ev.toolName, args: ev.args || {} }); } catch {}
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
        if (isProxiedLocalToolEvent(ev.toolName)) return;
        try {
          const raw = (typeof ev.partialResult !== 'undefined') ? ev.partialResult : ev.update;
          if (raw && typeof raw === 'object'){
            const stream = String(raw.stream || '').toLowerCase();
            const chunkVal = raw.chunk;
            if ((stream === 'stdout' || stream === 'stderr') && typeof chunkVal === 'string'){
              try { scheduleAppendToolStream({ agentId, sessionId, toolCallId: eventToolCallId, stream, chunk: chunkVal }); } catch {}
            }
          }
        } catch {}
        try { emit(base); } catch {}
        return;
      }

      if (t === 'tool_execution_end'){
        if (isProxiedLocalToolEvent(ev.toolName)){
          try { forceFlushContextSession(sess); } catch {}
          return;
        }
        let payload = base;
        try {
          const usage = extractUsageFromToolEvent(ev);
          if (usage && typeof usage.totalTokens === 'number' && usage.totalTokens > 0){
            payload = base && typeof base === 'object' ? { ...base, usage, usageSource: 'tool' } : { type: 'tool_execution_end', usage, usageSource: 'tool', sessionId };
          }
        } catch {}
        try { emit(payload); } catch {}
        try {
          const eventForDisk = (ev && typeof ev === 'object' && eventToolCallId && !String(ev.toolCallId || '').trim())
            ? { ...ev, toolCallId: eventToolCallId }
            : ev;
          persistToolResultToDisk({ agentId, sessionId, event: eventForDisk });
        } catch {}
        try { forceFlushContextSession(sess); } catch {}
        return;
      }

      if (t === 'thinking_start' || t === 'thinking_delta' || t === 'thinking_end'){
        // Optionally persist full thinking text to disk for later fetch.
        const persist = String(process.env.ARCANA_PERSIST_THINKING || '').trim();
        const on = !!persist && !/^0|false|no|off|null|undefined$/i.test(persist);
        if (on){
          const key = String(sessionId || 'default');
          const idx = (sess.__turnIndexBySession && sess.__turnIndexBySession.get) ? sess.__turnIndexBySession.get(key) : 0;
          if (t === 'thinking_start'){
            try { thinkingStart({ agentId, sessionId, turnIndex: (typeof idx === 'number' && idx >= 0) ? idx : 0 }); } catch {}
          } else if (t === 'thinking_delta'){
            try {
              const src = (Object.prototype.hasOwnProperty.call(ev, 'delta')) ? ev.delta : (Object.prototype.hasOwnProperty.call(ev, 'text') ? ev.text : ev);
              const text = (typeof src === 'string') ? src : (src != null ? JSON.stringify(src) : '');
              appendThinkingDelta({ agentId, sessionId, turnIndex: (typeof idx === 'number' && idx >= 0) ? idx : 0, text });
            } catch {}
          } else if (t === 'thinking_end'){
            try { thinkingEnd({ agentId, sessionId, turnIndex: (typeof idx === 'number' && idx >= 0) ? idx : 0 }); } catch {}
          }
        }
        try { emit(base); } catch {}
        return;
      }

      if (t === 'error'){
        const payload = withSessionStreamRouting(base && typeof base === 'object' ? base : { type: 'error' }, { sessionId, sessionKey, agentId });
        try { emit(payload); } catch {}
        return;
      }

      if (t === 'message_start' && ev.message && ev.message.role === 'assistant'){
        // One item per assistant message: clients render each item in its own
        // bubble, so text before and after tool calls no longer share one.
        currentAssistantItemId = newItemId();
        try { record.__arcana_lastAssistantItemId = currentAssistantItemId; } catch {}
        emitItemEvent({ type: 'item_started', itemId: currentAssistantItemId, itemType: 'assistant_text' });
        return;
      }

      if (t === 'message_update' && ev.message && ev.message.role === 'assistant'){
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        const rawText = mergeTextBlocks(blocks);
        assistantRawText = mergeStreamingText(assistantRawText, rawText);
        const extracted = extractMediaFromAssistantText(assistantRawText);
        const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
        const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
        if (cleanText && cleanText !== lastAssistantTextEmitted){
          lastAssistantTextEmitted = cleanText;
          try { record.__arcana_lastAssistantTextEmitted = cleanText; } catch {}
          try { emit(withSessionStreamRouting({ type: 'assistant_text', text: cleanText }, { sessionId, sessionKey, agentId })); } catch {}
          if (!currentAssistantItemId){
            // Upstream skipped message_start; allocate lazily.
            currentAssistantItemId = newItemId();
            try { record.__arcana_lastAssistantItemId = currentAssistantItemId; } catch {}
            emitItemEvent({ type: 'item_started', itemId: currentAssistantItemId, itemType: 'assistant_text' });
          }
          emitItemEvent({
            type: 'item_updated',
            itemId: currentAssistantItemId,
            text: cleanText,
            mediaRefs: dedupeNormalizedMediaRefs(mediaRefs),
          });
        }
        if (mediaRefs.length){
          for (const raw of mediaRefs){
            const ref = normalizeMediaRef(raw);
            if (!ref || mediaRefsSeen.has(ref)) continue;
            mediaRefsSeen.add(ref);
            try { emit(withSessionStreamRouting({ type: 'assistant_image', url: ref, mime: 'image/*' }, { sessionId, sessionKey, agentId })); } catch {}
          }
        }
      }

      if (t === 'message_end' && ev.message && ev.message.role === 'assistant'){
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const rawText = mergeTextBlocks(blocks);
          assistantRawText = mergeStreamingText(assistantRawText, rawText);
          const extracted = extractMediaFromAssistantText(assistantRawText);
          const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
          const mediaRefs = dedupeNormalizedMediaRefs((extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : []);
          if (cleanText && cleanText !== lastAssistantTextEmitted){
            lastAssistantTextEmitted = cleanText;
            try { record.__arcana_lastAssistantTextEmitted = cleanText; } catch {}
            try { emit(withSessionStreamRouting({ type: 'assistant_text', text: cleanText }, { sessionId, sessionKey, agentId })); } catch {}
          }
          if (cleanText || mediaRefs.length){
            if (!currentAssistantItemId){
              currentAssistantItemId = newItemId();
              emitItemEvent({ type: 'item_started', itemId: currentAssistantItemId, itemType: 'assistant_text' });
            }
            try { record.__arcana_lastAssistantItemId = currentAssistantItemId; } catch {}
            try { record.__arcana_lastAssistantTextPersisted = cleanText; } catch {}
            try { ssAppend(sessionId, { role: 'assistant', text: cleanText, agentId, mediaRefs, itemId: currentAssistantItemId }); } catch {}
            emitItemEvent({
              type: 'item_completed',
              itemId: currentAssistantItemId,
              text: cleanText,
              mediaRefs,
            });
          }
          currentAssistantItemId = '';
          if (mediaRefs.length){
            for (const raw of mediaRefs){
              const ref = normalizeMediaRef(raw);
              if (!ref || mediaRefsSeen.has(ref)) continue;
              mediaRefsSeen.add(ref);
              try { emit(withSessionStreamRouting({ type: 'assistant_image', url: ref, mime: 'image/*' }, { sessionId, sessionKey, agentId })); } catch {}
            }
          }
        } catch {}

        const usageInfo = extractUsageFromAssistantMessage(ev.message, extractUsageTotals);
        const totals = usageInfo && usageInfo.totals;
        if (totals){
          if (typeof totals.inputTokens === 'number' && totals.inputTokens > 0){
            runInputTokens += totals.inputTokens;
          }
          if (typeof totals.cacheReadTokens === 'number' && totals.cacheReadTokens > 0){
            runCacheReadTokens += totals.cacheReadTokens;
          }
          if (typeof totals.cacheWriteTokens === 'number' && totals.cacheWriteTokens > 0){
            runCacheWriteTokens += totals.cacheWriteTokens;
          }
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
          lastCallInputTokens = (typeof totals.inputTokens === 'number' && totals.inputTokens > 0) ? totals.inputTokens : 0;
          lastCallCacheReadTokens = (typeof totals.cacheReadTokens === 'number' && totals.cacheReadTokens > 0) ? totals.cacheReadTokens : 0;
          lastCallCacheWriteTokens = (typeof totals.cacheWriteTokens === 'number' && totals.cacheWriteTokens > 0) ? totals.cacheWriteTokens : 0;
          lastCallContextTokens = (typeof totals.contextTokens === 'number' && totals.contextTokens > 0) ? totals.contextTokens : 0;
          lastCallTotalTokens = (typeof totals.totalTokens === 'number' && totals.totalTokens > 0) ? totals.totalTokens : 0;
          // Emit per-call usage so frontend can update the current LLM card
          try {
            emit({
              type: 'llm_call_usage',
              sessionId,
              agentId,
              inputTokens: lastCallInputTokens,
              cacheReadTokens: lastCallCacheReadTokens,
              cacheWriteTokens: lastCallCacheWriteTokens,
              contextTokens: lastCallContextTokens,
              totalTokens: lastCallTotalTokens,
            });
          } catch {}
        }


        assistantRawText = '';
        try { forceFlushContextSession(sess); } catch {}
      }
    } catch {}
  });

  // Attach a helper so callers can drain usage per completed turn
  sess.__arcana_chat_usage = {
    reset(){
      runInputTokens = 0; runCacheReadTokens = 0; runCacheWriteTokens = 0;
      runContextTokens = 0; runOutputTokens = 0; runTotalTokens = 0;
      lastCallInputTokens = 0; lastCallCacheReadTokens = 0; lastCallCacheWriteTokens = 0;
      lastCallContextTokens = 0; lastCallTotalTokens = 0;
    },
    snapshot(){
      return {
        inputTokens: runInputTokens,
        cacheReadTokens: runCacheReadTokens,
        cacheWriteTokens: runCacheWriteTokens,
        contextTokens: runContextTokens,
        outputTokens: runOutputTokens,
        totalTokens: runTotalTokens,
        lastCallInputTokens,
        lastCallCacheReadTokens,
        lastCallCacheWriteTokens,
        lastCallContextTokens,
        lastCallTotalTokens,
      };
    },
  };
}

function sessionAlreadyHasAssistantText(sessionId, agentId, text){
  try {
    const expected = String(text || '').trim();
    if (!expected) return false;
    const obj = ssLoad(sessionId, { agentId });
    const messages = Array.isArray(obj && obj.messages) ? obj.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1){
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant') continue;
      if (String(msg.text || '').trim() === expected) return true;
      return false;
    }
  } catch {}
  return false;
}

export function ensureAssistantTextDelivered({ record, sessionId, sessionKey, agentId, text } = {}){
  // Normalize through the same media extraction as the streaming path, so the
  // comparison below is clean-vs-clean. Comparing raw text against the
  // streamed cleanText used to mismatch whenever the message carried MEDIA
  // refs, re-emitting (duplicate bubble) and re-persisting (duplicate history).
  const extracted = extractMediaFromAssistantText(String(text || ''));
  const finalText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
  const mediaRefs = dedupeNormalizedMediaRefs((extracted && extracted.mediaRefs) || []);
  if (!finalText.trim() && !mediaRefs.length) return false;
  let delivered = false;
  try {
    if (finalText.trim() && String(record && record.__arcana_lastAssistantTextEmitted || '') !== finalText){
      emit(withSessionStreamRouting({ type: 'assistant_text', text: finalText }, { sessionId, sessionKey, agentId }));
      // Re-deliver as item_completed too. Keyed by itemId, so a client that
      // already rendered this item just refreshes its content in place.
      const itemId = String(record && record.__arcana_lastAssistantItemId || '') || newItemId();
      if (record) record.__arcana_lastAssistantItemId = itemId;
      const itemEvent = withSessionStreamRouting({
        type: 'item_completed',
        itemId,
        text: finalText,
        mediaRefs,
      }, { sessionId, sessionKey, agentId });
      const turnId = String(record && record.__arcana_currentTurnId || '');
      if (turnId) itemEvent.turnId = turnId;
      itemEvent.seq = nextEventSeq(sessionId);
      emit(itemEvent);
      if (record) record.__arcana_lastAssistantTextEmitted = finalText;
      delivered = true;
    }
  } catch {}
  try {
    const alreadyPersisted = String(record && record.__arcana_lastAssistantTextPersisted || '') === finalText
      || sessionAlreadyHasAssistantText(sessionId, agentId, finalText);
    if (finalText.trim() && !alreadyPersisted){
      ssAppend(sessionId, { role: 'assistant', text: finalText, agentId, mediaRefs });
      if (record) record.__arcana_lastAssistantTextPersisted = finalText;
      delivered = true;
    }
  } catch {}
  return delivered;
}

export function emitUserMessageDelivered({ sessionId, sessionKey, agentId, text, mediaRefs } = {}){
  try {
    const event = {
      type: 'user_message',
      text: String(text || ''),
    };
    if (Array.isArray(mediaRefs) && mediaRefs.length) event.mediaRefs = mediaRefs;
    emit(withSessionStreamRouting(event, { sessionId, sessionKey, agentId }));
    return true;
  } catch {}
  return false;
}

export function ensureTurnEndDelivered({ record, sessionId, sessionKey, agentId, turnEndCountBefore, force } = {}){
  try {
    const before = Number(turnEndCountBefore) || 0;
    const after = Number(record && record.__arcana_turnEndCount) || 0;
    if (!force && after > before) return false;
    emit(withSessionStreamRouting({ type: 'turn_end' }, { sessionId, sessionKey, agentId }));
    if (record) record.__arcana_turnEndCount = after + 1;
    return true;
  } catch {}
  return false;
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
  if (attachmentImages.length) {
    images.push(...attachmentImages);
  }

  return {
    cleanedMessage: keptLines.join('\n'),
    images,
  };
}

async function runPromptWithSteer({ record, sessionId, sessionKey, message, prelude, isSteer, attachments, clientTurnId }){
  const sess = record.session;
  const toolHost = record.toolHost;
  const agentId = record.agentId;
  const agentHomeDir = record.agentHomeDir;
  const workspaceRoot = record.workspaceRoot;
  const model = record.model || null;
  const ctx = { sessionId, sessionKey, agentId, agentHomeRoot: agentHomeDir, workspaceRoot };
  const { cleanedMessage, images } = await extractUserPromptImages(message, ctx, attachments);
  const promptMessage = cleanedMessage || (images.length ? 'See attached image.' : '');

  // Only inject prelude when pi-agent-core has no internal context.
  // Once the agent has processed at least one turn, it keeps its own
  // tool-call history — injecting the prelude again would double-count.
  let usePrelude = '';
  let internalMessageCount = 0;
  try {
    const agentMessages = sess.agent && sess.agent.state && sess.agent.state.messages;
    internalMessageCount = Array.isArray(agentMessages) ? agentMessages.length : 0;
    if (!agentMessages || agentMessages.length === 0) {
      usePrelude = prelude || '';
    }
  } catch {
    usePrelude = prelude || '';
  }
  chatContextDebugLog('turn:start', {
    sessionId,
    agentId,
    internalMessageCount,
    injectedPrelude: !!usePrelude,
    preludeChars: usePrelude.length,
    messageChars: String(message || '').length,
    isSteer: !!isSteer,
  });
  let payloadMsg = (usePrelude ? usePrelude + '\n\n' : '') + '[Current Question]\n' + promptMessage;
  let dynamicPrelude = prelude || '';
  let overflowRetries = 0;
  const usageHelper = sess.__arcana_chat_usage;
  if (usageHelper) usageHelper.reset();
  const compressionKeepUserTurns = _getCompressionKeepUserTurns(agentHomeDir);

  if (isSteer){
    try { toolHost && toolHost.cancelActiveCall && toolHost.cancelActiveCall(); } catch {}
    const promptOpts = { streamingBehavior: 'steer', expandPromptTemplates: true };
    if (images.length) promptOpts.images = images;
    await runWithContext(ctx, () => sess.prompt(payloadMsg, promptOpts));
    try { emit({ type: 'steer_enqueued', sessionId, agentId, text: message }); } catch {}
    return { ok: true, mode: 'steer', text: '' };
  }

  let lastAssistantText = '';
  let out = '';
  let thinkingChars = 0;
  let toolCalls = 0;
  const assistantBlockTypes = new Set();
  let finishReason = '';
  let stopReason = '';
  let lastErrorMessage = '';
  let sawAssistantText = false;
  let diagnosticEvents = [];
  let assistantMessageMeta = null;
  let promptError = null;
  let observedInputTokens = 0;
  let observedCacheReadTokens = 0;
  let observedCacheWriteTokens = 0;
  let observedContextTokens = 0;
  let observedOutputTokens = 0;
  let observedTotalTokens = 0;
  let observedLastCallInputTokens = 0;
  let observedLastCallCacheReadTokens = 0;
  let observedLastCallCacheWriteTokens = 0;
  let observedLastCallContextTokens = 0;
  let observedLastCallTotalTokens = 0;

  for (;;){
    // Reset tracking vars for each attempt
    lastAssistantText = ''; out = ''; thinkingChars = 0; toolCalls = 0;
    assistantBlockTypes.clear(); finishReason = ''; stopReason = '';
    sawAssistantText = false; diagnosticEvents = []; assistantMessageMeta = null;
    promptError = null;
    lastErrorMessage = '';
    observedInputTokens = 0;
    observedCacheReadTokens = 0;
    observedCacheWriteTokens = 0;
    observedContextTokens = 0;
    observedOutputTokens = 0;
    observedTotalTokens = 0;
    observedLastCallInputTokens = 0;
    observedLastCallCacheReadTokens = 0;
    observedLastCallCacheWriteTokens = 0;
    observedLastCallContextTokens = 0;
    observedLastCallTotalTokens = 0;
    // Build payload for this attempt (may be updated on overflow retries)
    payloadMsg = (usePrelude ? usePrelude + '\n\n' : '') + '[Current Question]\n' + promptMessage;

    // --- Pre-prompt context overflow prevention ---
    // The sessions-store threshold check (in handleUserMessage) only measures text summaries,
    // not pi-agent-core's in-memory context which includes full tool call results.
    // Check the actual pi-agent-core context usage before sending the prompt.
    try {
      if (sess && typeof sess.getContextUsage === 'function') {
        const ctxUsage = sess.getContextUsage();
        if (ctxUsage && ctxUsage.tokens != null) {
          const configuredThreshold = _getCompressionThresholdTokens(agentHomeDir) || 100000;
          const projected = estimateProjectedPromptTokens({
            liveContextTokens: ctxUsage.tokens,
            preludeText: usePrelude,
            promptMessage,
          });
          chatContextDebugLog('turn:context-usage', {
            sessionId,
            agentId,
            phase: 'pre_prompt',
            tokens: Number(ctxUsage.tokens || 0) || 0,
            projectedTokens: Number(projected && projected.tokens || 0) || 0,
            baseTokens: Number(projected && projected.baseTokens || 0) || 0,
            promptTokens: Number(projected && projected.promptTokens || 0) || 0,
            source: String(projected && projected.source || ''),
            contextWindow: Number(ctxUsage.contextWindow || 0) || 0,
            configuredThreshold,
            internalMessageCount: (() => {
              try {
                const msgs = sess.agent && sess.agent.state && Array.isArray(sess.agent.state.messages)
                  ? sess.agent.state.messages
                  : [];
                return msgs.length;
              } catch {
                return 0;
              }
            })(),
          });
          if (projected.tokens > configuredThreshold && compressionKeepUserTurns > 0) {
            dynamicPrelude = await compactInternalHistoryAndRebuildPrelude({
              session: sess,
              sessionId,
              sessionKey,
              agentId,
              workspaceRoot,
              agentHomeDir,
              message,
              keepRecentUserTurns: compressionKeepUserTurns,
              reason: 'pre_prompt_threshold',
            });
            usePrelude = dynamicPrelude || '';
            chatContextDebugLog('turn:prelude-updated', {
              sessionId,
              agentId,
              phase: 'pre_prompt_threshold',
              injectedPrelude: !!usePrelude,
              preludeChars: usePrelude.length,
            });
            payloadMsg = (usePrelude ? usePrelude + '\n\n' : '') + '[Current Question]\n' + promptMessage;
          }
        }
      }
    } catch {}

    if (usageHelper) usageHelper.reset();

    // Idle timeout disabled by default. Set ARCANA_PROMPT_IDLE_TIMEOUT_MS>0 to re-enable.
    const _idleTimeoutRaw = Number(process.env.ARCANA_PROMPT_IDLE_TIMEOUT_MS);
    const _idleTimeoutMs = (Number.isFinite(_idleTimeoutRaw) && _idleTimeoutRaw > 0) ? _idleTimeoutRaw : 0;
    let _idleTimer = null;
    let _idleReject = null;
    let _idlePromise = null;
    let _resetIdleTimer = () => {};
    if (_idleTimeoutMs > 0){
      _idlePromise = new Promise((_, reject) => { _idleReject = reject; });
      // redefine reset only when enabled
      const __reset = () => {
        if (_idleTimer) clearTimeout(_idleTimer);
        if (_idleReject) {
          _idleTimer = setTimeout(() => {
            try { if (sess && typeof sess.abort === 'function') sess.abort(); } catch {}
            try { _idleReject(new Error('Agent prompt idle timeout (' + _idleTimeoutMs + 'ms) — no stream events received. The agent may be stuck.')); } catch {}
            _idleReject = null;
          }, _idleTimeoutMs);
        }
      };
      // shadow no-op with active implementation
      // eslint-disable-next-line no-func-assign
      _resetIdleTimer = __reset;
    }

    const unsub = sess.subscribe((ev) => {
      try { _resetIdleTimer(); } catch {}
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
          const text = mergeTextBlocks(blocks);
          if (text){
            out = mergeStreamingText(out, text);
            sawAssistantText = true;
          }
        }

        if (t === 'message_end' && ev.message && ev.message.role === 'assistant'){
          const msg = ev.message;
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          const text = mergeTextBlocks(blocks);
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
            if (msg.errorMessage){
              lastErrorMessage = String(msg.errorMessage);
            }
          } catch {}
          try {
            const meta = extractAssistantMessageMeta(msg);
            if (meta) assistantMessageMeta = meta;
          } catch {}
          try {
            const usageInfo = extractUsageFromAssistantMessage(msg, extractUsageTotals);
            const totals = usageInfo && usageInfo.totals;
            if (totals){
              const inputTokens = Number(totals.inputTokens || 0) || 0;
              const cacheReadTokens = Number(totals.cacheReadTokens || 0) || 0;
              const cacheWriteTokens = Number(totals.cacheWriteTokens || 0) || 0;
              const contextTokens = Number(totals.contextTokens || 0) || 0;
              const outputTokens = Number(totals.outputTokens || 0) || 0;
              const totalTokens = Number(totals.totalTokens || 0) || 0;
              if (inputTokens > 0) observedInputTokens += inputTokens;
              if (cacheReadTokens > 0) observedCacheReadTokens += cacheReadTokens;
              if (cacheWriteTokens > 0) observedCacheWriteTokens += cacheWriteTokens;
              if (contextTokens > 0) observedContextTokens += contextTokens;
              if (outputTokens > 0) observedOutputTokens += outputTokens;
              if (totalTokens > 0) observedTotalTokens += totalTokens;
              observedLastCallInputTokens = inputTokens > 0 ? inputTokens : 0;
              observedLastCallCacheReadTokens = cacheReadTokens > 0 ? cacheReadTokens : 0;
              observedLastCallCacheWriteTokens = cacheWriteTokens > 0 ? cacheWriteTokens : 0;
              observedLastCallContextTokens = contextTokens > 0 ? contextTokens : 0;
              observedLastCallTotalTokens = totalTokens > 0 ? totalTokens : 0;
            }
          } catch {}
        }
      } catch {}
    });
    _resetIdleTimer(); // no-op when idle timeout disabled
    try {
      // If the agent starts streaming between the earlier isSteer check and this call,
      // pass a safe fallback so we queue instead of throwing. 'followUp' is ignored
      // when not streaming, and avoids HTTP 500 "Agent is already processing" races.
      const promptOpts = { expandPromptTemplates: true };
      if (images.length) promptOpts.images = images;
      try { if (sess && sess.isStreaming) Object.assign(promptOpts, { streamingBehavior: 'followUp' }); } catch {}
      if (_idlePromise){
        await Promise.race([
          runWithContext(ctx, () => sess.prompt(payloadMsg, promptOpts)),
          _idlePromise,
        ]);
      } else {
        await runWithContext(ctx, () => sess.prompt(payloadMsg, promptOpts));
      }
    } catch (e) {
      promptError = e;
    } finally {
      if (_idleTimer) { try { clearTimeout(_idleTimer); } catch {} _idleTimer = null; }
      _idleReject = null;
      try { unsub && unsub(); } catch {}
    }

    // Fallback: if subscriber didn't capture error info (e.g. HTTP 413 only emits
    // agent_end, not message_end), read directly from pi-agent-core's agent state.
    try {
      const agent = sess && sess.agent ? sess.agent : null;
      if (agent) {
        const agentError = agent.state && agent.state.error ? String(agent.state.error) : '';
        if (agentError && !lastErrorMessage) {
          lastErrorMessage = agentError;
        }
        // Also check the last message in agent state for stopReason/errorMessage
        const msgs = agent.state && Array.isArray(agent.state.messages) ? agent.state.messages : [];
        if (msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') {
            if (last.stopReason && !stopReason) stopReason = String(last.stopReason);
            if (last.errorMessage && !lastErrorMessage) lastErrorMessage = String(last.errorMessage);
          }
        }
      }
    } catch {}

    // Determine if this attempt had an error
    const _completionErr = isCompletionErrorReason(finishReason) ? finishReason : (isCompletionErrorReason(stopReason) ? stopReason : '');
    const _hasError = !!(promptError || _completionErr || lastErrorMessage);
    if (!_hasError) break; // success

    // Context overflow handling: compact + reset + immediate retry
    const overflowMax = (DEFAULT_CONTEXT_POLICY && Number.isFinite(DEFAULT_CONTEXT_POLICY.maxOverflowRetries))
      ? Number(DEFAULT_CONTEXT_POLICY.maxOverflowRetries)
      : 3;
    if (isContextOverflowError(promptError, finishReason, stopReason, lastErrorMessage) && overflowRetries < overflowMax) {
      try {
        if (compressionKeepUserTurns <= 0){
          break;
        }

        dynamicPrelude = await compactInternalHistoryAndRebuildPrelude({
          session: sess,
          sessionId,
          sessionKey,
          agentId,
          workspaceRoot,
          agentHomeDir,
          message,
          keepRecentUserTurns: compressionKeepUserTurns,
          reason: 'overflow',
        });
        usePrelude = dynamicPrelude || '';
        chatContextDebugLog('turn:prelude-updated', {
          sessionId,
          agentId,
          phase: 'overflow_retry',
          injectedPrelude: !!usePrelude,
          preludeChars: usePrelude.length,
          overflowRetries: overflowRetries + 1,
        });
        payloadMsg = (usePrelude ? usePrelude + '\n\n' : '') + '[Current Question]\n' + promptMessage;

        overflowRetries += 1;

        // Reset usage helper before retry
        if (usageHelper) usageHelper.reset();

        continue;
      } catch {
        // If compaction/reset fails, fall through to normal error handling below.
      }
    }
    break;
  }
  const bridgeUsage = sess.__arcana_chat_usage ? sess.__arcana_chat_usage.snapshot() : { contextTokens: 0, outputTokens: 0, totalTokens: 0 };
  const observedUsage = {
    inputTokens: observedInputTokens,
    cacheReadTokens: observedCacheReadTokens,
    cacheWriteTokens: observedCacheWriteTokens,
    contextTokens: observedContextTokens,
    outputTokens: observedOutputTokens,
    totalTokens: observedTotalTokens,
    lastCallInputTokens: observedLastCallInputTokens,
    lastCallCacheReadTokens: observedLastCallCacheReadTokens,
    lastCallCacheWriteTokens: observedLastCallCacheWriteTokens,
    lastCallContextTokens: observedLastCallContextTokens,
    lastCallTotalTokens: observedLastCallTotalTokens,
  };
  const usage = selectUsageSnapshot(bridgeUsage, observedUsage);
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
  if (hasRealTokenUsage(usage)){
    try {
      const ev = buildLlmUsageEvent({
        usage,
        sessionId,
        sessionKey,
        agentId,
        sessionTokens: sessionTokensTotal,
        model: usageModelLabel,
        clientTurnId,
      });
      if (ev) emit(ev);
    } catch {}
  }


  const completionErrorReason = isCompletionErrorReason(finishReason) ? finishReason : (isCompletionErrorReason(stopReason) ? stopReason : '');
  const diagnostics = buildDiagnosticsPayload({ record: { ...record, model }, finishReason, stopReason, completionErrorReason, assistantMessageMeta, diagnosticEvents });

  // Optional model_request logging
  let modelRequest = null;
  try {
    if (record && record.session && (truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST') || truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL') || chatLogAllFullEnabled())){
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
      const promptFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT_FULL') || chatLogAllFullEnabled();
      const includePrompt = promptEnv || promptFullEnv;
      const promptText = payloadMsg;
      const promptMaxChars = promptFullEnv ? fullChatLogMaxChars() : MAX_PROMPT_LOG_CHARS;
      const reqEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST');
      const reqFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL') || chatLogAllFullEnabled();
      const includeModelRequest = !!(modelRequest && (reqEnv || reqFullEnv));
      const modelRequestMaxChars = reqFullEnv ? fullChatLogMaxChars() : MAX_PROMPT_LOG_CHARS;
      await writeChatLog({ logPath: lp, headerLines, promptText, includePrompt, errorStack: stack, stats, diagnostics, promptMaxChars, modelRequest, includeModelRequest, modelRequestMaxChars, captureSummary: chatLogAllFullEnabled() });
      logPath = lp;
    } catch {}
    try {
      const msgWithLog = logPath ? (msg + ' (log: ' + logPath + ')') : msg;
      emit(withSessionStreamRouting({ type: 'error', message: msgWithLog, stack }, { sessionId, sessionKey, agentId }));
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
      const promptFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT_FULL') || chatLogAllFullEnabled();
      const includePrompt = promptEnv || promptFullEnv;
      const promptText = payloadMsg;
      const promptMaxChars = promptFullEnv ? fullChatLogMaxChars() : MAX_PROMPT_LOG_CHARS;
      const reqEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST');
      const reqFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL') || chatLogAllFullEnabled();
      const includeModelRequest = !!(modelRequest && (reqEnv || reqFullEnv));
      const modelRequestMaxChars = reqFullEnv ? fullChatLogMaxChars() : MAX_PROMPT_LOG_CHARS;
      await writeChatLog({ logPath: lp, headerLines, promptText, includePrompt, errorStack: null, stats, diagnostics, promptMaxChars, modelRequest, includeModelRequest, modelRequestMaxChars, captureSummary: chatLogAllFullEnabled() });
      logPath = lp;
    } catch {}
    try {
      const msgCore = core || (reasonShort || completionErrorReason || '');
      const msg = 'completion_error: ' + msgCore;
      const msgWithLog = logPath ? (msg + ' (log: ' + logPath + ')') : msg;
      emit(withSessionStreamRouting({ type: 'error', message: msgWithLog }, { sessionId, sessionKey, agentId }));
    } catch {}
    const errCore = core || (reasonShort || completionErrorReason || '');
    return { ok: false, mode: 'turn', error: 'completion_error: ' + errCore, text: lastAssistantText || out, logPath };
  }

  if (isRequiredBillingUsageMissing(record, usage) && (finalText || sawAssistantText)){
    const code = 'llm_usage_missing';
    const messageText = 'llm_usage_missing: provider did not return token usage for a billable Agent turn';
    try {
      const lp = buildChatLogPath(agentId, sessionKey, sessionId);
      const headerLines = [
        '[arcana:gateway-v2] llm_usage_missing',
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
        usageContextTokens: usage && usage.contextTokens || 0,
        usageOutputTokens: usage && usage.outputTokens || 0,
        usageTotalTokens: usage && usage.totalTokens || 0,
      };
      await writeChatLog({
        logPath: lp,
        headerLines,
        promptText: payloadMsg,
        includePrompt: chatLogAllFullEnabled(),
        errorStack: null,
        stats,
        diagnostics,
        promptMaxChars: chatLogAllFullEnabled() ? fullChatLogMaxChars() : MAX_PROMPT_LOG_CHARS,
        modelRequest,
        includeModelRequest: chatLogAllFullEnabled() && !!modelRequest,
        modelRequestMaxChars: chatLogAllFullEnabled() ? fullChatLogMaxChars() : MAX_PROMPT_LOG_CHARS,
        captureSummary: chatLogAllFullEnabled(),
      });
      logPath = lp;
    } catch {}
    try {
      const msg = messageText + (logPath ? ' (log: ' + logPath + ')' : '');
      emit(withSessionStreamRouting({ type: 'error', code, message: msg }, { sessionId, sessionKey, agentId }));
    } catch {}
    return { ok: false, mode: 'turn', error: code, text: finalText, logPath, usage: null };
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
      const promptFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_PROMPT_FULL') || chatLogAllFullEnabled();
      const includePrompt = promptEnv || promptFullEnv;
      const promptText = payloadMsg;
      const promptMaxChars = promptFullEnv ? fullChatLogMaxChars() : MAX_PROMPT_LOG_CHARS;
      const reqEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST');
      const reqFullEnv = truthyEnv('ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL') || chatLogAllFullEnabled();
      const includeModelRequest = !!(modelRequest && (reqEnv || reqFullEnv));
      const modelRequestMaxChars = reqFullEnv ? fullChatLogMaxChars() : MAX_PROMPT_LOG_CHARS;
      await writeChatLog({ logPath: lp, headerLines, promptText, includePrompt, errorStack: null, stats, diagnostics, promptMaxChars, modelRequest, includeModelRequest, modelRequestMaxChars, captureSummary: chatLogAllFullEnabled() });
      logPath = lp;
      warning = (toolCalls > 0 || assistantBlockTypes.size > 0)
        ? 'empty_completion_after_tools'
        : 'empty_completion';
      try {
        const msg = String(warning) + (logPath ? ' (log: ' + logPath + ')' : '');
        emit(withSessionStreamRouting({ type: 'warning', code: String(warning), message: msg }, { sessionId, sessionKey, agentId }));
      } catch {}
    } catch {}
  }

  const responseUsage = usage && (usage.totalTokens > 0 || usage.contextTokens > 0 || usage.outputTokens > 0)
    ? {
      inputTokens: usage.inputTokens || Math.max(0, (usage.contextTokens || 0) - (usage.cacheReadTokens || 0) - (usage.cacheWriteTokens || 0)),
      contextTokens: usage.contextTokens,
      cacheReadTokens: usage.cacheReadTokens || 0,
      cacheWriteTokens: usage.cacheWriteTokens || 0,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      lastCallInputTokens: usage.lastCallInputTokens || Math.max(0, (usage.lastCallContextTokens || 0) - (usage.lastCallCacheReadTokens || 0) - (usage.lastCallCacheWriteTokens || 0)),
      lastCallCacheReadTokens: usage.lastCallCacheReadTokens || 0,
      lastCallCacheWriteTokens: usage.lastCallCacheWriteTokens || 0,
      lastCallContextTokens: usage.lastCallContextTokens || 0,
      lastCallTotalTokens: usage.lastCallTotalTokens || 0,
      ...(usageModelLabel ? { model: usageModelLabel } : {}),
    }
    : null;

  if (chatLogAllFullEnabled() && !logPath && finalText){
    try {
      const lp = buildChatLogPath(agentId, sessionKey, sessionId);
      const headerLines = [
        '[arcana:gateway-v2] turn_success',
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
      await writeChatLog({
        logPath: lp,
        headerLines,
        promptText: payloadMsg,
        includePrompt: true,
        errorStack: null,
        stats,
        diagnostics,
        promptMaxChars: fullChatLogMaxChars(),
        modelRequest,
        includeModelRequest: !!modelRequest,
        modelRequestMaxChars: fullChatLogMaxChars(),
        captureSummary: true,
      });
      logPath = lp;
    } catch {}
  }

  if (warning){
    if (warning === 'empty_completion_after_tools'){
      try {
        const msg = 'completion_error: ' + warning + (logPath ? ' (log: ' + logPath + ')' : '');
        emit(withSessionStreamRouting({ type: 'error', message: msg }, { sessionId, sessionKey, agentId }));
      } catch {}
      return { ok: false, mode: 'turn', error: warning, text: '', warning, logPath, usage: responseUsage };
    }
    return { ok: true, mode: 'turn', text: '', warning, logPath, usage: responseUsage };
  }
  return { ok: true, mode: 'turn', text: finalText, logPath, usage: responseUsage };
}

export async function runChatMessage({ agentId: rawAgentId, sessionKey, sessionId: rawSessionId, workspaceRoot: rawWorkspaceRoot, agentHomeRoot: rawAgentHomeRoot, text: rawText, policy: rawPolicy, title, sync, toolRouting, localToolProxy, toolAllowlist, localToolDefinitions, localBootstrapFiles, localAgentSignature, systemPromptOverride, clientTurnId: rawClientTurnId, attachments: rawAttachments }){
  const agentId = normalizeAgentId(rawAgentId || DEFAULT_AGENT_ID);
  const policy = String(rawPolicy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
  const trimmed = trimUserMessage(String(rawText || '').trim(), DEFAULT_CONTEXT_POLICY);
  const clientTurnId = rawClientTurnId == null ? '' : String(rawClientTurnId).trim();
  const attachments = normalizeChatAttachments(rawAttachments);
  if (!trimmed && !attachments.length){
    return { ok: false, error: 'missing_text' };
  }
  const promptText = trimmed || 'See attached image.';
  localProxyDebugLog('runChatMessage ingress', {
    agentId,
    sessionKey: String(sessionKey || '').trim() || null,
    sessionId: String(rawSessionId || '').trim() || null,
    agentHomeRoot: normalizeAgentHomeRootOverride(rawAgentHomeRoot) || null,
    localToolProxyEnabled: !!localToolProxy,
    toolAllowlistCount: Array.isArray(toolAllowlist) ? toolAllowlist.length : 0,
    localAgentSignature: buildLocalAgentSignature(localAgentSignature),
    systemPromptOverrideActive: !!normalizeSystemPromptOverride(systemPromptOverride),
    localToolDefinitions: summarizeInjectedLocalToolDefinitionsForDebug(localToolDefinitions),
    attachmentCount: attachments.length,
  });

  const ws = normalizeWorkspaceRootOverride(rawWorkspaceRoot) || resolveWorkspaceRoot();
  const agentHomeDir = normalizeAgentHomeRootOverride(rawAgentHomeRoot) || arcanaHomePath('agents', agentId);
  const ensuredId = await ensureSessionId({ sessionId: rawSessionId, sessionKey, title: title || 'Arcana Web', agentId, workspaceRoot: ws });
  const sessionId = String(ensuredId || '').trim();
  if (!sessionId){
    return { ok: false, error: 'session_resolve_failed' };
  }

  // Load session history object for prelude & persistence
  let historyObj = null;
  let keepUserTurnsForPrelude = null;
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

  let record;
  try {
    record = await ensureChatSession({
      sessionId,
      sessionKey,
      agentId,
      policy,
      workspaceRoot: ws,
      agentHomeRoot: agentHomeDir,
      toolRouting,
      localToolProxy,
      toolAllowlist,
    localToolDefinitions,
    localBootstrapFiles,
    localAgentSignature,
    systemPromptOverride,
  });
  } catch (e) {
    const code = String((e && e.code) || '').toUpperCase();
    const message = String((e && e.message) || e || 'Failed to start chat session');
    if (code === 'ARCANA_NO_MODEL_SELECTED'){
      return { ok: false, error: 'no_model_selected', status: (typeof e.status === 'number' ? e.status : 400), message };
    }
    return { ok: false, error: 'turn_failed', status: (typeof e.status === 'number' ? e.status : 500), message };
  }
  const session = record.session;

  // Optional history compaction based on the real prompt context footprint.
  // If the session already has internal context, use its live token usage.
  // Otherwise, estimate the prelude that will actually be injected for this turn.
  try {
    if (historyObj && Array.isArray(historyObj.messages) && historyObj.messages.length){
      const historyCompressionEnabled = _getCompressionEnabled(agentHomeDir);
      const thresholdTokens = _getCompressionThresholdTokens(agentHomeDir) || 100000;
      const keepTurnsConfig = _getCompressionKeepUserTurns(agentHomeDir);

      if (historyCompressionEnabled && keepTurnsConfig > 0){
        keepUserTurnsForPrelude = keepTurnsConfig;
      }

      if (historyCompressionEnabled && thresholdTokens > 0 && keepTurnsConfig > 0){
        const ctx = _getLiveContextTokensForCompression(session, historyObj, keepTurnsConfig, promptText);
        chatContextDebugLog('turn:compression-check', {
          sessionId,
          agentId,
          phase: 'run_chat_message',
          source: String(ctx && ctx.source || ''),
          baseTokens: Number(ctx && ctx.baseTokens || 0) || 0,
          promptTokens: Number(ctx && ctx.promptTokens || 0) || 0,
          tokens: Number(ctx && ctx.tokens || 0) || 0,
          thresholdTokens,
          keepRecentUserTurns: keepTurnsConfig,
          storedMessages: Array.isArray(historyObj.messages) ? historyObj.messages.length : 0,
          summaryChars: typeof historyObj.summary === 'string' ? historyObj.summary.length : 0,
        });
        if (ctx.tokens > thresholdTokens){
          let userTurns = 0;
          try {
            const msgs = Array.isArray(historyObj.messages) ? historyObj.messages : [];
            for (const m of msgs){
              if (m && m.role === 'user') userTurns += 1;
            }
          } catch {}

          if (userTurns > 0){
            let keepTurns = keepTurnsConfig;
            if (userTurns < keepTurns){
              keepTurns = Math.min(5, userTurns);
            }

            if (keepTurns > 0){
              const compactResult = await compactSessionByUserTurns({
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

              if (compactResult && compactResult.compacted === true){
                chatContextDebugLog('turn:compression-applied', {
                  sessionId,
                  agentId,
                  phase: 'run_chat_message',
                  reason: 'threshold',
                  keepRecentUserTurns: keepTurns,
                });
                try {
                  let rotatedReloaded = false;
                  try { historyObj = ssLoad(sessionId, { agentId }); } catch {}
                  const contextPath = session && session.__arcana_context_file ? String(session.__arcana_context_file || '') : '';
                  if (contextPath){
                    const rotated = rotateContextAfterCompaction({
                      agentId,
                      sessionId,
                      workspaceRoot: ws,
                      historyObj,
                      keepRecentUserTurns: keepTurns,
                      config: record && record.contextConfig,
                    });
                    if (rotated && rotated.ok){
                      rotatedReloaded = reloadSessionRuntimeFromContext(session, rotated.contextPath);
                      chatContextDebugLog('turn:context-rotated', {
                        sessionId,
                        agentId,
                        phase: 'run_chat_message',
                        contextPath: rotated.contextPath,
                        archivedPath: rotated.archivedPath || '',
                        retainedMessages: rotated.retainedMessages || 0,
                        reloaded: rotatedReloaded,
                      });
                    }
                  }
                  if (!rotatedReloaded && !resetSessionRuntimeMessages(session) && session && typeof session.newSession === 'function'){
                    const p = session.newSession();
                    if (p && typeof p.then === 'function') await p;
                  }
                } catch {}

                try { historyObj = ssLoad(sessionId, { agentId }); } catch {}
              }
            }
          }
        }
      }
    }
  } catch {}

  // Build prelude before appending current user message
  let prelude;
  const summaryTextRaw = historyObj && typeof historyObj.summary === 'string' ? historyObj.summary : '';
  const summaryText = String(summaryTextRaw || '').trim();
  if (summaryText && keepUserTurnsForPrelude != null){
    prelude = buildSessionPrelude(historyObj, DEFAULT_CONTEXT_POLICY, { keepRecentUserTurns: keepUserTurnsForPrelude });
  } else {
    prelude = buildSessionPrelude(historyObj, DEFAULT_CONTEXT_POLICY);
  }

  // Persist user message
  const userMediaRefs = attachmentsToMediaRefs(attachments);
  ssAppend(sessionId, { role: 'user', text: promptText, agentId, mediaRefs: userMediaRefs });
  emitUserMessageDelivered({
    sessionId,
    sessionKey,
    agentId,
    text: promptText,
    mediaRefs: userMediaRefs,
  });

  const isSteer = !!(session && session.isStreaming);
  const turnEndCountBefore = Number(record && record.__arcana_turnEndCount) || 0;
  let result = null;
  try {
    result = await runPromptWithSteer({ record, sessionId, sessionKey, message: promptText, prelude, isSteer, attachments, clientTurnId });
    if (!isSteer && result && result.ok !== false){
      ensureAssistantTextDelivered({
        record,
        sessionId,
        sessionKey,
        agentId,
        text: result.text || '',
      });
      ensureTurnEndDelivered({
        record,
        sessionId,
        sessionKey,
        agentId,
        turnEndCountBefore,
      });
    }
  } finally {
    try { forceFlushContextSession(session); } catch {}
    try { if (!session || !session.isStreaming) releaseChatSessionRecord(record); } catch {}
  }

  const response = {
    ok: result && result.ok !== false,
    mode: result && result.mode,
    sessionId,
    text: result && result.text ? result.text : '',
    error: result && result.error,
    warning: result && result.warning,
    logPath: result && result.logPath,
    usage: result && result.usage || null,
  };
  if (!sync) return response;
  return response;
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
  // Ensure a session record exists so reset works after restarts
  try { await ensureChatSession({ sessionId, sessionKey, agentId, policy: 'restricted' }); } catch {}

  let cleared = false;
  for (const rec of Array.from(chatSessions.values())){
    if (!rec || rec.agentId !== agentId) continue;
    if (String(rec.sessionId || '') !== sessionId) continue;

    const sess = rec.session;
    let thisCleared = resetSessionRuntimeMessages(sess);
    if (thisCleared) cleared = true;
    try { releaseChatSessionRecord(rec); } catch {}
  }
  const diskCleared = deleteContextFile({ agentId, sessionId });
  return { ok: cleared || diskCleared };
}

export default {
  runChatMessage,
  abortChat,
  clearChatContext,
  invalidateChatSessions,
  attachLocalToolProxyHub,
  cancelLocalToolProxyCallsForClient,
  handleLocalToolProxyMessage,
  handleLocalToolProxyHeartbeat,
};
