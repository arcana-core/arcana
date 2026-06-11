// Supervises a single isolated service running in a child process.
//
// Responsibilities:
//   - spawn the service in a forked child (service-child.js harness)
//   - restart it with exponential backoff when it crashes
//   - give up after too many crashes in a window (crash-loop protection)
//   - enforce a memory quota via --max-old-space-size
//   - detect a hung/blocked service via heartbeat timeout and kill+restart it
//   - stop it cleanly (graceful stop -> SIGTERM -> SIGKILL)
//
// Timers, clock, and fork are injectable so the state machine can be tested
// deterministically without real processes.

import { fork } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';

export function computeBackoffMs(attempt, opts = {}){
  const base = Number(opts.baseMs) > 0 ? Number(opts.baseMs) : 1000;
  const cap = Number(opts.capMs) > 0 ? Number(opts.capMs) : 30000;
  const a = Math.max(1, Math.floor(Number(attempt) || 1));
  const ms = base * Math.pow(2, a - 1);
  return Math.min(cap, Math.max(0, ms));
}

function defaultFork({ childPath, logFile, memoryLimitMB }){
  const execArgv = [];
  if (Number(memoryLimitMB) > 0){
    execArgv.push('--max-old-space-size=' + Math.floor(Number(memoryLimitMB)));
  }
  let out = 'ignore';
  let err = 'ignore';
  let fd = null;
  try {
    fd = openSync(logFile, 'a');
    out = fd;
    err = fd;
  } catch {}
  const child = fork(childPath, [], { execArgv, stdio: ['ignore', out, err, 'ipc'] });
  // The child dup'd the fd; the parent copy is no longer needed.
  if (fd != null){ try { closeSync(fd); } catch {} }
  return child;
}

