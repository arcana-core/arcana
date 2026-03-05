import http from 'node:http';
import { readFile, writeFile, chmod } from 'node:fs/promises';
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
import { loadArcanaConfig } from '../src/config.js';
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
import { buildSopExtractionPrompt } from '../src/memory-reflection.js';
import { arcanaHomePath, ensureArcanaHomeDir } from '../src/arcana-home.js';
// Tier1 memory triggers (direct daily append)


import { detectProblemMention, detectCorrectionMention, truncateText } from '../src/memory-triggers.js';
const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..'); // arcana/
let workspaceRoot = null; // set on start

const DEFAULT_AGENT_ID = 'default';

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
const SOP_EXTRACTION_ENABLED = envFlagDefaultTrue('ARCANA_SOP_EXTRACTION');

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
  writeIfMissing('AGENTS.md',
    '# Agent Home\n\n' +
    'This directory belongs to agent "' + safeId + '".\n' +
    'Use this file for agent-level rules, routing notes, and shared context.\n');
  writeIfMissing('MEMORY.md',
    '# MEMORY\n\n' +
    'Use this file to capture long-term notes, decisions, and links for agent "' + safeId + '".\n');
  writeIfMissing('SOUL.md',
    '# SOUL.md - Who You Are\n\n' +
    'Describe the persona, tone, and boundaries for this agent.\n');
  writeIfMissing('USER.md',
    '# USER.md - Who I Am\n\n' +
    'Describe the primary user or team this agent serves, plus preferences and constraints.\n');
  writeIfMissing('TOOLS.md',
    '# TOOLS.md - Tools and Capabilities\n\n' +
    'List important tools, APIs, and workflows this agent should know about.\n');

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


// Legacy per-policy sessions used by /api/chat
const sessionsByPolicy = new Map();
let pluginFiles = [];
let toolNames = [];
let model;
let skillNames = [];

// Apply execution policy to a session by toggling active tools.
// - Always enable safe read-only tools: read, grep, find, ls
// - Enable bash only when policy === "open"
// - Always remove edit/write tools
// - Preserve any currently active custom/extension tools
function applyExecPolicyToSession(sess, policy) {
  try {
    const desired = new Set(sess.getActiveToolNames?.() || []);
    ['read','grep','find','ls'].forEach((t) => desired.add(t));
    if (String(policy || '').toLowerCase() === 'open') desired.add('bash');
    else desired.delete('bash');
    desired.delete('edit');
    desired.delete('write');
    const list = Array.from(desired);
    sess.setActiveToolsByName?.(list);
    // Keep a copy for diagnostics broadcast on new SSE connections
    toolNames = list;
  } catch {}
}


// Per-session (id+policy+cwd) sessions used by /api/chat2

// Reflection/SOP extraction infra (per workspace)
const DEDUPE_SOP_TTL_MS = 24*60*60*1000;
const dedupeSop = new Map(); // key -> lastSeenMs
const reflectionSessionsByWs = new Map(); // ws -> session
// Tier1 trigger dedupe (per workspace/session) — keep small TTL; best effort
const DEDUPE_TRIGGER_TTL_MS = 10*60*1000; // 10 minutes
const dedupeUserIssue = new Map(); // key -> lastSeenMs
const dedupeUserCorrection = new Map(); // key -> lastSeenMs
const dedupeToolFail = new Map(); // key -> lastSeenMs
const reflectionQueueByWs = new Map(); // ws -> Promise chain
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
// Legacy global state (used by /api/chat)
const legacyMediaRefsByTurn = new Set();
const bridgedSessions = new WeakSet();
const toolRepeat = new Map();
let thinkStats = null;

// SSE clients
const clients = new Set(); // Response objects
let subagentHooked = false;

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
  const key = String(sessionId || 'default') + '|' + pol + '|' + String(ws || '');
  if (chatSessions.has(key)) return chatSessions.get(key);

  const effectiveAgentId = agentId || DEFAULT_AGENT_ID;
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

async function ensureReflectionSession(ws, agentHomeDir){
  try {
    const key = String(ws || workspaceRoot || '');
    if (reflectionSessionsByWs.has(key)) return reflectionSessionsByWs.get(key);
    const created = await createArcanaSession({ workspaceRoot: key, agentHomeRoot: agentHomeDir, execPolicy: 'restricted' });
    const sess = created.session;
    try { sess.setActiveToolsByName?.(['read','grep','find','ls','memory_search','memory_get']); } catch {}
    reflectionSessionsByWs.set(key, sess);
    return sess;
  } catch { return null }
}

function hash(s){ try { return createHash('sha1').update(String(s||'')).digest('hex'); } catch { return String(s||'') } }

