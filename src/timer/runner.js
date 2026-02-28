import { listJobs, saveJob, setJobNextRun, buildLogPath, appendRun, acquireJobRunLock, releaseJobRunLock } from './store.js';
import { runExecTask } from './exec.js';
import { runArcanaTask } from './arcana-task.js';

function nowIso(){ return new Date().toISOString(); }

function stamp(){
  return nowIso().replace(/[:.]/g,'-').replace('T','_').replace('Z','');
}

async function runOne(job){
  const lockPath = acquireJobRunLock(job.id);
  if (!lockPath) return { skipped: true, reason: 'locked' };
  try {
    const startMs = Date.now();
    const logPath = buildLogPath(job.id, stamp());
    let res;
    const kind = job.task?.kind || 'exec';
    if (kind === 'exec') {
      res = await runExecTask({ command: String(job.task.command||''), logPath });
    } else if (kind === 'arcana') {
      res = await runArcanaTask({ prompt: String(job.task.prompt||''), sessionId: job.task.sessionId, title: job.task.title||job.title, logPath });
    } else {
      res = { ok:false, error:'unknown_task_kind', startedAtMs:startMs, finishedAtMs: Date.now(), outputTail:'' };
    }
    const endMs = Date.now();
    // update job status and next run
    job.lastRunAtMs = endMs;
    job.lastStatus = res.ok ? 'ok' : 'error';
    if (job.schedule && job.schedule.type === 'at') {
      job.nextRunAtMs = null; // one-shot
    } else {
      setJobNextRun(job, endMs);
    }
    saveJob(job);

    // append run record
    appendRun({
      jobId: job.id,
      title: job.title,
      schedule: job.schedule,
      task: { kind, ...(kind==='exec'?{ command: job.task.command }:{ prompt: job.task.prompt, sessionId: job.task.sessionId, title: job.task.title }) },
      startedAtMs: res.startedAtMs || startMs,
      finishedAtMs: res.finishedAtMs || endMs,
      ok: !!res.ok,
      code: res.code,
      error: res.error,
      outputTail: res.outputTail,
      logPath,
      wroteAt: Date.now(),
    });
    return { skipped:false, jobId: job.id, ok: !!res.ok, logPath };
  } finally { releaseJobRunLock(lockPath); }
}

export async function runDueOnce(){
  const now = Date.now();
  const jobs = listJobs();
  const due = jobs.filter((j)=> j.enabled && typeof j.nextRunAtMs === 'number' && j.nextRunAtMs <= now);
  const results = [];
  for (const j of due){
    try { results.push(await runOne(j)); } catch (e) { try { appendRun({ jobId: j.id, title: j.title, ok:false, error: String(e?.message||e), startedAtMs: Date.now(), finishedAtMs: Date.now() }); } catch {} }
  }
  return results;
}

export async function runJobById(id){
  const job = listJobs().find((j)=> j.id === id);
  if (!job) return { ok:false, error:'job_not_found' };
  try { return await runOne(job); } catch (e) { return { ok:false, error: String(e?.message||e) }; }
}

export async function serveLoop({ intervalMs = 1000 } = {}) {
  const dt = Math.max(200, Number(intervalMs)||1000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await runDueOnce(); } catch {}
    await new Promise((r)=> setTimeout(r, dt));
  }
}

export default { runDueOnce, serveLoop, runJobById };
