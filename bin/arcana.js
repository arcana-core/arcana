#!/usr/bin/env node
import readline from 'node:readline';
import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createArcanaSession } from '../src/session.js';
import { runDoctor, printDoctor } from '../src/doctor.js';
import { createSupportBundle } from '../src/support-bundle.js';
import { webCLI } from '../src/cli-web.js';
import { wechatCLI } from '../src/cli-wechat.js';
import { runDueOnce, serveLoop, runJobById } from '../src/cron/runner.js';
import { listJobSummaries as cronList, listRuns as cronListRuns } from '../src/cron/store.js';
import { startHeartbeatRunner } from '../src/heartbeat/runner.js';
import { runHeartbeatOnce } from '../src/heartbeat/run-once.js';
import { requestHeartbeatNow } from '../src/heartbeat/wake.js';
import { enqueueSystemEvent } from '../src/system-events/store.js';
import { loadAgentsSnapshot } from '../src/agents-snapshot.js';
import { loadHeartbeatConfigForAgent } from '../src/heartbeat/config.js';
import { startGatewayV2 } from '../server/gateway.mjs';

const HELP = `
Usage:
  arcana chat                               # interactive chat with tools (pi-coding-agent)
  arcana doctor [--json]                    # run health checks and print report
  arcana support-bundle [--out <path>]      # create support bundle directory (+ .tar.gz if available)
  arcana web navigate <url>                 # open URL in Playwright and wait for networkidle
  arcana web extract                        # extract readable text from current page
  arcana web search <query> [--engine <e>]  # search via browser (engine: auto|duckduckgo|bing|baidu)
  arcana web serve [--port <n>]             # start lightweight web UI
  arcana wechat token [--force]             # fetch/cache Official Account access_token
  arcana wechat upload-cover <file>         # upload permanent image, print thumb_media_id
  arcana wechat draft --title ... --content-file <html> --thumb-media-id <id> [--author ... --digest ...]
  arcana wechat publish --media-id <id> [--wait] [--timeout-sec n]
  arcana wechat publish-file --title ... --content-file <html> --thumb-media-id <id> [--wait]
  arcana cron once                      # run due jobs once and exit
  arcana cron serve                     # run scheduler loop (Ctrl+C to stop)
  arcana cron run <id>                  # run a specific job now
  arcana cron list                      # list jobs
  arcana cron runs [--limit n]          # list recent runs
  arcana heartbeat serve                # run heartbeat runner loop (Ctrl+C to stop)
  arcana heartbeat once --agent <id> --session <sessionKey> [--reason r]
  arcana heartbeat request --agent <id> [--session <sessionKey>] [--reason r]
  arcana heartbeat enqueue --agent <id> --session <sessionKey> --text <text> [--context c] [--dedupe k] [--wake]
  arcana heartbeat status               # show heartbeat config per agent
  arcana livestream enable --room <roomId> [--agent <agentId>] [--tick-ms <n>] [--tts-provider <p>] [--tts-play 0|1] [--subtitle 0|1]
  arcana livestream disable [--agent <agentId>] [--room <roomId>]
  arcana livestream status [--agent <agentId>]
  arcana gateway serve [--port <n>]     # run gateway v2 HTTP+WS server

Env:
  Use the Secrets UI to bind providers/<provider>/api_key (for example providers/openai/api_key).
`;

function error(msg){ console.error('[arcana]', msg); process.exit(1); }

function resolveArcanaHome(){
  try {
    const env = String(process.env.ARCANA_HOME || '').trim();
    if (env) return env;
  } catch {}
  try {
    return join(homedir(), '.arcana');
  } catch {
    return '.arcana';
  }
}

function resolveAgentId(rawFromCli){
  const cli = String(rawFromCli || '').trim();
  if (cli) return cli;
  try {
    const env = String(process.env.ARCANA_AGENT_ID || '').trim();
    if (env) return env;
  } catch {}
  return 'default';
}

function resolveLivestreamConfigPath(agentIdFromCli){
  const arcanaHome = resolveArcanaHome();
  const agentId = resolveAgentId(agentIdFromCli);
  return { path: join(arcanaHome, 'agents', agentId, 'livestream', 'config.json'), agentId, arcanaHome };
}

