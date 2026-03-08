import http from 'node:http';
import { readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { existsSync, statSync, realpathSync, readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createArcanaSession } from '../src/session.js';
import { eventBus, runWithContext } from '../src/event-bus.js';
import { parseFrontmatter, parseSkillBlock } from '@mariozechner/pi-coding-agent';
import { resolveWorkspaceRoot, ensureReadAllowed, ensureWriteAllowed, resetWorkspaceRootCache } from '../src/workspace-guard.js';
import { runDoctor } from '../src/doctor.js';
import { createSupportBundle } from '../src/support-bundle.js';
import { loadArcanaConfig, loadAgentConfig } from '../src/config.js';
import { loadArcanaSkills } from '../src/skills.js';
import {
  createSession as ssCreate,
  listSessions as ssList,
  loadSession as ssLoad,
  appendMessage as ssAppend,
  deleteSession as ssDelete,
  buildHistoryPreludeText as ssPrelude,
  saveSession as ssSave,
} from '../src/sessions-store.js';
import { arcanaHomePath, ensureArcanaHomeDir } from '../src/arcana-home.js';
import { loadAgentTemplate } from '../src/agent-templates.js';
import { 
  loadCronSettings as cronLoadSettings, saveCronSettings as cronSaveSettings, acquireSessionTurnLock, releaseSessionTurnLock } from '../src/cron/store.js';
// Tier1 memory triggers (direct daily append)


import { detectProblemMention, detectCorrectionMention, truncateText } from '../src/memory-triggers.js';
const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..'); // arcana/
let workspaceRoot = null; // set on start

const DEFAULT_AGENT_ID = 'default';

// On-disk cache for tool outputs (meta/result/stream logs)
const TOOL_OUTPUT_BASE_DIR = join(projectRoot, '.cache', 'tool-output');

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

async function persistToolMetaToDisk({ agentId, sessionId, toolCallId, toolName, args }){
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

async function persistToolResultToDisk({ agentId, sessionId, event }){
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

function scheduleAppendToolStream({ agentId, sessionId, toolCallId, stream, chunk }){
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

function readStreamLogTail(agentId, sessionId, toolCallId, tailBytes){
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

// Feature flags for automatic memory writes
function envFlagEnabled(name){
  try {
    const v = String(process.env[name] || '').trim().toLowerCase();
    if (!v) return false;
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } catch { return false; }
}

const MEMORY_TRIGGERS_ENABLED = envFlagEnabled('ARCANA_MEMORY_TRIGGERS');
function envFlagDefaultTrue(name){
  try {
    const v = String(process.env[name] || '').trim().toLowerCase();
    if (!v) return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    return true;
  } catch { return true; }
}

const MEMORY_FLUSH_ENABLED = envFlagDefaultTrue('ARCANA_MEMORY_FLUSH');
function mergeAgentConfig(globalCfg, agentCfg){
  const base = (globalCfg && typeof globalCfg === 'object') ? { ...globalCfg } : {};
  const agent = (agentCfg && typeof agentCfg === 'object') ? agentCfg : null;
  if (agent){
    for (const [k, vRaw] of Object.entries(agent)){
      if (k === 'path') continue;
      const v = vRaw;
      if (v == null) continue;
      if (typeof v === 'string'){
        if (v.trim() === '') continue;
      }
      base[k] = v;
    }
    if (agent.path) base.path = agent.path;
  }
  return base;
}

function expandHomeDirPath(input){
  if (!input) return input;
  const s = String(input);
  if (s === '~'){
    try { return os.homedir(); } catch { return s; }
  }
  if (s.startsWith('~/') || s.startsWith('~\\')){
    try {
      const home = os.homedir && os.homedir();
      if (home) return join(home, s.slice(2));
    } catch {
      // ignore
    }
  }
  return s;
}

function safeRealpath(p){
  const s = String(p || '').trim();
  if (!s) return '';
  try { return realpathSync(s); } catch { return s; }
}

function nowIso(){
  try { return new Date().toISOString(); } catch { return String(new Date()); }
}

// Load a snapshot of all agents under ~/.arcana/agents/<agentId>/agent.json.
function loadAgentsSnapshot(){
  ensureArcanaHomeDir();
  const agentsDir = arcanaHomePath('agents');
  let entries = [];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return { agentsDir, agents: [] };
  }
  const agents = [];
  for (const entry of entries){
    try {
      if (!entry || typeof entry.name !== 'string') continue;
      const isDir = entry.isDirectory ? entry.isDirectory() : true;
      if (!isDir) continue;
      const dirId = entry.name;
      const agentDirRaw = join(agentsDir, dirId);
      const metaPath = join(agentDirRaw, 'agent.json');
      let metaStat;
      try { metaStat = statSync(metaPath); } catch { continue; }
      if (!metaStat || !metaStat.isFile()) continue;
      const agentHomeDir = safeRealpath(agentDirRaw);
      let meta = null;
      try {
        const raw = readFileSync(metaPath, 'utf-8');
        if (raw) meta = JSON.parse(raw);
      } catch {}
      let agentId = dirId;
      try {
        const idFromFile = meta && meta.agentId ? String(meta.agentId || '').trim() : '';
        if (idFromFile) agentId = idFromFile;
      } catch {}
      let workspaceRoot = '';
      try {
        const rawWs = meta && (meta.workspaceRoot || meta.workspaceDir || '');
        if (rawWs) workspaceRoot = safeRealpath(expandHomeDirPath(rawWs));
      } catch {}
      let createdAt = '';
      if (meta && typeof meta.createdAt === 'string' && meta.createdAt.trim()){
        createdAt = meta.createdAt.trim();
      }
      if (!createdAt){
        const ts = metaStat.birthtimeMs || metaStat.ctimeMs || metaStat.mtimeMs || Date.now();
        try { createdAt = new Date(ts).toISOString(); } catch { createdAt = nowIso(); }
      }
      agents.push({ agentId, agentDir: agentHomeDir, agentHomeDir, workspaceRoot, createdAt });
    } catch {
      // ignore entry-level errors
    }
  }
  agents.sort((a, b) => {
    const aT = String(a.createdAt || '');
    const bT = String(b.createdAt || '');
    if (!aT && !bT) return String(a.agentId || '').localeCompare(String(b.agentId || ''));
    if (!aT) return 1;
    if (!bT) return -1;
    return aT.localeCompare(bT);
  });
  return { agentsDir, agents };
  }
function normalizeAgentId(raw){
  const s = String(raw || '').trim();
  return s || DEFAULT_AGENT_ID;
}

function findAgentMeta(agentId){
  const id = normalizeAgentId(agentId);
  const snap = loadAgentsSnapshot();
  const agents = Array.isArray(snap && snap.agents) ? snap.agents : [];
  for (const a of agents){
    const cur = String(a && a.agentId || '').trim();
    if (cur === id) return a;
  }
  return null;
}

function seedAgentHomeBootstrap(agentHomeDir, agentId){
  const safeId = normalizeAgentId(agentId);
  function writeIfMissing(name, content){
    const p = join(agentHomeDir, name);
    try {
      if (existsSync(p)) return;
      mkdirSync(agentHomeDir, { recursive: true });
      writeFileSync(p, content, 'utf-8');
    } catch {}
  }
  function loadTemplateOrFallback(name, fallback){
    try {
      const tpl = loadAgentTemplate(name);
      if (tpl && String(tpl).trim()) return tpl;
    } catch {}
    return typeof fallback === 'function' ? fallback() : String(fallback || '');
  }
  writeIfMissing('AGENTS.md', loadTemplateOrFallback('AGENTS.md', () => (
    '# Agent Home\n\n' +
    'This directory belongs to agent "' + safeId + '".\n' +
    'Use this file for agent-level rules, routing notes, and shared context.\n'
  )));
  writeIfMissing('MEMORY.md',
    '# MEMORY\n\n' +
    'Use this file to capture long-term notes, decisions, and links for agent "' + safeId + '".\n'
  );
  writeIfMissing('SOUL.md', loadTemplateOrFallback('SOUL.md', () => (
    '# SOUL.md - Who You Are\n\n' +
    'Describe the persona, tone, and boundaries for this agent.\n'
  )));
  writeIfMissing('USER.md', loadTemplateOrFallback('USER.md', () => (
    '# USER.md - Who I Am\n\n' +
    'Describe the primary user or team this agent serves, plus preferences and constraints.\n'
  )));
  writeIfMissing('TOOLS.md', loadTemplateOrFallback('TOOLS.md', () => (
    '# TOOLS.md - Tools and Capabilities\n\n' +
    'List important tools, APIs, and workflows this agent should know about.\n'
  )));
  writeIfMissing('IDENTITY.md', loadTemplateOrFallback('IDENTITY.md', () => (
    '# IDENTITY.md - Who Am I?\n'
  )));
  writeIfMissing('HEARTBEAT.md', loadTemplateOrFallback('HEARTBEAT.md', () => (
    '# HEARTBEAT.md\n'
  )));
  writeIfMissing('BOOTSTRAP.md', loadTemplateOrFallback('BOOTSTRAP.md', () => (
    '# BOOTSTRAP.md - Hello, World\n'
  )));

  const memDir = join(agentHomeDir, 'memory');
  const skillsDir = join(agentHomeDir, 'skills');
  const agentsSkillsDir = join(agentHomeDir, '.agents', 'skills');
  try { mkdirSync(memDir, { recursive: true }); } catch {}
  try { mkdirSync(skillsDir, { recursive: true }); } catch {}
  try { mkdirSync(agentsSkillsDir, { recursive: true }); } catch {}

  const servicesIniPath = join(agentHomeDir, 'services.ini');
  if (!existsSync(servicesIniPath)) {
    const servicesIniLines = [
      '; Arcana services configuration',
      '; Each section [serviceId] defines an auto-starting service.',
      ';',
      '; Example Feishu WebSocket bridge service:',
      ';',
      '; [feishu]',
      '; command = node $ARCANA_PKG_ROOT/skills/feishu/scripts/feishu-bridge.mjs',
      '; env.FEISHU_APP_ID = your-app-id',
      '; env.FEISHU_APP_SECRET = your-app-secret',
      '; env.FEISHU_DOMAIN = feishu',
      '',
    ];
    try { writeFileSync(servicesIniPath, servicesIniLines.join('\n'), 'utf-8'); } catch {}
  }
}

function copyDirRecursive(src, dst){
  try {
    const st = statSync(src);
    if (!st || !st.isDirectory()) return;
  } catch { return; }
  try { mkdirSync(dst, { recursive: true }); } catch {}
  let entries = [];
  try { entries = readdirSync(src, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries){
    try {
      if (!entry || typeof entry.name !== 'string') continue;
      const from = join(src, entry.name);
      const to = join(dst, entry.name);
      const isDir = entry.isDirectory ? entry.isDirectory() : false;
      if (isDir) {
        copyDirRecursive(from, to);
      } else {
        const isFile = entry.isFile ? entry.isFile() : true;
        if (isFile && !existsSync(to)) copyFileSync(from, to);
      }
    } catch {}
  }
}

function ensureDefaultAgentExists(){
  ensureArcanaHomeDir();
  const agentsBase = arcanaHomePath('agents');
  try { mkdirSync(agentsBase, { recursive: true }); } catch {}

  const agentHomeDir = arcanaHomePath('agents', DEFAULT_AGENT_ID);

  // One-time bootstrap: if "default" is missing, clone the newest existing agent home (if any).
  try {
    if (!existsSync(agentHomeDir)) {
      const snap = loadAgentsSnapshot();
      const agents = Array.isArray(snap && snap.agents) ? snap.agents : [];
      let latest = null;
      for (const a of agents){
        if (!a) continue;
        const id = String(a.agentId || '').trim();
        if (!id || id === DEFAULT_AGENT_ID) continue;
        if (!latest) latest = a;
        else {
          const cur = String(a.createdAt || '');
          const prev = String(latest.createdAt || '');
          if (cur && (!prev || cur.localeCompare(prev) > 0)) {
            latest = a;
          }
        }
      }
      if (latest && latest.agentHomeDir && existsSync(latest.agentHomeDir)) {
        copyDirRecursive(latest.agentHomeDir, agentHomeDir);
        const agentJsonPath = join(agentHomeDir, 'agent.json');
        let meta = null;
        try {
          if (existsSync(agentJsonPath)) {
            const raw = readFileSync(agentJsonPath, 'utf-8');
            meta = raw ? JSON.parse(raw) : null;
          }
        } catch { meta = null; }
        if (!meta || typeof meta !== 'object') meta = {};
        meta.agentId = DEFAULT_AGENT_ID;
        try { writeFileSync(agentJsonPath, JSON.stringify(meta, null, 2), 'utf-8'); } catch {}
      }
    }
  } catch {}

  let meta = findAgentMeta(DEFAULT_AGENT_ID);
  if (meta && meta.workspaceRoot && existsSync(meta.workspaceRoot)) return meta;

  let ws = String(process.env.ARCANA_WORKSPACE || '').trim();
  if (!ws) {
    try {
      const cfg = loadArcanaConfig();
      const cand = cfg?.workspace_root || cfg?.workspaceRoot || cfg?.workspace_dir || cfg?.workspaceDir;
      if (cand) ws = expandHomeDirPath(cand);
    } catch {}
  }
  if (!ws) ws = process.cwd();
  try { mkdirSync(ws, { recursive: true }); } catch {}
  try { mkdirSync(join(ws, 'artifacts'), { recursive: true }); } catch {}

  try { mkdirSync(agentHomeDir, { recursive: true }); } catch {}
  const agentJsonPath = join(agentHomeDir, 'agent.json');
  let metaObj = null;
  try {
    if (existsSync(agentJsonPath)) {
      const raw = readFileSync(agentJsonPath, 'utf-8');
      metaObj = raw ? JSON.parse(raw) : null;
    }
  } catch { metaObj = null; }
  if (!metaObj || typeof metaObj !== 'object') metaObj = {};
  metaObj.agentId = DEFAULT_AGENT_ID;
  metaObj.workspaceRoot = safeRealpath(expandHomeDirPath(ws));
  if (!metaObj.createdAt) metaObj.createdAt = nowIso();
  try { writeFileSync(agentJsonPath, JSON.stringify(metaObj, null, 2), 'utf-8'); } catch {}
  seedAgentHomeBootstrap(agentHomeDir, DEFAULT_AGENT_ID);
  meta = findAgentMeta(DEFAULT_AGENT_ID) || {
    agentId: DEFAULT_AGENT_ID,
    agentDir: agentHomeDir,
    agentHomeDir,
    workspaceRoot: metaObj.workspaceRoot,
    createdAt: metaObj.createdAt,
  };
  return meta;
}

function resolveSessionContext(sessionId, explicitAgentId){
  const sid = String(sessionId || '').trim();
  const rawAgentId = explicitAgentId || DEFAULT_AGENT_ID;
  const agentId = normalizeAgentId(rawAgentId);
  const obj = sid ? ssLoad(sid, { agentId }) : null;
  const agent = findAgentMeta(agentId) || ensureDefaultAgentExists();
  const ws = agent && agent.workspaceRoot ? agent.workspaceRoot : workspaceRoot;
  const agentHomeDir = agent && agent.agentHomeDir ? agent.agentHomeDir : arcanaHomePath('agents', agentId);
  return { session: obj, agent, agentId, agentHomeDir, workspaceRoot: ws };
}


// Per-policy system sessions used for shared agent context
const sessionsByPolicy = new Map();
let pluginFiles = [];
let toolNames = [];
let model;
let skillNames = [];

// Apply execution policy to a session by toggling active tools.
// - Always enable safe read-only tools: read, grep, find, ls
// - Enable bash only when policy === "open"
// - Preserve any currently active custom/extension tools
function applyExecPolicyToSession(sess, policy) {
  try {
    const desired = new Set(sess.getActiveToolNames?.() || []);
    ['read','grep','find','ls'].forEach((t) => desired.add(t));
    if (String(policy || '').toLowerCase() === 'open') desired.add('bash');
    else desired.delete('bash');
    const list = Array.from(desired);
    sess.setActiveToolsByName?.(list);
    // Keep a copy for diagnostics broadcast on new SSE connections
    toolNames = list;
  } catch {}
}


// Per-session (id+policy+cwd) sessions used by /api/chat2

// Internal reflection sessions (per workspace)
// Tier1 trigger dedupe (per workspace/session) — keep small TTL; best effort
const DEDUPE_TRIGGER_TTL_MS = 10*60*1000; // 10 minutes
const dedupeUserIssue = new Map(); // key -> lastSeenMs
const dedupeUserCorrection = new Map(); // key -> lastSeenMs
const dedupeToolFail = new Map(); // key -> lastSeenMs
const chatSessions = new Map();
const bridgedById = new WeakSet();
// Map sessionId -> Map(skillName -> toolNames[])
const skillToolMapById = new Map();
// For legacy policy sessions (no id), keep last mapping per policy
const policySkillToolMap = new Map(); // key: 'open'|'restricted' -> Map(skill->tools)

// Per-session state for event aggregation
const mediaRefsByTurn = new Map(); // sessionId -> Set(ref)
const toolRepeatById = new Map(); // sessionId -> Map(key -> count)
const thinkStatsById = new Map(); // sessionId -> { startedAt, chars }

const sessionUsageTotalsById = new Map(); // sessionId -> totalTokens
const sessionTokensPendingByKey = new Map(); // key(agentId|sessionId) -> tokens
const sessionTokensPersistTimers = new Map(); // key -> timeout id
const SESSION_TOKENS_PERSIST_DEBOUNCE_MS = 500;
function keyForSession(agentId, sessionId){
  try {
    const sid = String(sessionId || 'default');
    const aid = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    return aid + '|' + sid;
  } catch { return String(sessionId || 'default'); }
}
function schedulePersistSessionTokens({ agentId, sessionId, tokens }){
  try {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const tNum = Number(tokens);
    if (!Number.isFinite(tNum) || tNum < 0) return;
    const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const key = keyForSession(effectiveAgentId, sid);
    sessionTokensPendingByKey.set(key, tNum);
    const existing = sessionTokensPersistTimers.get(key);
    if (existing){ try { clearTimeout(existing); } catch {} }
    const handle = setTimeout(()=>{
      try {
        sessionTokensPersistTimers.delete(key);
        const latest = sessionTokensPendingByKey.get(key);
        sessionTokensPendingByKey.delete(key);
        const latestNum = Number(latest);
        if (!Number.isFinite(latestNum) || latestNum < 0) return;
        const obj = ssLoad(sid, { agentId: effectiveAgentId }) || null;
        if (!obj || typeof obj !== 'object') return;
        obj.sessionTokens = latestNum;
        try { ssSave(obj, { agentId: effectiveAgentId }); } catch {}
      } catch {}
    }, SESSION_TOKENS_PERSIST_DEBOUNCE_MS);
    try { if (handle && typeof handle.unref === 'function') handle.unref(); } catch {}
    sessionTokensPersistTimers.set(key, handle);
  } catch {}
}
function initSessionUsageFromStore({ agentId, sessionId }){
  try {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const sidKey = String(sessionId || 'default');
    if (sessionUsageTotalsById.has(sidKey)) return;
    const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const obj = ssLoad(sid, { agentId: effectiveAgentId }) || null;
    if (!obj || typeof obj !== 'object') return;
    const raw = obj.sessionTokens;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) return;
    sessionUsageTotalsById.set(sidKey, num);
  } catch {}
}
// Context overflow detection (similar to pi-ai patterns)
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /^4(00|13)\s*(status code)?\s*\(no body\)/i,
];

function isContextOverflowErrorMessage(msg){
  try {
    const s = String(msg || '').trim();
    if (!s) return false;
    for (const p of CONTEXT_OVERFLOW_PATTERNS){
      if (p.test(s)) return true;
    }
    return false;
  } catch { return false; }
}

// History compaction state (per workspace + agent)
const historyCompressionSessionsByKey = new Map(); // key: agentId|ws -> session
const memoryFlushSessionsByKey = new Map(); // key: agentId|ws -> session
const HISTORY_COMPACT_KEEP_RECENT_MESSAGES = 40;
const HISTORY_COMPACT_SUMMARY_CHAR_BUDGET = 20000;

async function ensureHistoryCompressionSession(ws, agentId, agentHomeDir){
  try {
    const w = String(ws || workspaceRoot || '');
    const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const key = effectiveAgentId + '|' + w;
    if (historyCompressionSessionsByKey.has(key)) return historyCompressionSessionsByKey.get(key);
    const created = await createArcanaSession({ workspaceRoot: w, agentHomeRoot: agentHomeDir, execPolicy: 'restricted' });
    const sess = created.session;
    try { sess.setActiveToolsByName?.([]); } catch {}
    historyCompressionSessionsByKey.set(key, sess);
    return sess;
  } catch { return null; }
}

async function ensureMemoryFlushSession(ws, agentId, agentHomeDir){
  try {
    const w = String(ws || workspaceRoot || '');
    const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const key = effectiveAgentId + '|' + w;
    if (memoryFlushSessionsByKey.has(key)) return memoryFlushSessionsByKey.get(key);
    const created = await createArcanaSession({ workspaceRoot: w, agentHomeRoot: agentHomeDir, execPolicy: 'restricted' });
    const sess = created.session;
    try { sess.setActiveToolsByName?.(['memory_search','memory_get','memory_write','memory_edit']); } catch {}
    memoryFlushSessionsByKey.set(key, sess);
    return sess;
  } catch { return null; }
}

async function summarizeOlderMessagesForCompaction({ ws, agentId, agentHomeDir, sessionId, olderMessages }){
  try {
    const w = String(ws || workspaceRoot || '');
    const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    let finalSummaryText = '';
    await runWithContext({ sessionId, agentId: effectiveAgentId, agentHomeRoot: agentHomeDir, workspaceRoot: w }, async () => {
      const sess = await ensureHistoryCompressionSession(w, effectiveAgentId, agentHomeDir);
      if (!sess) return;
      const allMessages = Array.isArray(olderMessages) ? olderMessages : [];
      if (!allMessages.length) return;

      const maxSegmentChars = HISTORY_COMPACT_SUMMARY_CHAR_BUDGET > 0 ? HISTORY_COMPACT_SUMMARY_CHAR_BUDGET : 20000;
      const segments = [];
      let currentSegment = [];
      for (const m of allMessages){
        const tentative = currentSegment.concat(m);
        let text = '';
        try {
          const obj = { messages: tentative };
          text = ssPrelude(obj) || '';
        } catch {
          text = '';
        }
        if (text && text.length > maxSegmentChars && currentSegment.length){
          segments.push(currentSegment);
          currentSegment = [m];
        } else {
          currentSegment = tentative;
        }
      }
      if (currentSegment.length) segments.push(currentSegment);
      if (!segments.length) return;

      const segmentSummaries = [];
      let latestSummaryText = '';
      const unsub = sess.subscribe((ev) => {
        try {
          if (ev && ev.type === 'message_end' && ev.message && ev.message.role === 'assistant'){
            const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
            const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
            if (text) latestSummaryText = text;
          }
        } catch {}
      });

      try {
        for (const segment of segments){
          try { await sess.newSession?.(); } catch {}
          const historyObj = { messages: segment };
          const historyText = ssPrelude(historyObj) || '';
          if (!historyText) continue;
          let prompt = 'You are compressing earlier chat messages to save tokens.\n';
          prompt += 'Produce a concise summary capturing important context, decisions, and facts.\n';
          prompt += 'Do not include instructions for the assistant, only what happened.\n';
          prompt += 'Write the summary as plain text paragraphs.\n\n';
          prompt += 'Messages to summarize:\n';
          prompt += historyText + '\n\n';
          try { await sess.prompt(prompt); } catch {}
          const segSummary = String(latestSummaryText || '').trim();
          if (segSummary) segmentSummaries.push(segSummary);
          latestSummaryText = '';
        }

        if (!segmentSummaries.length) return;

        if (segmentSummaries.length === 1){
          finalSummaryText = segmentSummaries[0];
        } else {
          try { await sess.newSession?.(); } catch {}
          let mergePrompt = 'You are compressing earlier chat messages to save tokens.\n';
          mergePrompt += 'You will be given summaries of several segments of a longer conversation.\n';
          mergePrompt += 'Merge them into a single concise summary capturing important context, decisions, and facts.\n';
          mergePrompt += 'Do not include instructions for the assistant, only what happened.\n';
          mergePrompt += 'Write the summary as plain text paragraphs.\n\n';
          mergePrompt += 'Segment summaries:\n';
          mergePrompt += segmentSummaries.map((s, idx) => 'Segment ' + String(idx + 1) + ':\n' + s + '\n').join('\n');
          try { await sess.prompt(mergePrompt); } catch {}
          const mergedSummary = String(latestSummaryText || '').trim();
          finalSummaryText = mergedSummary || segmentSummaries.join('\n\n');
        }
      } finally {
        try { unsub && unsub(); } catch {}
      }
    });
    const final = String(finalSummaryText || '').trim();
    return final;
  } catch {
    return '';
  }
}

async function runPreCompactionMemoryFlush({ ws, agentId, agentHomeDir, sessionId, summaryText, recentMessages }){
  if (!MEMORY_FLUSH_ENABLED) return;
  try {
    const w = String(ws || workspaceRoot || '');
    const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const summary = String(summaryText || '').trim();
    const recent = Array.isArray(recentMessages) ? recentMessages : [];
    if (!summary && !recent.length) return;
    await runWithContext({ sessionId, agentId: effectiveAgentId, agentHomeRoot: agentHomeDir, workspaceRoot: w }, async () => {
      const sess = await ensureMemoryFlushSession(w, effectiveAgentId, agentHomeDir);
      if (!sess) return;
      try { await sess.newSession?.(); } catch {}
      let recentExcerpt = '';
      try {
        if (recent.length){
          const obj = { messages: recent };
          recentExcerpt = ssPrelude(obj) || '';
          const maxChars = 4000;
          if (recentExcerpt && recentExcerpt.length > maxChars) recentExcerpt = recentExcerpt.slice(0, maxChars);
        }
      } catch {}
      let ts = '';
      try {
        const now = new Date();
        ts = now.toISOString();
      } catch {
        try { ts = String(new Date()); } catch { ts = ''; }
      }
      let prompt = '';
      prompt += 'You are managing durable long-term memory for this agent.\n';
      prompt += 'Before older conversation history is compacted, review the summary and recent messages below.\n';
      prompt += 'Decide what should be written to persistent memory so future sessions can benefit.\n';
      prompt += 'You may only write to MEMORY.md and memory/*.md under the agent home, using the tools memory_write and memory_edit.\n';
      prompt += 'Prefer appending raw notes to a daily file under memory/YYYY-MM-DD.md and keeping concise summaries in MEMORY.md.\n';
      prompt += 'Do not write to any other files.\n\n';
      if (ts) {
        prompt += 'Current local timestamp: ' + ts + '\n\n';
      }
      if (summary) {
        prompt += '[Summary of older messages]\n';
        prompt += summary + '\n\n';
      }
      if (recentExcerpt) {
        prompt += '[Recent messages excerpt]\n';
        prompt += recentExcerpt + '\n\n';
      }
      prompt += 'Think briefly, then call memory_write/memory_edit tools to update memory as needed.\n';
      try { await sess.prompt(prompt); } catch {}
    });
  } catch {}
}

async function compactSessionHistoryOnOverflow({ sessionId, agentId, ws, agentHomeDir }){
  const sid = String(sessionId || '').trim();
  const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
  if (!sid) return { compacted: false };
  try {
    let obj = ssLoad(sid, { agentId: effectiveAgentId });
    const msgs = (obj && Array.isArray(obj.messages)) ? obj.messages : [];
    if (!msgs.length) return { compacted: false };
    const keep = HISTORY_COMPACT_KEEP_RECENT_MESSAGES > 0 ? HISTORY_COMPACT_KEEP_RECENT_MESSAGES : 40;
    if (msgs.length <= keep) return { compacted: false };
    const splitIndex = msgs.length - keep;
    const older = msgs.slice(0, splitIndex);
    const recent = msgs.slice(splitIndex);
    try { broadcast({ type: 'history_compact_start', sessionId: sid, agentId: effectiveAgentId, keepRecentMessages: keep }); } catch {}
    const summary = await summarizeOlderMessagesForCompaction({ ws, agentId: effectiveAgentId, agentHomeDir, sessionId: sid, olderMessages: older });
    const text = String(summary || '').trim();
    if (!text) {
      try { broadcast({ type: 'history_compact_end', sessionId: sid, agentId: effectiveAgentId, keepRecentMessages: keep, compacted: false }); } catch {}
      return { compacted: false };
    }
    try {
      await runPreCompactionMemoryFlush({ ws, agentId: effectiveAgentId, agentHomeDir, sessionId: sid, summaryText: text, recentMessages: recent });
    } catch {}
    const summaryMessage = { role: 'assistant', text: '[Conversation Summary] ' + text, ts: nowIso() };
    obj = ssLoad(sid, { agentId: effectiveAgentId }) || obj || { id: sid, agentId: effectiveAgentId, messages: [] };
    const curMsgs = Array.isArray(obj.messages) ? obj.messages : [];
    const nextMsgs = [summaryMessage, ...recent];
    obj.messages = nextMsgs;
    try { ssSave(obj, { agentId: effectiveAgentId }); } catch {}
    try { broadcast({ type: 'history_compact_end', sessionId: sid, agentId: effectiveAgentId, keepRecentMessages: keep, compacted: true }); } catch {}
    return { compacted: true };
  } catch {
    try { broadcast({ type: 'history_compact_end', sessionId: sid, agentId: effectiveAgentId, keepRecentMessages: HISTORY_COMPACT_KEEP_RECENT_MESSAGES, compacted: false }); } catch {}
    return { compacted: false };
  }
}

// Global state used by the legacy SSE bridge
const legacyMediaRefsByTurn = new Set();
const bridgedSessions = new WeakSet();
const toolRepeat = new Map();
let thinkStats = null;

// SSE clients
const clients = new Set(); // Response objects
const sseClientMeta = new WeakMap(); // res -> { paused, drainHooked, queue, queuedBytes, includeToolStream, toolStreamSessionId }
let subagentHooked = false;

const SSE_SKIP_RAW_TYPES = new Set([
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'turn_start',
  'turn_end',
  'thinking_start',
  'thinking_delta',
  'thinking_end',
]);

function readIntEnv(name, fallback){
  try {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  } catch { return fallback; }
}

const SSE_MAX_QUEUE_EVENTS = readIntEnv('ARCANA_SSE_MAX_QUEUE_EVENTS', 500);
const SSE_MAX_QUEUE_BYTES = readIntEnv('ARCANA_SSE_MAX_QUEUE_BYTES', 1000000);

function getSseMeta(res){
  let meta = sseClientMeta.get(res);
  if (!meta){
    meta = { paused: false, drainHooked: false, queue: [], queuedBytes: 0, includeToolStream: false, toolStreamSessionId: '' };
    sseClientMeta.set(res, meta);
  }
  return meta;
}

function enqueueSseChunk(meta, chunk){
  try {
    const size = Buffer.byteLength(chunk);
    meta.queue.push(chunk);
    meta.queuedBytes += size;
    while (meta.queue.length > SSE_MAX_QUEUE_EVENTS || meta.queuedBytes > SSE_MAX_QUEUE_BYTES){
      const dropped = meta.queue.shift();
      if (dropped != null) meta.queuedBytes -= Buffer.byteLength(dropped);
    }
  } catch {}
}

function hookSseDrain(res, meta){
  if (meta.drainHooked) return;
  meta.drainHooked = true;
  try {
    res.on('drain', () => {
      const curMeta = sseClientMeta.get(res);
      if (!curMeta) return;
      curMeta.paused = false;
      try {
        while (curMeta.queue.length){
          const chunk = curMeta.queue.shift();
          if (chunk == null) continue;
          curMeta.queuedBytes -= Buffer.byteLength(chunk);
          const ok = res.write(chunk);
          if (!ok){
            curMeta.paused = true;
            break;
          }
        }
      } catch {}
    });
  } catch {}
}

// Env vault: runtime env setter + on-disk vault
function isValidEnvName(n){
  try {
    const s = String(n || '');
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  } catch { return false; }
}

// --- On-disk vault state + helpers ---
const VAULT_PATH = arcanaHomePath('vault.json');
// Public-ish meta exposed via /api/env.vault
const vaultInfo = {
  path: VAULT_PATH,
  hasFile: false,
  encrypted: false,
  locked: false,
  names: new Set(), // env var names stored in vault
};
// In-memory decrypted values (only when unlocked/plain)
let vaultValues = {};

function vaultMetaForResponse(){
  try {
    return {
      path: String(vaultInfo.path || ''),
      hasFile: !!vaultInfo.hasFile,
      encrypted: !!vaultInfo.encrypted,
      locked: !!vaultInfo.locked,
      names: Array.from(vaultInfo.names || []),
    };
  } catch {
    return {
      path: String(VAULT_PATH || ''),
      hasFile: false,
      encrypted: false,
      locked: false,
      names: [],
    };
  }
}

function pad2(n){ return String(n).padStart(2, '0'); }
function localParts(d = new Date()){
  return {
    Y: d.getFullYear(),
    M: pad2(d.getMonth() + 1),
    D: pad2(d.getDate()),
    h: pad2(d.getHours()),
    m: pad2(d.getMinutes()),
  };
}

function agentDailyMemoryPath(agentHomeDir, dateStr){
  const base = String(agentHomeDir || '').trim();
  if (!base) return '';
  let Y;
  let M;
  let D;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))){
    const parts = String(dateStr).split('-');
    Y = parts[0];
    M = parts[1];
    D = parts[2];
  } else {
    const p = localParts();
    Y = String(p.Y);
    M = p.M;
    D = p.D;
  }
  const memDir = join(base, 'memory');
  try { mkdirSync(memDir, { recursive: true }); } catch {}
  return join(memDir, Y + '-' + M + '-' + D + '.md');
}

