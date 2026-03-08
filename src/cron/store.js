import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceRoot, ensureReadAllowed, ensureWriteAllowed } from '../workspace-guard.js';
import { computeNextRun } from './schedule.js';
import { getContext, runWithContext } from '../event-bus.js';

const DEFAULT_AGENT_ID = 'default';

// Default per-agent history compaction thresholds for cron agentTurn
// payloads. Stored under .arcana/agents/<agentId>/cron/settings.json.
const DEFAULT_CRON_COMPACTION = {
  thresholdTokens: 200000,
  fallbackBytes: 600000,
  keepRecentMessages: 50,
};

function nowIso(){ return new Date().toISOString(); }
function nowMs(){ return Date.now(); }

function normalizeAgentId(raw){
  try {
    const s = String(raw || '').trim();
    if (!s) return DEFAULT_AGENT_ID;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function normalizeSessionId(raw){
  try {
    const s = String(raw || '').trim();
    if (!s) return null;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    if (!safe) return null;
    return safe;
  } catch {
    return null;
  }
}

function withWorkspaceRoot(workspaceRoot, fn){
  if (typeof fn !== 'function') return undefined;
  if (!workspaceRoot) return fn();
  const cur = getContext?.() || {};
  const ctx = { ...cur, workspaceRoot };
  return runWithContext ? runWithContext(ctx, fn) : fn();
}

function resolveWorkspaceRootForOptions(options){
  const optRoot = options && options.workspaceRoot;
  if (!optRoot) return resolveWorkspaceRoot();
  return withWorkspaceRoot(optRoot, () => resolveWorkspaceRoot());
}

function ensureReadInWorkspace(path, workspaceRoot){
  return withWorkspaceRoot(workspaceRoot, () => ensureReadAllowed(path));
}

function ensureWriteInWorkspace(path, workspaceRoot){
  return withWorkspaceRoot(workspaceRoot, () => ensureWriteAllowed(path));
}

function resolveAgentContext(options){
  const ctx = getContext?.() || {};
  const workspaceRoot = resolveWorkspaceRootForOptions(options || {});
  const agentIdRaw = (options && options.agentId) || ctx.agentId || DEFAULT_AGENT_ID;
  const agentId = normalizeAgentId(agentIdRaw);
  return { workspaceRoot, agentId };
}

function ensureCronBaseDir(workspaceRoot, agentId){
  const base = join(workspaceRoot, '.arcana', 'agents', agentId, 'cron');
  if (!existsSync(base)) mkdirSync(ensureWriteInWorkspace(base, workspaceRoot), { recursive: true });
  return base;
}

function jobsPath(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureCronBaseDir(workspaceRoot, agentId);
  return join(baseDir, 'jobs.json');
}

function runsPath(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureCronBaseDir(workspaceRoot, agentId);
  return join(baseDir, 'runs.jsonl');
}

function logsDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureCronBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'logs');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function locksDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureCronBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'locks');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function lockFilePath(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureCronBaseDir(workspaceRoot, agentId);
  return join(baseDir, 'jobs.lock');
}

function settingsPath(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureCronBaseDir(workspaceRoot, agentId);
  return join(baseDir, 'settings.json');
}

// If cron/settings.json is missing but legacy timer/settings.json exists
// for the same agent, copy it once so compaction thresholds carry over.
function maybeMigrateLegacyCronSettings(env){
  try {
    const workspaceRoot = env && env.workspaceRoot;
    const agentId = env && env.agentId;
    if (!workspaceRoot) return;
    const normalized = normalizeAgentId(agentId);
    if (!normalized) return;

    const cronDir = ensureCronBaseDir(workspaceRoot, normalized);
    const cronSettings = join(cronDir, 'settings.json');
    if (existsSync(cronSettings)) return;

    const legacyDir = join(workspaceRoot, '.arcana', 'agents', normalized, 'timer');
    const legacySettings = join(legacyDir, 'settings.json');
    if (!existsSync(legacySettings)) return;

    const src = ensureReadInWorkspace(legacySettings, workspaceRoot);
    const dst = ensureWriteInWorkspace(cronSettings, workspaceRoot);
    const data = readFileSync(src, 'utf-8');
    writeFileSync(dst, data, 'utf-8');
  } catch {}
}

