import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root (arcana/arcana)
const projectRoot = join(__dirname, '..');

// On-disk cache for tool outputs (meta/result/stream logs)
export const TOOL_OUTPUT_BASE_DIR = join(projectRoot, '.cache', 'tool-output');

const DEFAULT_AGENT_ID = 'default';

function normalizeAgentId(raw){
  try {
    const s = String(raw == null ? '' : raw).trim();
    return s || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function nowIso(){
  try { return new Date().toISOString(); } catch { return String(new Date()); }
}

function sanitizeIdSegment(raw, fallback){
  try {
    const base = String(raw || '').trim() || String(fallback || '');
    const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, '_');
    if (!cleaned || cleaned === '.' || cleaned === '..') return String(fallback || 'default');
    return cleaned.slice(0, 80);
  } catch { return String(fallback || 'default'); }
}

function ensureToolOutputDir(agentId, sessionId, toolCallId){
  try {
    const a = sanitizeIdSegment(normalizeAgentId(agentId || DEFAULT_AGENT_ID), DEFAULT_AGENT_ID);
    const sid = sanitizeIdSegment(sessionId || 'default', 'default');
    const tid = sanitizeIdSegment(toolCallId || 'tool', 'tool');
    const dir = join(TOOL_OUTPUT_BASE_DIR, a, sid, tid);
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    try {
      const a = sanitizeIdSegment(DEFAULT_AGENT_ID, DEFAULT_AGENT_ID);
      const sid = sanitizeIdSegment('default', 'default');
      const tid = sanitizeIdSegment(toolCallId || 'tool', 'tool');
      const dir = join(TOOL_OUTPUT_BASE_DIR, a, sid, tid);
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch { return TOOL_OUTPUT_BASE_DIR; }
  }
}

function toolOutputKey(agentId, sessionId, toolCallId){
  try {
    const a = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const sid = String(sessionId || 'default');
    const tid = String(toolCallId || '');
    return a + '|' + sid + '|' + tid;
  } catch {
    return String(toolCallId || '');
  }
}

export async function persistToolMetaToDisk({ agentId, sessionId, toolCallId, toolName, args }){
  try {
    if (!toolCallId) return;
    const dir = ensureToolOutputDir(agentId, sessionId, toolCallId);
    const metaPath = join(dir, 'meta.json');
    const payload = {
      toolName: String(toolName || ''),
      args: args == null ? null : args,
      startedAt: nowIso(),
    };
    await writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {}
}

export async function persistToolResultToDisk({ agentId, sessionId, event }){
  try {
    if (!event || !event.toolCallId) return;
    const dir = ensureToolOutputDir(agentId, sessionId, event.toolCallId);
    const resultPath = join(dir, 'result.json');
    const isErr = !!(event?.isError || event?.error || (event?.result && ((event.result.details && event.result.details.ok === false) || event.result.error)));
    const payload = {
      endedAt: nowIso(),
      isError: isErr,
      error: event.error == null ? null : event.error,
      result: event.result == null ? null : event.result,
    };
    await writeFile(resultPath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {}
}

const TOOL_STREAM_FLUSH_MS = 200;
const TOOL_STREAM_MAX_BYTES = (()=>{
  try {
    const raw = process.env.ARCANA_TOOL_STREAM_CACHE_MAX_BYTES;
    if (!raw) return 2000000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 2000000;
    return Math.floor(n);
  } catch { return 2000000; }
})();

const toolStreamBuffers = new Map(); // key -> { buf:string, timer:any, path:string }

function flushToolStreamBuffer(key){
  try {
    const state = toolStreamBuffers.get(key);
    if (!state) return;
    const text = state.buf || '';
    const logPath = state.path;
    state.buf = '';
    state.timer = null;
    if (!text || !logPath) return;
    try {
      appendFileSync(logPath, text, 'utf-8');
    } catch {}
    if (TOOL_STREAM_MAX_BYTES > 0){
      try {
        const st = statSync(logPath);
        if (st && st.size > TOOL_STREAM_MAX_BYTES){
          const buf = readFileSync(logPath);
          const tail = buf.slice(Math.max(0, buf.length - TOOL_STREAM_MAX_BYTES));
          try { writeFileSync(logPath, tail); } catch {}
        }
      } catch {}
    }
  } catch {}
}

export function scheduleAppendToolStream({ agentId, sessionId, toolCallId, stream, chunk }){
  try {
    if (!toolCallId) return;
    const dir = ensureToolOutputDir(agentId, sessionId, toolCallId);
    const logPath = join(dir, 'stream.log');
    const key = toolOutputKey(agentId, sessionId, toolCallId);
    let state = toolStreamBuffers.get(key);
    if (!state){
      state = { buf: '', timer: null, path: logPath };
      toolStreamBuffers.set(key, state);
    } else {
      state.path = logPath;
    }
    const line = '[' + String(stream || '') + '] ' + String(chunk || '') + '\n';
    state.buf += line;
    if (!state.timer){
      const handle = setTimeout(()=>{
        try { flushToolStreamBuffer(key); } catch {}
      }, TOOL_STREAM_FLUSH_MS);
      try { if (handle && typeof handle.unref === 'function') handle.unref(); } catch {}
      state.timer = handle;
    }
  } catch {}
}

export function readStreamLogTail(agentId, sessionId, toolCallId, tailBytes){
  try {
    const a = sanitizeIdSegment(normalizeAgentId(agentId || DEFAULT_AGENT_ID), DEFAULT_AGENT_ID);
    const sid = sanitizeIdSegment(sessionId || 'default', 'default');
    const tid = sanitizeIdSegment(toolCallId || 'tool', 'tool');
    const dir = join(TOOL_OUTPUT_BASE_DIR, a, sid, tid);
    const p = join(dir, 'stream.log');
    if (!existsSync(p)) return '';
    const st = statSync(p);
    if (!st || !st.size) return '';
    const size = st.size;
    const n = (typeof tailBytes === 'number' && tailBytes > 0) ? tailBytes : 200000;
    const start = size > n ? (size - n) : 0;
    const buf = readFileSync(p);
    const tail = start ? buf.slice(start) : buf;
    try { return tail.toString('utf-8'); } catch { return String(tail); }
  } catch { return ''; }
}

export function readToolOutputBundle({ agentId, sessionId, toolCallId, tailBytes }){
  const a = sanitizeIdSegment(normalizeAgentId(agentId || DEFAULT_AGENT_ID), DEFAULT_AGENT_ID);
  const sid = sanitizeIdSegment(sessionId || 'default', 'default');
  const tid = sanitizeIdSegment(toolCallId || 'tool', 'tool');
  const dir = join(TOOL_OUTPUT_BASE_DIR, a, sid, tid);
  const metaPath = join(dir, 'meta.json');
  const resultPath = join(dir, 'result.json');

  let meta = null;
  let result = null;
  try {
    if (existsSync(metaPath)){
      const raw = readFileSync(metaPath, 'utf-8');
      if (raw) meta = JSON.parse(raw);
    }
  } catch {}
  try {
    if (existsSync(resultPath)){
      const raw = readFileSync(resultPath, 'utf-8');
      if (raw) result = JSON.parse(raw);
    }
  } catch {}

  const streamTail = readStreamLogTail(agentId, sessionId, toolCallId, tailBytes);

  return {
    meta: meta || null,
    result: result || null,
    streamTail: streamTail || '',
  };
}