function agentLongtermMemoryPath(agentHomeDir){
  const base = String(agentHomeDir || '').trim();
  if (!base) return '';
  try { mkdirSync(base, { recursive: true }); } catch {}
  return join(base, 'MEMORY.md');
}

function buildAgentMemoryBlock(kind, heading, content){
  const p = localParts();
  const stamp = p.Y + '-' + p.M + '-' + p.D + ' ' + p.h + ':' + p.m;
  const head = heading ? (' - ' + heading) : '';
  const label = kind === 'daily' ? (p.h + ':' + p.m) : stamp;
  const body = String(content || '').replace(/\s+$/, '');
  return '\n\n## ' + label + head + '\n\n' + body + '\n';
}

function appendToAgentDailyMemory({ agentHomeDir, heading, content, date }){
  try {
    const path = agentDailyMemoryPath(agentHomeDir, date);
    if (!path) return null;
    const block = buildAgentMemoryBlock('daily', heading, content);
    appendFileSync(path, block, { encoding: 'utf-8' });
    return { path, bytes: Buffer.byteLength(block, 'utf-8') };
  } catch {
    return null;
  }
}

function appendToAgentLongtermMemory({ agentHomeDir, heading, content }){
  try {
    const path = agentLongtermMemoryPath(agentHomeDir);
    if (!path) return null;
    const block = buildAgentMemoryBlock('longterm', heading, content);
    appendFileSync(path, block, { encoding: 'utf-8' });
    return { path, bytes: Buffer.byteLength(block, 'utf-8') };
  } catch {
    return null;
  }
}

