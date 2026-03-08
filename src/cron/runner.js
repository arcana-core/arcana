import { listJobs, saveJob, setJobNextRun, buildLogPath, appendRun, acquireJobRunLock, releaseJobRunLock, listAgentIdsWithJobs, acquireSessionTurnLock, releaseSessionTurnLock } from './store.js';
import { runExecTask } from './exec.js';
import { runArcanaTask } from './arcana-task.js';
import { appendMessage } from '../sessions-store.js';

function nowIso(){ return new Date().toISOString(); }

function stamp(){
  return nowIso().replace(/[:.]/g,'-').replace('T','_').replace('Z','');
}

function resolveArcanaTimeoutMs(job){
  try {
    const rawJob = job && job.payload && job.payload.timeoutMs;
    const nJob = Number(rawJob);
    if (Number.isFinite(nJob) && nJob > 0) return nJob;
  } catch {}
  try {
    const rawEnv = process.env.ARCANA_CRON_ARCANA_TIMEOUT_MS;
    if (rawEnv != null && rawEnv !== '') {
      const nEnv = Number(rawEnv);
      if (Number.isFinite(nEnv) && nEnv > 0) return nEnv;
    }
  } catch {}
  return 60000;
}

async function runAgentTurn(job, { agentId, workspaceRoot, logPath, startMs }){
  const payload = job && job.payload ? job.payload : {};
  const prompt = String(payload.prompt || '');
  if (!prompt) {
    const finishedAtMs = Date.now();
    return { ok:false, error:'missing_prompt', startedAtMs:startMs, finishedAtMs, outputTail:'' };
  }
  const timeoutMs = resolveArcanaTimeoutMs(job);
  const targetRaw = String(job && job.sessionTarget || 'main').trim().toLowerCase();
  const target = targetRaw === 'isolated' ? 'isolated' : 'main';
  const delivery = job && job.delivery && typeof job.delivery === 'object' ? job.delivery : { mode: 'none' };
  const modeRaw = String(delivery.mode || 'none').trim().toLowerCase();
  const mode = modeRaw === 'announce' ? 'announce' : 'none';
  const deliverySessionId = delivery.sessionId ? String(delivery.sessionId).trim() : '';

  // Run directly in the main session; respect per-session turn lock.
  if (target === 'main'){
    if (!deliverySessionId){
      const finishedAtMs = Date.now();
      return { ok:false, error:'missing_delivery_sessionId', startedAtMs:startMs, finishedAtMs, outputTail:'' };
    }
    const turnLockOptions = { agentId, workspaceRoot };
    let turnLockPath = null;
    try {
      try { turnLockPath = acquireSessionTurnLock(deliverySessionId, turnLockOptions); } catch {}
      if (!turnLockPath) {
        const finishedAtMs = Date.now();
        return { skipped:true, reason:'turn_locked', startedAtMs:startMs, finishedAtMs };
      }
      const title = job.title || 'Cron Agent Turn';
      return await runArcanaTask({ prompt, sessionId: deliverySessionId, title, logPath, agentId, timeoutMs });
    } finally {
      try { if (turnLockPath) releaseSessionTurnLock(turnLockPath, turnLockOptions); } catch {}
    }
  }

  // Isolated: run in a fresh session each time. If delivery.mode === 'announce',
  // append the assistant text buffer into delivery.sessionId (best-effort).
  const titleBase = job.title || 'Cron Agent Turn';
  const uniqueTitle = titleBase + ' #' + stamp();
  const res = await runArcanaTask({ prompt, sessionId: '', title: uniqueTitle, logPath, agentId, timeoutMs });

  if (mode === 'announce' && deliverySessionId && res && res.ok){
    const rawAssistant = (res && typeof res.assistantText === 'string') ? res.assistantText : '';
    let text = String(rawAssistant || '').trim();
    const maxChars = 8000;
    if (text.length > maxChars){
      text = text.slice(-maxChars);
    }
    if (text){
      const jobId = job && job.id ? String(job.id).trim() : '';
      const jobTitle = job && job.title ? String(job.title).trim() : '';
      let header = jobId ? `[cron:${jobId}]` : '[cron]';
      if (jobTitle) header += ' ' + jobTitle;
      const payload = header + '\n\n' + text;

      const turnLockOptions = { agentId, workspaceRoot };
      let turnLockPath = null;
      try {
        try { turnLockPath = acquireSessionTurnLock(deliverySessionId, turnLockOptions); } catch {}
        if (turnLockPath){
          try { appendMessage(deliverySessionId, { role: 'assistant', text: payload, agentId }); } catch {}
        }
      } finally {
        try { if (turnLockPath) releaseSessionTurnLock(turnLockPath, turnLockOptions); } catch {}
      }
    }
  }

  return res;
}

