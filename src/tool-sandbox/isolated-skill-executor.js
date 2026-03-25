// Isolated Skill Tool Executor (parent side)
//
// Spawns a Node child process with the experimental permission
// system enabled and forwards a single tool invocation payload
// via stdin. The child runs src/tool-sandbox/isolated-skill-runner.js
// which in turn loads the tool module and executes it.
//
// JSONL protocol on child stdout:
//   { type: 'update', partial }
//   { type: 'result', result }
//   { type: 'error', error }
//
// This helper returns an executor function that mirrors the
// ToolDefinition.execute(callId, args, signal, onUpdate, ctx)
// signature and can be used to wrap skill tools marked as
// isolated in SKILL.md frontmatter.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { resolveWorkspaceRoot } from '../workspace-guard.js';
import { resolveArcanaHome, arcanaHomePath } from '../arcana-home.js';
import { createSafeOps } from '../tools/safe-ops.js';

function safeStringify(obj){
  const seen = new WeakSet();
  return JSON.stringify(obj, (k, v)=>{
    if (typeof v === 'function') return undefined;
    if (typeof v === 'bigint') return String(v);
    if (v && typeof v === 'object'){
      if (seen.has(v)) return undefined;
      seen.add(v);
    }
    return v;
  });
}

function toArray(value){
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function normalizePathList(list, workspaceRoot){
  const root = workspaceRoot || resolveWorkspaceRoot();
  const out = [];
  for (const raw of toArray(list)){
    if (!raw) continue;
    const s = String(raw);
    const abs = isAbsolute(s) ? s : resolve(root, s);
    out.push(abs);
  }
  return out;
}

function buildSeatbeltPolicyDenyNetwork(){
  // Minimal Seatbelt policy: allow everything else, but deny any network access.
  // Node permission flags still restrict FS/child-process/etc.
  return `(version 1)
(allow default)
(deny network*)
`;
}

function resolveSandboxExecBin(){
  return process.env.ARCANA_SANDBOX_SEATBELT_BIN || '/usr/bin/sandbox-exec';
}

function shouldUseSeatbelt(){
  if (process.env.ARCANA_SANDBOX_SEATBELT === '0') return false;
  if (process.platform !== 'darwin') return false;
  try {
    const sb = resolveSandboxExecBin();
    return !!(sb && existsSync(sb));
  } catch {
    return false;
  }
}

function iso(tsMs){
  try { return new Date(typeof tsMs === 'number' ? tsMs : Date.now()).toISOString(); } catch { return String(tsMs || ''); }
}

function auditLogPath(tsMs){
  const day = iso(tsMs).slice(0, 10);
  return arcanaHomePath('tool-sandbox', 'http-broker', 'audit-' + day + '.jsonl');
}

function redactUrl(u){
  const redact = (process.env.ARCANA_HTTP_BROKER_AUDIT_REDACT || '1') !== '0';
  try {
    const x = new URL(String(u));
    // remove creds
    try { x.username = ''; x.password = ''; } catch {}
    if (!redact) return x.toString();
    if (!x.search) return x.toString();
    const params = new URLSearchParams(x.search);
    for (const k of params.keys()) params.set(k, 'REDACTED');
    const s = params.toString();
    x.search = s ? ('?' + s) : '';
    return x.toString();
  } catch {
    return String(u || '');
  }
}

function parseHostPort(u){
  try {
    const x = new URL(String(u));
    const port = x.port ? (':' + x.port) : (x.protocol === 'https:' ? ':443' : ':80');
    return (x.hostname + port).toLowerCase();
  } catch {
    return '';
  }
}

async function appendHttpBrokerAudit(record){
  try {
    if (!record || typeof record !== 'object') return;
    const tsMs = Date.now();
    const payload = { ...record };
    if (!Object.prototype.hasOwnProperty.call(payload, 'tsMs')) payload.tsMs = tsMs;
    if (!Object.prototype.hasOwnProperty.call(payload, 'ts')) payload.ts = iso(payload.tsMs);

    const filePath = auditLogPath(payload.tsMs);
    try { await fsp.mkdir(dirname(filePath), { recursive: true }); } catch {}

    await fsp.appendFile(filePath, JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    // best-effort only
  }
}

function buildFsReadArgs({ allowedReadPaths, toolEntryDir, workspaceRoot, agentHomeRoot }){
  const args = [];
  const root = workspaceRoot || resolveWorkspaceRoot();
  const readPaths = [];

  // Always allow the tool module itself to be imported.
  if (toolEntryDir) readPaths.push(toolEntryDir);

  // Workspace root (most tools read/write relative to the workspace).
  if (root) readPaths.push(root);

  // Arcana code + deps may be imported by tools (wrapArcanaTool, etc).
  try { readPaths.push(resolve(root, 'src')); } catch {}
  try { readPaths.push(resolve(root, 'node_modules')); } catch {}

  // Allow reading Arcana home for secrets/memory access via the secrets store.
  try {
    const home = resolveArcanaHome();
    if (home) readPaths.push(home);
  } catch {}
  if (agentHomeRoot) readPaths.push(agentHomeRoot);

  // Node may walk up to the user's home package.json to determine ESM/CJS semantics
  // for .js files outside the workspace (e.g., agent-home skills). Allow read of that file only.
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) readPaths.push(resolve(homeDir, 'package.json'));
  } catch {}

  // Optional extra read allow-list from SKILL.md frontmatter.
  if (Array.isArray(allowedReadPaths) && allowedReadPaths.length){
    readPaths.push(...normalizePathList(allowedReadPaths, root));
  }

  // Dedupe
  const seen = new Set();
  for (const p of readPaths){
    if (!p) continue;
    const abs = String(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    args.push('--allow-fs-read=' + abs);
  }
  return args;
}

function buildFsWriteArgs({ allowWrite, allowedWritePaths, workspaceRoot }){
  const args = [];
  const root = workspaceRoot || resolveWorkspaceRoot();
  if (allowWrite === false){
    return args;
  }
  if (Array.isArray(allowedWritePaths) && allowedWritePaths.length){
    const paths = normalizePathList(allowedWritePaths, root);
    for (const p of paths){
      if (!p) continue;
      args.push('--allow-fs-write=' + p);
    }
    return args;
  }
  args.push('--allow-fs-write=' + root);
  return args;
}

function buildNodeArgs({ runnerPath, toolEntry, skillSafety, agentHomeRoot }){
  const workspaceRoot = resolveWorkspaceRoot();
  const toolDir = dirname(toolEntry);
  const baseArgs = ['--experimental-permission', '--allow-child-process', '--allow-worker'];

  const fsReadArgs = buildFsReadArgs({
    allowedReadPaths: skillSafety && Array.isArray(skillSafety.allowedReadPaths) ? skillSafety.allowedReadPaths : undefined,
    toolEntryDir: toolDir,
    workspaceRoot,
    agentHomeRoot,
  });

  const fsWriteArgs = buildFsWriteArgs({
    allowWrite: skillSafety && skillSafety.allowWrite !== undefined ? !!skillSafety.allowWrite : undefined,
    allowedWritePaths: skillSafety && Array.isArray(skillSafety.allowedWritePaths) ? skillSafety.allowedWritePaths : undefined,
    workspaceRoot,
  });

  // Network is denied at the process level (platform sandbox / best-effort)
  // and exposed only via the SafeOps HTTP broker (parent process).
  const nodeArgs = [
    ...baseArgs,
    ...fsReadArgs,
    ...fsWriteArgs,
    runnerPath,
  ];
  return nodeArgs;
}

export function createIsolatedSkillExecutor({ toolEntry, toolName, skillSafety, agentHomeRoot }){
  const workspaceRoot = resolveWorkspaceRoot();
  const runnerPath = fileURLToPath(new URL('./isolated-skill-runner.js', import.meta.url));
  const entryPath = toolEntry && toolEntry.startsWith('file:') ? fileURLToPath(toolEntry) : toolEntry;
  const scriptPath = runnerPath;

  return async function isolatedExecute(callId, args, signal, onUpdate, ctx){
    const payload = {
      agentHomeRoot: agentHomeRoot || '',
      toolEntry: entryPath,
      callId,
      args,
      toolName,
      ctx: ctx || {},
      safety: skillSafety || {},
    };

    const nodeExec = process.execPath;
    const childArgs = buildNodeArgs({ runnerPath: scriptPath, toolEntry: entryPath, skillSafety, agentHomeRoot });

    let spawnCmd = nodeExec;
    let spawnArgs = childArgs;

    // On macOS, use Seatbelt (sandbox-exec) to strongly deny direct network access.
    // All HTTP(S) must go through the parent broker, which enforces allowedHosts.
    if (shouldUseSeatbelt()){
      const sb = resolveSandboxExecBin();
      const policy = buildSeatbeltPolicyDenyNetwork();
      spawnCmd = sb;
      spawnArgs = ['-p', policy, nodeExec, ...childArgs];
    }

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
      serialization: 'advanced',
    });



    const safety = skillSafety || {};
    const parentSafeOps = createSafeOps({
      allowNetwork: safety.allowNetwork !== false,
      allowedHosts: Array.isArray(safety.allowedHosts) ? safety.allowedHosts : undefined,
    });

    // id -> { ctrl:AbortController, startedMs:number, url:string, hostPort:string, method:string }
    const inflight = new Map();

    const sendIpc = (m)=>{ try { child.send && child.send(m); } catch {} };

    child.on('message', async (msg)=>{
      try {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'safeops_http_cancel'){
          const id = msg.id;
          const meta = inflight.get(id);
          if (meta && meta.ctrl){
            try { meta.ctrl.abort(); } catch {}
          }
          inflight.delete(id);
          await appendHttpBrokerAudit({
            kind: 'tool.http.cancel',
            toolName,
            callId,
            requestId: id,
            url: meta && meta.url ? meta.url : undefined,
            hostPort: meta && meta.hostPort ? meta.hostPort : undefined,
            method: meta && meta.method ? meta.method : undefined,
          });
          return;
        }
        if (msg.type !== 'safeops_http_fetch') return;
        const id = msg.id;
        const url = String(msg.url || '');
        const init = (msg.init && typeof msg.init === 'object') ? msg.init : {};

        const startedMs = Date.now();
        const ctrl = new AbortController();
        const method = String(init.method || 'GET').toUpperCase();
        const hostPort = parseHostPort(url);
        const urlRedacted = redactUrl(url);
        inflight.set(id, { ctrl, startedMs, method, hostPort, url: urlRedacted });

        try {
          const res = await parentSafeOps.http.fetch(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
            redirect: init.redirect,
            timeout: init.timeout,
            signal: ctrl.signal,
          });
          const bodyBuf = Buffer.from(await parentSafeOps.http.readBody(res));
          const headers = [];
          try { for (const [k,v] of res.headers) headers.push([k, v]); } catch {}
          sendIpc({ type: 'safeops_http_response', id, status: res.status, headers, body: bodyBuf });

          const meta = inflight.get(id);
          await appendHttpBrokerAudit({
            kind: 'tool.http',
            outcome: 'ok',
            toolName,
            callId,
            requestId: id,
            url: meta && meta.url ? meta.url : urlRedacted,
            hostPort: meta && meta.hostPort ? meta.hostPort : hostPort,
            method: meta && meta.method ? meta.method : method,
            status: res.status,
            durationMs: meta && meta.startedMs ? (Date.now() - meta.startedMs) : undefined,
            bytes: bodyBuf ? bodyBuf.length : undefined,
            allowedHosts: Array.isArray(safety.allowedHosts) ? safety.allowedHosts : undefined,
          });
        } catch (e) {
          const errMsg = String(e && e.message ? e.message : e);
          sendIpc({ type: 'safeops_http_response', id, error: { message: errMsg } });

          const meta = inflight.get(id);
          await appendHttpBrokerAudit({
            kind: 'tool.http',
            outcome: 'error',
            toolName,
            callId,
            requestId: id,
            url: meta && meta.url ? meta.url : redactUrl(url),
            hostPort: meta && meta.hostPort ? meta.hostPort : parseHostPort(url),
            method: meta && meta.method ? meta.method : String(init.method || 'GET').toUpperCase(),
            durationMs: meta && meta.startedMs ? (Date.now() - meta.startedMs) : undefined,
            error: errMsg,
            allowedHosts: Array.isArray(safety.allowedHosts) ? safety.allowedHosts : undefined,
          });
        } finally {
          inflight.delete(id);
        }
      } catch (e) {
        // ignore
      }
    });
    let settled = false;
    let lastError = null;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const onAbort = ()=>{
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(()=>{ try { child.kill('SIGKILL'); } catch {} }, 1000).unref?.();
    };
    if (signal){
      if (signal.aborted){
        onAbort();
      } else if (typeof signal.addEventListener === 'function'){
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const writePayload = ()=>{
      try {
        child.stdin.write(JSON.stringify(payload) + '\n');
        child.stdin.end();
      } catch (e) {
        lastError = e;
      }
    };

    // Start piping the payload once the process is ready.
    writePayload();

    return await new Promise((resolve, reject)=>{
      rl.on('line', (line)=>{
        let msg;
        try { msg = JSON.parse(line || '{}'); }
        catch {
          lastError = new Error('invalid_child_message');
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'update'){
          if (typeof onUpdate === 'function'){
            try { onUpdate(msg.partial); } catch {}
          }
          return;
        }
        if (msg.type === 'result'){
          if (settled) return;
          settled = true;
          resolve(msg.result);
          return;
        }
        if (msg.type === 'error'){
          const e = msg.error || { message: 'child_error' };
          const msgText = String((e && e.message) ? e.message : e);
          const details = (e && e.details) ? String(e.details) : '';
          const err = new Error(details ? (msgText + ': ' + details) : msgText);
          try { err.code = e && e.code ? e.code : undefined; } catch {}
          lastError = err;
        }
      });

      rl.on('close', ()=>{
        if (settled) return;
        if (lastError){
          const err = lastError instanceof Error ? lastError : new Error(String(lastError && lastError.message ? lastError.message : lastError));
          reject(err);
        } else {
          reject(new Error('isolated_tool_no_result'));
        }
      });

      child.on('error', (err)=>{
        if (settled) return;
        settled = true;
        reject(err);
      });

      child.on('exit', (code, sig)=>{
        if (settled) return;
        if (code === 0){
          // If we reach here without a result, treat as error.
          settled = true;
          reject(new Error('isolated_tool_missing_result'));
        } else {
          settled = true;
          const label = sig ? 'signal ' + sig : 'code ' + code;
          reject(new Error('isolated_tool_exit_' + label));
        }
      });
    });
  };
}

export default { createIsolatedSkillExecutor };