function filterValid(obj){
  const out = {};
  try {
    for (const [k, v] of Object.entries(obj || {})){
      if (!isValidEnvName(k)) continue;
      out[k] = v == null ? '' : String(v);
    }
  } catch {}
  return out;
}

function applyEnvFrom(values){
  try {
    for (const [k, v] of Object.entries(filterValid(values))){
      process.env[k] = v == null ? '' : String(v);
    }
  } catch {}
}

// KDF + crypto helpers
function deriveVaultKey(passphrase, kdfParams){
  const base = kdfParams || {};
  const N = typeof base.N === 'number' ? base.N : 16384;
  const r = typeof base.r === 'number' ? base.r : 8;
  const p = typeof base.p === 'number' ? base.p : 1;
  const saltB64 = base.saltB64 || randomBytes(16).toString('base64');
  const salt = Buffer.from(String(saltB64), 'base64');
  const key = scryptSync(String(passphrase || ''), salt, 32, { N, r, p });
  return { key, kdf:{ saltB64, N, r, p } };
}

function encryptValues(values, passphrase){
  const { key, kdf } = deriveVaultKey(passphrase, null);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(filterValid(values)), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const names = Object.keys(filterValid(values));
  return {
    version: 1,
    encrypted: true,
    updatedAt: new Date().toISOString(),
    names,
    kdf,
    cipher: {
      alg: 'aes-256-gcm',
      ivB64: iv.toString('base64'),
      tagB64: tag.toString('base64'),
    },
    ciphertextB64: ciphertext.toString('base64'),
  };
}

