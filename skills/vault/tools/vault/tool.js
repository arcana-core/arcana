// Vault tool — open the front-end secrets UI with suggested secret names.
// No network or filesystem writes; just emits an event consumed by the web UI via SSE.
import { wrapArcanaTool } from '../../../../../src/tools/wrap-arcana-tool.js';
import { emit } from '../../../../../src/event-bus.js';
import { fileURLToPath } from 'node:url';

function ensureNames(arr){
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr){
    const s = String(x || '').trim(); if (s) out.push(s);
  }
  return Array.from(new Set(out));
}

function createVaultTool(){
  return {
    name: 'vault',
    label: '\u5bc6\u7801\u7bb1',
    description: 'Open secrets vault UI; can preset secret names and guide binding.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Suggested secret names (logical names like providers/openai/api_key)' },
        note: { type: 'string', description: 'Optional note to log for the user' }
      },
      required: []
    },
    async execute(_id, args){
      const names = ensureNames(args?.names);
      try { emit({ type: 'open_vault', names }); } catch {}
      const msg = names.length ? ('[vault] please bind: ' + names.join(', ')) : '[vault] open';
      const extra = args?.note ? ('\n' + String(args.note)) : '';
      return { content:[{ type:'text', text: msg + extra }], details:{ ok:true, names } };
    }
  };
}

export default function(){
  // Resolve skillDir two levels up from tools/vault/
  const skillDir = fileURLToPath(new URL('../..', import.meta.url));
  return wrapArcanaTool(createVaultTool, { skillDir, defaultSafety: { allowNetwork:false, allowWrite:false } });
}
