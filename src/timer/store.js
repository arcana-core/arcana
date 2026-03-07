import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, appendFileSync, statSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceRoot, ensureReadAllowed, ensureWriteAllowed } from '../workspace-guard.js';
import { computeNextRun } from './schedule.js';
import { getContext, runWithContext } from '../event-bus.js';

const DEFAULT_AGENT_ID = 'default';

const DEFAULT_TIMER_COMPACTION = {
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

function ensureTimerBaseDir(workspaceRoot, agentId){
  const base = join(workspaceRoot, '.arcana', 'agents', agentId, 'timer');
  if (!existsSync(base)) mkdirSync(ensureWriteInWorkspace(base, workspaceRoot), { recursive: true });
  return base;
}

function sessionEventsDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'session_events');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function sessionWakesDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'session_wakes');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function sessionEventLocksDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'session_event_locks');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function sessionTurnLocksDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'session_turn_locks');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function jobsPath(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  return join(baseDir, 'jobs.json');
}

function runsPath(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  return join(baseDir, 'runs.jsonl');
}

function logsDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'logs');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function locksDir(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  const d = join(baseDir, 'locks');
  if (!existsSync(d)) mkdirSync(ensureWriteInWorkspace(d, workspaceRoot), { recursive: true });
  return d;
}

function lockFilePath(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  return join(baseDir, 'jobs.lock');
}

function settingsPath(options){
  const { workspaceRoot, agentId } = resolveAgentContext(options);
  const baseDir = ensureTimerBaseDir(workspaceRoot, agentId);
  return join(baseDir, 'settings.json');
}

// Best-effort migration from legacy .arcana/timer/* into
// .arcana/agents/default/timer/*. Keeps legacy files intact.
function maybeMigrateLegacyTimerFiles(env){
  try {
    const workspaceRoot = env && env.workspaceRoot;
    const agentId = env && env.agentId;
    if (!workspaceRoot) return;
    if (normalizeAgentId(agentId) !== DEFAULT_AGENT_ID) return;

    const legacyDir = join(workspaceRoot, '.arcana', 'timer');
    const legacyJobs = join(legacyDir, 'jobs.json');
    const legacyRuns = join(legacyDir, 'runs.jsonl');

    const baseDir = ensureTimerBaseDir(workspaceRoot, DEFAULT_AGENT_ID);
    const newJobs = join(baseDir, 'jobs.json');
    const newRuns = join(baseDir, 'runs.jsonl');

    if (!existsSync(newJobs) && existsSync(legacyJobs)){
      try {
        copyFileSync(ensureReadInWorkspace(legacyJobs, workspaceRoot), ensureWriteInWorkspace(newJobs, workspaceRoot));
      } catch {}
    }
    if (!existsSync(newRuns) && existsSync(legacyRuns)){
      try {
        copyFileSync(ensureReadInWorkspace(legacyRuns, workspaceRoot), ensureWriteInWorkspace(newRuns, workspaceRoot));
      } catch {}
    }
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
  maybeMigrateLegacyTimerFiles(env);
  const p = jobsPath(options);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(ensureReadInWorkspace(p, env.workspaceRoot), 'utf-8'));
    if (Array.isArray(raw)) return raw;
  } catch {}
  return [];
}