function decryptValues(fileObj, passphrase){
  if (!fileObj || !fileObj.encrypted){
    return filterValid((fileObj && fileObj.values) || {});
  }
  const { key } = deriveVaultKey(passphrase, fileObj.kdf || {});
  const cipherMeta = fileObj.cipher || {};
  const ivB64 = cipherMeta.ivB64 || fileObj.ivB64 || fileObj.iv;
  const tagB64 = cipherMeta.tagB64 || fileObj.tagB64 || fileObj.tag;
  const ciphertextB64 = fileObj.ciphertextB64 || fileObj.ciphertext;
  const iv = Buffer.from(String(ivB64 || ''), 'base64');
  const tag = Buffer.from(String(tagB64 || ''), 'base64');
  const enc = Buffer.from(String(ciphertextB64 || ''), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  const obj = JSON.parse(out.toString('utf8') || '{}');
  return filterValid(obj && typeof obj === 'object' ? obj : {});
}

async function readVaultFile(){
  try {
    if (!existsSync(VAULT_PATH)) return null;
    const text = readFileSync(VAULT_PATH, 'utf8');
    if (!text) return null;
    const data = JSON.parse(text);
    const encrypted = !!data && !!data.encrypted;
    let names = [];
    if (Array.isArray(data.names)) names = data.names;
    else if (!encrypted && data && data.values && typeof data.values === 'object') names = Object.keys(data.values);
    names = names.filter((n) => isValidEnvName(n));
    return { data, encrypted, names };
  } catch { return null; }
}

async function writeVaultFile(obj){
  try { ensureArcanaHomeDir(); } catch {}
  const json = JSON.stringify(obj, null, 2);
  try {
    await writeFile(VAULT_PATH, json, { mode: 0o600 });
  } catch {
    await writeFile(VAULT_PATH, json);
  }
  try { await chmod(VAULT_PATH, 0o600); } catch {}
}

async function loadVaultFromDisk(){
  try {
    const file = await readVaultFile();
    if (!file){
      vaultInfo.hasFile = false;
      vaultInfo.encrypted = false;
      vaultInfo.locked = false;
      vaultInfo.names = new Set();
      vaultValues = {};
      return;
    }
    vaultInfo.hasFile = true;
    vaultInfo.encrypted = !!file.encrypted;
    vaultInfo.names = new Set(Array.isArray(file.names) ? file.names : []);
    if (!file.encrypted){
      const vals = filterValid((file.data && file.data.values) || {});
      vaultInfo.locked = false;
      vaultValues = vals;
      applyEnvFrom(vals);
      return;
    }
    const envPass = String(process.env.ARCANA_VAULT_PASSPHRASE || '').trim();
    if (!envPass){
      vaultInfo.locked = true;
      vaultValues = {};
      return;
    }
    try {
      const vals = decryptValues(file.data, envPass);
      vaultInfo.locked = false;
      vaultValues = vals;
      try {
        if (!vaultInfo.names || !(vaultInfo.names instanceof Set)){
          vaultInfo.names = new Set();
        }
        for (const n of Object.keys(vals || {})){
          if (isValidEnvName(n)) vaultInfo.names.add(n);
        }
      } catch {}
      applyEnvFrom(vals);
    } catch {
      vaultInfo.locked = true;
      vaultValues = {};
    }
  } catch {
    vaultInfo.hasFile = false;
    vaultInfo.encrypted = false;
    vaultInfo.locked = false;
    vaultInfo.names = new Set();
    vaultValues = {};
  }
}

const ERR_VAULT_LOCKED = 'VAULT_LOCKED';
const ERR_VAULT_BAD_PASSPHRASE = 'VAULT_BAD_PASSPHRASE';

async function persistVaultUpdate({ set, unset, passphrase }){
  try {
    const pass = String(passphrase || '').trim();
    const file = await readVaultFile();
    const wasEncrypted = !!(file && file.encrypted);
    let baseValues = {};

    if (!file){
      baseValues = {};
    } else if (!file.encrypted){
      baseValues = filterValid((file.data && file.data.values) || {});
    } else {
      if (!pass){
        const err = new Error('vault_locked');
        err.code = ERR_VAULT_LOCKED;
        throw err;
      }
      try {
        baseValues = decryptValues(file.data, pass);
      } catch {
        const err = new Error('vault_bad_passphrase');
        err.code = ERR_VAULT_BAD_PASSPHRASE;
        throw err;
      }
    }

    const cleanSet = filterValid(set || {});
    const cleanUnset = Array.isArray(unset) ? unset.filter((n) => isValidEnvName(n)) : [];
    for (const [k, v] of Object.entries(cleanSet)) baseValues[k] = v;
    for (const n of cleanUnset) { delete baseValues[n]; }

    const finalValues = filterValid(baseValues);
    const names = Object.keys(finalValues);
    const shouldEncrypt = !!pass || wasEncrypted;

    if (shouldEncrypt){
      if (!pass){
        const err = new Error('vault_locked');
        err.code = ERR_VAULT_LOCKED;
        throw err;
      }
      const obj = encryptValues(finalValues, pass);
      await writeVaultFile(obj);
      vaultInfo.hasFile = true;
      vaultInfo.encrypted = true;
      vaultInfo.locked = false;
      vaultInfo.names = new Set(names);
      vaultValues = finalValues;
      return;
    }

    const obj = {
      version: 1,
      encrypted: false,
      updatedAt: new Date().toISOString(),
      values: finalValues,
    };
    await writeVaultFile(obj);
    vaultInfo.hasFile = true;
    vaultInfo.encrypted = false;
    vaultInfo.locked = false;
    vaultInfo.names = new Set(names);
    vaultValues = finalValues;
  } catch (e) {
    if (e && (e.code === ERR_VAULT_LOCKED || e.code === ERR_VAULT_BAD_PASSPHRASE)){
      throw e;
    }
    throw e;
  }
}

function resolveAgentHomeDirForEnv(agentIdRaw){
  try {
    const id = normalizeAgentId(agentIdRaw);
    const meta = findAgentMeta(id) || (id === DEFAULT_AGENT_ID ? ensureDefaultAgentExists() : null);
    if (meta && (meta.agentHomeDir || meta.agentDir)) return meta.agentHomeDir || meta.agentDir;
    return arcanaHomePath('agents', id);
  } catch {
    return arcanaHomePath('agents', normalizeAgentId(agentIdRaw));
  }
}

function agentVaultPath(agentHomeDir){
  const base = String(agentHomeDir || '').trim();
  if (!base) return '';
  return join(base, 'vault.json');
}

async function readAgentVaultFile(agentHomeDir){
  try {
    const path = agentVaultPath(agentHomeDir);
    if (!path || !existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    if (!text) return { path, data: null, encrypted: false, names: [], inheritGlobal: true };
    const data = JSON.parse(text);
    const encrypted = !!data && !!data.encrypted;
    let names = [];
    if (Array.isArray(data.names)) names = data.names;
    else if (!encrypted && data && data.values && typeof data.values === 'object') names = Object.keys(data.values);
    names = names.filter((n) => isValidEnvName(n));
    const inheritGlobal = (typeof data.inheritGlobal === 'boolean') ? data.inheritGlobal : true;
    return { path, data, encrypted, names, inheritGlobal };
  } catch {
    return null;
  }
}

async function writeAgentVaultFile(agentHomeDir, obj){
  const base = String(agentHomeDir || '').trim();
  if (!base) return;
  try { mkdirSync(base, { recursive: true }); } catch {}
  const path = agentVaultPath(base);
  const json = JSON.stringify(obj, null, 2);
  try {
    await writeFile(path, json, { mode: 0o600 });
  } catch {
    await writeFile(path, json);
  }
  try { await chmod(path, 0o600); } catch {}
}

async function readAgentVaultState(agentHomeDir){
  const base = String(agentHomeDir || '').trim();
  const path = agentVaultPath(base);
  const emptyMeta = {
    path: path || '',
    hasFile: false,
    encrypted: false,
    locked: false,
    names: [],
    inheritGlobal: true,
  };
  try {
    const file = await readAgentVaultFile(base);
    if (!file || !file.data){
      const meta = { ...emptyMeta };
      if (file && file.path) meta.path = file.path;
      if (file) meta.hasFile = true;
      return { meta, values: {} };
    }
    const data = file.data;
    const encrypted = !!file.encrypted;
    const inheritGlobal = (typeof file.inheritGlobal === 'boolean') ? file.inheritGlobal : true;
    let names = Array.isArray(file.names) ? file.names : [];
    names = names.filter((n) => isValidEnvName(n));
    const meta = {
      path: file.path || path || '',
      hasFile: true,
      encrypted,
      locked: false,
      names,
      inheritGlobal,
    };

    let values = {};
    if (!encrypted){
      values = filterValid((data && data.values && typeof data.values === 'object') ? data.values : {});
      meta.locked = false;
      return { meta, values };
    }

    const envPass = String(process.env.ARCANA_VAULT_PASSPHRASE || '').trim();
    if (!envPass){
      meta.locked = true;
      return { meta, values: {} };
    }
    try {
      values = decryptValues(data, envPass);
      meta.locked = false;
      return { meta, values };
    } catch {
      meta.locked = true;
      return { meta, values: {} };
    }
  } catch {
    return { meta: emptyMeta, values: {} };
  }
}

async function persistAgentVaultUpdate({ agentHomeDir, set, unset, passphrase, inheritGlobal }){
  try {
    const pass = String(passphrase || '').trim();
    const file = await readAgentVaultFile(agentHomeDir);
    const wasEncrypted = !!(file && file.encrypted);
    const prevData = file && file.data;
    let baseValues = {};
    let inherit = (prevData && typeof prevData.inheritGlobal === 'boolean') ? prevData.inheritGlobal : true;

    if (typeof inheritGlobal === 'boolean') inherit = inheritGlobal;

    if (!file || !prevData){
      baseValues = {};
    } else if (!file.encrypted){
      baseValues = filterValid((prevData && prevData.values) || {});
    } else {
      if (!pass){
        const err = new Error('vault_locked');
        err.code = ERR_VAULT_LOCKED;
        throw err;
      }
      try {
        baseValues = decryptValues(prevData, pass);
      } catch {
        const err = new Error('vault_bad_passphrase');
        err.code = ERR_VAULT_BAD_PASSPHRASE;
        throw err;
      }
    }

    const cleanSet = filterValid(set || {});
    const cleanUnset = Array.isArray(unset) ? unset.filter((n) => isValidEnvName(n)) : [];
    for (const [k, v] of Object.entries(cleanSet)) baseValues[k] = v;
    for (const n of cleanUnset) { delete baseValues[n]; }

    const finalValues = filterValid(baseValues);
    const names = Object.keys(finalValues);
    const shouldEncrypt = !!pass || wasEncrypted;

    if (shouldEncrypt){
      if (!pass){
        const err = new Error('vault_locked');
        err.code = ERR_VAULT_LOCKED;
        throw err;
      }
      const obj = encryptValues(finalValues, pass);
      obj.inheritGlobal = inherit;
      await writeAgentVaultFile(agentHomeDir, obj);
      return {
        names,
        inheritGlobal: inherit,
        encrypted: true,
        locked: false,
      };
    }

    const obj = {
      version: 1,
      encrypted: false,
      updatedAt: new Date().toISOString(),
      inheritGlobal: inherit,
      values: finalValues,
    };
    await writeAgentVaultFile(agentHomeDir, obj);
    return {
      names,
      inheritGlobal: inherit,
      encrypted: false,
      locked: false,
    };
  } catch (e) {
    if (e && (e.code === ERR_VAULT_LOCKED || e.code === ERR_VAULT_BAD_PASSPHRASE)){
      throw e;
    }
    throw e;
  }
}

async function handleGetEnv(req, res){
  try {
    const url = new URL(req.url, 'http://localhost');
    const agentIdParam = String(url.searchParams.get('agentId') || '').trim();
    const agentId = agentIdParam || DEFAULT_AGENT_ID;
    const agentHomeDir = resolveAgentHomeDirForEnv(agentId);

    const globalVault = vaultMetaForResponse();
    const globalNames = Array.isArray(globalVault.names) ? globalVault.names : [];

    const { meta: agentVault, values: agentValues } = await readAgentVaultState(agentHomeDir);
    const agentNames = Array.isArray(agentVault.names) ? agentVault.names : [];
    const inheritEffective = agentVault.inheritGlobal !== false;

    const allNamesSet = new Set();
    for (const n of globalNames){ if (n) allNamesSet.add(String(n)); }
    for (const n of agentNames){ if (n) allNamesSet.add(String(n)); }
    const allNames = Array.from(allNamesSet);
    allNames.sort();

    const vars = allNames.map((name) => {
      const storedGlobal = globalNames.includes(name);
      const storedAgent = agentNames.includes(name);
      const scope = storedAgent ? 'agent' : (storedGlobal ? 'global' : '');
      let hasValue = false;
      if (storedAgent && !agentVault.locked){
        const v = agentValues && Object.prototype.hasOwnProperty.call(agentValues, name) ? agentValues[name] : undefined;
        if (v) hasValue = true;
      }
      if (!hasValue && inheritEffective && process.env[name]){
        hasValue = true;
      }
      return { name, storedGlobal, storedAgent, scope, hasValue };
    });

    const vault = {
      global: globalVault,
      agent: agentVault,
      inheritGlobal: inheritEffective,
    };

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ vars, vault }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'env_list_failed', message: e?.message || String(e) }));
  }
}

// Set/unset environment variables at runtime + persist to vault.
// Body shape: { agentId?: string, scope?: 'global'|'agent', set: { VAR: value, ... }, unset: [ 'VAR2', ... ], passphrase?: '...', inheritGlobal?: boolean }
async function handlePostEnv(req, res){
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const toSet = (body && body.set && typeof body.set === 'object') ? body.set : {};
    const toUnset = Array.isArray(body && body.unset) ? body.unset : [];
    const passphrase = String((body && body.passphrase) || process.env.ARCANA_VAULT_PASSPHRASE || '').trim();

    let agentId = '';
    try {
      if (body && Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null){
        agentId = String(body.agentId || '').trim();
      }
    } catch {}
    if (!agentId) agentId = DEFAULT_AGENT_ID;

    const scopeRaw = String((body && body.scope) || '').trim().toLowerCase();
    const scope = (scopeRaw === 'agent') ? 'agent' : 'global';
    const inheritGlobal = (body && typeof body.inheritGlobal === 'boolean') ? body.inheritGlobal : undefined;

    if (scope === 'global'){
      try {
        await persistVaultUpdate({ set: toSet, unset: toUnset, passphrase });
      } catch (e) {
        if (e && e.code === ERR_VAULT_LOCKED){
          res.writeHead(423, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'vault_locked', message: 'Vault is encrypted; provide passphrase.' }));
          return;
        }
        if (e && e.code === ERR_VAULT_BAD_PASSPHRASE){
          res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'vault_bad_passphrase' }));
          return;
        }
        throw e;
      }

      let touchedWorkspace = false;
      for (const [kRaw, vRaw] of Object.entries(toSet)){
        const k = String(kRaw || '').trim();
        if (!isValidEnvName(k)) continue;
        const v = vRaw == null ? '' : String(vRaw);
        process.env[k] = v;
        if (k === 'ARCANA_WORKSPACE') touchedWorkspace = true;
      }
      for (const nRaw of toUnset){
        const n = String(nRaw || '').trim();
        if (!isValidEnvName(n)) continue;
        try { delete process.env[n]; } catch {}
        if (n === 'ARCANA_WORKSPACE') touchedWorkspace = true;
      }

      if (touchedWorkspace){
        try { resetWorkspaceRootCache(); } catch {}
        workspaceRoot = resolveWorkspaceRoot();
        resetSessions();
        try { await ensurePolicySession('restricted'); } catch {}
      }
    } else {
      const agentHomeDir = resolveAgentHomeDirForEnv(agentId);
      try {
        await persistAgentVaultUpdate({ agentHomeDir, set: toSet, unset: toUnset, passphrase, inheritGlobal });
      } catch (e) {
        if (e && e.code === ERR_VAULT_LOCKED){
          res.writeHead(423, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'vault_locked', message: 'Vault is encrypted; provide passphrase.' }));
          return;
        }
        if (e && e.code === ERR_VAULT_BAD_PASSPHRASE){
          res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'vault_bad_passphrase' }));
          return;
        }
        throw e;
      }
    }

    try { broadcast({ type: 'env_refresh' }); } catch {}
    try {
      const modelLabel = model ? (model.provider + ':' + model.id + (model.baseUrl ? (' @ ' + model.baseUrl) : '')) : '<auto>';
      broadcast({ type: 'server_info', model: modelLabel, tools: toolNames, plugins: pluginFiles, workspace: workspaceRoot, skills: skillNames });
    } catch {}

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'env_update_failed', message: e?.message || String(e) }));
  }
}

