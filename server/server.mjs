import http from 'node:http';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync, statSync, realpathSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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


import { createMemoryTools } from '../src/tools/memory.js';
import { detectProblemMention, truncateText } from '../src/memory-triggers.js';
const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..'); // arcana/
let workspaceRoot = null; // set on start

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
const dedupeToolFail = new Map(); // key -> lastSeenMs

// Singleton memory tools for direct append without going through the LLM
const memoryTools = createMemoryTools();
const memoryAppendTool = memoryTools.find((t) => t && t.name === 'memory_append');
const reflectionQueueByWs = new Map(); // ws -> Promise chain
const chatSessions = new Map();
const bridgedById = new WeakSet();
// Map sessionId -> Map(skillName -> toolNames[])
const skillToolMapById = new Map();
// For legacy policy sessions (no id), keep last mapping per policy
const policySkillToolMap = new Map(); // key: 'open'|'restricted' -> Map(skill->tools)

// Per-session state for event aggregation
const toolRepeatById = new Map(); // sessionId -> Map(key -> count)
const thinkStatsById = new Map(); // sessionId -> { startedAt, chars }

// Legacy global state (used by /api/chat)
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

async function handleGetEnv(req, res){
  try {
    const vault = vaultMetaForResponse();
    const names = Array.isArray(vault.names) ? vault.names : [];
    const vars = names.map((name) => ({
      name,
      hasValue: !!process.env[name],
      stored: Array.isArray(vault.names) ? vault.names.includes(name) : false,
    }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ vars, vault }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'env_list_failed', message: e?.message || String(e) }));
  }
}

