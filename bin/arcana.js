#!/usr/bin/env node
import readline from 'node:readline';
import { createArcanaSession } from '../src/session.js';
import { runDoctor, printDoctor } from '../src/doctor.js';
import { createSupportBundle } from '../src/support-bundle.js';
import { webCLI } from '../src/cli-web.js';
import { wechatCLI } from '../src/cli-wechat.js';
import { runDueOnce, serveLoop, runJobById } from '../src/timer/runner.js';
import { listJobSummaries as timerList, listRuns as timerListRuns } from '../src/timer/store.js';

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
  arcana timer once                      # run due jobs once and exit
  arcana timer serve                     # run scheduler loop (Ctrl+C to stop)
  arcana timer run <id>                  # run a specific job now
  arcana timer list                      # list jobs
  arcana timer runs [--limit n]          # list recent runs

Env:
  OPENAI_API_KEY (or /login in interactive modes)
`;

function error(msg){ console.error('[arcana]', msg); process.exit(1); }

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
    await new Promise((resolve)=> rl.question('> ', async (line)=>{ try { await session.prompt(line); } catch(e){ console.error('[arcana]', e?.message||e); } resolve(); }));
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
  if (cmd === 'timer') return timerCLI({ args: argv });
  return console.log(HELP);
}

main().catch((e)=>{ console.error('[arcana] failed:', e?.message||e); process.exit(1); });

async function timerCLI({ args }){
  const [, , sub, ...rest] = args;
  const s = String(sub||'').toLowerCase();
  if (s === 'once'){
    const results = await runDueOnce();
    for (const r of results){
      if (r.skipped) console.log('[arcana] skipped', r.reason||'');
      else console.log('[arcana] run', r.jobId, r.ok?'ok':'error');
    }
    return;
  }
  if (s === 'serve'){
    console.log('[arcana] timer: serve loop (Ctrl+C to stop)');
    await serveLoop({ intervalMs: 1000 });
    return;
  }
  if (s === 'run'){
    const id = rest[0];
    if (!id) return error('arcana timer run <id>');
    const r = await runJobById(id);
    if (r && r.skipped) console.log('[arcana] skipped', r.reason||'');
    else console.log('[arcana] run', id, r && r.ok ? 'ok' : 'error');
    return;
  }
  if (s === 'list'){
    const items = timerList();
    for (const j of items){
      console.log(j.id + '\t' + (j.enabled?'on':'off') + '\t' + j.schedule.type + ':' + j.schedule.value + (j.schedule.timezone?('('+j.schedule.timezone+')'):'') + '\t' + (j.nextRunAtMs?new Date(j.nextRunAtMs).toISOString():'n/a') + '\t' + j.title);
    }
    if (!items.length) console.log('no jobs');
    return;
  }
  if (s === 'runs'){
    const idx = Math.max(0, args.indexOf('--limit'));
    const limit = idx > -1 ? parseInt(args[idx+1]||'50', 10) : 50;
    const runs = timerListRuns({ limit: Number.isFinite(limit) ? limit : 50 });
    for (const r of runs){
      console.log(r.jobId + '\t' + (r.ok?'ok':'err') + '\t' + new Date(r.startedAtMs).toISOString() + '\t' + (r.title||''));
    }
    if (!runs.length) console.log('no runs');
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
    catch(e){ console.error('[arcana]', e?.message||e); }
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
