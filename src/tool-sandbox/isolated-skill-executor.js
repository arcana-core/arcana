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
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { resolveWorkspaceRoot } from '../workspace-guard.js';

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

function buildFsReadArgs({ allowedReadPaths, toolEntryDir, workspaceRoot }){
  const args = [];
  const root = workspaceRoot || resolveWorkspaceRoot();
  const readPaths = [];

  if (Array.isArray(allowedReadPaths) && allowedReadPaths.length){
    readPaths.push(...normalizePathList(allowedReadPaths, root));
    if (toolEntryDir) readPaths.push(toolEntryDir);
    readPaths.push(resolve(root, 'src'));
    readPaths.push(resolve(root, 'node_modules'));
  } else {
    readPaths.push(root);
  }

  for (const p of readPaths){
    if (!p) continue;
    args.push('--allow-fs-read=' + p);
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

function buildNodeArgs({ runnerPath, toolEntry, skillSafety }){
  const workspaceRoot = resolveWorkspaceRoot();
  const toolDir = dirname(toolEntry);
  const baseArgs = ['--experimental-permission'];

  const fsReadArgs = buildFsReadArgs({
    allowedReadPaths: skillSafety && Array.isArray(skillSafety.allowedReadPaths) ? skillSafety.allowedReadPaths : undefined,
    toolEntryDir: toolDir,
    workspaceRoot,
  });

  const fsWriteArgs = buildFsWriteArgs({
    allowWrite: skillSafety && skillSafety.allowWrite !== undefined ? !!skillSafety.allowWrite : undefined,
    allowedWritePaths: skillSafety && Array.isArray(skillSafety.allowedWritePaths) ? skillSafety.allowedWritePaths : undefined,
    workspaceRoot,
  });

  const netArgs = [];
  const safety = skillSafety || {};
  if (safety.allowNetwork === false){
    // no --allow-net flags when network is disabled
  } else {
    const hosts = Array.isArray(safety.allowedHosts)
      ? safety.allowedHosts.map((h)=>String(h).trim()).filter(Boolean)
      : [];
    if (hosts.length){
      netArgs.push('--allow-net=' + hosts.join(','));
    } else {
      netArgs.push('--allow-net');
    }
  }

  const nodeArgs = [
    ...baseArgs,
    ...fsReadArgs,
    ...fsWriteArgs,
    ...netArgs,
    runnerPath,
  ];
  return nodeArgs;
}

export function createIsolatedSkillExecutor({ toolEntry, toolName, skillSafety }){
  const workspaceRoot = resolveWorkspaceRoot();
  const runnerPath = fileURLToPath(new URL('./isolated-skill-runner.js', import.meta.url));
  const entryPath = toolEntry && toolEntry.startsWith('file:') ? fileURLToPath(toolEntry) : toolEntry;
  const scriptPath = runnerPath;

  return async function isolatedExecute(callId, args, signal, onUpdate, ctx){
    const payload = {
      toolEntry: entryPath,
      callId,
      args,
      toolName,
      ctx: ctx || {},
      safety: skillSafety || {},
    };

    const nodeExec = process.execPath;
    const childArgs = buildNodeArgs({ runnerPath: scriptPath, toolEntry: entryPath, skillSafety });

    const child = spawn(nodeExec, childArgs, {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
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
          lastError = msg.error || { message: 'child_error' };
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