// Set/unset environment variables at runtime + persist to vault.
// Body shape: { set: { VAR: value, ... }, unset: [ 'VAR2', ... ], passphrase?: '...' }
async function handlePostEnv(req, res){
  try {
    const bufs = []; for await (const chunk of req) bufs.push(chunk);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
    const toSet = (body && body.set && typeof body.set === 'object') ? body.set : {};
    const toUnset = Array.isArray(body && body.unset) ? body.unset : [];
    const passphrase = String((body && body.passphrase) || process.env.ARCANA_VAULT_PASSPHRASE || '').trim();

    // First: update vault on disk (may be encrypted)
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

    // Apply simple name validation to live process.env
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
      // Reset model/tool sessions so changes take effect immediately and refresh diagnostics info
      resetSessions();
      try { await ensurePolicySession('restricted'); } catch {}
    }

    // Notify clients: env changed + refreshed server_info
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
  const created = await createArcanaSession({ cwd: workspaceRoot, execPolicy: pol });
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

async function ensureSessionFor(sessionId, policy, cwdForSession) {
  const pol = String(policy || 'restricted').toLowerCase() === 'open' ? 'open' : 'restricted';
  const wsKey = String(cwdForSession || workspaceRoot || '');
  const key = String(sessionId || 'default') + '|' + pol + '|' + wsKey;
  if (chatSessions.has(key)) return chatSessions.get(key);
  const created = await createArcanaSession({ cwd: cwdForSession || workspaceRoot, execPolicy: pol });
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
  ensureEventBridgeForId(sess, sessionId);
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

async function ensureReflectionSession(ws){
  try {
    const key = String(ws || workspaceRoot || '');
    if (reflectionSessionsByWs.has(key)) return reflectionSessionsByWs.get(key);
    const created = await createArcanaSession({ cwd: key, execPolicy: 'restricted' });
    const sess = created.session;
    try { sess.setActiveToolsByName?.(['read','grep','find','ls','memory_search','memory_get','memory_append']); } catch {}
    reflectionSessionsByWs.set(key, sess);
    return sess;
  } catch { return null }
}

function hash(s){ try { return createHash('sha1').update(String(s||'')).digest('hex'); } catch { return String(s||'') } }

function scheduleSopExtraction({ ws, sessionId, toolName, safeArgs, errTextRaw }){
  try {
    const w = String(ws || workspaceRoot || '');
    const key = w + '|' + String(toolName || '?') + '|' + hash(String(safeArgs || '') + '|' + String(errTextRaw || ''));
    if (seenRecentlyTtl(dedupeSop, key, DEDUPE_SOP_TTL_MS)) return; // dedupe within TTL

    const prev = reflectionQueueByWs.get(w) || Promise.resolve();
    let chain = prev.then(async () => {
      try {
        const sess = await ensureReflectionSession(w);
        if (!sess) return;
        const prompt = buildSopExtractionPrompt({ toolName, argsJson: safeArgs, errorText: errTextRaw });
        await runWithContext({ workspaceRoot: w, sessionId }, async () => { try { await sess.prompt(prompt); } catch {} });
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


function ensureEventBridgeForId(sess, sessionId) {
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
            const obj = ssLoad(String(sessionId||'').trim());
            const ws = (obj && obj.workspace) ? String(obj.workspace) : workspaceRoot;
            const pRaw = String(ev.args.path||'');
            const p = pRaw.startsWith('/') ? pRaw : join(ws || '', pRaw);
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
        try {
          const isErr = !!(ev?.isError || ev?.error || (ev?.result && ((ev.result.details && ev.result.details.ok===false) || ev.result.error)));
          if (isErr) {
            // Resolve workspace for this session
            let ws = workspaceRoot;
            try { const obj = ssLoad(String(sessionId||'').trim()); if (obj && obj.workspace) ws = String(obj.workspace); } catch {}

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
              if (memoryAppendTool) {
                const dedupeKey = String(sessionId || 'default') + '|' + hash(String(ev?.toolName || '?') + '|' + safeArgs + '|' + errTextRaw);
                if (!seenRecentlyTtl(dedupeToolFail, dedupeKey, DEDUPE_TRIGGER_TTL_MS)) {
                  const shortArgs = truncateText(safeArgs);
                  const shortErr = truncateText(errTextRaw);
                  const content = 'args: ' + shortArgs + '\n\nerror: ' + shortErr;
                  runWithContext({ workspaceRoot: ws, sessionId }, async () => {
                    try {
                      const r = await memoryAppendTool.execute('srv-tool-fail', { target:'daily', heading: 'tool_fail:' + String(ev?.toolName || '?'), content });
                      const ok = !!(r && r.details && r.details.ok);
                      if (ok) { try { broadcast({ type: 'memory_trigger', kind: 'tool_fail', toolName: ev?.toolName || '?', sessionId, path: r.details && r.details.path }); } catch {} }
                    } catch {}
                  });
                }
              }
            } catch {}

            scheduleSopExtraction({ ws, sessionId, toolName: ev?.toolName || '?', safeArgs, errTextRaw });
          }
        } catch {}
      }

      // Turn lifecycle
      if (ev.type === 'turn_start') broadcast({ type: 'turn_start', sessionId });
      if (ev.type === 'turn_end') broadcast({ type: 'turn_end', sessionId });

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

      // Assistant streaming (text/images)
      if (ev.type === 'message_update' && ev.message && ev.message.role === 'assistant') {
        try {
          const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) broadcast({ type: 'assistant_text', text, sessionId });
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
          const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          if (text) broadcast({ type: 'assistant_text', text });
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
      if (memoryAppendTool && detectProblemMention(message)) {
        const key = 'legacy' + '|' + hash(message);
        if (!seenRecentlyTtl(dedupeUserIssue, key, DEDUPE_TRIGGER_TTL_MS)) {
          await runWithContext({ workspaceRoot }, async () => {
            try { await memoryAppendTool.execute('srv-user-issue', { target:'daily', heading:'user_issue', content: message }); } catch {}
          });
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
    let sessionId = String(body.sessionId || '').trim();
    if (!message) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_message' })); return; }
    if (!sessionId) { const created = ssCreate({ title: '新会话' }); sessionId = created.id; }

    // Load session object and determine its workspace
    const obj0 = ssLoad(sessionId);
    const ws = (obj0 && obj0.workspace) ? String(obj0.workspace) : workspaceRoot;
    if (obj0 && !obj0.workspace) { try { obj0.workspace = ws; ssSave(obj0); } catch {} }

    const sess = await ensureSessionFor(sessionId, policy, ws);
    applyExecPolicyToSession(sess, policy);
    // If user explicitly invoked a skill via a skill block (/skill:name), activate its tools
    try {
      const blk = parseSkillBlock(message);
      if (blk && blk.name) activateToolsForSkill({ sess, sessionId, skillName: String(blk.name), policy });
    } catch {}

    // Tier1: user_issue detection -> direct daily memory append (deduped)
    try {
      if (memoryAppendTool && detectProblemMention(message)) {
        const key = String(sessionId || 'default') + '|' + hash(message);
        if (!seenRecentlyTtl(dedupeUserIssue, key, DEDUPE_TRIGGER_TTL_MS)) {
          await runWithContext({ sessionId, workspaceRoot: ws }, async () => {
            try { await memoryAppendTool.execute('srv-user-issue', { target:'daily', heading:'user_issue', content: message }); } catch {}
          });
        }
      }
    } catch {}
    // Persist user message and build context prelude
    ssAppend(sessionId, { role: 'user', text: message });
    const obj = ssLoad(sessionId);
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
              ssAppend(sessionId, { role: 'assistant', text });
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
        await runWithContext({ sessionId, workspaceRoot: ws }, () =>
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
      await runWithContext({ sessionId, workspaceRoot: ws }, () => sess.prompt(payloadMsg));
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
        const cur = ssLoad(sessionId);
        const msgs = (cur && Array.isArray(cur.messages)) ? cur.messages : [];
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        if (persistedCount === 0 || !last || last.role !== 'assistant' || String(last.text || '') !== String(lastAssistantText)) {
          ssAppend(sessionId, { role: 'assistant', text: lastAssistantText });
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
    if (!sessionId) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_sessionId' })); return; }

    const obj0 = ssLoad(sessionId);
    const ws = (obj0 && obj0.workspace) ? String(obj0.workspace) : workspaceRoot;
    const policy = String(body.policy || '').toLowerCase() === 'open' ? 'open' : 'restricted';
    const sess = await ensureSessionFor(sessionId, policy, ws);
    applyExecPolicyToSession(sess, policy);

    try { await runWithContext({ sessionId, workspaceRoot: ws }, () => sess.abort()); } catch {}
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
    if (!message) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_message' })); return; }
    if (!sessionId) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing_sessionId' })); return; }

    // Persist user message and build prelude like chat2 for consistency
    ssAppend(sessionId, { role: 'user', text: message });
    const obj0 = ssLoad(sessionId);
    const ws = (obj0 && obj0.workspace) ? String(obj0.workspace) : workspaceRoot;
    const prelude = ssPrelude(obj0);
    const payloadMsg = (prelude ? prelude + '\n\n' : '') + '[Current Question]\n' + message;

    const sess = await ensureSessionFor(sessionId, policy, ws);
    applyExecPolicyToSession(sess, policy);
    try {
      await runWithContext({ sessionId, workspaceRoot: ws }, () =>
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
    const obj = sid ? ssLoad(sid) : null;
    const ws = (obj && obj.workspace) ? String(obj.workspace) : workspaceRoot;
    const filePath = runWithContext({ sessionId: sid || undefined, workspaceRoot: ws }, () => ensureReadAllowed(p));
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
    const obj = sid ? ssLoad(sid) : null;
    const ws = (obj && obj.workspace) ? String(obj.workspace) : workspaceRoot;
    const result = await runWithContext({ sessionId: sid || undefined, workspaceRoot: ws }, () => runDoctor({ cwd: ws }));
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
    const obj = sid ? ssLoad(sid) : null;
    const ws = (obj && obj.workspace) ? String(obj.workspace) : workspaceRoot;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDirRaw = join(ws, 'artifacts', 'support-' + stamp);
    const outDir = runWithContext({ sessionId: sid || undefined, workspaceRoot: ws }, () => ensureWriteAllowed(outDirRaw));
    const { dir, tarPath } = await createSupportBundle({ outDir, cwd: ws });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, dir, tarPath: tarPath || '' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'support_bundle_failed', message: e?.message || String(e) }));
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

// Sessions CRUD
async function handleListSessions(req, res) {
  try { const items = ssList(); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ sessions: items })); }
  catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'list_failed', message: e?.message || String(e) })); }
}

async function handleCreateSession(req, res) {
  try {
    const bufs = []; for await (const c of req) bufs.push(c);
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf-8')) : {};
    const title = String(body.title || '新会话').trim();
    const workspace = String(body.workspace || '').trim();
    if (!workspace) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workspace_required' })); return; }
    // Validate directory exists and canonicalize
    if (!existsSync(workspace)) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workspace_invalid' })); return; }
    let canonical = '';
    try { canonical = realpathSync(workspace); } catch { canonical = workspace; }
    try { const st = statSync(canonical); if (!st.isDirectory()) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workspace_invalid' })); return; } } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workspace_invalid' })); return; }
    const obj = ssCreate({ title, workspace: canonical });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'create_failed', message: e?.message || String(e) }));
  }
}

async function handleGetSession(req, res, id) {
  try { const obj = ssLoad(String(id || '').trim()); if (!obj) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' })); return; } res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj)); }
  catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'get_failed', message: e?.message || String(e) })); }
}

// DELETE /api/sessions/:id
async function handleDeleteSession(req, res, id) {
  try {
    let decoded = '';
    try { decoded = decodeURIComponent(String(id || '').trim()); } catch { decoded = String(id || '').trim(); }
    const ok = ssDelete(decoded);
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