export function loadTimerSettings(options){
  const env = resolveAgentContext(options);
  const p = settingsPath(options);
  const base = { compaction: { ...DEFAULT_TIMER_COMPACTION } };
  if (!existsSync(p)) return base;
  try {
    const raw = JSON.parse(readFileSync(ensureReadInWorkspace(p, env.workspaceRoot), 'utf-8'));
    const out = { compaction: { ...DEFAULT_TIMER_COMPACTION } };
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

export function saveTimerSettings(settings, options){
  const env = resolveAgentContext(options);
  const p = settingsPath(options);
  const tmp = p + '.tmp';
  const current = loadTimerSettings(options) || { compaction: { ...DEFAULT_TIMER_COMPACTION } };
  const incoming = settings && typeof settings === 'object' ? settings : {};
  const srcComp = incoming.compaction && typeof incoming.compaction === 'object' ? incoming.compaction : incoming;

  const baseComp = current.compaction && typeof current.compaction === 'object' ? current.compaction : { ...DEFAULT_TIMER_COMPACTION };
  const nextComp = { ...DEFAULT_TIMER_COMPACTION, ...baseComp };

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
  if (!acquireLock(5000, options)) throw new Error('timer_store_lock_timeout');
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

export function addJob({ title, schedule, task, enabled=true }, options){
  const t = String(title||'').trim() || 'Timer Job';
  const s = schedule && typeof schedule === 'object' ? schedule : null;
  if (!s || !s.type) throw new Error('invalid_schedule');
  const tk = task && typeof task === 'object' ? task : null;
  if (!tk || !tk.kind) throw new Error('invalid_task');
  // Basic validation for tasks
  const kind = String(tk.kind).toLowerCase();
  if (kind === 'exec') {
    if (!String(tk.command||'').trim()) throw new Error('exec_missing_command');
  } else if (kind === 'arcana') {
    if (!String(tk.prompt||'').trim()) throw new Error('arcana_missing_prompt');
    if (tk.timeoutMs !== undefined) {
      const n = Number(tk.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) throw new Error('arcana_invalid_timeout');
      tk.timeoutMs = n;
    }
  } else {
    throw new Error('unknown_task_kind');
  }

  const obj = {
    id: genId(t),
    title: t,
    enabled: Boolean(enabled),
    schedule: {
      type: String(s.type).toLowerCase(),
      value: s.value || s.expr || s.at || s.every || s.cron || '',
      timezone: (s.timezone||'local')
    },
    task: { kind, ...tk },
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
  if (patch.task && typeof patch.task === 'object'){
    const k = String(patch.task.kind || j.task.kind).toLowerCase();
    j.task.kind = k;
    if (k === 'exec'){
      if (typeof patch.task.command === 'string') j.task.command = patch.task.command;
      if (!String(j.task.command||'').trim()) throw new Error('exec_missing_command');
    } else if (k === 'arcana') {
      if (typeof patch.task.prompt === 'string') j.task.prompt = patch.task.prompt;
      if (typeof patch.task.sessionId === 'string') j.task.sessionId = patch.task.sessionId;
      if (typeof patch.task.title === 'string') j.task.title = patch.task.title;
      if (Object.prototype.hasOwnProperty.call(patch.task, 'timeoutMs')) {
        const n = Number(patch.task.timeoutMs);
        if (Number.isFinite(n) && n > 0) j.task.timeoutMs = n;
        else if (patch.task.timeoutMs === null) delete j.task.timeoutMs;
      }
      if (!String(j.task.prompt||'').trim()) throw new Error('arcana_missing_prompt');
    } else throw new Error('unknown_task_kind');
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
  maybeMigrateLegacyTimerFiles(env);
  const p = runsPath(options);
  if (!existsSync(p)) return [];
  // Simple implementation: read whole file; acceptable for modest sizes
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
  return arr.map((j)=> ({ id: j.id, title: j.title, enabled: j.enabled, schedule: j.schedule, nextRunAtMs: j.nextRunAtMs, lastRunAtMs: j.lastRunAtMs, lastStatus: j.lastStatus }));
}

export function acquireJobRunLock(jobId, options){
  const env = resolveAgentContext(options);
  const path = join(locksDir(options), jobId + '.lock');
  const now = nowMs();
  let staleMs = 10 * 60 * 1000;
  try {
    const raw = process.env.ARCANA_TIMER_JOB_LOCK_STALE_MS;
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

const MAX_SESSION_EVENTS = 20;

function sessionEventFilePath(sessionId, options){
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const d = sessionEventsDir(options);
  return join(d, sid + '.json');
}

function sessionWakeFilePath(sessionId, options){
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const d = sessionWakesDir(options);
  return join(d, sid + '.wake');
}

function sessionEventLockPath(sessionId, options){
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const d = sessionEventLocksDir(options);
  return join(d, sid + '.lock');
}

function sessionTurnLockPath(sessionId, options){
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const d = sessionTurnLocksDir(options);
  return join(d, sid + '.lock');
}

export function enqueueSessionEvent({ sessionId, text }, options){
  const env = resolveAgentContext(options);
  const sid = normalizeSessionId(sessionId);
  if (!sid) return { ok: false, size: 0 };
  const lockPath = sessionEventLockPath(sid, options);
  if (!lockPath) return { ok: false, size: 0 };
  const start = nowMs();
  const timeoutMs = 5000;
  let acquired = false;
  while (!acquired && (nowMs() - start) < timeoutMs){
    try {
      const fd = openSync(ensureWriteInWorkspace(lockPath, env.workspaceRoot), 'wx');
      closeSync(fd);
      acquired = true;
      break;
    } catch {}
    try {
      const st = statSync(ensureReadInWorkspace(lockPath, env.workspaceRoot));
      if (nowMs() - st.mtimeMs > 30000) {
        try { unlinkSync(ensureWriteInWorkspace(lockPath, env.workspaceRoot)); } catch {}
      }
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (!acquired) return { ok: false, size: 0 };

  let events = [];
  const filePath = sessionEventFilePath(sid, options);
  try {
    if (filePath && existsSync(filePath)){
      try {
        const raw = readFileSync(ensureReadInWorkspace(filePath, env.workspaceRoot), 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) events = parsed;
      } catch {}
    }
  } catch {}

  const trimmed = String(text || '').trim();
  let skippedDuplicate = false;
  if (trimmed){
    const last = events.length ? events[events.length - 1] : null;
    const lastText = last && typeof last.text === 'string' ? last.text.trim() : '';
    if (lastText === trimmed){
      skippedDuplicate = true;
    } else {
      events.push({ text: trimmed, ts: nowIso() });
    }
  }
  if (events.length > MAX_SESSION_EVENTS){
    events = events.slice(events.length - MAX_SESSION_EVENTS);
  }

  if (filePath){
    try {
      const tmp = filePath + '.tmp';
      writeFileSync(ensureWriteInWorkspace(tmp, env.workspaceRoot), JSON.stringify(events, null, 2), 'utf-8');
      renameSync(tmp, ensureWriteInWorkspace(filePath, env.workspaceRoot));
    } catch {}
  }

  try {
    const wakePath = sessionWakeFilePath(sid, options);
    if (wakePath){
      writeFileSync(ensureWriteInWorkspace(wakePath, env.workspaceRoot), '', 'utf-8');
    }
  } catch {}

  try { unlinkSync(ensureWriteInWorkspace(lockPath, env.workspaceRoot)); } catch {}

  return { ok: true, skippedDuplicate: skippedDuplicate || undefined, size: events.length };
}

export function listSessionWakes(options){
  const env = resolveAgentContext(options);
  const dir = sessionWakesDir(options);
  const out = [];
  try {
    const entries = readdirSync(ensureReadInWorkspace(dir, env.workspaceRoot));
    for (const name of entries){
      if (!name.endsWith('.wake')) continue;
      const base = name.slice(0, -5);
      const sid = normalizeSessionId(base);
      if (sid) out.push(sid);
    }
  } catch {}
  return out;
}

export function readSessionEvents(sessionId, options){
  const env = resolveAgentContext(options);
  const sid = normalizeSessionId(sessionId);
  if (!sid) return [];
  const filePath = sessionEventFilePath(sid, options);
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const raw = readFileSync(ensureReadInWorkspace(filePath, env.workspaceRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e)=> ({ text: String(e && e.text || ''), ts: e && e.ts ? String(e.ts) : nowIso() }));
  } catch {
    return [];
  }
}

export function clearSessionEvents(sessionId, options){
  const env = resolveAgentContext(options);
  const sid = normalizeSessionId(sessionId);
  if (!sid) return false;
  const filePath = sessionEventFilePath(sid, options);
  const wakePath = sessionWakeFilePath(sid, options);
  let ok = true;
  try {
    if (filePath && existsSync(filePath)){
      try { unlinkSync(ensureWriteInWorkspace(filePath, env.workspaceRoot)); } catch { ok = false; }
    }
  } catch {}
  try {
    if (wakePath && existsSync(wakePath)){
      try { unlinkSync(ensureWriteInWorkspace(wakePath, env.workspaceRoot)); } catch { ok = false; }
    }
  } catch {}
  return ok;
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
        const jobs = join(agentsDir, name, 'timer', 'jobs.json');
        try { if (existsSync(jobs)) agentIds.add(name); } catch {}
      }
    }
  } catch {}

  // Legacy default agent: .arcana/timer/jobs.json
  try {
    const legacyJobs = join(root, '.arcana', 'timer', 'jobs.json');
    const defaultDir = join(root, '.arcana', 'agents', DEFAULT_AGENT_ID, 'timer');
    const newJobs = join(defaultDir, 'jobs.json');
    if (existsSync(legacyJobs) || existsSync(newJobs)){
      maybeMigrateLegacyTimerFiles({ workspaceRoot: root, agentId: DEFAULT_AGENT_ID });
      if (existsSync(newJobs)) agentIds.add(DEFAULT_AGENT_ID);
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
  loadTimerSettings,
  saveTimerSettings,
  enqueueSessionEvent,
  listSessionWakes,
  readSessionEvents,
  clearSessionEvents,
  isSessionTurnLocked,
  acquireSessionTurnLock,
  releaseSessionTurnLock,
};
