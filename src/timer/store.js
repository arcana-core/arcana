import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceRoot, ensureReadAllowed, ensureWriteAllowed } from '../workspace-guard.js';
import { computeNextRun } from './schedule.js';

function baseDir() {
  const root = resolveWorkspaceRoot();
  const d = join(root, '.arcana', 'timer');
  if (!existsSync(d)) mkdirSync(ensureWriteAllowed(d), { recursive: true });
  return d;
}

function jobsPath(){ return join(baseDir(), 'jobs.json'); }
function runsPath(){ return join(baseDir(), 'runs.jsonl'); }
function logsDir(){ const d = join(baseDir(), 'logs'); if (!existsSync(d)) mkdirSync(ensureWriteAllowed(d), { recursive: true }); return d; }
function locksDir(){ const d = join(baseDir(), 'locks'); if (!existsSync(d)) mkdirSync(ensureWriteAllowed(d), { recursive: true }); return d; }

function nowIso(){ return new Date().toISOString(); }
function nowMs(){ return Date.now(); }

// Basic lock around jobs.json writes to avoid corruption across concurrent processes.
// We create .lock with O_EXCL and remove it after the write. If lock exists and is stale (>30s), steal it.
function lockFilePath(){ return join(baseDir(), 'jobs.lock'); }

function acquireLock(timeoutMs = 5000){
  const path = lockFilePath();
  const start = Date.now();
  while (Date.now() - start < timeoutMs){
    try { const fd = openSync(ensureWriteAllowed(path), 'wx'); closeSync(fd); return true; } catch {}
    // check staleness
    try { const st = statSync(ensureReadAllowed(path)); if (Date.now() - st.mtimeMs > 30000) { try { unlinkSync(ensureWriteAllowed(path)); } catch {} } } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

function releaseLock(){ try { unlinkSync(ensureWriteAllowed(lockFilePath())); } catch {} }

export function listJobs(){
  const p = jobsPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(ensureReadAllowed(p), 'utf-8'));
    if (Array.isArray(raw)) return raw;
  } catch {}
  return [];
}

function saveJobsArray(arr){
  const p = jobsPath();
  const tmp = p + '.tmp';
  if (!acquireLock()) throw new Error('timer_store_lock_timeout');
  try {
    writeFileSync(ensureWriteAllowed(tmp), JSON.stringify(arr, null, 2), 'utf-8');
    renameSync(tmp, ensureWriteAllowed(p));
  } finally { releaseLock(); }
}

function genId(title){
  const stamp = nowIso().replace(/[:.]/g,'-').replace('T','_').replace('Z','');
  const slug = String(title||'job').toLowerCase().trim().replace(/[^a-z0-9\-\_\s]+/g,'').replace(/\s+/g,'-').slice(0,40) || 'job';
  const rand = Math.random().toString(36).slice(2, 8);
  return stamp + '--' + slug + '-' + rand;
}

export function addJob({ title, schedule, task, enabled=true }){
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

  const arr = listJobs();
  arr.push(obj);
  saveJobsArray(arr);
  return obj;
}

export function findJob(id){
  const arr = listJobs();
  return arr.find(j=> j.id === id) || null;
}

export function saveJob(job){
  const arr = listJobs();
  const idx = arr.findIndex(j=> j.id === job.id);
  if (idx === -1) throw new Error('job_not_found');
  arr[idx] = job;
  saveJobsArray(arr);
  return job;
}

export function removeJob(id){
  const arr = listJobs();
  const next = arr.filter(j=> j.id !== id);
  saveJobsArray(next);
  return arr.length !== next.length;
}

export function enableJob(id){ const arr = listJobs(); const j = arr.find(x=>x.id===id); if (!j) throw new Error('job_not_found'); j.enabled = true; j.updatedAt = nowIso(); if (!j.nextRunAtMs) j.nextRunAtMs = computeNextRun(j.schedule, nowMs()); saveJobsArray(arr); return j; }
export function disableJob(id){ const arr = listJobs(); const j = arr.find(x=>x.id===id); if (!j) throw new Error('job_not_found'); j.enabled = false; j.updatedAt = nowIso(); saveJobsArray(arr); return j; }

export function patchJob(id, patch){
  const arr = listJobs();
  const j = arr.find(x=> x.id === id);
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
      if (!String(j.task.prompt||'').trim()) throw new Error('arcana_missing_prompt');
    } else throw new Error('unknown_task_kind');
  }
  if (resched) j.nextRunAtMs = computeNextRun(j.schedule, nowMs());
  j.updatedAt = nowIso();
  saveJobsArray(arr);
  return j;
}

export function appendRun(rec){
  const line = JSON.stringify(rec) + '\n';
  const p = runsPath();
  appendFileSync(ensureWriteAllowed(p), line, { encoding: 'utf-8' });
}

export function listRuns({ limit = 50 } = {}){
  const p = runsPath();
  if (!existsSync(p)) return [];
  // Simple implementation: read whole file; acceptable for modest sizes
  try {
    const text = readFileSync(ensureReadAllowed(p), 'utf-8');
    const lines = text.split('\n').filter(Boolean);
    const tail = lines.slice(-Math.max(1, Math.min(500, limit)));
    return tail.map((l)=>{ try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function jobLogDir(jobId){ const d = join(logsDir(), jobId); if (!existsSync(d)) mkdirSync(ensureWriteAllowed(d), { recursive: true }); return d; }
export function buildLogPath(jobId, stamp){ return join(jobLogDir(jobId), stamp + '.log'); }

export function setJobNextRun(job, baseMs){ job.nextRunAtMs = computeNextRun(job.schedule, typeof baseMs==='number'?baseMs:nowMs()); job.updatedAt = nowIso(); saveJob(job); return job; }

export function listJobSummaries(){
  const arr = listJobs();
  return arr.map((j)=> ({ id: j.id, title: j.title, enabled: j.enabled, schedule: j.schedule, nextRunAtMs: j.nextRunAtMs, lastRunAtMs: j.lastRunAtMs, lastStatus: j.lastStatus }));
}

export function acquireJobRunLock(jobId){
  const path = join(locksDir(), jobId + '.lock');
  try { const fd = openSync(ensureWriteAllowed(path), 'wx'); closeSync(fd); return path; } catch { return null; }
}
export function releaseJobRunLock(lockPath){ if (!lockPath) return; try { unlinkSync(ensureWriteAllowed(lockPath)); } catch {} }

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
};

