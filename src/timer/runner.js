import { listJobs, saveJob, setJobNextRun, buildLogPath, appendRun, acquireJobRunLock, releaseJobRunLock, listAgentIdsWithJobs, enqueueSessionEvent, listSessionWakes, readSessionEvents, clearSessionEvents, isSessionTurnLocked } from './store.js';
import { runExecTask } from './exec.js';
import { runArcanaTask } from './arcana-task.js';
import { createSession } from '../sessions-store.js';

function nowIso(){ return new Date().toISOString(); }

function stamp(){
  return nowIso().replace(/[:.]/g,'-').replace('T','_').replace('Z','');
}

function resolveArcanaTimeoutMs(job){
  try {
    const rawJob = job && job.task && job.task.timeoutMs;
    const nJob = Number(rawJob);
    if (Number.isFinite(nJob) && nJob > 0) return nJob;
  } catch {}
  try {
    const rawEnv = process.env.ARCANA_TIMER_ARCANA_TIMEOUT_MS;
    if (rawEnv != null && rawEnv !== '') {
      const nEnv = Number(rawEnv);
      if (Number.isFinite(nEnv) && nEnv > 0) return nEnv;
    }
  } catch {}
  return 60000;
}

async function runOne(job, { agentId, workspaceRoot } = {}){
  const storeOpts = { agentId, workspaceRoot };
  const lockPath = acquireJobRunLock(job.id, storeOpts);
  if (!lockPath) return { skipped: true, reason: 'locked', jobId: job.id, agentId };
  try {
    const startMs = Date.now();
    const logPath = buildLogPath(job.id, stamp(), storeOpts);
    let res;
    const kind = job.task?.kind || 'exec';
    if (kind === 'exec') {
      res = await runExecTask({ command: String(job.task.command||''), logPath });
    } else if (kind === 'arcana') {
      const arcanaTimeoutMs = resolveArcanaTimeoutMs(job);
      const sessionMode = String(job.task && job.task.sessionMode || 'inherit').toLowerCase();
      if (sessionMode === 'main_queue') {
        const sessionId = String(job.task && job.task.sessionId || '').trim();
        if (!sessionId) {
          const finishedAtMs = Date.now();
          res = { ok:false, error:'missing_sessionId', startedAtMs:startMs, finishedAtMs, outputTail:'' };
        } else {
          const enqueueRes = enqueueSessionEvent({ sessionId, text: job.task.prompt }, storeOpts);
          const parts = ['enqueued_to_main_queue'];
          if (enqueueRes && typeof enqueueRes.size === 'number') parts.push('size=' + enqueueRes.size);
          if (enqueueRes && enqueueRes.skippedDuplicate) parts.push('skippedDuplicate=true');
          const finishedAtMs = Date.now();
          res = { ok:true, startedAtMs:startMs, finishedAtMs, outputTail: parts.join(' ') };
        }
      } else if (sessionMode === 'new') {
        const title = job.task && job.task.title || job.title || 'Arcana Timer';
        const sess = createSession({ title, workspace: storeOpts.workspaceRoot, agentId });
        const sid = sess && sess.id;
        res = await runArcanaTask({ prompt: String(job.task.prompt||''), sessionId: sid, title: job.task.title||job.title, logPath, agentId, timeoutMs: arcanaTimeoutMs });
      } else {
        res = await runArcanaTask({ prompt: String(job.task.prompt||''), sessionId: job.task.sessionId, title: job.task.title||job.title, logPath, agentId, timeoutMs: arcanaTimeoutMs });
      }
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
      setJobNextRun(job, endMs, storeOpts);
    }
    saveJob(job, storeOpts);

    // append run record
    appendRun({
      jobId: job.id,
      agentId,
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
    }, storeOpts);
    return { skipped:false, jobId: job.id, ok: !!res.ok, logPath, agentId };
  } finally { releaseJobRunLock(lockPath, storeOpts); }
}