async function ensurePolicySession(policy) {
  const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
  if (sessionsByPolicy.has(pol)) return sessionsByPolicy.get(pol);

  // Run policy sessions inside ALS context for the default agent so that
  // agentHomeRoot/workspaceRoot, memory, services, and persona all
  // resolve consistently.
  const defaultAgentMeta = ensureDefaultAgentExists();
  const agentId = DEFAULT_AGENT_ID;
  const ws = (defaultAgentMeta && defaultAgentMeta.workspaceRoot) ? defaultAgentMeta.workspaceRoot : (workspaceRoot || resolveWorkspaceRoot());
  const agentHomeDir = (defaultAgentMeta && defaultAgentMeta.agentHomeDir) ? defaultAgentMeta.agentHomeDir : arcanaHomePath('agents', agentId);

  const ctx = {
    sessionId: 'policy:' + pol,
    agentId,
    agentHomeRoot: agentHomeDir,
    workspaceRoot: ws,
  };

  const created = await runWithContext(ctx, () => createArcanaSession({ workspaceRoot: ws, agentHomeRoot: agentHomeDir, execPolicy: pol }));
  const sess = created.session;
  sessionsByPolicy.set(pol, sess);
  pluginFiles = created.pluginFiles || pluginFiles || [];
  toolNames = created.toolNames || toolNames || [];
  model = created.model || model || null;
  skillNames = created.skillNames || skillNames || [];
  try { if (created.skillToolMap) policySkillToolMap.set(pol, created.skillToolMap); } catch {}
  ensureEventBridge(sess);
  return sess;
}

async function ensureSessionFor(sessionId, policy, cwdForSession, agentId, agentHomeDir) {
  const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
  const ws = cwdForSession || workspaceRoot || '';
  const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
  const key = effectiveAgentId + '|' + String(sessionId || 'default') + '|' + pol + '|' + String(ws || '');
  if (chatSessions.has(key)) return chatSessions.get(key);

  const ctx = {
    sessionId: String(sessionId || 'default'),
    agentId: effectiveAgentId,
    agentHomeRoot: agentHomeDir || (findAgentMeta(effectiveAgentId)?.agentHomeDir || arcanaHomePath('agents', effectiveAgentId)),
    workspaceRoot: ws,
  };

  const created = await runWithContext(ctx, () => createArcanaSession({ workspaceRoot: ws, agentHomeRoot: agentHomeDir, execPolicy: pol }));
  const sess = created.session;
  chatSessions.set(key, sess);
  try {
    // Update globals for diagnostics (safe to overwrite; just for /api/events server_info)
    pluginFiles = created.pluginFiles || pluginFiles || [];
    toolNames = created.toolNames || toolNames || [];
    model = created.model || model || null;
    skillNames = created.skillNames || skillNames || [];
    if (created.skillToolMap) skillToolMapById.set(String(sessionId || 'default'), created.skillToolMap);
  } catch {}
  ensureEventBridgeForId(sess, sessionId, effectiveAgentId, ctx.agentHomeRoot, ws);
  return sess;
}

// TTL helper with parameterized TTL
function seenRecentlyTtl(map, key, ttlMs){
  try {
    const now = Date.now();
    const ts = map.get(key) || 0;
    if (now - ts < (ttlMs || 0)) return true;
    map.set(key, now);
    return false;
  } catch { return false }
}

function hash(s){ try { return createHash('sha1').update(String(s||'')).digest('hex'); } catch { return String(s||'') } }

function activateToolsForSkill({ sess, sessionId, skillName, policy }){
  try {
    const map = sessionId ? (skillToolMapById.get(String(sessionId)) || new Map()) : (policySkillToolMap.get(String(policy||'restricted')) || new Map());
    const names = map.get(String(skillName || '')) || [];
    if (!names || !names.length) return false;
    const desired = new Set(sess.getActiveToolNames?.() || []);
    for (const n of names) desired.add(n);
    const list = Array.from(desired);
    sess.setActiveToolsByName?.(list);
    try { broadcast({ type: 'tools_active', tools: list, sessionId }); } catch {}
    return true;
  } catch { return false }
}


function mimeForImageExt(ext){
  const t = String(ext || '').toLowerCase();
  if (t === '.png') return 'image/png';
  if (t === '.jpg' || t === '.jpeg') return 'image/jpeg';
  if (t === '.gif') return 'image/gif';
  if (t === '.webp') return 'image/webp';
  return '';
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
  const strip = new Set(["'", '"', '`', '(', ')', '[', ']', '<', '>', ',', ';']);
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

function ensureEventBridgeForId(sess, sessionId, agentId, agentHomeDir, ws) {
  if (!sess || bridgedById.has(sess)) return;
  bridgedById.add(sess);
  // Hook subagent event bus once so codex/subagent streaming logs also reach SSE listeners
  if (!subagentHooked) {
    subagentHooked = true;
    try {
      eventBus.on('event', (ev) => {
        try {
          const t = ev && ev.type ? String(ev.type) : '';
          if (t && SSE_SKIP_RAW_TYPES.has(t)) return;
          broadcast(ev);
        } catch {}
      });
    } catch {}
  }
  const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
  const effectiveAgentHome = agentHomeDir || arcanaHomePath('agents', effectiveAgentId);
  const effectiveWorkspace = String(ws || workspaceRoot || '');
  try { initSessionUsageFromStore({ agentId: effectiveAgentId, sessionId }); } catch {}
  const toolArgsByCallId = new Map(); // toolCallId -> args snapshot for failure context
  sess.subscribe((ev) => {
    try {
      const t = ev && ev.type ? String(ev.type) : '';
          // Tool repeat aggregation (per-session)
      if (t === 'tool_execution_start') {
        try {
          const key = ev.toolName + '|' + (function (o) {
            try { return JSON.stringify(o, Object.keys(o).sort()); } catch { try { return JSON.stringify(o); } catch { return String(o); } }
          })(ev.args || {});
          const map = toolRepeatById.get(sessionId) || new Map();
          const n = (map.get(key) || 0) + 1; map.set(key, n); toolRepeatById.set(sessionId, map);
          if (n > 1) broadcast({ type: 'tool_repeat', toolName: ev.toolName, args: ev.args || {}, count: n, sessionId });
        } catch {}
        // Forward original start event with sessionId for filtering on the client
        broadcast({ type: 'tool_execution_start', toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args || {}, sessionId });
        try { if (ev && ev.toolCallId) toolArgsByCallId.set(ev.toolCallId, ev.args || {}); } catch {}
        try { persistToolMetaToDisk({ agentId: effectiveAgentId, sessionId, toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args || {} }); } catch {}
        // If the agent is reading a SKILL.md, auto-activate that skill's tools for this session
        try {
          if (ev.toolName === 'read' && ev.args && ev.args.path && /\bSKILL\.md$/i.test(String(ev.args.path))) {
            const obj = ssLoad(String(sessionId || '').trim(), { agentId: effectiveAgentId });
            const wsForSkill = (obj && obj.workspace) ? String(obj.workspace) : effectiveWorkspace;
            const pRaw = String(ev.args.path || '');
            const p = pRaw.startsWith('/') ? pRaw : join(wsForSkill || '', pRaw);
            try { const text = readFileSync(p, 'utf-8'); const { frontmatter } = parseFrontmatter(text); const name = frontmatter && frontmatter.name; if (name) activateToolsForSkill({ sess, sessionId, skillName: String(name) }); } catch {}
          }
        } catch {}
      }

      // Forward updates/ends tagged with sessionId
      if (t === 'tool_execution_update') {
        try {
          const raw = (typeof ev.partialResult !== 'undefined') ? ev.partialResult : ev.update;
          if (raw && typeof raw === 'object'){
            const stream = String(raw.stream || '').toLowerCase();
            const chunkVal = raw.chunk;
            if ((stream === 'stdout' || stream === 'stderr') && typeof chunkVal === 'string'){
              try { scheduleAppendToolStream({ agentId: effectiveAgentId, sessionId, toolCallId: ev.toolCallId, stream, chunk: chunkVal }); } catch {}
              const payload = { type: 'tool_execution_update', toolCallId: ev.toolCallId, toolName: ev.toolName, update: { stream, chunk: chunkVal }, sessionId };
              broadcast(payload);
            }
          }
        } catch {}
      }
      if (t === 'tool_execution_end') {
        let errorSummary = '';
        // Best-effort failure capture for optional memory triggers
        if (String(ev.toolName||'') === "codex"){
          const sidKey = String(sessionId||"default");
          const t = Number((ev && ev.result && ev.result.details && ev.result.details.usage && (ev.result.details.usage.totalTokens || ev.result.details.usage.total_tokens)) || 0) || 0;
          if (t>0){
            const prevTotal = sessionUsageTotalsById.get(sidKey) || 0;
            const nextTotal = prevTotal + t;
            sessionUsageTotalsById.set(sidKey, nextTotal);
            try { schedulePersistSessionTokens({ agentId: effectiveAgentId, sessionId, tokens: nextTotal }); } catch {}
          }
        }
        try {
          const isErr = !!(ev?.isError || ev?.error || (ev?.result && ((ev.result.details && ev.result.details.ok===false) || ev.result.error)));
          if (isErr) {
            // Build safe args and raw error text
            const origArgs = (ev && ev.toolCallId && toolArgsByCallId.has(ev.toolCallId)) ? toolArgsByCallId.get(ev.toolCallId) : (ev?.args || {});
            try { if (ev && ev.toolCallId) toolArgsByCallId.delete(ev.toolCallId); } catch {}
            const redactKeys = new Set(['stdin','password','token','apikey','api_key','apiKey','secret','secrets','key']);
            const safeObj = (function(){
              try {
                const clone = JSON.parse(JSON.stringify(origArgs||{}));
                for (const k of Object.keys(clone||{})){
                  const low = String(k).toLowerCase();
                  if (redactKeys.has(low)) clone[k] = '[redacted]';
                  const v = clone[k];
                  if (typeof v === 'string' && v.length > 400) clone[k] = v.slice(0,400) + '…';
                }
                return clone;
              } catch { return origArgs || {} }
            })();
            let safeArgs = '';
            try { safeArgs = JSON.stringify(safeObj, Object.keys(safeObj).sort()); } catch { try { safeArgs = JSON.stringify(safeObj); } catch { safeArgs = String(safeObj||''); } }

            let errTextRaw = '';
            try {
              const cand = ev?.error?.message || ev?.error || ev?.result?.error?.message || ev?.result?.error || ev?.result?.stderr || ev?.result?.stdout;
              if (typeof cand === 'string') errTextRaw = cand;
              else if (cand != null) { try { errTextRaw = JSON.stringify(cand); } catch { errTextRaw = String(cand); } }
              errTextRaw = String(errTextRaw||'').slice(0, 2000);
            } catch {}

            errorSummary = errTextRaw;

            // Tier1: direct daily memory append of the failure (deduped)
            try {
              if (MEMORY_TRIGGERS_ENABLED) {
                const dedupeKey = String(sessionId || 'default') + '|' + hash(String(ev?.toolName || '?') + '|' + safeArgs + '|' + errTextRaw);
                if (!seenRecentlyTtl(dedupeToolFail, dedupeKey, DEDUPE_TRIGGER_TTL_MS)) {
                  const shortArgs = truncateText(safeArgs);
                  const shortErr = truncateText(errTextRaw);
                  const content = 'args: ' + shortArgs + '\n\nerror: ' + shortErr;
                  const r = appendToAgentDailyMemory({ agentHomeDir: effectiveAgentHome, heading: 'tool_fail:' + String(ev?.toolName || '?'), content });
                  if (r && r.path) {
                    try { broadcast({ type: 'memory_trigger', kind: 'tool_fail', toolName: ev?.toolName || '?', sessionId, path: r.path }); } catch {}
                  }
                }
              }
            } catch {}

          }
        } catch {}
        const endIsErr = !!(ev?.isError || ev?.error || (ev?.result && ((ev.result.details && ev.result.details.ok===false) || ev.result.error)));
        const cachedFlag = !!(ev && (ev.cached || ev.isCached || ev.fromCache));
        try {
          broadcast({
            type: 'tool_execution_end',
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            isError: endIsErr,
            errorSummary,
            sessionId,
            cached: cachedFlag,
          });
        } catch {}
        try { persistToolResultToDisk({ agentId: effectiveAgentId, sessionId, event: ev }); } catch {}
      }

      // Turn lifecycle
      if (t === 'turn_start') {
        try { mediaRefsByTurn.delete(String(sessionId || 'default')); } catch {}
        broadcast({ type: 'turn_start', sessionId });
      }
      if (t === 'turn_end') {
        try { mediaRefsByTurn.delete(String(sessionId || 'default')); } catch {}
        broadcast({ type: 'turn_end', sessionId, sessionTokens: (sessionUsageTotalsById.get(String(sessionId||'default')) || 0) });
      }

      // Thinking lifecycle (per-session)
      if (t === 'thinking_start') {
        thinkStatsById.set(sessionId, { startedAt: Date.now(), chars: 0 });
        broadcast({ type: 'thinking_start', sessionId });
      }
      if (t === 'thinking_delta') {
        const st = thinkStatsById.get(sessionId);
        if (st) {
          try {
            const size = JSON.stringify(ev.delta || ev).length;
            st.chars += size;
            broadcast({ type: 'thinking_progress', chars: st.chars, sessionId });
          } catch {}
        }
      }
      if (t === 'thinking_end') {
        const st = thinkStatsById.get(sessionId);
        if (st) {
          const tookMs = Date.now() - st.startedAt;
          broadcast({ type: 'thinking_end', chars: st.chars, tookMs, sessionId });
          thinkStatsById.delete(sessionId);
        } else {
          broadcast({ type: 'thinking_end', sessionId });
        }
      }

      // LLM usage accounting (per assistant message_end)
      if (ev && t === 'message_end' && ev.message && ev.message.role === 'assistant') {
      // Assistant streaming (text/images)
        try {
          const u = ev && ev.message && ev.message.usage;
          let ctx = 0, out = 0, tot = 0;
          if (u && typeof u === 'object'){
            ctx = Number(u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.input ?? u.prompt ?? 0) || 0;
            out = Number(u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? u.output ?? 0) || 0;
            tot = Number(u.totalTokens ?? u.total_tokens ?? u.total ?? 0) || 0;
          }
          if (!tot) tot = ctx + out;
          if (tot > 0 || ctx > 0 || out > 0){
            const sidKey = String(sessionId || "default");
            const prev = sessionUsageTotalsById.get(sidKey) || 0;
            const next = prev + (tot||0);
            sessionUsageTotalsById.set(sidKey, next);
            try { schedulePersistSessionTokens({ agentId: effectiveAgentId, sessionId, tokens: next }); } catch {}
            try { broadcast({ type: 'llm_usage', sessionId, contextTokens: ctx, outputTokens: out, totalTokens: tot, sessionTokens: next }); } catch {}
          }
        } catch {}
      }
      if (t === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const rawText = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          const extracted = extractMediaFromAssistantText(rawText);
          const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
          const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
          if (cleanText) broadcast({ type: 'assistant_text', text: cleanText, sessionId });
          if (mediaRefs.length) {
            const sidKey = String(sessionId || 'default');
            let seen = mediaRefsByTurn.get(sidKey);
            if (!seen) { seen = new Set(); mediaRefsByTurn.set(sidKey, seen); }
	            for (const raw of mediaRefs){
	              const ref = normalizeMediaRef(raw);
	              if (!ref || seen.has(ref)) continue;
	              seen.add(ref);
	              const lower = ref.toLowerCase();
	              if (lower.startsWith('http://') || lower.startsWith('https://')){
	                try { broadcast({ type: 'assistant_image', url: ref, mime: 'image/*', sessionId }); } catch {}
	                continue;
	              }
              try {
                const meta = runWithContext({ sessionId, agentId: effectiveAgentId, agentHomeRoot: effectiveAgentHome, workspaceRoot: effectiveWorkspace }, () => {
                  const filePath = ensureReadAllowed(ref);
                  const mime = mimeForImageExt(extname(filePath));
                  if (!mime) return null;
                  return { mime };
                });
                if (meta && meta.mime){
                  const encodedPath = encodeURIComponent(ref);
                  const sidParam = sessionId ? '&sessionId=' + encodeURIComponent(String(sessionId)) : '';
                  const url = '/api/local-file?path=' + encodedPath + sidParam;
                  try { broadcast({ type: 'assistant_image', url, mime: meta.mime, sessionId }); } catch {}
                }
              } catch {}
            }
          }
          for (const c of blocks) {
            if (!c || c.type !== 'image') continue;
            const mime = c.mime || c.mimeType || c.MIMEType || 'image/png';
            let url = c.image_url || c.url || '';
            if (!url && c.data) url = 'data:' + mime + ';base64,' + c.data;
            if (url) broadcast({ type: 'assistant_image', url, mime, sessionId });
          }
        } catch {}
      }
      if (!SSE_SKIP_RAW_TYPES.has(t)) {
        try { broadcast(ev); } catch {}
      }
    } catch {}
  });
}

