// Isolated Skill Tool Runner (child process)
//
// - Reads a single JSON payload from stdin:
//   { toolEntry, callId, args, toolName, ctx, safety }
// - Dynamically imports the toolEntry module (ESM) and calls its
//   default export factory to obtain a ToolDefinition.
// - Executes def.execute(callId, args, signal, onUpdate, ctxWithSafeOps)
//   where ctxWithSafeOps extends the provided ctx with SafeOps
//   constructed from the given safety configuration.
// - Emits JSONL messages on stdout:
//   { type: 'update', partial }
//   { type: 'result', result }
//   { type: 'error', error }
//
// All console.* output is redirected to stderr so stdout remains
// clean JSONL for the parent process.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createSafeOps } from '../tools/safe-ops.js';

function redirectConsoleToStderr(){
  try {
    const orig = { ...console };
    const stderr = process.stderr;
    const make = (level)=>function(...args){
      try {
        const msg = args.map((v)=>{
          try { return typeof v === 'string' ? v : JSON.stringify(v); }
          catch { return String(v); }
        }).join(' ');
        stderr.write(msg + '\n');
      } catch {
        try { orig[level](...args); } catch {}
      }
    };
    console.log = make('log');
    console.info = make('info');
    console.warn = make('warn');
    console.error = make('error');
    console.debug = make('debug');
  } catch {
    // Best-effort only.
  }
}

function send(msg){
  try {
    if (!msg || typeof msg !== 'object') return;
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch {
    // stdout failure is fatal for the protocol; exit fast.
    try { process.exit(1); } catch {}
  }
}

function buildAbortSignal(){
  if (typeof AbortController !== 'function'){
    return { signal: null, cancel: ()=>{} };
  }
  const ctrl = new AbortController();
  const onSig = ()=>{
    try { ctrl.abort(); } catch {}
  };
  try {
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
  } catch {}
  const cancel = ()=>{
    try { ctrl.abort(); } catch {}
  };
  return { signal: ctrl.signal, cancel };
}

async function main(){
  redirectConsoleToStderr();

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let lineRead = false;

  rl.on('line', async (line)=>{
    if (lineRead) return; // single-shot runner
    lineRead = true;
    rl.close();

    let payload;
    try {
      payload = JSON.parse(line || '{}');
    } catch (e) {
      send({ type: 'error', error: { message: 'invalid_json', details: String(e && e.message ? e.message : e) } });
      try { process.exit(1); } catch {}
      return;
    }

    const toolEntry = payload && payload.toolEntry ? String(payload.toolEntry) : '';
    const callId = payload && payload.callId !== undefined ? payload.callId : undefined;
    const args = payload && payload.args !== undefined ? payload.args : undefined;
    const toolName = payload && payload.toolName ? String(payload.toolName) : '';
    const ctx = payload && typeof payload.ctx === 'object' && payload.ctx !== null ? payload.ctx : {};
    const safety = payload && typeof payload.safety === 'object' && payload.safety !== null ? payload.safety : {};

    if (!toolEntry){
      send({ type: 'error', error: { message: 'missing_tool_entry' } });
      try { process.exit(1); } catch {}
      return;
    }

    let mod;
    try {
      const url = toolEntry.startsWith('file:') ? toolEntry : pathToFileURL(toolEntry).href;
      mod = await import(url);
    } catch (e) {
      send({ type: 'error', error: { message: 'import_failed', details: String(e && e.message ? e.message : e) } });
      try { process.exit(1); } catch {}
      return;
    }

    const factory = mod && typeof mod.default === 'function' ? mod.default : null;
    if (!factory){
      send({ type: 'error', error: { message: 'no_default_factory' } });
      try { process.exit(1); } catch {}
      return;
    }

    let def;
    try {
      def = await Promise.resolve(factory());
    } catch (e) {
      send({ type: 'error', error: { message: 'factory_failed', details: String(e && e.message ? e.message : e) } });
      try { process.exit(1); } catch {}
      return;
    }

    if (!def || typeof def.execute !== 'function'){
      send({ type: 'error', error: { message: 'invalid_definition' } });
      try { process.exit(1); } catch {}
      return;
    }

    const safeOps = createSafeOps({
      allowNetwork: safety && safety.allowNetwork !== undefined ? !!safety.allowNetwork : true,
      allowWrite: safety && safety.allowWrite !== undefined ? !!safety.allowWrite : true,
      allowedHosts: Array.isArray(safety && safety.allowedHosts) ? safety.allowedHosts : undefined,
      allowedWritePaths: Array.isArray(safety && safety.allowedWritePaths) ? safety.allowedWritePaths : undefined,
    });

    const ctxWithSafeOps = { ...(ctx || {}), safeOps };

    const { signal } = buildAbortSignal();

    const onUpdate = (partial)=>{
      try {
        send({ type: 'update', partial });
      } catch {
        // ignore send errors for updates; caller may still await result
      }
    };

    try {
      const result = await def.execute(callId, args, signal, onUpdate, ctxWithSafeOps);
      send({ type: 'result', result });
    } catch (e) {
      send({ type: 'error', error: { message: String(e && e.message ? e.message : e) } });
    } finally {
      try { process.exit(0); } catch {}
    }
  });

  rl.on('close', ()=>{
    if (!lineRead){
      send({ type: 'error', error: { message: 'no_payload' } });
      try { process.exit(1); } catch {}
    }
  });
}

main().catch((e)=>{
  try {
    send({ type: 'error', error: { message: 'runner_crashed', details: String(e && e.message ? e.message : e) } });
  } catch {}
  try { process.exit(1); } catch {}
});