// Basic lock around jobs.json writes to avoid corruption across concurrent processes.
// We create .lock with O_EXCL and remove it after the write. If lock exists and is stale (>30s), steal it.
function acquireLock(timeoutMs = 5000, options){
  const env = resolveAgentContext(options);
  const path = lockFilePath(options);
  const start = Date.now();
  while (Date.now() - start < timeoutMs){
    try {
      const fd = openSync(ensureWriteInWorkspace(path, env.workspaceRoot), 'wx');
      closeSync(fd);
      return true;
    } catch {}
    // check staleness
    try {
      const st = statSync(ensureReadInWorkspace(path, env.workspaceRoot));
      if (Date.now() - st.mtimeMs > 30000) {
        try { unlinkSync(ensureWriteInWorkspace(path, env.workspaceRoot)); } catch {}
      }
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

function releaseLock(options){
  const env = resolveAgentContext(options);
  try { unlinkSync(ensureWriteInWorkspace(lockFilePath(options), env.workspaceRoot)); } catch {}
}

export function listJobs(options){
  const env = resolveAgentContext(options);
  const p = jobsPath(options);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(ensureReadInWorkspace(p, env.workspaceRoot), 'utf-8'));
    if (Array.isArray(raw)) return raw;
  } catch {}
  return [];
}

export function loadCronSettings(options){
  const env = resolveAgentContext(options);
  maybeMigrateLegacyCronSettings(env);
  const p = settingsPath(options);
  const base = { compaction: { ...DEFAULT_CRON_COMPACTION } };
  if (!existsSync(p)) return base;
  try {
    const raw = JSON.parse(readFileSync(ensureReadInWorkspace(p, env.workspaceRoot), 'utf-8'));
    const out = { compaction: { ...DEFAULT_CRON_COMPACTION } };
    if (raw && typeof raw === 'object'){
      const src = raw.compaction && typeof raw.compaction === 'object' ? raw.compaction : raw;
      const t = Number(src.thresholdTokens);
      const fb = Number(src.fallbackBytes);
      const fc = Number(src.fallbackChars);
      const k = Number(src.keepRecentMessages);
      if (Number.isFinite(t) && t > 0) out.compaction.thresholdTokens = t;
      if (Number.isFinite(fb) && fb > 0) { out.compaction.fallbackBytes = fb; }
      else if (Number.isFinite(fc) && fc > 0) { out.compaction.fallbackBytes = fc; }
      if (Number.isFinite(k) && k > 0) out.compaction.keepRecentMessages = k;
    }
    return out;
  } catch {
    return base;
  }
}

export function saveCronSettings(settings, options){
  const env = resolveAgentContext(options);
  maybeMigrateLegacyCronSettings(env);
  const p = settingsPath(options);
  const tmp = p + '.tmp';
  const current = loadCronSettings(options) || { compaction: { ...DEFAULT_CRON_COMPACTION } };
  const incoming = settings && typeof settings === 'object' ? settings : {};
  const srcComp = incoming.compaction && typeof incoming.compaction === 'object' ? incoming.compaction : incoming;

  const baseComp = current.compaction && typeof current.compaction === 'object' ? current.compaction : { ...DEFAULT_CRON_COMPACTION };
  const nextComp = { ...DEFAULT_CRON_COMPACTION, ...baseComp };

  function pickNumber(v){
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? n : null;
  }

  const t = pickNumber(srcComp.thresholdTokens);
  const fb = pickNumber(srcComp.fallbackBytes);
  const fcLegacy = pickNumber(srcComp.fallbackChars);
  const k = pickNumber(srcComp.keepRecentMessages);
  if (t != null) nextComp.thresholdTokens = t;
  if (fb != null) nextComp.fallbackBytes = fb;
  else if (fcLegacy != null && (fb == null)) nextComp.fallbackBytes = fcLegacy;
  if (k != null) nextComp.keepRecentMessages = k;

  const finalSettings = { compaction: nextComp };

  writeFileSync(ensureWriteInWorkspace(tmp, env.workspaceRoot), JSON.stringify(finalSettings, null, 2), 'utf-8');
  renameSync(tmp, ensureWriteInWorkspace(p, env.workspaceRoot));
  return finalSettings;
}

function saveJobsArray(arr, options){
  const env = resolveAgentContext(options);
  const p = jobsPath(options);
  const tmp = p + '.tmp';
  if (!acquireLock(5000, options)) throw new Error('cron_store_lock_timeout');
  try {
    writeFileSync(ensureWriteInWorkspace(tmp, env.workspaceRoot), JSON.stringify(arr, null, 2), 'utf-8');
    renameSync(tmp, ensureWriteInWorkspace(p, env.workspaceRoot));
  } finally { releaseLock(options); }
}

function genId(title){
  const stamp = nowIso().replace(/[:.]/g,'-').replace('T','_').replace('Z','');
  const slug = String(title||'job').toLowerCase().trim().replace(/[^a-z0-9\-\_\s]+/g,'').replace(/\s+/g,'-').slice(0,40) || 'job';
  const rand = Math.random().toString(36).slice(2, 8);
  return stamp + '--' + slug + '-' + rand;
}

function normalizeSessionTarget(raw){
  const s = String(raw || '').trim().toLowerCase();
  return s === 'isolated' ? 'isolated' : 'main';
}

function normalizeDelivery(raw){
  const base = raw && typeof raw === 'object' ? raw : {};
  const modeRaw = base.mode != null ? String(base.mode).trim().toLowerCase() : 'none';
  const mode = modeRaw === 'announce' ? 'announce' : 'none';
  const out = { mode };
  const sid = base.sessionId != null ? String(base.sessionId).trim() : '';
  if (sid) out.sessionId = sid;
  return out;
}

function normalizePayload(raw){
  const pl = raw && typeof raw === 'object' ? raw : null;
  if (!pl || !pl.kind) throw new Error('invalid_payload');
  const kindRaw = String(pl.kind).toLowerCase();
  if (kindRaw === 'exec'){
    const cmd = String(pl.command || '').trim();
    if (!cmd) throw new Error('exec_missing_command');
    return { kind: 'exec', command: cmd };
  }
  if (kindRaw === 'agentturn' || kindRaw === 'agent_turn' || kindRaw === 'agentturntask' || kindRaw === 'arcana'){
    const prompt = String(pl.prompt || '').trim();
    if (!prompt) throw new Error('agentTurn_missing_prompt');
    const out = { kind: 'agentTurn', prompt };
    if (Object.prototype.hasOwnProperty.call(pl, 'timeoutMs')){
      const n = Number(pl.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) throw new Error('agentTurn_invalid_timeout');
      out.timeoutMs = n;
    }
    return out;
  }
  if (kindRaw === 'agentturn'.toLowerCase()){
    const prompt = String(pl.prompt || '').trim();
    if (!prompt) throw new Error('agentTurn_missing_prompt');
    const out = { kind: 'agentTurn', prompt };
    if (Object.prototype.hasOwnProperty.call(pl, 'timeoutMs')){
      const n = Number(pl.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) throw new Error('agentTurn_invalid_timeout');
      out.timeoutMs = n;
    }
    return out;
  }
  throw new Error('unknown_payload_kind');
}

export function addJob({ title, schedule, payload, sessionTarget, delivery, enabled = true }, options){
  const t = String(title||'').trim() || 'Cron Job';
  const s = schedule && typeof schedule === 'object' ? schedule : null;
  if (!s || !s.type) throw new Error('invalid_schedule');

  const normalizedPayload = normalizePayload(payload);
  const target = normalizeSessionTarget(sessionTarget);
  const deliveryObj = normalizeDelivery(delivery);

  const obj = {
    id: genId(t),
    title: t,
    enabled: Boolean(enabled),
    schedule: {
      type: String(s.type).toLowerCase(),
      value: s.value || s.expr || s.at || s.every || s.cron || '',
      timezone: (s.timezone||'local')
    },
    payload: normalizedPayload,
    sessionTarget: target,
    delivery: deliveryObj,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastStatus: null,
  };
  obj.nextRunAtMs = computeNextRun(obj.schedule, nowMs());

  const arr = listJobs(options);
  arr.push(obj);
  saveJobsArray(arr, options);
  return obj;
}

export function findJob(id, options){
  const arr = listJobs(options);
  return arr.find((j)=> j.id === id) || null;
}

export function saveJob(job, options){
  const arr = listJobs(options);
  const idx = arr.findIndex((j)=> j.id === job.id);
  if (idx === -1) throw new Error('job_not_found');
  arr[idx] = job;
  saveJobsArray(arr, options);
  return job;
}

export function removeJob(id, options){
  const arr = listJobs(options);
  const next = arr.filter((j)=> j.id !== id);
  saveJobsArray(next, options);
  return arr.length !== next.length;
}

export function enableJob(id, options){
  const arr = listJobs(options);
  const j = arr.find((x)=> x.id === id);
  if (!j) throw new Error('job_not_found');
  j.enabled = true;
  j.updatedAt = nowIso();
  if (!j.nextRunAtMs) j.nextRunAtMs = computeNextRun(j.schedule, nowMs());
  saveJobsArray(arr, options);
  return j;
}

export function disableJob(id, options){
  const arr = listJobs(options);
  const j = arr.find((x)=> x.id === id);
  if (!j) throw new Error('job_not_found');
  j.enabled = false;
  j.updatedAt = nowIso();
  saveJobsArray(arr, options);
  return j;
}

export function patchJob(id, patch, options){
  const arr = listJobs(options);
  const j = arr.find((x)=> x.id === id);
  if (!j) throw new Error('job_not_found');
  let resched = false;
  if (typeof patch.title === 'string' && patch.title.trim()) { j.title = patch.title.trim(); }
  if (typeof patch.enabled === 'boolean') { j.enabled = patch.enabled; }
  if (patch.schedule && typeof patch.schedule === 'object'){
    const s = patch.schedule;
    if (s.type) j.schedule.type = String(s.type).toLowerCase();
    if (s.value || s.expr || s.at || s.every || s.cron) j.schedule.value = s.value || s.expr || s.at || s.every || s.cron;
    if (s.timezone) j.schedule.timezone = s.timezone;
    resched = true;
  }
  if (patch.payload && typeof patch.payload === 'object'){
    const baseKind = (j.payload && j.payload.kind) || 'exec';
    const kindRaw = patch.payload.kind ? String(patch.payload.kind).toLowerCase() : String(baseKind).toLowerCase();
    if (kindRaw === 'exec'){
      const next = { kind: 'exec', command: j.payload && j.payload.command };
      if (typeof patch.payload.command === 'string') next.command = patch.payload.command;
      if (!String(next.command||'').trim()) throw new Error('exec_missing_command');
      j.payload = next;
    } else {
      const merged = { ...j.payload, ...patch.payload };
      j.payload = normalizePayload(merged);
    }
  }
  if (patch.sessionTarget){
    j.sessionTarget = normalizeSessionTarget(patch.sessionTarget);
  }
  if (patch.delivery && typeof patch.delivery === 'object'){
    const cur = j.delivery && typeof j.delivery === 'object' ? j.delivery : { mode: 'none' };
    const merged = { ...cur, ...patch.delivery };
    j.delivery = normalizeDelivery(merged);
  }
  if (resched) j.nextRunAtMs = computeNextRun(j.schedule, nowMs());
  j.updatedAt = nowIso();
  saveJobsArray(arr, options);
  return j;
}

export function appendRun(rec, options){
  const env = resolveAgentContext(options);
  const line = JSON.stringify(rec) + '\n';
  const p = runsPath(options);
  appendFileSync(ensureWriteInWorkspace(p, env.workspaceRoot), line, { encoding: 'utf-8' });
}

export function listRuns({ limit = 50 } = {}, options){
  const env = resolveAgentContext(options);
  const p = runsPath(options);
  if (!existsSync(p)) return [];
  try {
    const text = readFileSync(ensureReadInWorkspace(p, env.workspaceRoot), 'utf-8');
    const lines = text.split('\n').filter(Boolean);
    const tail = lines.slice(-Math.max(1, Math.min(500, limit)));
    return tail.map((l)=>{ try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function jobLogDir(jobId, options){
  const d = join(logsDir(options), jobId);
  const env = resolveAgentContext(options);
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, env.workspaceRoot), { recursive: true });
  return d;
}

export function buildLogPath(jobId, stamp, options){
  return join(jobLogDir(jobId, options), stamp + '.log');
}

export function setJobNextRun(job, baseMs, options){
  job.nextRunAtMs = computeNextRun(job.schedule, typeof baseMs==='number'?baseMs:nowMs());
  job.updatedAt = nowIso();
  saveJob(job, options);
  return job;
}

export function listJobSummaries(options){
  const arr = listJobs(options);
  return arr.map((j)=> ({
    id: j.id,
    title: j.title,
    enabled: j.enabled,
    schedule: j.schedule,
    nextRunAtMs: j.nextRunAtMs,
    lastRunAtMs: j.lastRunAtMs,
    lastStatus: j.lastStatus,
    sessionTarget: j.sessionTarget,
    delivery: j.delivery,
    payloadKind: j.payload && j.payload.kind,
  }));
}

export function acquireJobRunLock(jobId, options){
  const env = resolveAgentContext(options);
  const path = join(locksDir(options), jobId + '.lock');
  const now = nowMs();
  let staleMs = 10 * 60 * 1000;
  try {
    const raw = process.env.ARCANA_CRON_JOB_LOCK_STALE_MS;
    if (raw != null && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) staleMs = n;
    }
  } catch {}
  const payload = JSON.stringify({ pid: process.pid, startedAtMs: now });
  const tryCreate = () => {
    const fd = openSync(ensureWriteInWorkspace(path, env.workspaceRoot), 'wx');
    try {
      try { writeFileSync(fd, payload, { encoding: 'utf-8' }); } catch {}
    } finally {
      try { closeSync(fd); } catch {}
    }
    return path;
  };
  try {
    return tryCreate();
  } catch {
    try {
      const st = statSync(ensureReadInWorkspace(path, env.workspaceRoot));
      const age = nowMs() - st.mtimeMs;
      if (age > staleMs) {
        try { unlinkSync(ensureWriteInWorkspace(path, env.workspaceRoot)); } catch {}
        try { return tryCreate(); } catch {}
      }
    } catch {}
    return null;
  }
}

export function releaseJobRunLock(lockPath, options){
  if (!lockPath) return;
  const env = resolveAgentContext(options);
  try { unlinkSync(ensureWriteInWorkspace(lockPath, env.workspaceRoot)); } catch {}
}

function sessionTurnLocksDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureCronBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'session_turn_locks');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function sessionTurnLockPath(sessionId, options){
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const d = sessionTurnLocksDir(options);
  return join(d, sid + '.lock');
}

export function isSessionTurnLocked(sessionId, options){
  const env = resolveAgentContext(options);
  const sid = normalizeSessionId(sessionId);
  if (!sid) return false;
  const path = sessionTurnLockPath(sid, options);
  if (!path) return false;
  try {
    const st = statSync(ensureReadInWorkspace(path, env.workspaceRoot));
    const age = nowMs() - st.mtimeMs;
    const staleMs = 10 * 60 * 1000;
    if (age > staleMs){
      try { unlinkSync(ensureWriteInWorkspace(path, env.workspaceRoot)); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function acquireSessionTurnLock(sessionId, options){
  const env = resolveAgentContext(options);
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const path = sessionTurnLockPath(sid, options);
  if (!path) return null;
  const now = nowMs();
  const staleMs = 10 * 60 * 1000;
  const payload = JSON.stringify({ pid: process.pid, startedAtMs: now });
  const tryCreate = () => {
    const fd = openSync(ensureWriteInWorkspace(path, env.workspaceRoot), 'wx');
    try {
      try { writeFileSync(fd, payload, { encoding: 'utf-8' }); } catch {}
    } finally {
      try { closeSync(fd); } catch {}
    }
    return path;
  };
  try {
    return tryCreate();
  } catch {}
  try {
    const st = statSync(ensureReadInWorkspace(path, env.workspaceRoot));
    const age = nowMs() - st.mtimeMs;
    if (age > staleMs){
      try { unlinkSync(ensureWriteInWorkspace(path, env.workspaceRoot)); } catch {}
      try { return tryCreate(); } catch {}
    }
  } catch {}
  return null;
}

export function releaseSessionTurnLock(lockPath, options){
  if (!lockPath) return;
  const env = resolveAgentContext(options);
  try { unlinkSync(ensureWriteInWorkspace(lockPath, env.workspaceRoot)); } catch {}
}

export function listAgentIdsWithJobs({ workspaceRoot } = {}){
  const root = resolveWorkspaceRootForOptions({ workspaceRoot });
  const agentIds = new Set();
  try {
    const agentsDir = join(root, '.arcana', 'agents');
    if (existsSync(agentsDir)){
      for (const name of readdirSync(agentsDir)){
        const jobs = join(agentsDir, name, 'cron', 'jobs.json');
        try { if (existsSync(jobs)) agentIds.add(name); } catch {}
      }
    }
  } catch {}
  return Array.from(agentIds);
}

export default {
  listJobs,
  addJob,
  findJob,
  saveJob,
  removeJob,
  enableJob,
  disableJob,
  patchJob,
  appendRun,
  listRuns,
  jobLogDir,
  buildLogPath,
  setJobNextRun,
  listJobSummaries,
  acquireJobRunLock,
  releaseJobRunLock,
  listAgentIdsWithJobs,
  loadCronSettings,
  saveCronSettings,
  isSessionTurnLocked,
  acquireSessionTurnLock,
  releaseSessionTurnLock,
};