function ensureEventBridge(sess) {
  if (!sess || bridgedSessions.has(sess)) return;
  bridgedSessions.add(sess);
  sess.subscribe((ev) => {
    try {
      if (ev.type === 'turn_start') { try { legacyMediaRefsByTurn.clear(); } catch {} }
      if (ev.type === 'turn_end') { try { legacyMediaRefsByTurn.clear(); } catch {} }
      if (ev.type === 'tool_execution_start') {
        const key = ev.toolName + '|' + (function (o) { try { return JSON.stringify(o, Object.keys(o).sort()); } catch { try { return JSON.stringify(o); } catch { return String(o); } } })(ev.args || {});
        const n = (toolRepeat.get(key) || 0) + 1; toolRepeat.set(key, n);
        if (n > 1) broadcast({ type: 'tool_repeat', toolName: ev.toolName, args: ev.args || {}, count: n });
      }
      if (ev.type === 'thinking_start') { thinkStats = { startedAt: Date.now(), chars: 0 }; broadcast({ type: 'thinking_start' }); }
      if (ev.type === 'thinking_delta') { if (thinkStats) { const size = JSON.stringify(ev.delta || ev).length; thinkStats.chars += size; broadcast({ type: 'thinking_progress', chars: thinkStats.chars }); } }
      if (ev.type === 'thinking_end') { if (thinkStats) { const tookMs = Date.now() - thinkStats.startedAt; broadcast({ type: 'thinking_end', chars: thinkStats.chars, tookMs }); thinkStats = null; } else { broadcast({ type: 'thinking_end' }); } }
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const rawText = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          const extracted = extractMediaFromAssistantText(rawText);
          const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
          const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
          if (cleanText) broadcast({ type: 'assistant_text', text: cleanText });
          if (mediaRefs.length) {
	            for (const raw of mediaRefs){
	              const ref = normalizeMediaRef(raw);
	              if (!ref || legacyMediaRefsByTurn.has(ref)) continue;
	              legacyMediaRefsByTurn.add(ref);
	              const lower = ref.toLowerCase();
	              if (lower.startsWith('http://') || lower.startsWith('https://')){
	                try { broadcast({ type: 'assistant_image', url: ref, mime: 'image/*' }); } catch {}
	                continue;
	              }
              try {
                const meta = runWithContext({
                  sessionId: undefined,
                  agentId: DEFAULT_AGENT_ID,
                  agentHomeRoot: arcanaHomePath('agents', DEFAULT_AGENT_ID),
                  workspaceRoot: workspaceRoot || resolveWorkspaceRoot(),
                }, () => {
                  const filePath = ensureReadAllowed(ref);
                  const mime = mimeForImageExt(extname(filePath));
                  if (!mime) return null;
                  return { mime };
                });
                if (meta && meta.mime){
                  const encodedPath = encodeURIComponent(ref);
                  const url = '/api/local-file?path=' + encodedPath;
                  try { broadcast({ type: 'assistant_image', url, mime: meta.mime }); } catch {}
                }
              } catch {}
            }
          }
          for (const c of blocks) {
            if (!c || c.type !== 'image') continue;
            const mime = c.mime || c.mimeType || c.MIMEType || 'image/png';
            let url = c.image_url || c.url || '';
            if (!url && c.data) url = 'data:' + mime + ';base64,' + c.data;
            if (url) broadcast({ type: 'assistant_image', url, mime });
          }
        } catch {}
      }
    } catch {}
    if (!subagentHooked) {
      subagentHooked = true; try { eventBus.on('event', (ev2) => { broadcast(ev2); }); } catch {}
    }
    broadcast(ev);
  });
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}
function send(res, payload) {
  let chunk = '';
  try {
    chunk = 'data: ' + JSON.stringify(payload) + '\n\n';
  } catch {
    return;
  }
  const meta = getSseMeta(res);
  if (meta.paused){
    enqueueSseChunk(meta, chunk);
    return;
  }
  let ok = true;
  try { ok = res.write(chunk); } catch { ok = false; }
  if (!ok){
    meta.paused = true;
    hookSseDrain(res, meta);
    enqueueSseChunk(meta, chunk);
  }
}

function isToolStreamChunk(ev){
  try {
    if (!ev || ev.type !== 'tool_execution_update') return false;
    const raw = (typeof ev.partialResult !== 'undefined') ? ev.partialResult : ev.update;
    if (!raw || typeof raw !== 'object') return false;
    const stream = String(raw.stream || '').toLowerCase();
    if (stream !== 'stdout' && stream !== 'stderr') return false;
    const chunkVal = raw.chunk;
    if (typeof chunkVal !== 'string') return false;
    return true;
  } catch { return false; }
}

function broadcast(ev) {
  for (const res of clients){
    const meta = getSseMeta(res);
    if (isToolStreamChunk(ev)){
      if (!meta.includeToolStream) continue;
      const sidFilter = String(meta.toolStreamSessionId || '').trim();
      if (sidFilter){
        const evSid = ev && ev.sessionId ? String(ev.sessionId || '') : '';
        if (!evSid || evSid !== sidFilter) continue;
      }
    }
    send(res, ev);
  }
}

async function handleEvents(req, res) {
  await ensurePolicySession('restricted');
  let includeToolStream = false;
  let toolStreamSessionId = '';
  try {
    const url = new URL(req.url, 'http://localhost');
    const v = (url.searchParams.get('toolStream') || '').toLowerCase();
    if (v === '1' || v === 'true'){
      includeToolStream = true;
    }
    const sid = String(url.searchParams.get('toolStreamSessionId') || '').trim();
    if (sid) toolStreamSessionId = sid;
  } catch {}
  const meta = getSseMeta(res);
  meta.includeToolStream = includeToolStream;
  meta.toolStreamSessionId = toolStreamSessionId;
  res.writeHead(200, sseHeaders());
  clients.add(res);
  const modelLabel = model ? (model.provider + ':' + model.id + (model.baseUrl ? (' @ ' + model.baseUrl) : '')) : '<auto>';
  send(res, { type: 'server_info', model: modelLabel, tools: toolNames, plugins: pluginFiles, workspace: workspaceRoot, skills: skillNames });
  req.on('close', () => {
    try { clients.delete(res); } catch {}
    try { sseClientMeta.delete(res); } catch {}
  });
}

