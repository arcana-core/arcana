// Forked harness for an isolated service.
//
// Runs in its OWN process: it imports the service module, calls start(ctx),
// keeps the returned handle, emits heartbeats to the supervisor, and shuts the
// service down cleanly on request. A crash here (uncaught exception, OOM,
// blocked event loop) takes down only this process — the gateway and every
// other service keep running. The supervisor restarts it.
//
// IPC protocol (parent -> child):
//   { type: 'init', servicePath, ctx, heartbeatIntervalMs }
//   { type: 'stop' }
// IPC protocol (child -> parent):
//   { type: 'spawned' }                      // process is alive, awaiting init
//   { type: 'ready', hasStop }               // start(ctx) resolved
//   { type: 'skipped' }                       // module has no start()/default
//   { type: 'heartbeat' }                     // periodic liveness
//   { type: 'fatal', error }                  // about to exit non-zero

import { pathToFileURL } from 'node:url';

const STOP_TIMEOUT_MS = 5000;

let handle = null;
let stopping = false;
let heartbeatTimer = null;

function send(msg){
  try { if (typeof process.send === 'function') process.send(msg); } catch {}
}

function resolveStarter(mod){
  if (mod && typeof mod.start === 'function') return mod.start;
  if (mod && typeof mod.default === 'function') return mod.default;
  if (mod && mod.default && typeof mod.default.start === 'function') return mod.default.start;
  return null;
}

async function runStart(servicePath, ctx){
  const href = pathToFileURL(servicePath).href + '?v=' + String(Date.now());
  const mod = await import(href);
  const starter = resolveStarter(mod);
  if (!starter){
    send({ type: 'skipped' });
    return;
  }
  handle = await starter(ctx);
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
    runStart(msg.servicePath, msg.ctx).catch((err) => {
      send({ type: 'fatal', error: String(err && err.stack ? err.stack : err) });
      process.exit(1);
    });
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