async function runOne(job, { agentId, workspaceRoot } = {}){
  const storeOpts = { agentId, workspaceRoot };
  const lockPath = acquireJobRunLock(job.id, storeOpts);
  if (!lockPath) return { skipped: true, reason: 'locked', jobId: job.id, agentId };
  try {
    const startMs = Date.now();
    const logPath = buildLogPath(job.id, stamp(), storeOpts);
    const kind = job && job.payload && job.payload.kind ? job.payload.kind : 'exec';
    let res;
    if (kind === 'exec') {
      const command = job && job.payload && job.payload.command ? String(job.payload.command) : '';
      res = await runExecTask({ command, logPath, cwd: workspaceRoot });
    } else if (kind === 'agentTurn') {
      res = await runAgentTurn(job, { agentId, workspaceRoot, logPath, startMs });
    } else {
      const finishedAtMs = Date.now();
      res = { ok:false, error:'unknown_payload_kind', startedAtMs:startMs, finishedAtMs, outputTail:'' };
    }

    if (res && res.skipped){
      return { skipped:true, reason: res.reason || 'skipped', jobId: job.id, agentId };
    }

    const endMs = Date.now();
    job.lastRunAtMs = endMs;
    job.lastStatus = res && res.ok ? 'ok' : 'error';
    if (job.schedule && job.schedule.type === 'at') {
      job.nextRunAtMs = null; // one-shot
    } else {
      setJobNextRun(job, endMs, storeOpts);
    }
    saveJob(job, storeOpts);

    appendRun({
      jobId: job.id,
      agentId,
      title: job.title,
      schedule: job.schedule,
      payloadKind: kind,
      sessionTarget: job.sessionTarget,
      delivery: job.delivery,
      startedAtMs: res.startedAtMs || startMs,
      finishedAtMs: res.finishedAtMs || endMs,
      ok: !!(res && res.ok),
      error: res.ok ? undefined : (res && res.error ? String(res.error) : undefined),
      logPath,
    }, storeOpts);

    return { ...(res || {}), jobId: job.id, agentId, logPath };
  } finally {
    try { releaseJobRunLock(lockPath, storeOpts); } catch {}
  }
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
          appendRun({ jobId: j.id, agentId, title: j.title, payloadKind: j.payload && j.payload.kind, ok:false, error: String(e?.message||e), startedAtMs: Date.now(), finishedAtMs: Date.now() }, storeOpts);
        } catch {}
      }
    }
  }
  return results;
}

export async function runJobById(id, { agentId, workspaceRoot } = {}){
  const targetId = String(id || '').trim();
  if (!targetId) return { ok:false, error:'job_not_found' };

  if (agentId){
    const storeOpts = { agentId, workspaceRoot };
    const job = listJobs(storeOpts).find((j)=> j.id === targetId);
    if (!job) return { ok:false, error:'job_not_found' };
    try { return await runOne(job, storeOpts); }
    catch (e) { return { ok:false, error: String(e?.message||e), agentId }; }
  }

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