// Concurrent + persistent endpoint
async function handleChat2(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const message = String(body.message || '').trim();
    const policy = String(body.policy || '').toLowerCase() === 'open' ? 'open' : 'restricted';
    let agentId = String(body.agentId || '').trim();
    let sessionId = String(body.sessionId || '').trim();

    if (!message) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_message' }));
      return;
    }

    if (!agentId) agentId = DEFAULT_AGENT_ID;

    // Resolve agent meta (home + workspaceRoot) from ~/.arcana/agents/<agentId>/agent.json
    const agent = findAgentMeta(agentId) || ensureDefaultAgentExists();
    if (!agent || !agent.workspaceRoot) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'agent_not_found' }));
      return;
    }
    const ws = agent.workspaceRoot;
    const agentHomeDir = agent.agentHomeDir || agent.agentDir || arcanaHomePath('agents', agentId);

    let initialSession = null;
    if (!sessionId) {
      const created = ssCreate({ title: '新会话', agentId });
      sessionId = created.id;
      initialSession = created;
    }

    // Load session object and ensure it is bound to this agent
    const obj0 = initialSession || ssLoad(sessionId, { agentId });
    if (obj0) {
      let changed = false;
      const existingAgentRaw = obj0.agentId != null ? String(obj0.agentId) : '';
      const existingAgent = existingAgentRaw.trim();
      if (existingAgent && existingAgent !== agentId) {
        res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'agent_mismatch' }));
        return;
      }
      if (!existingAgent) {
        obj0.agentId = agentId;
        changed = true;
      }
      if (changed) { try { ssSave(obj0, { agentId }); } catch {} }
    }

    const sess = await ensureSessionFor(sessionId, policy, ws, agentId, agentHomeDir);
    applyExecPolicyToSession(sess, policy);

    const ctxBase = { sessionId, agentId, agentHomeRoot: agentHomeDir, workspaceRoot: ws };

    // If user explicitly invoked a skill via a skill block (/skill:name), activate its tools
    try {
      const blk = parseSkillBlock(message);
      if (blk && blk.name) activateToolsForSkill({ sess, sessionId, skillName: String(blk.name), policy });
    } catch {}

    // Tier1: user_issue detection -> direct daily memory append (deduped)
    try {
      if (MEMORY_TRIGGERS_ENABLED && detectProblemMention(message)) {
        const key = String(sessionId || 'default') + '|' + hash(message);
        if (!seenRecentlyTtl(dedupeUserIssue, key, DEDUPE_TRIGGER_TTL_MS)) {
          const content = truncateText(message);
          appendToAgentDailyMemory({ agentHomeDir, heading: 'user_issue', content });
        }
      }
      if (MEMORY_TRIGGERS_ENABLED && detectCorrectionMention(message)) {
        const keyCorr = String(sessionId || 'default') + '|corr|' + hash(message);
        if (!seenRecentlyTtl(dedupeUserCorrection, keyCorr, DEDUPE_TRIGGER_TTL_MS)) {
          const content = truncateText(message);
          appendToAgentDailyMemory({ agentHomeDir, heading: 'user_correction', content });
        }
      }
    } catch {}

    // Build context prelude from existing session state before the current user message
    const historyObj = obj0 || ssLoad(sessionId, { agentId });
    if (historyObj) {
      let changed = false;
      if (agentId && !historyObj.agentId) { historyObj.agentId = agentId; changed = true; }
      if (changed) { try { ssSave(historyObj, { agentId }); } catch {} }
    }
    const prelude = ssPrelude(historyObj);

    // Persist user message after prelude so it is not duplicated in the prompt
    ssAppend(sessionId, { role: 'user', text: message, agentId });
    let payloadMsg = (prelude ? prelude + '\n\n' : '') + '[Current Question]\n' + message;
    let out = '';
    let lastAssistantText = '';
    let persistedCount = 0;
    const seenTexts = new Set();
    const unsub = sess.subscribe((ev) => {
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) out = text;
        } catch {}
      }
      if (ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) {
            lastAssistantText = text;
            if (!seenTexts.has(text)) {
              ssAppend(sessionId, { role: 'assistant', text, agentId });
              seenTexts.add(text);
              persistedCount++;
            }
          }
        } catch {}
      }
    });

    // If session is already streaming, treat this request as a steering message
    // so it interrupts the remaining plan after the current tool finishes.
    if (sess && sess.isStreaming) {
      try {
        await runWithContext(ctxBase, () =>
          sess.prompt(payloadMsg, { streamingBehavior: 'steer', expandPromptTemplates: true })
        );
        try { broadcast({ type: 'steer_enqueued', sessionId, text: message }); } catch {}
      } catch (e) {
        let msg = '';
        try { msg = String(e && (e.message || e)) || ''; } catch { msg = ''; }
        if (msg && isContextOverflowErrorMessage(msg)) {
          try {
            await compactSessionHistoryOnOverflow({ sessionId, agentId, ws, agentHomeDir });
            const updated = ssLoad(sessionId, { agentId });
            let preludeAfter = '';
            if (updated && Array.isArray(updated.messages) && updated.messages.length){
              const msgsAfter = updated.messages;
              const last = msgsAfter[msgsAfter.length - 1];
              let historyAfter = updated;
              if (last && last.role === 'user') {
                historyAfter = { ...updated, messages: msgsAfter.slice(0, -1) };
              }
              preludeAfter = ssPrelude(historyAfter);
            }
            const retryPayload = (preludeAfter ? preludeAfter + '\n\n' : '') + '[Current Question]\n' + message;
            try {
              await runWithContext(ctxBase, () =>
                sess.prompt(retryPayload, { streamingBehavior: 'steer', expandPromptTemplates: true })
              );
              try { broadcast({ type: 'steer_enqueued', sessionId, text: message }); } catch {}
            } catch {
              // best-effort for steer overflow retry
            }
          } catch {
            // ignore compaction failures for steer path
          }
        }
      }
      try { unsub && unsub(); } catch {}
      // For steer, we reply immediately; front-end will continue via SSE.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ text: '' }));
      return;
    }

    // Normal path: not streaming -> start a new agent turn
    let promptError = null;
    let attemptedCompaction = false;
    const turnLockOptions = { agentId, workspaceRoot: ws };
    let turnLockPath = null;
    try {
      try { turnLockPath = acquireSessionTurnLock(sessionId, turnLockOptions); } catch {}
      for (let attempt = 0; attempt < 2; attempt++) {
        promptError = null;
        try {
          await runWithContext(ctxBase, () => sess.prompt(payloadMsg));
        } catch (e) {
          promptError = e;
        }
        if (!promptError) break;

        let msg = '';
        try {
          msg = String(promptError && (promptError.message || promptError)) || 'agent_prompt_failed';
        } catch {
          msg = 'agent_prompt_failed';
        }

        if (!attemptedCompaction && isContextOverflowErrorMessage(msg)) {
          attemptedCompaction = true;
          try {
            await compactSessionHistoryOnOverflow({ sessionId, agentId, ws, agentHomeDir });
            const updated = ssLoad(sessionId, { agentId });
            let preludeAfter = '';
            if (updated && Array.isArray(updated.messages) && updated.messages.length){
              const msgsAfter = updated.messages;
              const last = msgsAfter[msgsAfter.length - 1];
              let historyAfter = updated;
              if (last && last.role === 'user') {
                historyAfter = { ...updated, messages: msgsAfter.slice(0, -1) };
              }
              preludeAfter = ssPrelude(historyAfter);
            }
            payloadMsg = (preludeAfter ? preludeAfter + '\n\n' : '') + '[Current Question]\n' + message;
            continue;
          } catch {
            // fall through to error handling below
          }
        }

        // Non-overflow error or compaction failed -> stop retrying
        break;
      }
    } finally {
      try {
        if (turnLockPath) releaseSessionTurnLock(turnLockPath, turnLockOptions);
      } catch {}
    }
    try { unsub && unsub(); } catch {}

    if (promptError) {
      let msg = '';
      try {
        msg = String(promptError && (promptError.message || promptError)) || 'agent_prompt_failed';
      } catch {
        msg = 'agent_prompt_failed';
      }
      try { console.error('[arcana:chat2] prompt failed:', msg); } catch {}
      try { broadcast({ type: 'error', sessionId, message: msg }); } catch {}
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server_error', message: msg }));
      return;
    }

    // Fallback persistence
    if (lastAssistantText) {
      try {
        const cur = ssLoad(sessionId, { agentId });
        const msgs = (cur && Array.isArray(cur.messages)) ? cur.messages : [];
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        if (persistedCount === 0 || !last || last.role !== 'assistant' || String(last.text || '') !== String(lastAssistantText)) {
          ssAppend(sessionId, { role: 'assistant', text: lastAssistantText, agentId });
          persistedCount++;
        }
      } catch {}
    }

    const respText = lastAssistantText || out;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ text: respText }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server_error', message: e?.message || String(e) }));
  }
}

// POST /api/abort  — hard-stop current run and active tool (if any)
async function handleAbort(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const sessionId = String(body.sessionId || '').trim();
    let agentId = '';
    try {
      if (Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null) {
        agentId = String(body.agentId || '').trim();
      }
    } catch {}
    if (!agentId) agentId = DEFAULT_AGENT_ID;
    if (!sessionId) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_sessionId' })); return; }

    const hardAbortOne = (sess) => {
      if (!sess) return false;
      try { sess.abortRetry?.(); } catch {}
      try { sess.clearQueue?.(); } catch {}
      try { sess.agent?.abort?.(); } catch {}
      try { sess._arcanaToolHostClient?.cancelActiveCall?.(); } catch {}

      // Fallback: if the agent is not exposed, trigger the session-level abort
      // but do not await it (it may wait for idle).
      try {
        if (!sess.agent?.abort && typeof sess.abort === 'function') {
          const p = sess.abort();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch {}
      return true;
    };

    let abortedCount = 0;
    const seen = new Set();

    // Abort all in-memory chat2 sessions with the same sessionId, regardless of
    // policy/workspace. This fixes cases where the UI started a session with a
    // custom workspace, but /api/abort used the agent's default workspace.
    try {
      const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
      for (const [key, sess] of chatSessions.entries()) {
        const parts = String(key || '').split('|');
        const aidPart = parts[0] || '';
        const sidPart = parts[1] || '';
        if (aidPart !== effectiveAgentId) continue;
        if (sidPart !== sessionId) continue;
        if (!sess || seen.has(sess)) continue;
        seen.add(sess);
        if (hardAbortOne(sess)) abortedCount += 1;
      }
    } catch {}

    // If nothing was found in-memory, best-effort locate/create likely session
    // instances for known workspace candidates and abort them.
    if (abortedCount === 0) {
      try {
        const ctx = resolveSessionContext(sessionId, agentId);
        const wsFromBody = String(body.workspace || body.workspaceRoot || '').trim();
        const wsFromStore = String(ctx.session?.workspace || '').trim();
        const wsFromAgent = String(ctx.workspaceRoot || workspaceRoot || '').trim();
        const wsCandidates = [wsFromBody, wsFromStore, wsFromAgent].filter((v, i, arr) => v && arr.indexOf(v) === i);
        const policies = ['restricted', 'open'];
        for (const ws of wsCandidates) {
          for (const pol of policies) {
            try {
              const sess = await ensureSessionFor(sessionId, pol, ws, ctx.agentId, ctx.agentHomeDir);
              if (sess && !seen.has(sess)) {
                seen.add(sess);
                if (hardAbortOne(sess)) abortedCount += 1;
              } else {
                hardAbortOne(sess);
              }
            } catch {}
          }
        }
      } catch {}
    }

    try { broadcast({ type: 'abort_done', sessionId }); } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, aborted: abortedCount }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'abort_failed', message: e?.message || String(e) }));
  }
}

// Optional: explicit steer endpoint — enqueue a steering message while streaming
async function handleSteer(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const message = String(body.message || '').trim();
    const sessionId = String(body.sessionId || '').trim();
    const policy = String(body.policy || '').toLowerCase() === 'open' ? 'open' : 'restricted';
    let agentId = '';
    try {
      if (Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null) {
        agentId = String(body.agentId || '').trim();
      }
    } catch {}
    if (!agentId) agentId = DEFAULT_AGENT_ID;
    if (!message) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_message' })); return; }
    if (!sessionId) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_sessionId' })); return; }

    // Build prelude from existing session before appending the current user message
    const ctx = resolveSessionContext(sessionId, agentId);
    const ws = ctx.workspaceRoot || workspaceRoot;
    const prelude = ssPrelude(ctx.session);

    // Persist user message after prelude so it is not duplicated
    ssAppend(sessionId, { role: 'user', text: message, agentId });
    const payloadMsg = (prelude ? prelude + '\n\n' : '') + '[Current Question]\n' + message;

    const sess = await ensureSessionFor(sessionId, policy, ws, ctx.agentId, ctx.agentHomeDir);
    applyExecPolicyToSession(sess, policy);
    try {
      await runWithContext({ sessionId, agentId: ctx.agentId, agentHomeRoot: ctx.agentHomeDir, workspaceRoot: ws }, () =>
        sess.prompt(payloadMsg, { streamingBehavior: 'steer', expandPromptTemplates: true })
      );
      try { broadcast({ type: 'steer_enqueued', sessionId, text: message }); } catch {}
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'steer_failed', message: e?.message || String(e) }));
  }
}

async function handleLocalFile(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams.get('path') || '';
    const sid = String(url.searchParams.get('sessionId') || '').trim();
    const ctx = resolveSessionContext(sid || undefined);
    const ws = ctx.workspaceRoot || workspaceRoot;
    const filePath = runWithContext({ sessionId: sid || undefined, agentId: ctx.agentId, agentHomeRoot: ctx.agentHomeDir, workspaceRoot: ws }, () => ensureReadAllowed(p));
    const data = await readFile(filePath);
    const type = extname(filePath).toLowerCase();
    const ct = type === '.png' ? 'image/png' : type === '.jpg' || type === '.jpeg' ? 'image/jpeg' : type === '.webp' ? 'image/webp' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) {
    res.writeHead(404).end('Not Found');
  }
}

function sanitizeConfig(cfg) {
  if (!cfg) return null;
  const out = { provider: cfg.provider || '', base_url: cfg.base_url || '', model: cfg.model || '', path: cfg.path || '' };
  out.has_key = !!cfg.key || !!cfg.api_key || !!cfg.apiKey;
  delete out.key; delete out.api_key; delete out.apiKey;
  return out;
}

function resetSessions() { try { sessionsByPolicy.clear(); chatSessions.clear(); } catch {} }

async function handleDoctor(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const sid = String(url.searchParams.get('sessionId') || '').trim();
    const ctx = resolveSessionContext(sid || undefined);
    const ws = ctx.workspaceRoot || workspaceRoot;
    const result = await runWithContext({ sessionId: sid || undefined, agentId: ctx.agentId, agentHomeRoot: ctx.agentHomeDir, workspaceRoot: ws }, () => runDoctor({ cwd: ws }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'doctor_failed', message: e?.message || String(e) }));
  }
}

async function handleSupportBundle(req, res) {
  try {
    const bufs = []; for await (const c of req) bufs.push(c);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf-8')) : {};
    const sid = String(body.sessionId || '').trim();
    const ctx = resolveSessionContext(sid || undefined);
    const ws = ctx.workspaceRoot || workspaceRoot;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDirRaw = join(ws, 'artifacts', 'support-' + stamp);
    const outDir = runWithContext({ sessionId: sid || undefined, agentId: ctx.agentId, agentHomeRoot: ctx.agentHomeDir, workspaceRoot: ws }, () => ensureWriteAllowed(outDirRaw));
    const { dir, tarPath } = await createSupportBundle({ outDir, cwd: ws });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, dir, tarPath: tarPath || '' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: 'support_bundle_failed', message: e?.message || String(e) }));
  }
}

