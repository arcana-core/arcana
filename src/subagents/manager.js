import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspaceRoot } from '../workspace-guard.js';
import { emit as emitEvent } from '../event-bus.js';

function registryPath(){
  const root = resolveWorkspaceRoot();
  const dir = join(root, 'arcana', '.cache', 'subagents');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return join(dir, 'runs.json');
}

function loadRuns(){
  const p = registryPath();
  try { if (existsSync(p)) return new Map(JSON.parse(readFileSync(p,'utf-8'))); } catch {}
  return new Map();
}

function saveRuns(map){
  const p = registryPath();
  try { writeFileSync(p, JSON.stringify(Array.from(map.entries()), null, 2)); } catch {}
}

const runs = loadRuns();
const liveChildren = new Map(); // runId -> ChildProcess

function now(){ return Date.now(); }
function makeChildSessionKey(){ return 'agent:arcana:subagent:' + randomUUID(); }

export function listRuns(recentMinutes=60){
  const cutoff = now() - Math.max(1, Math.floor(recentMinutes))*60_000;
  const active = [];
  const recent = [];
  for (const [runId, r] of runs.entries()){
    const entry = { runId, childSessionKey: r.childSessionKey, label: r.label, task: r.task, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status };
    if (r.endedAt) { if (r.endedAt >= cutoff) recent.push(entry); }
    else active.push(entry);
  }
  return { active, recent };
}

export function spawnSubagent({ task, label, allowedPaths, runTimeoutSeconds }){
  const runId = randomUUID();
  const childSessionKey = makeChildSessionKey();
  const root = resolveWorkspaceRoot();
  const childPath = resolve(join(root, 'arcana', 'src', 'subagents', 'embedded-child.js'));
  const init = { task, label, allowedPaths, runId, childSessionKey };
  const child = spawn(process.execPath, [childPath], {
    cwd: root,
    stdio: ['pipe','pipe','pipe'],
    env: { ...process.env, SUBAGENT_INIT: JSON.stringify(init) },
  });
  liveChildren.set(runId, child);

  const record = { runId, childSessionKey, task, label, pid: child.pid, startedAt: now(), status: 'running' };
  runs.set(runId, record); saveRuns(runs);
  emitEvent({ type:'subagent_start', id: runId, agent: 'embedded', args: [task] });

  child.on('close', (code, signal)=>{
    const ended = runs.get(runId); if (!ended) return;
    ended.endedAt = now();
    ended.status = code===0 ? 'ok' : (signal ? 'signal:' + signal : 'exit:' + code);
    saveRuns(runs);
    liveChildren.delete(runId);
    emitEvent({ type:'subagent_end', id: runId, code, ok: code===0 });
  });
  child.stdout.on('data', (d)=> emitEvent({ type:'subagent_stream', id: runId, stream: 'stdout', chunk: String(d) }));
  child.stderr.on('data', (d)=> emitEvent({ type:'subagent_stream', id: runId, stream: 'stderr', chunk: String(d) }));

  if (runTimeoutSeconds && Number.isFinite(runTimeoutSeconds) && runTimeoutSeconds>0){
    setTimeout(()=>{ try { child.kill('SIGKILL'); } catch {} }, Math.floor(runTimeoutSeconds)*1000).unref?.();
  }

  return { status: 'accepted', childSessionKey, runId };
}

export function steerSubagent(target, message){
  const run = [...runs.values()].find(r=> r.runId===target || r.childSessionKey===target);
  if (!run) return { status: 'error', error: 'not_found' };
  const child = liveChildren.get(run.runId);
  if (!child || !child.stdin) return { status: 'error', error: 'not_active' };
  try {
    child.stdin.write(JSON.stringify({ op:'message', message })+'\n');
    return { status: 'ok' };
  } catch (e){ return { status:'error', error: String(e&&e.message||e) }; }
}

export function killSubagent(target){
  const run = [...runs.values()].find(r=> r.runId===target || r.childSessionKey===target);
  if (!run) return { status: 'not-found' };
  const child = liveChildren.get(run.runId);
  if (!child) return { status: 'not-found' };
  try { child.kill('SIGKILL'); return { status:'ok' }; } catch { return { status:'error' }; }
}

export default { listRuns, spawnSubagent, steerSubagent, killSubagent };