export async function runDueOnce({ workspaceRoot } = {}){
  const now = Date.now();
  const agentIds = listAgentIdsWithJobs({ workspaceRoot });
  const results = [];
  for (const agentId of agentIds){
    const storeOpts = { agentId, workspaceRoot };
    const jobs = listJobs(storeOpts);
    const due = jobs.filter((j)=> j.enabled && typeof j.nextRunAtMs === 'number' && j.nextRunAtMs <= now);
    for (const j of due){
      try {
        results.push(await runOne(j, storeOpts));
      } catch (e) {
        try {
          appendRun({ jobId: j.id, agentId, title: j.title, ok:false, error: String(e?.message||e), startedAtMs: Date.now(), finishedAtMs: Date.now() }, storeOpts);
        } catch {}
      }
    }

    const wakes = listSessionWakes(storeOpts);
    if (wakes && wakes.length){
      const arcanaTimeoutMs = resolveArcanaTimeoutMs(null);
      for (const sessionId of wakes){
        if (isSessionTurnLocked(sessionId, storeOpts)) continue;
        const events = readSessionEvents(sessionId, storeOpts);
        if (!events || !events.length){
          clearSessionEvents(sessionId, storeOpts);
          continue;
        }
        const lines = [];
        lines.push('You are processing queued timer events for the current conversation.');
        lines.push('');
        lines.push('Events:');
        let idx = 1;
        for (const ev of events){
          const text = String(ev && ev.text || '').trim();
          if (!text) continue;
          lines.push(String(idx) + '. ' + text);
          idx++;
        }
        lines.push('');
        lines.push('Respond once and address them concisely.');
        const mergedPrompt = lines.join('\n');
        const queueJobId = '__queue__';
        const logPath = buildLogPath(queueJobId, stamp(), storeOpts);
        try {
          const res = await runArcanaTask({ prompt: mergedPrompt, sessionId, title: 'Timer Queue', logPath, agentId, timeoutMs: arcanaTimeoutMs });
          if (res && res.ok) {
            clearSessionEvents(sessionId, storeOpts);
          }
          results.push({ skipped:false, jobId: queueJobId + ':' + sessionId, ok: !!(res && res.ok), logPath, agentId });
        } catch {}
      }
    }
  }
  return results;
}

export async function runJobById(id, { agentId, workspaceRoot } = {}){
  const targetId = String(id || '').trim();
  if (!targetId) return { ok:false, error:'job_not_found' };

  // If agentId is specified, restrict lookup to that agent.
  if (agentId){
    const storeOpts = { agentId, workspaceRoot };
    const job = listJobs(storeOpts).find((j)=> j.id === targetId);
    if (!job) return { ok:false, error:'job_not_found' };
    try { return await runOne(job, storeOpts); }
    catch (e) { return { ok:false, error: String(e?.message||e), agentId }; }
  }

  // Otherwise, search across all agents and detect ambiguity.
  const agentIds = listAgentIdsWithJobs({ workspaceRoot });
  const matches = [];
  for (const aid of agentIds){
    const storeOpts = { agentId: aid, workspaceRoot };
    const job = listJobs(storeOpts).find((j)=> j.id === targetId);
    if (job) matches.push({ agentId: aid, job });
  }
  if (!matches.length) return { ok:false, error:'job_not_found' };
  if (matches.length > 1) {
    return { ok:false, error:'job_ambiguous', matches: matches.map((m)=> ({ agentId: m.agentId, jobId: m.job.id })) };
  }
  const only = matches[0];
  const storeOpts = { agentId: only.agentId, workspaceRoot };
  try { return await runOne(only.job, storeOpts); }
  catch (e) { return { ok:false, error: String(e?.message||e), agentId: only.agentId }; }
}

export async function serveLoop({ intervalMs = 1000, workspaceRoot } = {}) {
  const dt = Math.max(200, Number(intervalMs)||1000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await runDueOnce({ workspaceRoot }); } catch {}
    await new Promise((r)=> setTimeout(r, dt));
  }
}

export default { runDueOnce, serveLoop, runJobById };