export function createServiceProcess(opts = {}){
  const {
    id,
    servicePath,
    ctx,
    logFile,
    childPath,
    memoryLimitMB = 0,
    heartbeatIntervalMs = 2000,
    heartbeatTimeoutMs = 10000,
    restart = true,
    maxRestarts = 5,
    crashWindowMs = 60000,
    backoffBaseMs = 1000,
    backoffCapMs = 30000,
    stableMs = 60000,
    onLog = null,
    forkFn = defaultFork,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    nowFn = Date.now,
  } = opts;

  let child = null;
  let status = 'idle';
  let restarts = 0;
  let crashTimes = [];
  let startedAt = 0;
  let readyAt = 0;
  let lastHeartbeatAt = 0;
  let lastError = '';
  let stopRequested = false;
  let restartTimer = null;
  let healthTimer = null;
  let stopResolvers = [];

  function log(level, msg){ try { if (onLog) onLog(level, msg); } catch {} }

  function clearRestartTimer(){ if (restartTimer){ clearTimeoutFn(restartTimer); restartTimer = null; } }
  function clearHealthTimer(){ if (healthTimer){ clearTimeoutFn(healthTimer); healthTimer = null; } }

  function scheduleHealthCheck(){
    clearHealthTimer();
    healthTimer = setTimeoutFn(() => {
      healthTimer = null;
      if (status !== 'running') { scheduleHealthCheck(); return; }
      const idle = nowFn() - lastHeartbeatAt;
      if (idle > heartbeatTimeoutMs){
        lastError = 'heartbeat timeout after ' + idle + 'ms';
        log('warn', 'health timeout id=' + id + ' (' + idle + 'ms); killing');
        killChild('SIGTERM'); // exit handler restarts
      } else {
        scheduleHealthCheck();
      }
    }, heartbeatTimeoutMs);
    if (healthTimer && typeof healthTimer.unref === 'function') healthTimer.unref();
  }

  function killChild(sig){ try { if (child) child.kill(sig); } catch {} }
  function resolveStops(){ const rs = stopResolvers; stopResolvers = []; for (const r of rs){ try { r(); } catch {} } }

  function onMessage(msg){
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'heartbeat'){ lastHeartbeatAt = nowFn(); return; }
    if (msg.type === 'ready'){
      status = 'running';
      readyAt = nowFn();
      lastHeartbeatAt = nowFn();
      log('info', 'ready id=' + id + ' pid=' + (child && child.pid));
      return;
    }
    if (msg.type === 'skipped'){ status = 'skipped'; log('info', 'no start() id=' + id); return; }
    if (msg.type === 'fatal'){ lastError = String(msg.error || ''); log('error', 'fatal id=' + id + ': ' + lastError); return; }
  }

  function onExit(code, signal){
    clearHealthTimer();
    const wasStableRun = readyAt && (nowFn() - readyAt) >= stableMs;
    child = null;

    if (stopRequested){ status = 'stopped'; resolveStops(); return; }

    if (wasStableRun) crashTimes = []; // a long, healthy run clears the crash window
    const t = nowFn();
    crashTimes = crashTimes.filter((x) => t - x < crashWindowMs);
    crashTimes.push(t);
    if (!lastError) lastError = 'exited code=' + code + ' signal=' + signal;

    if (!restart){ status = 'stopped'; resolveStops(); return; }
    if (crashTimes.length > maxRestarts){
      status = 'crashed';
      log('error', 'crash loop id=' + id + ': ' + crashTimes.length + ' crashes in window; giving up');
      resolveStops();
      return;
    }
    restarts += 1;
    const delay = computeBackoffMs(crashTimes.length, { baseMs: backoffBaseMs, capMs: backoffCapMs });
    status = 'restarting';
    log('warn', 'restarting id=' + id + ' in ' + delay + 'ms (attempt ' + restarts + ')');
    clearRestartTimer();
    restartTimer = setTimeoutFn(() => { restartTimer = null; spawn(); }, delay);
    if (restartTimer && typeof restartTimer.unref === 'function') restartTimer.unref();
  }

  function spawn(){
    status = restarts > 0 ? 'restarting' : 'starting';
    startedAt = nowFn();
    readyAt = 0;
    child = forkFn({ childPath, logFile, memoryLimitMB });
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', (err) => { lastError = String(err && err.message ? err.message : err); });
    lastHeartbeatAt = nowFn();
    try {
      child.send({ type: 'init', servicePath, ctx, heartbeatIntervalMs });
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
    }
    scheduleHealthCheck();
  }

  function start(){
    if (child || status === 'starting' || status === 'running' || status === 'restarting') return;
    stopRequested = false;
    crashTimes = [];
    restarts = 0;
    status = 'idle';
    spawn();
  }

  async function stop({ timeoutMs = 6000 } = {}){
    stopRequested = true;
    clearRestartTimer();
    clearHealthTimer();
    if (!child){ status = 'stopped'; resolveStops(); return; }
    const done = new Promise((resolve) => stopResolvers.push(resolve));
    try { child.send({ type: 'stop' }); } catch { killChild('SIGTERM'); }
    const sigTimer = setTimeoutFn(() => killChild('SIGTERM'), Math.max(1, Math.floor(timeoutMs / 2)));
    const killTimer = setTimeoutFn(() => killChild('SIGKILL'), Math.max(2, timeoutMs));
    if (sigTimer && typeof sigTimer.unref === 'function') sigTimer.unref();
    if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
    await done;
    clearTimeoutFn(sigTimer);
    clearTimeoutFn(killTimer);
    status = 'stopped';
  }

  function statusObj(){
    return {
      id,
      mode: 'process',
      status,
      restarts,
      pid: child ? child.pid : null,
      startedAt: startedAt || null,
      readyAt: readyAt || null,
      lastHeartbeatAt: lastHeartbeatAt || null,
      error: lastError || null,
    };
  }

  return {
    start,
    stop,
    status: statusObj,
    // test hooks
    _emitMessage(msg){ onMessage(msg); },
    _getChild(){ return child; },
  };
}

export default { computeBackoffMs, createServiceProcess };
