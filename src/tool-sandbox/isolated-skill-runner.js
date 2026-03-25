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
import { createSecretsContext } from '../secrets/context.js';


function serializeHeaders(h){
  try {
    if (!h) return undefined;
    if (Array.isArray(h)) return h;
    if (typeof Headers !== 'undefined' && h instanceof Headers){
      const out = [];
      for (const [k,v] of h.entries()) out.push([k,v]);
      return out;
    }
    if (typeof h === 'object'){
      const out = [];
      for (const [k,v] of Object.entries(h)) out.push([k, String(v)]);
      return out;
    }
  } catch {}
  return undefined;
}

function serializeBody(b){
  if (b == null) return undefined;
  if (typeof b === 'string') return b;
  // Buffer/Uint8Array/ArrayBuffer are structured-cloneable over IPC
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  // Don't support streaming bodies in the broker v0
  throw new Error('unsupported_body');
}

function createHttpBrokerFetch(){
  if (!process.send || typeof process.send !== 'function'){
    return null;
  }
  let nextId = 1;
  const pending = new Map();

  const onMessage = (msg)=>{
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type !== 'safeops_http_response') return;
      const id = msg.id;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (msg.error){
        const e = new Error(String(msg.error.message || 'http_error'));
        try { e.code = msg.error.code; } catch {}
        p.reject(e);
        return;
      }
      const headers = Array.isArray(msg.headers) ? msg.headers : undefined;
      const body = msg.body !== undefined ? msg.body : undefined;
      // Build a real Response so downstream code can call res.text()/arrayBuffer()/etc.
      const res = new Response(body, { status: msg.status || 200, headers });
      p.resolve(res);
    } catch (e) {
      // ignore
    }
  };

  try { process.on('message', onMessage); } catch {}

  const brokerFetch = (u, init = {})=>{
    const id = nextId++;
    return new Promise((resolve, reject)=>{
      pending.set(id, { resolve, reject });
      const payload = {
        type: 'safeops_http_fetch',
        id,
        url: String(u),
        init: {
          method: init.method,
          headers: serializeHeaders(init.headers),
          body: undefined,
          redirect: init.redirect,
          timeout: init.timeout,
        }
      };
      try {
        if (init.body !== undefined) payload.init.body = serializeBody(init.body);
      } catch (e) {
        pending.delete(id);
        reject(e);
        return;
      }

      const sig = init.signal;
      const onAbort = ()=>{
        try {
          if (process.send) process.send({ type: 'safeops_http_cancel', id });
        } catch {}
      };
      try {
        if (sig && typeof sig.addEventListener === 'function') sig.addEventListener('abort', onAbort, { once: true });
        if (sig && sig.aborted) onAbort();
      } catch {}

      try {
        process.send(payload);
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  };

  return brokerFetch;
}

function disableDirectNetworkBestEffort(){
  // Not a security boundary by itself; just prevents accidental direct net usage.
  try {
    if (typeof globalThis.fetch === 'function'){
      globalThis.fetch = async ()=>{ throw new Error('direct_network_disabled_use_safeOps'); };
    }
  } catch {}
}

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
  disableDirectNetworkBestEffort();

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

    const agentHomeRoot = payload && payload.agentHomeRoot
      ? String(payload.agentHomeRoot)
      : (ctx && (ctx.agentHomeRoot || ctx.agentDir || ctx.agentHome) ? String(ctx.agentHomeRoot || ctx.agentDir || ctx.agentHome) : '');

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
      send({ type: 'error', error: { message: 'import_failed', details: String(e && e.stack ? e.stack : (e && e.message ? e.message : e)) } });
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

    const brokerFetch = createHttpBrokerFetch();

    const safeOps = createSafeOps({
      allowNetwork: safety && safety.allowNetwork !== undefined ? !!safety.allowNetwork : true,
      allowWrite: safety && safety.allowWrite !== undefined ? !!safety.allowWrite : true,
      allowedHosts: Array.isArray(safety && safety.allowedHosts) ? safety.allowedHosts : undefined,
      allowedWritePaths: Array.isArray(safety && safety.allowedWritePaths) ? safety.allowedWritePaths : undefined,
      // Strong net isolation: the child process must not open sockets directly.
      // All HTTP(S) goes through the parent broker, which enforces allowedHosts.
      fetchImpl: brokerFetch || (async ()=>{ throw new Error('http_broker_unavailable'); }),
    });

    const secrets = createSecretsContext({ agentHomeRoot });

    const ctxWithSafeOps = { ...(ctx || {}), safeOps, secrets, agentHomeRoot };

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

