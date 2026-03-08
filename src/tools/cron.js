import { Type } from '@sinclair/typebox';
import { addJob, listJobSummaries, listRuns as storeListRuns, enableJob, disableJob, removeJob, patchJob, findJob } from '../cron/store.js';
import { runDueOnce, runJobById } from '../cron/runner.js';
import { getContext } from '../event-bus.js';

export function createCronTool(){
  const Schedule = Type.Object({
    type: Type.String({ description: 'at|every|cron' }),
    value: Type.Optional(Type.String({ description: 'ISO, +duration, duration or cron expr' })),
    timezone: Type.Optional(Type.String({ description: 'local|UTC' })),
  });

  const ExecPayload = Type.Object({
    kind: Type.Literal('exec'),
    command: Type.String(),
  });

  const AgentTurnPayload = Type.Object({
    kind: Type.Literal('agentTurn'),
    prompt: Type.String(),
    timeoutMs: Type.Optional(Type.Number({ description: 'Override cron agent turn timeout in ms' })),
  });

  const Delivery = Type.Object({
    mode: Type.Optional(Type.String({ description: 'none|announce' })),
    sessionId: Type.Optional(Type.String()),
  });

  const Job = Type.Object({
    title: Type.Optional(Type.String()),
    schedule: Schedule,
    payload: Type.Union([ExecPayload, AgentTurnPayload]),
    sessionTarget: Type.Optional(Type.String({ description: 'main|isolated' })),
    delivery: Type.Optional(Delivery),
    enabled: Type.Optional(Type.Boolean()),
  });

  const Patch = Type.Object({
    title: Type.Optional(Type.String()),
    schedule: Type.Optional(Schedule),
    payload: Type.Optional(Type.Union([ExecPayload, AgentTurnPayload])),
    sessionTarget: Type.Optional(Type.String()),
    delivery: Type.Optional(Delivery),
    enabled: Type.Optional(Type.Boolean()),
  });

  const Params = Type.Object({
    action: Type.String({ description: 'add|list|runs|enable|disable|remove|update|run|run_due_once|status' }),
    id: Type.Optional(Type.String()),
    job: Type.Optional(Job),
    patch: Type.Optional(Patch),
    // Flat params (for convenience / compatibility)
    title: Type.Optional(Type.String()),
    schedule: Type.Optional(Schedule),
    payload: Type.Optional(Type.Union([ExecPayload, AgentTurnPayload])),
    sessionTarget: Type.Optional(Type.String()),
    delivery: Type.Optional(Delivery),
    enabled: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  });

  function fmtMs(ms){ return new Date(ms).toISOString(); }

  function resolveCronContext(){
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

  function normalizeSessionTarget(raw){
    const s = String(raw || '').trim().toLowerCase();
    return s === 'isolated' ? 'isolated' : 'main';
  }

  function withDefaultDelivery(job, ctxSessionId){
    const j = job && typeof job === 'object' ? { ...job } : {};
    if (!j.payload || typeof j.payload !== 'object') return j;
    const kind = String(j.payload.kind || '').toLowerCase();
    if (kind !== 'agentturn' && kind !== 'agent_turn' && kind !== 'agentturntask' && kind !== 'agentturn'.toLowerCase()) return j;

    j.sessionTarget = normalizeSessionTarget(j.sessionTarget || 'main');
    const baseDelivery = j.delivery && typeof j.delivery === 'object' ? { ...j.delivery } : {};
    if (!baseDelivery.mode) baseDelivery.mode = 'none';
    if (!baseDelivery.sessionId && ctxSessionId){
      baseDelivery.sessionId = ctxSessionId;
    }
    j.delivery = baseDelivery;
    return j;
  }

  function buildJobFromArgs(args, ctxSessionId){
    if (args.job) return withDefaultDelivery(args.job, ctxSessionId);
    const schedule = args.schedule;
    const payload = args.payload;
    if (!schedule || !payload) return null;
    const job = {
      title: args.title,
      schedule,
      payload,
      sessionTarget: args.sessionTarget,
      delivery: args.delivery,
      enabled: args.enabled,
    };
    return withDefaultDelivery(job, ctxSessionId);
  }

  function buildPatchFromArgs(args, ctxSessionId){
    const patch = args.patch && typeof args.patch === 'object' ? { ...args.patch } : {};
    if (!Object.keys(patch).length){
      if (args.title !== undefined) patch.title = args.title;
      if (args.schedule !== undefined) patch.schedule = args.schedule;
      if (args.payload !== undefined) patch.payload = args.payload;
      if (args.sessionTarget !== undefined) patch.sessionTarget = args.sessionTarget;
      if (args.delivery !== undefined) patch.delivery = args.delivery;
      if (args.enabled !== undefined) patch.enabled = args.enabled;
    }
    if (patch.payload){
      patch.sessionTarget = normalizeSessionTarget(patch.sessionTarget || 'main');
      const baseDelivery = patch.delivery && typeof patch.delivery === 'object' ? { ...patch.delivery } : {};
      if (!baseDelivery.mode) baseDelivery.mode = 'none';
      if (!baseDelivery.sessionId && ctxSessionId){
        baseDelivery.sessionId = ctxSessionId;
      }
      patch.delivery = baseDelivery;
    }
    return patch;
  }

  return {
    label: 'Cron',
    name: 'cron',
    description: 'Create and manage local cron-style jobs (exec or agentTurn). Stores data under .arcana/agents/<agentId>/cron/ in the workspace.',
    parameters: Params,
    async execute(_id, args){
      const action = String(args.action||'').trim().toLowerCase();
      const ctx = resolveCronContext();
      const storeOpts = { agentId: ctx.agentId, workspaceRoot: ctx.workspaceRoot };

      if (action === 'add'){
        const job = buildJobFromArgs(args, ctx.sessionId);
        if (!job || !job.schedule || !job.payload){
          return { content:[{ type:'text', text:'job.schedule and job.payload (or schedule/payload) are required.' }], details:{ ok:false, error:'missing_params' } };
        }
        try {
          const created = addJob({
            title: job.title || args.title || 'Cron Job',
            schedule: job.schedule,
            payload: job.payload,
            sessionTarget: job.sessionTarget,
            delivery: job.delivery,
            enabled: job.enabled !== false,
          }, storeOpts);
          const txt = 'cron: added ' + created.id + '\nnext: ' + (created.nextRunAtMs?fmtMs(created.nextRunAtMs):'n/a');
          return { content:[{ type:'text', text: txt }], details:{ ok:true, job: created } };
        } catch (e) {
          return { content:[{ type:'text', text:'add failed: ' + (e?.message || String(e)) }], details:{ ok:false } };
        }
      }

      if (action === 'list'){
        const arr = listJobSummaries(storeOpts);
        const lines = arr.map((j)=>{
          const sched = j.schedule ? (j.schedule.type + ':' + j.schedule.value + (j.schedule.timezone?('('+j.schedule.timezone+')') : '')) : '';
          const next = j.nextRunAtMs ? fmtMs(j.nextRunAtMs) : 'n/a';
          const kind = j.payloadKind || (j.payload && j.payload.kind) || '';
          const target = j.sessionTarget || '';
          return j.id + '\t' + (j.enabled?'on':'off') + '\t' + sched + '\t' + next + '\t' + kind + '\t' + target + '\t' + (j.title||'');
        });
        const text = lines.join('\n') || 'no jobs';
        return { content:[{ type:'text', text }], details:{ ok:true, jobs: arr } };
      }

      if (action === 'runs'){
        const idx = Math.max(0, (args._rawArgs || []).indexOf('--limit'));
        let limit = typeof args.limit === 'number' ? args.limit : 50;
        if (!Number.isFinite(limit) || limit <= 0 || limit > 500) limit = 50;
        const runs = storeListRuns({ limit }, storeOpts);
        const lines = runs.map((r)=>{
          const kind = r.payloadKind || (r.payload && r.payload.kind) || '';
          const ts = r.startedAtMs ? fmtMs(r.startedAtMs) : '';
          return r.jobId + '\t' + (r.ok?'ok':'err') + '\t' + ts + '\t' + kind + '\t' + (r.title||'');
        });
        const text = lines.join('\n') || 'no runs';
        return { content:[{ type:'text', text }], details:{ ok:true, runs } };
      }

      if (action === 'enable'){
        const id = String(args.id||'').trim();
        if (!id) return { content:[{ type:'text', text:'id required' }], details:{ ok:false, error:'missing_id' } };
        try {
          const j = enableJob(id, storeOpts);
          return { content:[{ type:'text', text: 'enabled: ' + j.id }], details:{ ok:true, job:j } };
        } catch (e) {
          return { content:[{ type:'text', text:'enable failed: ' + (e?.message || String(e)) }], details:{ ok:false } };
        }
      }

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

      if (action === 'update' || action === 'patch'){
        const id = String(args.id||'').trim();
        if (!id) return { content:[{ type:'text', text:'id required' }], details:{ ok:false, error:'missing_id' } };
        const patch = buildPatchFromArgs(args, ctx.sessionId);
        try {
          const j = patchJob(id, patch, storeOpts);
          const txt = 'updated: ' + j.id + (j.nextRunAtMs ? ('\nnext: ' + fmtMs(j.nextRunAtMs)) : '');
          return { content:[{ type:'text', text: txt }], details:{ ok:true, job:j } };
        } catch (e) {
          return { content:[{ type:'text', text:'update failed: ' + (e?.message || String(e)) }], details:{ ok:false } };
        }
      }

      if (action === 'run'){
        const id = String(args.id||'').trim();
        if (!id) return { content:[{ type:'text', text:'id required' }], details:{ ok:false, error:'missing_id' } };
        const j = findJob(id, storeOpts);
        if (!j) return { content:[{ type:'text', text:'job not found' }], details:{ ok:false, error:'job_not_found' } };
        const r = await runJobById(id, { agentId: ctx.agentId, workspaceRoot: ctx.workspaceRoot });
        const txt = (r && r.skipped) ? ('skipped ' + (r.reason || '')) : (r && r.ok ? 'ok' : 'error' + (r?.error ? (': ' + r.error) : ''));
        return { content:[{ type:'text', text: 'run ' + id + ': ' + txt }], details:{ ok: !!(r && r.ok), result: r } };
      }

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

      if (action === 'status'){
        const arr = listJobSummaries(storeOpts);
        const total = arr.length;
        const enabled = arr.filter((j)=> j.enabled).length;
        const nextTimes = arr.map((j)=> j.nextRunAtMs).filter((v)=> typeof v === 'number');
        const nextAt = nextTimes.length ? fmtMs(Math.min(...nextTimes)) : 'n/a';
        const summary = 'cron status: jobs=' + total + ' enabled=' + enabled + ' next=' + nextAt;
        return { content:[{ type:'text', text: summary }], details:{ ok:true, jobs: arr } };
      }

      const valid = 'add|list|runs|enable|disable|remove|update|run|run_due_once|status';
      return { content:[{ type:'text', text:'unknown action: ' + action + ' (valid: ' + valid + ')' }], details:{ ok:false, error:'unknown_action', action } };
    }
  };
}