function scheduleSopExtraction({ ws, sessionId, agentId, toolName, safeArgs, errTextRaw }){
  try {
    if (!SOP_EXTRACTION_ENABLED) return;
    const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
    const agentHomeDir = arcanaHomePath('agents', effectiveAgentId);
    const w = String(ws || workspaceRoot || '');
    const key = effectiveAgentId + '|' + w + '|' + String(toolName || '?') + '|' + hash(String(safeArgs || '') + '|' + String(errTextRaw || ''));
    if (seenRecentlyTtl(dedupeSop, key, DEDUPE_SOP_TTL_MS)) return; // dedupe within TTL

    const prev = reflectionQueueByWs.get(w) || Promise.resolve();
    let chain = prev.then(async () => {
      try {
        await runWithContext({ sessionId, agentId: effectiveAgentId, agentHomeRoot: agentHomeDir, workspaceRoot: w }, async () => {
          const sess = await ensureReflectionSession(w, agentHomeDir);
          if (!sess) return;
          const prompt = buildSopExtractionPrompt({ toolName, argsJson: safeArgs, errorText: errTextRaw });
          let sopText = '';
          const unsub = sess.subscribe((ev) => {
            try {
              if (ev && ev.type === 'message_end' && ev.message && ev.message.role === 'assistant'){
                const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
                const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
                if (text) sopText = text;
              }
            } catch {}
          });
          try { await sess.prompt(prompt); } catch {}
          try { unsub && unsub(); } catch {}
          if (sopText) {
            let normalized = '';
            try {
              const trimmed = String(sopText || '').trim();
              if (trimmed) {
                const parts = trimmed.split(/\r?\n/);
                if (parts.length && /^sop:/i.test(parts[0].trim())) {
                  parts.shift();
                }
                normalized = parts.join('\n').trim();
              }
            } catch {}
            if (normalized) {
              appendToAgentLongtermMemory({ agentHomeDir, heading: 'sop:' + String(toolName || '?'), content: normalized });
            }
          }
        });
      } catch {}
      finally { try { broadcast({ type: 'memory_trigger', kind: 'sop_extract', toolName, sessionId }); } catch {} }
    });
    chain = chain.catch(() => {});
    reflectionQueueByWs.set(w, chain);
  } catch {}
}

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
        broadcast(ev);
      });
    } catch {}
  }
  const effectiveAgentId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
  const effectiveAgentHome = agentHomeDir || arcanaHomePath('agents', effectiveAgentId);
  const effectiveWorkspace = String(ws || workspaceRoot || '');
  const toolArgsByCallId = new Map(); // toolCallId -> args snapshot for SOP context
  sess.subscribe((ev) => {
    try {
          // Tool repeat aggregation (per-session)
      if (ev.type === 'tool_execution_start') {
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
      if (ev.type === 'tool_execution_update') {
        try { broadcast({ type: 'tool_execution_update', toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args || {}, partialResult: ev.partialResult, sessionId }); } catch {}
      }
      if (ev.type === 'tool_execution_end') {
        try { broadcast({ type: 'tool_execution_end', toolCallId: ev.toolCallId, toolName: ev.toolName, result: ev.result, isError: ev.isError, error: ev.error, sessionId }); } catch {}
        // Best-effort SOP extraction on tool failures (deduped + serialized per workspace)
        if (String(ev.toolName||'') === "codex"){ const sidKey=String(sessionId||"default"); const t=Number((ev && ev.result && ev.result.details && ev.result.details.usage && (ev.result.details.usage.totalTokens || ev.result.details.usage.total_tokens)) || 0) || 0; if (t>0){ sessionUsageTotalsById.set(sidKey, (sessionUsageTotalsById.get(sidKey)||0)+t); } }
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

            // Tier1: direct daily memory append of the failure (deduped), keep SOP extraction infra intact
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

            if (SOP_EXTRACTION_ENABLED) {
              scheduleSopExtraction({ ws: effectiveWorkspace, sessionId, agentId: effectiveAgentId, toolName: ev?.toolName || '?', safeArgs, errTextRaw });
            }
          }
        } catch {}
      }

      // Turn lifecycle
      if (ev.type === 'turn_start') {
        try { mediaRefsByTurn.delete(String(sessionId || 'default')); } catch {}
        broadcast({ type: 'turn_start', sessionId });
      }
      if (ev.type === 'turn_end') {
        try { mediaRefsByTurn.delete(String(sessionId || 'default')); } catch {}
        broadcast({ type: 'turn_end', sessionId, sessionTokens: (sessionUsageTotalsById.get(String(sessionId||'default')) || 0) });
      }

      // Thinking lifecycle (per-session)
      if (ev.type === 'thinking_start') {
        thinkStatsById.set(sessionId, { startedAt: Date.now(), chars: 0 });
        broadcast({ type: 'thinking_start', sessionId });
      }
      if (ev.type === 'thinking_delta') {
        const st = thinkStatsById.get(sessionId);
        if (st) {
          try {
            const size = JSON.stringify(ev.delta || ev).length;
            st.chars += size;
            broadcast({ type: 'thinking_progress', chars: st.chars, sessionId });
          } catch {}
        }
      }
      if (ev.type === 'thinking_end') {
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
      if (ev && ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
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
            try { broadcast({ type: 'llm_usage', sessionId, contextTokens: ctx, outputTokens: out, totalTokens: tot, sessionTokens: next }); } catch {}
          }
        } catch {}
      }
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
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
function send(res, payload) { try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch {} }
function broadcast(ev) { for (const res of clients) send(res, ev); }

async function handleEvents(req, res) {
  await ensurePolicySession('restricted');
  res.writeHead(200, sseHeaders());
  clients.add(res);
  const modelLabel = model ? (model.provider + ':' + model.id + (model.baseUrl ? (' @ ' + model.baseUrl) : '')) : '<auto>';
  send(res, { type: 'server_info', model: modelLabel, tools: toolNames, plugins: pluginFiles, workspace: workspaceRoot, skills: skillNames });
  req.on('close', () => { try { clients.delete(res); } catch {} });
}

// Legacy single-session endpoint
async function handleChat(req, res) {
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const message = String(body.message || '').trim();
    const policy = String(body.policy || '').toLowerCase() === 'open' ? 'open' : 'restricted';
    if (!message) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_message' })); return; }
    const sess = await ensurePolicySession(policy);
    applyExecPolicyToSession(sess, policy);
    // Tier1: user_issue detection -> direct daily memory append (deduped)
    try {
      if (MEMORY_TRIGGERS_ENABLED && detectProblemMention(message)) {
        const key = 'legacy' + '|' + hash(message);
        if (!seenRecentlyTtl(dedupeUserIssue, key, DEDUPE_TRIGGER_TTL_MS)) {
          const effectiveAgentId = DEFAULT_AGENT_ID;
          const agentHomeDir = arcanaHomePath('agents', effectiveAgentId);
          const content = truncateText(message);
          appendToAgentDailyMemory({ agentHomeDir, heading: 'user_issue', content });
        }
      }
      if (MEMORY_TRIGGERS_ENABLED && detectCorrectionMention(message)) {
        const keyCorr = 'legacy' + '|corr|' + hash(message);
        if (!seenRecentlyTtl(dedupeUserCorrection, keyCorr, DEDUPE_TRIGGER_TTL_MS)) {
          const effectiveAgentId = DEFAULT_AGENT_ID;
          const agentHomeDir = arcanaHomePath('agents', effectiveAgentId);
          const content = truncateText(message);
          appendToAgentDailyMemory({ agentHomeDir, heading: 'user_correction', content });
        }
      }
    } catch {}
    let out = '';
    const unsub = sess.subscribe((ev) => {
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const text = (Array.isArray(ev.message.content) ? ev.message.content : []).filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) out = text;
        } catch {}
      }
    });
    try { await sess.prompt(message); } catch {}
    try { unsub && unsub(); } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ text: out }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server_error', message: e?.message || String(e) }));
  }
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

    // Persist user message and build context prelude
    ssAppend(sessionId, { role: 'user', text: message, agentId });
    const obj = ssLoad(sessionId, { agentId });
    if (obj) {
      let changed = false;
      if (agentId && !obj.agentId) { obj.agentId = agentId; changed = true; }
      if (changed) { try { ssSave(obj, { agentId }); } catch {} }
    }
    const prelude = ssPrelude(obj);
    const payloadMsg = (prelude ? prelude + '\n\n' : '') + '[Current Question]\n' + message;
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
      } catch {}
      try { unsub && unsub(); } catch {}
      // For steer, we reply immediately; front-end will continue via SSE.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ text: '' }));
      return;
    }

    // Normal path: not streaming -> start a new agent turn
    let promptError = null;
    try {
      await runWithContext(ctxBase, () => sess.prompt(payloadMsg));
    } catch (e) {
      promptError = e;
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

    const ctx = resolveSessionContext(sessionId, agentId);
    const ws = ctx.workspaceRoot || workspaceRoot;
    const policy = String(body.policy || '').toLowerCase() === 'open' ? 'open' : 'restricted';
    const sess = await ensureSessionFor(sessionId, policy, ws, ctx.agentId, ctx.agentHomeDir);
    applyExecPolicyToSession(sess, policy);

    try { await runWithContext({ sessionId, agentId: ctx.agentId, agentHomeRoot: ctx.agentHomeDir, workspaceRoot: ws }, () => sess.abort()); } catch {}
    try { broadcast({ type: 'abort_done', sessionId }); } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
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

    // Persist user message and build prelude like chat2 for consistency
    ssAppend(sessionId, { role: 'user', text: message, agentId });
    const ctx = resolveSessionContext(sessionId, agentId);
    const ws = ctx.workspaceRoot || workspaceRoot;
    const prelude = ssPrelude(ctx.session);
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
      : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
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
    // Legacy chat
    if (req.method === 'POST' && url.pathname === '/api/chat') { await handleChat(req, res); return; }

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
