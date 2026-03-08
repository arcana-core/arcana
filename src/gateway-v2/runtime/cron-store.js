import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

import { arcanaHomePath } from '../../arcana-home.js';
import { ensureDir, nowMs, iso, safeJsonParse, atomicWriteJson, randomId } from '../util.js';
import { computeNextRun } from '../../cron/schedule.js';

function cronBaseDir(){
  return arcanaHomePath('gateway-v2', 'cron');
}

function jobsFilePath(){
  return join(cronBaseDir(), 'jobs.json');
}

function runsFilePath(tsMs){
  const stamp = iso(typeof tsMs === 'number' && Number.isFinite(tsMs) ? tsMs : nowMs()).slice(0, 10);
  return join(cronBaseDir(), 'runs-' + stamp + '.jsonl');
}

async function readJobs(){
  const filePath = jobsFilePath();
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const parsed = safeJsonParse(text, []);
  return Array.isArray(parsed) ? parsed : [];
}

async function writeJobs(jobs){
  const filePath = jobsFilePath();
  const dir = dirname(filePath);
  await ensureDir(dir);
  await atomicWriteJson(filePath, Array.isArray(jobs) ? jobs : []);
}

function normalizeSchedule(raw){
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim().toLowerCase();
  if (!type) return null;
  const value = raw.value ?? raw.spec ?? raw.cron ?? raw.every ?? raw.at;
  if (value == null) return null;
  const sched = {
    type,
    value: String(value),
  };
  if (raw.timezone) sched.timezone = String(raw.timezone);
  return sched;
}

function computeNextRunSafe(schedule, baseMs){
  try {
    return computeNextRun(schedule, baseMs);
  } catch {
    return null;
  }
}

export function createCronStore(){
  async function listJobs(){
    return readJobs();
  }

  async function getJob(id){
    const jobs = await readJobs();
    const rid = String(id || '').trim();
    if (!rid) return null;
    return jobs.find((j) => j && String(j.id) === rid) || null;
  }

  async function createJob(input){
    const now = nowMs();
    const jobs = await readJobs();
    const id = 'job-' + randomId(8);
    const agentId = (input && input.agentId) ? String(input.agentId) : 'default';
    const sessionKey = (input && input.sessionKey) ? String(input.sessionKey) : 'session';
    const title = (input && input.title != null) ? String(input.title) : '';
    const priorityRaw = input && input.priority;
    const pr = Number(priorityRaw);
    const priority = Number.isFinite(pr) ? pr : 0;
    const schedule = normalizeSchedule(input && input.schedule);

    const job = {
      id,
      agentId,
      sessionKey,
      title,
      schedule,
      enabled: input && typeof input.enabled === 'boolean' ? input.enabled : true,
      priority,
      createdAtMs: now,
      updatedAtMs: now,
      nextRunAtMs: schedule ? computeNextRunSafe(schedule, now) : null,
      lastRunAtMs: null,
      lastStatus: null,
      meta: (input && input.meta && typeof input.meta === 'object') ? input.meta : null,
    };

    jobs.push(job);
    await writeJobs(jobs);
    return job;
  }

  async function updateJob(id, patch){
    const jobs = await readJobs();
    const rid = String(id || '').trim();
    if (!rid) return null;
    let updated = null;
    const now = nowMs();
    const next = jobs.map((job) => {
      if (!job || String(job.id) !== rid) return job;
      const copy = { ...job };
      if (patch && typeof patch === 'object'){
        if (patch.agentId != null) copy.agentId = String(patch.agentId);
        if (patch.sessionKey != null) copy.sessionKey = String(patch.sessionKey);
        if (patch.title != null) copy.title = String(patch.title);
        if (patch.enabled != null) copy.enabled = !!patch.enabled;
        if (patch.priority != null){
          const pr = Number(patch.priority);
          if (Number.isFinite(pr)) copy.priority = pr;
        }
        if (patch.schedule){
          const sched = normalizeSchedule(patch.schedule);
          copy.schedule = sched;
          copy.nextRunAtMs = sched ? computeNextRunSafe(sched, now) : null;
        }
        if (patch.meta && typeof patch.meta === 'object'){
          copy.meta = patch.meta;
        }
      }
      copy.updatedAtMs = now;
      updated = copy;
      return copy;
    });
    if (!updated) return null;
    await writeJobs(next);
    return updated;
  }

  async function deleteJob(id){
    const jobs = await readJobs();
    const rid = String(id || '').trim();
    if (!rid) return { ok: true, deleted: false };
    let deleted = false;
    const next = jobs.filter((job) => {
      if (!job || String(job.id) !== rid) return true;
      deleted = true;
      return false;
    });
    if (deleted) await writeJobs(next);
    return { ok: true, deleted };
  }

  async function findDueJobs({ nowMs: nowOverride } = {}){
    const now = typeof nowOverride === 'number' && Number.isFinite(nowOverride) ? nowOverride : nowMs();
    const jobs = await readJobs();
    return jobs.filter((job) => {
      if (!job || job.enabled === false) return false;
      const t = Number(job.nextRunAtMs || 0);
      if (!Number.isFinite(t) || t <= 0) return false;
      return t <= now;
    });
  }

  async function recordRun(id, info){
    const jobs = await readJobs();
    const rid = String(id || '').trim();
    if (!rid) return null;
    const now = nowMs();
    let updated = null;
    const nextJobs = jobs.map((job) => {
      if (!job || String(job.id) !== rid) return job;
      const copy = { ...job };
      copy.lastRunAtMs = now;
      copy.lastStatus = info && info.status ? String(info.status) : 'scheduled';
      if (copy.schedule){
        copy.nextRunAtMs = computeNextRunSafe(copy.schedule, now);
      }
      copy.updatedAtMs = now;
      updated = copy;
      return copy;
    });
    if (updated) await writeJobs(nextJobs);

    const filePath = runsFilePath(now);
    const dir = dirname(filePath);
    await ensureDir(dir);
    const payload = {
      jobId: rid,
      tsMs: now,
      ts: iso(now),
      status: info && info.status ? String(info.status) : 'scheduled',
      trigger: info && info.trigger ? String(info.trigger) : 'unknown',
    };
    const line = JSON.stringify(payload) + '\n';
    try {
      await fsp.appendFile(filePath, line, 'utf8');
    } catch {}

    return updated;
  }

  return {
    listJobs,
    getJob,
    createJob,
    updateJob,
    deleteJob,
    findDueJobs,
    recordRun,
  };
}

export default { createCronStore };