async function readJsonFile(path){
  try {
    const text = await fsp.readFile(path, 'utf8');
    if (!text) return null;
    return JSON.parse(text);
  } catch (err){
    if (err && err.code === 'ENOENT') return null;
    try {
      console.error('[arcana] failed to read JSON', path + ':', err && (err.message || String(err)));
    } catch {}
    return null;
  }
}

async function writeJsonFile(path, data){
  const dir = dirname(path);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {}
  const text = JSON.stringify(data, null, 2);
  await fsp.writeFile(path, text, 'utf8');
}

async function chat(){
  const { session, model, toolNames, pluginFiles, pluginErrors } = await createArcanaSession({ cwd: process.cwd() });
  if (pluginErrors && pluginErrors.length) { for (const e of pluginErrors) console.warn('[arcana][plugin]', e.file, '-', e.message); }
  const modelLabel = model ? (model.provider + ':' + model.id + (model.baseUrl ? (' @ ' + model.baseUrl) : '')) : '<auto>';
  console.info('[arcana] model:', modelLabel);
  console.info('[arcana] plugins:', (pluginFiles?.length||0), 'files,', (toolNames?.length||0), 'tools');
  console.info('[arcana] tools:', (toolNames||[]).join(', '));
  const env = String(process.env.ARCANA_WORKSPACE||"").trim();
  console.info('[arcana] work path:', env);
  // Stream text updates and show tool events
  let buffer = '';
  session.subscribe((ev)=>{
    if (ev.type === 'tool_execution_start'){
      try { console.info('[arcana] tool start:', ev.toolName, ev.args ? JSON.stringify(ev.args) : ''); }
      catch { console.info('[arcana] tool start:', ev.toolName); }
    }
    if (ev.type === 'tool_execution_end'){
      const ok = ev.error ? false : true;
      console.info('[arcana] tool end:', ev.toolName, ok ? 'ok' : ('error: ' + (ev.error?.message||ev.error)));
    }
    if (ev.type === 'message_update' && ev.message.role === 'assistant'){
      const blocks = ev.message.content.filter(c=>c.type==='text');
      const text = blocks.map(c=>c.text).join('');
      if (text && text !== buffer){ process.stdout.write(text.slice(buffer.length)); buffer = text; }
    }
    if (ev.type === 'message_end' && ev.message.role === 'assistant'){
      process.stdout.write('\n'); buffer='';
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  async function loop(){
    await new Promise((resolve)=> rl.question('> ', async (line)=>{ try { await session.prompt(line); } catch(e){ try{ console.error('[arcana]', e?.stack||e?.message||e); } catch{} } resolve(); }));
    return loop();
  }
  await loop();
}

async function doctor(argv){
  const json = argv.includes('--json');
  const result = await runDoctor({ cwd: process.cwd() });
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  printDoctor(result);
}

async function supportBundle(argv){
  const outIdx = Math.max(0, argv.indexOf('--out'));
  const out = outIdx > -1 ? (argv[outIdx+1]||'') : '';
  const info = await createSupportBundle({ outDir: out, cwd: process.cwd() });
  console.log('[arcana] support bundle created:', info.dir);
  if (info.tarPath) console.log('[arcana] archive:', info.tarPath);
}

async function main(){
  const argv = process.argv.slice(2);
  const [cmd, sub, ...rest] = argv;
  if (!cmd) return console.log(HELP);
  if (cmd === 'chat') return chat2();
  if (cmd === 'doctor') return doctor(argv);
  if (cmd === 'support-bundle') return supportBundle(argv);
  if (cmd === 'web') return webCLI({ args: argv });
  if (cmd === 'wechat') return wechatCLI({ args: argv });
  if (cmd === 'cron') return cronCLI({ args: argv });
  if (cmd === 'heartbeat') return heartbeatCLI({ args: argv });
  if (cmd === 'livestream') return livestreamCLI({ args: argv });
  if (cmd === 'gateway') return gatewayCLI({ args: argv });
  return console.log(HELP);
}

main().catch((e)=>{ try{ console.error('[arcana] failed:', e?.stack||e?.message||e); } catch{ console.error('[arcana] failed'); } process.exit(1); });

async function livestreamCLI({ args }){
  const [, , sub, ...rest] = args;
  const s = String(sub || '').toLowerCase();

  if (s === 'enable'){
    const roomIdx = rest.indexOf('--room');
    const agentIdx = rest.indexOf('--agent');
    const tickIdx = rest.indexOf('--tick-ms');
    const providerIdx = rest.indexOf('--tts-provider');
    const playIdx = rest.indexOf('--tts-play');
    const subtitleIdx = rest.indexOf('--subtitle');

    const roomId = roomIdx >= 0 ? rest[roomIdx + 1] : undefined;
    if (!roomId){
      return error('arcana livestream enable --room <roomId> [--agent <agentId>] [--tick-ms <n>] [--tts-provider <p>] [--tts-play 0|1] [--subtitle 0|1]');
    }

    const agentFromCli = agentIdx >= 0 ? rest[agentIdx + 1] : undefined;
    const tickRaw = tickIdx >= 0 ? rest[tickIdx + 1] : undefined;
    const ttsProvider = providerIdx >= 0 ? rest[providerIdx + 1] : undefined;
    const ttsPlayRaw = playIdx >= 0 ? rest[playIdx + 1] : undefined;
    const subtitleRaw = subtitleIdx >= 0 ? rest[subtitleIdx + 1] : undefined;

    const { path: cfgPath, agentId } = resolveLivestreamConfigPath(agentFromCli);
    const roomStr = String(roomId).trim();

    let tickMs;
    if (tickRaw != null && tickRaw !== undefined){
      const n = Number(tickRaw);
      if (Number.isFinite(n) && n > 0) tickMs = n;
    }

    let ttsPlay;
    if (ttsPlayRaw != null && ttsPlayRaw !== undefined){
      const v = String(ttsPlayRaw).toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes') ttsPlay = true;
      else if (v === '0' || v === 'false' || v === 'no') ttsPlay = false;
    }

    let subtitle;
    if (subtitleRaw != null && subtitleRaw !== undefined){
      const v = String(subtitleRaw).toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes') subtitle = true;
      else if (v === '0' || v === 'false' || v === 'no') subtitle = false;
    }

    const existing = await readJsonFile(cfgPath);
    const prevRooms = Array.isArray(existing && existing.rooms) ? existing.rooms : [];
    const rooms = [];
    let updated = false;
    for (const r of prevRooms){
      if (!r) continue;
      const id = r.roomId != null ? String(r.roomId).trim() : '';
      if (!id) continue;
      if (id === roomStr){
        const next = { ...r, roomId: roomStr };
        if (tickMs != null) next.tickMs = tickMs;
        if (ttsProvider != null && ttsProvider !== undefined) next.ttsProvider = ttsProvider;
        if (ttsPlay !== undefined) next.ttsPlay = ttsPlay;
        if (subtitle !== undefined) next.subtitle = subtitle;
        rooms.push(next);
        updated = true;
      } else {
        rooms.push(r);
      }
    }

    if (!updated){
      const newRoom = { roomId: roomStr };
      if (tickMs != null) newRoom.tickMs = tickMs;
      if (ttsProvider != null && ttsProvider !== undefined) newRoom.ttsProvider = ttsProvider;
      if (ttsPlay !== undefined) newRoom.ttsPlay = ttsPlay;
      if (subtitle !== undefined) newRoom.subtitle = subtitle;
      rooms.push(newRoom);
    }

    const nextCfg = { enabled: true, rooms };
    await writeJsonFile(cfgPath, nextCfg);
    console.log('[arcana] livestream: enabled for agent=' + agentId + ' room=' + roomStr);
    console.log(JSON.stringify(nextCfg, null, 2));
    return;
  }

  if (s === 'disable'){
    const roomIdx = rest.indexOf('--room');
    const agentIdx = rest.indexOf('--agent');
    const roomId = roomIdx >= 0 ? rest[roomIdx + 1] : undefined;
    const agentFromCli = agentIdx >= 0 ? rest[agentIdx + 1] : undefined;

    const { path: cfgPath, agentId } = resolveLivestreamConfigPath(agentFromCli);
    const existing = await readJsonFile(cfgPath);
    const prevRooms = Array.isArray(existing && existing.rooms) ? existing.rooms : [];

    let rooms;
    if (roomId){
      const roomStr = String(roomId).trim();
      rooms = [];
      for (const r of prevRooms){
        if (!r) continue;
        const id = r.roomId != null ? String(r.roomId).trim() : '';
        if (!id || id === roomStr) continue;
        rooms.push(r);
      }
    } else {
      rooms = [];
    }

    const enabled = rooms.length > 0 ? !!(existing && existing.enabled) : false;
    const nextCfg = { enabled, rooms };
    await writeJsonFile(cfgPath, nextCfg);
    if (!rooms.length){
      console.log('[arcana] livestream: disabled for agent=' + agentId + ' (no rooms)');
    } else if (roomId){
      console.log('[arcana] livestream: disabled room=' + String(roomId) + ' for agent=' + agentId);
    } else {
      console.log('[arcana] livestream: disabled for agent=' + agentId);
    }
    console.log(JSON.stringify(nextCfg, null, 2));
    return;
  }

  if (s === 'status'){
    const agentIdx = rest.indexOf('--agent');
    const agentFromCli = agentIdx >= 0 ? rest[agentIdx + 1] : undefined;
    const { path: cfgPath, agentId } = resolveLivestreamConfigPath(agentFromCli);
    const existing = await readJsonFile(cfgPath);

    if (!existing){
      console.log('disabled');
    } else {
      console.log(JSON.stringify(existing, null, 2));
    }

    const logDir = join(process.cwd(), '.arcana', 'services', 'livestream_showrunner');
    console.log('[arcana] livestream: agent=' + agentId + ' config=' + cfgPath);
    console.log('[arcana] livestream: check service logs under ' + logDir);
    return;
  }

  return console.log(HELP);
}

async function gatewayCLI({ args }){
  const [, sub, ...rest] = args;
  const s = String(sub || '').toLowerCase();

  if (s === 'serve'){
    const portIdx = rest.indexOf('--port');
    let port;
    if (portIdx >= 0 && rest[portIdx + 1]){
      const raw = Number(rest[portIdx + 1]);
      if (Number.isFinite(raw) && raw > 0) port = raw;
    }
    console.log('[arcana] gateway v2: serve loop (Ctrl+C to stop)');
    await startGatewayV2({ port });
    return;
  }

  return console.log(HELP);
}


async function cronCLI({ args }){
  const [, , sub, ...rest] = args;
  const s = String(sub||'').toLowerCase();
  if (s === 'once'){
    const results = await runDueOnce({ workspaceRoot: process.cwd() });
    for (const r of results){
      if (r.skipped) console.log('[arcana] skipped', r.reason||'');
      else console.log('[arcana] run', r.jobId, r.ok?'ok':'error');
    }
    return;
  }
  if (s === 'serve'){
    console.log('[arcana] cron: serve loop (Ctrl+C to stop)');
    await serveLoop({ intervalMs: 1000, workspaceRoot: process.cwd() });
    return;
  }
  if (s === 'run'){
    const id = rest[0];
    if (!id) return error('arcana cron run <id>');
    const r = await runJobById(id, { workspaceRoot: process.cwd() });
    if (r && r.skipped) console.log('[arcana] skipped', r.reason||'');
    else console.log('[arcana] run', id, r && r.ok ? 'ok' : 'error');
    return;
  }
  if (s === 'list'){
    const items = cronList({ workspaceRoot: process.cwd() });
    for (const j of items){
      console.log(j.id + '\t' + (j.enabled?'on':'off') + '\t' + j.schedule.type + ':' + j.schedule.value + (j.schedule.timezone?('('+j.schedule.timezone+')'):'') + '\t' + (j.nextRunAtMs?new Date(j.nextRunAtMs).toISOString():'n/a') + '\t' + j.title);
    }
    if (!items.length) console.log('no jobs');
    return;
  }
  if (s === 'runs'){
    const idx = Math.max(0, args.indexOf('--limit'));
    const limit = idx > -1 ? parseInt(args[idx+1]||'50', 10) : 50;
    const runs = cronListRuns({ limit: Number.isFinite(limit) ? limit : 50 }, { workspaceRoot: process.cwd() });
    for (const r of runs){
      console.log(r.jobId + '\t' + (r.ok?'ok':'err') + '\t' + new Date(r.startedAtMs).toISOString() + '\t' + (r.title||''));
    }
    if (!runs.length) console.log('no runs');
    return;
  }
  return console.log(HELP);
}


async function heartbeatCLI({ args }){
  const [, , sub, ...rest] = args;
  const s = String(sub || '').toLowerCase();

  if (s === 'serve'){
    console.log('[arcana] heartbeat: runner started (Ctrl+C to stop)');
    console.warn('[arcana] Note: heartbeat runner now starts automatically with `arcana web`. This standalone command is kept for debugging.');
    startHeartbeatRunner({
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
          console.log(line.trim());
        } catch {}
      },
    });
    // Keep process alive until interrupted.
    // eslint-disable-next-line no-constant-condition
    while (true){
      // 1 minute sleep to keep event loop active for timers.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve)=> setTimeout(resolve, 60000));
    }
  }

  if (s === 'once'){
    const agentIdx = rest.indexOf('--agent');
    const sessionIdx = rest.indexOf('--session');
    const reasonIdx = rest.indexOf('--reason');
    const agentId = agentIdx >= 0 ? rest[agentIdx + 1] : undefined;
    const sessionKey = sessionIdx >= 0 ? rest[sessionIdx + 1] : undefined;
    const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : undefined;

    const res = await runHeartbeatOnce({ agentId, sessionKey, reason });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (s === 'request'){
    const agentIdx = rest.indexOf('--agent');
    const sessionIdx = rest.indexOf('--session');
    const reasonIdx = rest.indexOf('--reason');
    const agentId = agentIdx >= 0 ? rest[agentIdx + 1] : undefined;
    const sessionKey = sessionIdx >= 0 ? rest[sessionIdx + 1] : undefined;
    const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : undefined;

    if (!agentId){
      return error('arcana heartbeat request --agent <id> [--session <sessionKey>] [--reason <r>]');
    }

    requestHeartbeatNow({ agentId, sessionKey, reason });
    console.log('[arcana] heartbeat wake requested for agent=' + agentId + (sessionKey ? ' sessionKey=' + sessionKey : '') + (reason ? ' reason=' + reason : ''));
    return;
  }

  if (s === 'enqueue'){
    const agentIdx = rest.indexOf('--agent');
    const sessionIdx = rest.indexOf('--session');
    const textIdx = rest.indexOf('--text');
    const ctxIdx = rest.indexOf('--context');
    const dedupeIdx = rest.indexOf('--dedupe');
    const wake = rest.includes('--wake');

    const agentId = agentIdx >= 0 ? rest[agentIdx + 1] : undefined;
    const sessionKey = sessionIdx >= 0 ? rest[sessionIdx + 1] : undefined;
    const text = textIdx >= 0 ? rest[textIdx + 1] : undefined;
    const contextKey = ctxIdx >= 0 ? rest[ctxIdx + 1] : undefined;
    const dedupeKey = dedupeIdx >= 0 ? rest[dedupeIdx + 1] : undefined;

    if (!agentId || !sessionKey || !text){
      return error('arcana heartbeat enqueue --agent <id> --session <sessionKey> --text <text> [--context c] [--dedupe k] [--wake]');
    }

    const record = await enqueueSystemEvent({ agentId, sessionKey, text, contextKey, dedupeKey });
    console.log(JSON.stringify(record, null, 2));

    if (wake){
      requestHeartbeatNow({ agentId, sessionKey, reason: 'enqueue' });
      console.log('[arcana] heartbeat wake requested for agent=' + agentId + ' sessionKey=' + sessionKey + ' reason=enqueue');
    }
    return;
  }

  if (s === 'status'){
    const agents = await loadAgentsSnapshot();
    if (!agents.length){
      console.log('no agents found under ~/.arcana/agents');
      return;
    }

    for (const meta of agents){
      if (!meta || !meta.agentId) continue;
      const agentId = String(meta.agentId);
      let cfg = null;
      try { cfg = await loadHeartbeatConfigForAgent(agentId); } catch { cfg = null; }
      const enabled = !!(cfg && cfg.enabled !== false);
      const every = cfg && Object.prototype.hasOwnProperty.call(cfg, 'every') ? cfg.every : null;
      const interval = every != null ? every : null;
      const session = cfg && (typeof cfg.targetSessionId === 'string' ? cfg.targetSessionId : (typeof cfg.sessionId === 'string' ? cfg.sessionId : ''));
      const parts = [];
      parts.push('agent=' + agentId);
      parts.push('enabled=' + enabled);
      if (interval != null) parts.push('every=' + interval);
      if (session) parts.push('targetSessionId=' + session);
      console.log(parts.join(' '));
    }
    return;
  }

  return console.log(HELP);
}

async function chat2(){
  const { session, model, toolNames, pluginFiles, pluginErrors, toolHost } = await createArcanaSession({ cwd: process.cwd() });
  if (pluginErrors && pluginErrors.length) { for (const e of pluginErrors) console.warn('[arcana][plugin]', e.file, '-', e.message); }
  const modelLabel = model ? (model.provider + ':' + model.id + (model.baseUrl ? (' @ ' + model.baseUrl) : '')) : '<auto>';
  console.info('[arcana] model:', modelLabel);
  console.info('[arcana] plugins:', (pluginFiles?.length||0), 'files,', (toolNames?.length||0), 'tools');
  console.info('[arcana] tools:', (toolNames||[]).join(', '));
  const env = String(process.env.ARCANA_WORKSPACE||"").trim();
  console.info('[arcana] work path:', env);
  // Stream text updates and show tool events
  let buffer = '';
  session.subscribe((ev)=>{
    if (ev.type === 'tool_execution_start'){
      try { console.info('[arcana] tool start:', ev.toolName, ev.args ? JSON.stringify(ev.args) : ''); }
      catch { console.info('[arcana] tool start:', ev.toolName); }
    }
    if (ev.type === 'tool_execution_end'){
      const ok = ev.error ? false : true;
      console.info('[arcana] tool end:', ev.toolName, ok ? 'ok' : ('error: ' + (ev.error?.message||ev.error)));
    }
    if (ev.type === 'message_update' && ev.message.role === 'assistant'){
      const blocks = ev.message.content.filter(c=>c.type==='text');
      const text = blocks.map(c=>c.text).join('');
      if (text && text !== buffer){ process.stdout.write(text.slice(buffer.length)); buffer = text; }
    }
    if (ev.type === 'message_end' && ev.message.role === 'assistant'){
      process.stdout.write('\n'); buffer='';
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let inFlight = false;
  const queue = [];

  async function runPrompt(line){
    inFlight = true;
    try { await session.prompt(line); }
    catch(e){ try{ console.error('[arcana]', e?.stack||e?.message||e); } catch{} }
    finally { inFlight = false; if (queue.length){ const next = queue.shift(); runPrompt(next); } }
  }

  function printStatus(){
    const st = toolHost?.getStatus ? toolHost.getStatus() : { busy:false };
    if (st.busy){ console.info('[arcana] status: running tool', st.method, '-', Math.round((st.elapsedMs||0)/1000)+'s'); }
    else console.info('[arcana] status: idle');
  }

  rl.on('line', async (line)=>{
    const t = String(line||'').trim();
    if (t === '/status'){ printStatus(); rl.prompt(); return; }
    if (t === '/cancel'){
      const ok = await (toolHost?.cancelActiveCall?.()||false);
      console.info('[arcana] cancel:', ok ? 'sent (tool-host killed, restarting...)' : 'nothing to cancel');
      rl.prompt();
      return;
    }
    if (inFlight){ queue.push(line); return; }
    runPrompt(line);
  });

  rl.setPrompt('> ');
  rl.prompt();
}
