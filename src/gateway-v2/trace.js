import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { arcanaHomePath } from '../arcana-home.js';
import { ensureDir, nowMs, iso, randomId } from './util.js';

function tracesBaseDir(){
  return arcanaHomePath('gateway-v2', 'traces');
}

function traceFilePath(){
  const stamp = iso(nowMs()).slice(0, 10);
  return join(tracesBaseDir(), 'spans-' + stamp + '.jsonl');
}

export function createTraceEmitter({ wsHub } = {}){
  async function emitSpan(span){
    const now = nowMs();
    const spanId = span && span.spanId ? span.spanId : ('span-' + randomId(8));
    const traceId = span && span.traceId ? span.traceId : ('trc-' + randomId(12));
    const record = {
      ...span,
      spanId,
      traceId,
      tsMs: now,
      ts: iso(now),
    };

    const filePath = traceFilePath();
    const dir = dirname(filePath);
    await ensureDir(dir);
    try {
      await fsp.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {}

    if (wsHub && typeof wsHub.broadcast === 'function'){
      try {
        wsHub.broadcast({ type: 'trace', data: record });
      } catch {}
    }

    return record;
  }

  return { emitSpan };
}

export default { createTraceEmitter };

