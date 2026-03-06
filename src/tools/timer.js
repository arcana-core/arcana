import { Type } from '@sinclair/typebox';
import { addJob, listJobSummaries, listRuns as storeListRuns, enableJob, disableJob, removeJob, patchJob, findJob } from '../timer/store.js';
import { runDueOnce, runJobById } from '../timer/runner.js';
import { getContext } from '../event-bus.js';

export function createTimerTool(){
  const Schedule = Type.Object({
    type: Type.String({ description: 'at|every|cron' }),
    value: Type.Optional(Type.String({ description: 'ISO, +duration, duration or cron expr' })),
    timezone: Type.Optional(Type.String({ description: 'local|UTC' })),
  });
  const ExecTask = Type.Object({
    kind: Type.Literal('exec'),
    command: Type.String(),
  });
  const ArcanaTask = Type.Object({
    kind: Type.Literal('arcana'),
    prompt: Type.String(),
    sessionId: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number({ description: 'Override arcana job timeout in ms' })),
  });

  const Params = Type.Object({
    action: Type.String({ description: 'add|list|runs|enable|disable|remove|update|run|run_due_once' }),
    id: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    schedule: Type.Optional(Schedule),
    task: Type.Optional(Type.Union([ExecTask, ArcanaTask])),
    enabled: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  });

  function fmtMs(ms){ return new Date(ms).toISOString(); }

  function resolveTimerContext(){
    try {
      const ctx = getContext?.();
      const agentId = ctx && ctx.agentId ? String(ctx.agentId) : undefined;
      const workspaceRoot = ctx && ctx.workspaceRoot ? String(ctx.workspaceRoot) : undefined;
      const sessionId = ctx && ctx.sessionId ? String(ctx.sessionId) : undefined;
      return { agentId, workspaceRoot, sessionId };
    } catch {
      return { agentId: undefined, workspaceRoot: undefined, sessionId: undefined };
    }
  }

  return {
    label: 'Timer',
    name: 'timer',
    description: 'Create and manage local scheduled jobs (exec or arcana). Stores data under .arcana/agents/<agentId>/timer/ in the workspace.',
    parameters: Params,
    async execute(_id, args){
      const action = String(args.action||'').trim().toLowerCase();
      const ctx = resolveTimerContext();
      const storeOpts = { agentId: ctx.agentId, workspaceRoot: ctx.workspaceRoot };

      if (action === 'add'){
        const title = String(args.title||'Timer Job');
        const schedule = args.schedule || null;
        const rawTask = args.task || null;
        if (!schedule || !rawTask){
          return { content:[{ type:'text', text:'schedule and task are required.' }], details:{ ok:false, error:'missing_params' } };
        }
        let task = rawTask;
        if (task && typeof task === 'object' && String(task.kind||'').toLowerCase() === 'arcana'){
          const sid = task.sessionId || ctx.sessionId;
          if (sid && !task.sessionId) task = { ...task, sessionId: sid };
        }
        try {
          const job = addJob({ title, schedule, task, enabled: args.enabled !== false }, storeOpts);
          const txt = 'timer: added ' + job.id + '\nnext: ' + (job.nextRunAtMs?fmtMs(job.nextRunAtMs):'n/a');
          return { content:[{ type:'text', text: txt }], details:{ ok:true, job } };
        } catch (e) { return { content:[{ type:'text', text:'add failed: '+(e?.message||String(e)) }], details:{ ok:false } }; }
      }

      if (action === 'list'){
        const arr = listJobSummaries(storeOpts);
        const lines = arr.map((j)=> j.id + '\t' + (j.enabled?'on':'off') + '\t' + (j.schedule.type + ':' + j.schedule.value + (j.schedule.timezone?('(' + j.schedule.timezone + ')') : '')) + '\t' + (j.nextRunAtMs?fmtMs(j.nextRunAtMs):'n/a') + '\t' + j.title);
        return { content:[{ type:'text', text: (lines.join('\n')||'no jobs') }], details:{ ok:true, items: arr } };
      }

      if (action === 'runs'){
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const runs = storeListRuns({ limit }, storeOpts);
        const lines = runs.map((r)=> r.jobId + '\t' + (r.ok ? 'ok' : 'err') + '\t' + new Date(r.startedAtMs).toISOString() + '\t' + (r.title || '') + '\t' + (r.error ? ('err:' + r.error) : ''));
        return { content:[{ type:'text', text: (lines.join('\n') || 'no runs') }], details:{ ok:true, items: runs } };
      }

      // Enable a job
      if (action === 'enable'){
        const id = String(args.id||'').trim();
        if (!id) return { content:[{ type:'text', text:'id required' }], details:{ ok:false, error:'missing_id' } };
        try {
          const j = enableJob(id, storeOpts);
          const txt = 'enabled: ' + j.id + (j.nextRunAtMs ? ('\nnext: ' + fmtMs(j.nextRunAtMs)) : '');
          return { content:[{ type:'text', text: txt }], details:{ ok:true, job:j } };
        } catch (e) {
          return { content:[{ type:'text', text:'enable failed: ' + (e?.message || String(e)) }], details:{ ok:false } };
        }
      }

      // Disable a job
      if (action === 'disable'){
        const id = String(args.id||'').trim();
        if (!id) return { content:[{ type:'text', text:'id required' }], details:{ ok:false, error:'missing_id' } };
        try {
          const j = disableJob(id, storeOpts);
          return { content:[{ type:'text', text: 'disabled: ' + j.id }], details:{ ok:true, job:j } };
        } catch (e) {
          return { content:[{ type:'text', text:'disable failed: ' + (e?.message || String(e)) }], details:{ ok:false } };
        }
      }

      // Remove/Delete a job
      if (action === 'remove' || action === 'delete'){
        const id = String(args.id||'').trim();
        if (!id) return { content:[{ type:'text', text:'id required' }], details:{ ok:false, error:'missing_id' } };
        try {
          const ok = removeJob(id, storeOpts);
          return { content:[{ type:'text', text: ok ? 'removed' : 'not found' }], details:{ ok } };
        } catch (e) {
          return { content:[{ type:'text', text:'remove failed: ' + (e?.message || String(e)) }], details:{ ok:false } };
        }
      }

      // Update/Patch a job
      if (action === 'update' || action === 'patch'){
        const id = String(args.id||'').trim();
        if (!id) return { content:[{ type:'text', text:'id required' }], details:{ ok:false, error:'missing_id' } };
        let taskPatch = args.task;
        if (taskPatch && typeof taskPatch === 'object' && String(taskPatch.kind||'').toLowerCase() === 'arcana'){
          const sid = taskPatch.sessionId || ctx.sessionId;
          if (sid && !taskPatch.sessionId) taskPatch = { ...taskPatch, sessionId: sid };
        }
        try {
          const j = patchJob(id, { title: args.title, enabled: args.enabled, schedule: args.schedule, task: taskPatch }, storeOpts);
          const txt = 'updated: ' + j.id + (j.nextRunAtMs ? ('\nnext: ' + fmtMs(j.nextRunAtMs)) : '');
          return { content:[{ type:'text', text: txt }], details:{ ok:true, job:j } };
        } catch (e) {
          return { content:[{ type:'text', text:'update failed: ' + (e?.message || String(e)) }], details:{ ok:false } };
        }
      }

      // Run a specific job by id
      if (action === 'run'){
        const id = String(args.id||'').trim();
        if (!id) return { content:[{ type:'text', text:'id required' }], details:{ ok:false, error:'missing_id' } };
        const j = findJob(id, storeOpts);
        if (!j) return { content:[{ type:'text', text:'job not found' }], details:{ ok:false, error:'job_not_found' } };
        const r = await runJobById(id, { agentId: ctx.agentId, workspaceRoot: ctx.workspaceRoot });
        const txt = (r && r.skipped) ? ('skipped ' + (r.reason || '')) : (r && r.ok ? 'ok' : 'error' + (r?.error ? (': ' + r.error) : ''));
        return { content:[{ type:'text', text: 'run ' + id + ': ' + txt }], details:{ ok: !!(r && r.ok), result: r } };
      }

      // Run all due jobs once
      if (action === 'run_due_once'){
        try {
          const res = await runDueOnce({ workspaceRoot: ctx.workspaceRoot });
          const lines = res.map((r)=> {
            const status = r.skipped ? ('skipped ' + (r.reason || '')) : (r.ok ? 'ok' : 'error');
            const agentPart = r.agentId ? (' [agent:' + r.agentId + ']') : '';
            const idPart = r.jobId ? (' ' + r.jobId) : '';
            return status + agentPart + idPart;
          });
          return { content:[{ type:'text', text: lines.join('\n') || 'no due jobs' }], details:{ ok:true, results: res } };
        } catch (e) {
          return { content:[{ type:'text', text:'run_due_once failed: ' + (e?.message || String(e)) }], details:{ ok:false } };
        }
      }

      const valid = 'add|list|runs|enable|disable|remove|update|run|run_due_once';
      return { content:[{ type:'text', text:'unknown action: ' + action + ' (valid: ' + valid + ')' }], details:{ ok:false, error:'unknown_action', action } };
    }

  };
}
