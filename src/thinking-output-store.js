import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lightweight on-disk cache for THINK/LLM card "thinking" text per session turn.
// Mirrors src/tool-output-store.js but keyed by (agentId, sessionId, turnIndex)
// and stores a single rolling text log with a size cap. The cap defaults to 2MB
// and can be overridden via ARCANA_THINKING_CACHE_MAX_BYTES. When the cap is
// exceeded we keep the tail and mark meta.truncated=true.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

export const THINKING_OUTPUT_BASE_DIR = join(projectRoot, '.cache', 'thinking-output');

const DEFAULT_AGENT_ID = 'default';

function normalizeAgentId(raw){
  try {
    const s = String(raw == null ? '' : raw).trim();
    return s || DEFAULT_AGENT_ID;
  } catch { return DEFAULT_AGENT_ID; }
}

function sanitizeIdSegment(raw, fallback){
  try {
    const base = String(raw || '').trim() || String(fallback || '');
    const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, '_');
    if (!cleaned || cleaned === '.' || cleaned === '..') return String(fallback || 'default');
    return cleaned.slice(0, 80);
  } catch { return String(fallback || 'default'); }
}

function ensureThinkingDir(agentId, sessionId, turnIndex){
  try {
    const a = sanitizeIdSegment(normalizeAgentId(agentId || DEFAULT_AGENT_ID), DEFAULT_AGENT_ID);
    const sid = sanitizeIdSegment(sessionId || 'default', 'default');
    const tid = String(Number.isFinite(turnIndex) && turnIndex >= 0 ? Math.floor(turnIndex) : 0);
    const dir = join(THINKING_OUTPUT_BASE_DIR, a, sid, tid);
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    try {
      const a = sanitizeIdSegment(DEFAULT_AGENT_ID, DEFAULT_AGENT_ID);
      const sid = sanitizeIdSegment('default', 'default');
      const tid = String(Number.isFinite(turnIndex) && turnIndex >= 0 ? Math.floor(turnIndex) : 0);
      const dir = join(THINKING_OUTPUT_BASE_DIR, a, sid, tid);
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch { return THINKING_OUTPUT_BASE_DIR; }
  }
}

function nowIso(){
  try { return new Date().toISOString(); } catch { return String(new Date()); }
}

function getMaxBytes(){
  try {
    const raw = process.env.ARCANA_THINKING_CACHE_MAX_BYTES;
    if (!raw) return 2000000; // 2MB default
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 2000000;
    return Math.floor(n);
  } catch { return 2000000; }
}

function readMeta(path){
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch { return null; }
}

async function writeMeta(path, obj){
  try {
    await writeFile(path, JSON.stringify(obj || {}, null, 2), 'utf-8');
  } catch {}
}

export async function thinkingStart({ agentId, sessionId, turnIndex }){
  try {
    const dir = ensureThinkingDir(agentId, sessionId, turnIndex);
    const metaPath = join(dir, 'meta.json');
    const meta = readMeta(metaPath) || {};
    if (!meta.startedAt) meta.startedAt = nowIso();
    meta.turnIndex = (Number.isFinite(turnIndex) && turnIndex >= 0) ? Math.floor(turnIndex) : 0;
    meta.truncated = !!meta.truncated;
    await writeMeta(metaPath, meta);
  } catch {}
}

export function appendThinkingDelta({ agentId, sessionId, turnIndex, text }){
  try {
    const dir = ensureThinkingDir(agentId, sessionId, turnIndex);
    const logPath = join(dir, 'thinking.txt');
    const metaPath = join(dir, 'meta.json');
    const payload = (typeof text === 'string') ? text : (text != null ? String(text) : '');
    if (!payload) return;
    appendFileSync(logPath, payload, 'utf-8');
    const maxBytes = getMaxBytes();
    if (maxBytes > 0){
      try {
        const st = statSync(logPath);
        if (st && st.size > maxBytes){
          const buf = readFileSync(logPath);
          const tail = buf.slice(Math.max(0, buf.length - maxBytes));
          try { writeFileSync(logPath, tail); } catch {}
          const meta = readMeta(metaPath) || {};
          meta.truncated = true;
          try { writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8'); } catch {}
        }
      } catch {}
    }
  } catch {}
}

export async function thinkingEnd({ agentId, sessionId, turnIndex }){
  try {
    const dir = ensureThinkingDir(agentId, sessionId, turnIndex);
    const metaPath = join(dir, 'meta.json');
    const meta = readMeta(metaPath) || {};
    meta.endedAt = nowIso();
    meta.turnIndex = (Number.isFinite(turnIndex) && turnIndex >= 0) ? Math.floor(turnIndex) : 0;
    await writeMeta(metaPath, meta);
  } catch {}
}

export function readThinkingBundle({ agentId, sessionId, turnIndex }){
  try {
    const a = sanitizeIdSegment(normalizeAgentId(agentId || DEFAULT_AGENT_ID), DEFAULT_AGENT_ID);
    const sid = sanitizeIdSegment(sessionId || 'default', 'default');
    const tid = String(Number.isFinite(turnIndex) && turnIndex >= 0 ? Math.floor(turnIndex) : 0);
    const dir = join(THINKING_OUTPUT_BASE_DIR, a, sid, tid);
    const metaPath = join(dir, 'meta.json');
    const txtPath = join(dir, 'thinking.txt');

    let meta = null;
    try { if (existsSync(metaPath)) { const raw = readFileSync(metaPath, 'utf-8'); if (raw) meta = JSON.parse(raw); } } catch {}

    let thinking = '';
    try { if (existsSync(txtPath)) thinking = readFileSync(txtPath, 'utf-8') || ''; } catch {}

    const truncated = !!(meta && meta.truncated);
    return { meta: meta || null, thinking: thinking || '', truncated };
  } catch { return { meta: null, thinking: '', truncated: false }; }
}

