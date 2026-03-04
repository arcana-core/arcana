import { Type } from '@sinclair/typebox';
import { listRuns, spawnSubagent, steerSubagent, killSubagent } from '../subagents/manager.js';

export function createSubagentsTool(){
  const Params = Type.Object({
    action: Type.String({ description: 'spawn|steer|list|kill' }),
    task: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    allowedPaths: Type.Optional(Type.Array(Type.String())),
    runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    policy: Type.Optional(Type.Object({})),
    target: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    recentMinutes: Type.Optional(Type.Number({ minimum: 1 })),
    waitSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  });

  return {
    label: 'Subagents',
    name: 'subagents',
    description: 'Spawn/steer/list/kill embedded Arcana subagents.',
    parameters: Params,
    async execute(_id, args){
      const action = String(args.action||'').trim();
      if (action === 'list'){
        const mins = typeof args.recentMinutes === 'number' ? args.recentMinutes : 60;
        const out = listRuns(mins);
        const lines = [];
        lines.push('active subagents: '+out.active.length);
        lines.push('recent subagents: '+out.recent.length);
        return { content: [{ type:'text', text: lines.join('\n') }], details: out };
      }
      if (action === 'spawn'){
        if (!args.task || typeof args.task !== 'string'){
          return { content:[{type:'text', text:'task required'}], details:{ status:'error', error:'task_required' } };
        }
        const res = spawnSubagent({ task: args.task, label: args.label, allowedPaths: args.allowedPaths, runTimeoutSeconds: args.runTimeoutSeconds });
        const text = res.status === 'accepted' ? ('spawned subagent: ' + res.runId) : ('spawn failed: ' + res.status);
        return { content:[{type:'text', text}], details: res };
      }
      if (action === 'steer'){
        const target = String(args.target||'');
        const message = String(args.message||'');
        if (!target || !message){ return { content:[{type:'text', text:'target and message required'}], details:{ status:'error', error:'missing_params' } }; }
        const res = steerSubagent(target, message);
        const text = res.status === 'ok' ? 'steer sent' : ('steer error: ' + (res.error||res.status));
        return { content:[{type:'text', text}], details: res };
      }
      if (action === 'kill'){
        const target = String(args.target||'');
        if (!target){ return { content:[{type:'text', text:'target required'}], details:{ status:'error', error:'missing_target' } }; }
        const res = killSubagent(target);
        const text = res.status === 'ok' ? 'killed' : res.status;
        return { content:[{type:'text', text}], details: res };
      }
      return { content:[{type:'text', text:'unknown action'}], details:{ status:'error', error:'unknown_action' } };
    }
  };
}

export default createSubagentsTool;