async function handleGetConfig(req, res) {
  try { const cfg = loadArcanaConfig(); const out = sanitizeConfig(cfg || {}); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(out || {})); }
  catch { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({})); }
}

async function handleGetAgentConfig(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const agentIdParam = String(url.searchParams.get('agentId') || '').trim();
    const agentId = agentIdParam || DEFAULT_AGENT_ID;
    const meta = findAgentMeta(agentId) || (agentId === DEFAULT_AGENT_ID ? ensureDefaultAgentExists() : null);
    const baseHome = (meta && (meta.agentHomeDir || meta.agentDir)) ? (meta.agentHomeDir || meta.agentDir) : arcanaHomePath('agents', agentId);
    const agentHomeDir = baseHome || arcanaHomePath('agents', agentId);
    const rawCfg = loadAgentConfig(agentHomeDir);
    const cfgPath = join(agentHomeDir, 'config.json');
    const merged = rawCfg ? { ...rawCfg } : { path: cfgPath };
    if (!merged.path) merged.path = cfgPath;
    const out = sanitizeConfig(merged) || { provider: '', base_url: '', model: '', path: cfgPath, has_key: false };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(out));
  } catch {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({}));
  }
}

async function handlePostAgentConfig(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    let agentId = '';
    try {
      if (Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null) {
        agentId = String(body.agentId || '').trim();
      }
    } catch {}
    if (!agentId) agentId = DEFAULT_AGENT_ID;
    const meta = findAgentMeta(agentId) || (agentId === DEFAULT_AGENT_ID ? ensureDefaultAgentExists() : null);
    const baseHome = (meta && (meta.agentHomeDir || meta.agentDir)) ? (meta.agentHomeDir || meta.agentDir) : arcanaHomePath('agents', agentId);
    const agentHomeDir = baseHome || arcanaHomePath('agents', agentId);
    const cfgPath = join(agentHomeDir, 'config.json');

    const shouldClear = !!(body && body.clear === true);
    if (shouldClear) {
      try {
        if (cfgPath && existsSync(cfgPath)) await unlink(cfgPath);
      } catch {}
    } else {
      const provider = String(body.provider || '').trim();
      const modelId = String(body.model || '').trim();
      const baseUrl = String(body.base_url || '').trim();
      const key = String(body.key || '').trim();
      const cfgObj = { provider, model: modelId, base_url: baseUrl };
      if (key) cfgObj.key = key;
      const baseDir = String(agentHomeDir || '').trim();
      if (baseDir) {
        try { mkdirSync(baseDir, { recursive: true }); } catch {}
        await writeFile(cfgPath, JSON.stringify(cfgObj, null, 2), 'utf-8');
      }
    }

    resetSessions();
    try { broadcast({ type: 'server_info', model: '', tools: toolNames, plugins: pluginFiles, workspace: workspaceRoot, skills: skillNames }); } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'agent_config_write_failed', message: e?.message || String(e) }));
  }
}

async function handleGetTimerSettings(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const agentIdParam = String(url.searchParams.get('agentId') || '').trim();
    const agentId = agentIdParam || DEFAULT_AGENT_ID;
    const meta = findAgentMeta(agentId) || ensureDefaultAgentExists();
    const ws = (meta && meta.workspaceRoot) ? meta.workspaceRoot : workspaceRoot;
    const settings = cronLoadSettings({ agentId, workspaceRoot: ws });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, settings }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: false, error: 'cron_settings_read_failed', message: e?.message || String(e) }));
  }
}

async function handlePostTimerSettings(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    let agentId = '';
    try {
      if (Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null) {
        agentId = String(body.agentId || '').trim();
      }
    } catch {}
    if (!agentId) agentId = DEFAULT_AGENT_ID;
    const meta = findAgentMeta(agentId) || ensureDefaultAgentExists();
    const ws = (meta && meta.workspaceRoot) ? meta.workspaceRoot : workspaceRoot;
    const settingsRaw = body && body.settings && typeof body.settings === 'object' ? body.settings : {};
    const settings = cronSaveSettings(settingsRaw, { agentId, workspaceRoot: ws });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, settings }));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: false, error: 'cron_settings_write_failed', message: e?.message || String(e) }));
  }
}

async function handlePostConfig(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const provider = String(body.provider || '').trim();
    const modelId = String(body.model || '').trim();
    const baseUrl = String(body.base_url || '').trim();
    const key = String(body.key || '').trim();
    const cfgObj = { provider, model: modelId, base_url: baseUrl };
    if (key) cfgObj.key = key;

    const envCfg = String(process.env.ARCANA_CONFIG || '').trim();
    let path = '';
    if (envCfg) {
      path = envCfg; // honor explicit ARCANA_CONFIG path as-is
    } else {
      try { ensureArcanaHomeDir(); } catch {}
      path = arcanaHomePath('config.json');
    }

    await writeFile(path, JSON.stringify(cfgObj, null, 2), 'utf-8');
    resetSessions();
    broadcast({ type: 'server_info', model: '', tools: toolNames, plugins: pluginFiles, workspace: workspaceRoot, skills: skillNames });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'config_write_failed', message: e?.message || String(e) }));
  }
}

async function handleListAgents(req, res) {
  try {
    // Ensure at least a default agent exists.
    ensureDefaultAgentExists();
    const snap = loadAgentsSnapshot();
    const list = Array.isArray(snap && snap.agents) ? snap.agents : [];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ agents: list }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'agents_list_failed', message: e?.message || String(e) }));
  }
}

// Sessions CRUD
async function handleListSessions(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const agentIdParam = String(url.searchParams.get('agentId') || '').trim();
    const agentId = agentIdParam || DEFAULT_AGENT_ID;
    const sessions = ssList(agentId);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ sessions }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'list_failed', message: e?.message || String(e) }));
  }
}

async function handleCreateSession(req, res) {
  try {
    const bufs = []; for await (const c of req) bufs.push(c);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf-8')) : {};
    const title = String(body.title || '新会话').trim();

    let agentId = '';
    try {
      if (Object.prototype.hasOwnProperty.call(body, 'agentId') && body.agentId != null) {
        agentId = String(body.agentId || '').trim();
      }
    } catch {}
    if (!agentId) agentId = DEFAULT_AGENT_ID;

    // Ensure the target agent exists and has a workspaceRoot configured.
    const agent = findAgentMeta(agentId) || ensureDefaultAgentExists();
    if (!agent || !agent.workspaceRoot) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'agent_not_found' }));
      return;
    }

    const obj = ssCreate({ title, agentId });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'create_failed', message: e?.message || String(e) }));
  }
}

async function handleGetSession(req, res, id) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const agentIdParam = String(url.searchParams.get('agentId') || '').trim();
    const agentId = agentIdParam || DEFAULT_AGENT_ID;
    const obj = ssLoad(String(id || '').trim(), { agentId });
    if (!obj) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'get_failed', message: e?.message || String(e) }));
  }
}



// DELETE /api/sessions/:id
async function handleDeleteSession(req, res, id) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const agentIdParam = String(url.searchParams.get('agentId') || '').trim();
    const agentId = agentIdParam || DEFAULT_AGENT_ID;
    let decoded = '';
    try { decoded = decodeURIComponent(String(id || '').trim()); } catch { decoded = String(id || '').trim(); }
    const ok = ssDelete(decoded, { agentId });
    if (!ok) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' })); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'delete_failed', message: e?.message || String(e) }));
  }
}

async function handleGetToolOutput(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const agentIdParam = String(url.searchParams.get('agentId') || '').trim();
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    const toolCallId = String(url.searchParams.get('toolCallId') || '').trim();
    const tailRaw = String(url.searchParams.get('tailBytes') || '').trim();
    const agentId = agentIdParam || DEFAULT_AGENT_ID;
    if (!sessionId || !toolCallId) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'missing_params' }));
      return;
    }

    let tailBytes = undefined;
    if (tailRaw) {
      try {
        const n = Number(tailRaw);
        if (Number.isFinite(n) && n > 0) tailBytes = Math.floor(n);
      } catch {}
    }

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

    if (!meta && !result && !streamTail){
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }

    const payload = {
      ok: true,
      meta: meta || null,
      result: result || null,
      streamTail: streamTail || '',
    };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(payload));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'tool_output_failed', message: e?.message || String(e) }));
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname;
  if (path === '/' || path === '/chat') path = '/index.html';
  const filePath = join(projectRoot, 'web', path.replace(/^\/+/, ''));
  try {
    const data = await readFile(filePath);
    const type = extname(filePath);
    const ct = type === '.html' ? 'text/html; charset=utf-8'
      : type === '.css' ? 'text/css'
      : type === '.js' ? 'text/javascript'
      : type === '.json' ? 'application/json; charset=utf-8'
      : type === '.svg' ? 'image/svg+xml; charset=utf-8'
      : type === '.png' ? 'image/png'
      : type === '.jpg' || type === '.jpeg' ? 'image/jpeg'
      : type === '.gif' ? 'image/gif'
      : type === '.webp' ? 'image/webp'
      : type === '.ico' ? 'image/x-icon'
      : 'application/octet-stream';
    res.writeHead(200, {
      'content-type': ct,
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

function createRequestHandler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // CORS for dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(200).end(); return; }

    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, plugins: (pluginFiles?.length || 0) })); return; }
    if (req.method === 'GET' && url.pathname === '/api/events') { await handleEvents(req, res); return; }

    if (req.method === 'GET' && url.pathname === '/api/env') { await handleGetEnv(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/env') { await handlePostEnv(req, res); return; }

    // Concurrent chat + persistence
    if (req.method === 'POST' && url.pathname === '/api/chat2') { await handleChat2(req, res); return; }

    // Interrupt/steer APIs
    if (req.method === 'POST' && url.pathname === '/api/abort') { await handleAbort(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/steer') { await handleSteer(req, res); return; }

    if (req.method === 'GET' && url.pathname === '/api/agents') { await handleListAgents(req, res); return; }

    // Sessions CRUD
    if (req.method === 'GET' && url.pathname === '/api/sessions') { await handleListSessions(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/sessions') { await handleCreateSession(req, res); return; }
    if (url.pathname.startsWith('/api/sessions/')) {
      const id = url.pathname.slice('/api/sessions/'.length);
      if (req.method === 'GET') { await handleGetSession(req, res, id); return; }
      if (req.method === 'DELETE') { await handleDeleteSession(req, res, id); return; }
    }

    // Utilities
    if (req.method === 'GET' && url.pathname === '/api/local-file') { await handleLocalFile(req, res); return; }
    if (req.method === 'GET' && url.pathname === '/api/doctor') { await handleDoctor(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/support-bundle') { await handleSupportBundle(req, res); return; }
    if (req.method === 'GET' && url.pathname === '/api/config') { await handleGetConfig(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/config') { await handlePostConfig(req, res); return; }
    if (req.method === 'GET' && url.pathname === '/api/agent-config') { await handleGetAgentConfig(req, res); return; }
    if (req.method === 'POST' && url.pathname === '/api/agent-config') { await handlePostAgentConfig(req, res); return; }
    if (req.method === 'GET' && (url.pathname === '/api/timer-settings' || url.pathname === '/api/cron-settings')) { await handleGetTimerSettings(req, res); return; }
    if (req.method === 'POST' && (url.pathname === '/api/timer-settings' || url.pathname === '/api/cron-settings')) { await handlePostTimerSettings(req, res); return; }
    if (req.method === 'GET' && url.pathname === '/api/tool-output') { await handleGetToolOutput(req, res); return; }

    await serveStatic(req, res);
  };
}

export async function startArcanaWebServer({ port, workspaceRoot: wsRoot } = {}) {
  if (wsRoot) { process.env.ARCANA_WORKSPACE = String(wsRoot); try { resetWorkspaceRootCache(); } catch {} }
  workspaceRoot = resolveWorkspaceRoot();
  try { ensureArcanaHomeDir(); await loadVaultFromDisk(); } catch {}
  try { ensureDefaultAgentExists(); } catch {}

  const server = http.createServer(createRequestHandler());
  const desiredPort = typeof port === 'number' ? port : (process.env.PORT ? Number(process.env.PORT) : 5678);
  await new Promise((resolve) => { server.listen(desiredPort, () => resolve()); });
  const bound = server.address();
  const actualPort = bound && typeof bound.port === 'number' ? bound.port : desiredPort;
  console.log('[arcana:web] http://localhost:' + actualPort + '  (plugins: ' + (pluginFiles ? pluginFiles.length : 0) + ')');
  return { server, port: actualPort };
}

// CLI entry:
const isDirectRun = (() => { try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();
if (isDirectRun) {
  const p = process.env.PORT ? Number(process.env.PORT) : 5678;
  // Force a stable workspace root when launched directly from CLI.
  const ws = process.env.ARCANA_WORKSPACE && String(process.env.ARCANA_WORKSPACE).trim()
    ? String(process.env.ARCANA_WORKSPACE).trim()
    : process.cwd();
  startArcanaWebServer({ port: p, workspaceRoot: ws }).catch((e) => { console.error('[arcana:web] failed to start:', e?.stack || e); process.exit(1); });
}
