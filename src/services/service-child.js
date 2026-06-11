// Forked harness for an isolated service.
//
// Runs in its OWN process: it imports the service module, calls start(ctx),
// keeps the returned handle, emits heartbeats to the supervisor, and shuts the
// service down cleanly on request. A crash here (uncaught exception, OOM,
// blocked event loop) takes down only this process — the gateway and every
// other service keep running. The supervisor restarts it.
//
// IPC protocol (parent -> child):
//   { type: 'init', servicePath, ctx, heartbeatIntervalMs, sdkInit }
//   { type: 'stop' }
//   { type: 'sdk_rpc_result', id, ok, value | error: { message, code } }
// IPC protocol (child -> parent):
//   { type: 'spawned' }                      // process is alive, awaiting init
//   { type: 'ready', hasStop }               // start(ctx) resolved
//   { type: 'skipped' }                       // module has no start()/default
//   { type: 'heartbeat' }                     // periodic liveness
//   { type: 'fatal', error }                  // about to exit non-zero
//   { type: 'sdk_rpc', id, method, params }   // capability call (e.g. secrets)

import { pathToFileURL } from 'node:url';
import { buildServiceSdk } from './sdk.js';

const STOP_TIMEOUT_MS = 5000;
const SDK_RPC_TIMEOUT_MS = 30000;

let handle = null;
let stopping = false;
let heartbeatTimer = null;

const pendingRpc = new Map(); // id -> { resolve, reject, timer }
let rpcSeq = 0;

function send(msg){
  try { if (typeof process.send === 'function') process.send(msg); } catch {}
}

function ipcCall(method, params){
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      const err = new Error('sdk rpc timeout: ' + method);
      err.code = 'SDK_RPC_TIMEOUT';
      reject(err);
    }, SDK_RPC_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    pendingRpc.set(id, { resolve, reject, timer });
    send({ type: 'sdk_rpc', id, method, params });
  });
}

function onRpcResult(msg){
  const entry = pendingRpc.get(msg.id);
  if (!entry) return;
  pendingRpc.delete(msg.id);
  try { clearTimeout(entry.timer); } catch {}
  if (msg.ok){
    entry.resolve(msg.value);
  } else {
    const err = new Error(msg.error && msg.error.message ? msg.error.message : 'sdk rpc failed');
    if (msg.error && msg.error.code) err.code = msg.error.code;
    entry.reject(err);
  }
}

function resolveStarter(mod){
  if (mod && typeof mod.start === 'function') return mod.start;
  if (mod && typeof mod.default === 'function') return mod.default;
  if (mod && mod.default && typeof mod.default.start === 'function') return mod.default.start;
  return null;
}

async function runStart(servicePath, ctx, sdkInit){
  const href = pathToFileURL(servicePath).href + '?v=' + String(Date.now());
  const mod = await import(href);
  const starter = resolveStarter(mod);
  if (!starter){
    send({ type: 'skipped' });
    return;
  }
  const sdk = buildServiceSdk({
    mode: 'child',
    serviceId: ctx && ctx.serviceId,
    workspaceRoot: ctx && ctx.workspaceRoot,
    logDir: ctx && ctx.logDir,
    secretsAllowlist: sdkInit && sdkInit.secretsAllowlist,
    ipcCall,
  });
  handle = await starter({ ...ctx, sdk });
  send({ type: 'ready', hasStop: !!(handle && typeof handle.stop === 'function') });
}

async function shutdown(code){
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer){ try { clearInterval(heartbeatTimer); } catch {} heartbeatTimer = null; }
  try {
    if (handle && typeof handle.stop === 'function'){
      await Promise.race([
        Promise.resolve().then(() => handle.stop()),
        new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
      ]);
    }
  } catch {}
  process.exit(code);
}

function startHeartbeat(intervalMs){
  const ms = Number(intervalMs) > 0 ? Math.floor(Number(intervalMs)) : 2000;
  heartbeatTimer = setInterval(() => send({ type: 'heartbeat' }), ms);
  if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init'){
    startHeartbeat(msg.heartbeatIntervalMs);
    runStart(msg.servicePath, msg.ctx, msg.sdkInit).catch((err) => {
      send({ type: 'fatal', error: String(err && err.stack ? err.stack : err) });
      process.exit(1);
    });
  } else if (msg.type === 'sdk_rpc_result'){
    onRpcResult(msg);
  } else if (msg.type === 'stop'){
    shutdown(0);
  }
});

process.on('uncaughtException', (err) => {
  send({ type: 'fatal', error: String(err && err.stack ? err.stack : err) });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  send({ type: 'fatal', error: String(err && err.stack ? err.stack : err) });
  process.exit(1);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

send({ type: 'spawned' });
