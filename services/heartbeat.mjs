// heartbeat service. Runs heartbeat checks via src/heartbeat/runner.js
// and logs each run to a dedicated log file.

import { join } from 'node:path';
import { createWriteStream, promises as fsp } from 'node:fs';
import { startHeartbeatRunner } from '../src/heartbeat/runner.js';

export async function start(ctx){
  await fsp.mkdir(ctx.logDir, { recursive: true });
  const logPath = join(ctx.logDir, 'heartbeat.log');
  const logStream = createWriteStream(logPath, { flags: 'a' });

  function logLine(line){
    try { logStream.write(line + '\n'); } catch {}
  }

  const runner = startHeartbeatRunner({
    async onLog(res){
      try {
        const ts = new Date().toISOString();
        const status = res && res.status ? String(res.status) : 'unknown';
        const agentId = res && res.agentId != null ? String(res.agentId) : '';
        const sessionId = res && res.sessionId != null ? String(res.sessionId) : '';
        const reason = res && res.reason != null ? String(res.reason) : '';
        const delivered = res && res.delivered ? ' delivered=true' : '';
        const events = typeof res?.eventsProcessed === 'number' ? ' events=' + res.eventsProcessed : '';
        const line = ts + ' ' + status +
          (agentId ? ' agentId=' + agentId : '') +
          (sessionId ? ' sessionId=' + sessionId : '') +
          (reason ? ' reason=' + reason : '') +
          delivered +
          events;
        logLine(line.trim());
      } catch {}
    },
  });

  return {
    async stop(){
      try { await runner.stop(); } catch {}
      try { logStream.end(); } catch {}
    }
  };
}

export default { start };
