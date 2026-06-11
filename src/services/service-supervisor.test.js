import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeBackoffMs, createServiceProcess } from './service-supervisor.js';

const CHILD_PATH = fileURLToPath(new URL('./service-child.js', import.meta.url));

test('computeBackoffMs grows exponentially and respects the cap', () => {
  assert.equal(computeBackoffMs(1, { baseMs: 100, capMs: 5000 }), 100);
  assert.equal(computeBackoffMs(2, { baseMs: 100, capMs: 5000 }), 200);
  assert.equal(computeBackoffMs(3, { baseMs: 100, capMs: 5000 }), 400);
  assert.equal(computeBackoffMs(10, { baseMs: 100, capMs: 5000 }), 5000);
  assert.equal(computeBackoffMs(0, { baseMs: 100, capMs: 5000 }), 100, 'attempt floors to 1');
});

// A fake child process: an EventEmitter with send()/kill()/pid that records
// the messages the supervisor sends and lets the test drive lifecycle events.
function makeFakeChild(){
  const child = new EventEmitter();
  child.pid = 1234;
  child.sent = [];
  child.killed = [];
  child.send = (msg) => { child.sent.push(msg); };
  child.kill = (sig) => { child.killed.push(sig); };
  return child;
}

// A controllable timer harness: setTimeoutFn queues callbacks the test fires
// manually; nowFn is driven by an explicit clock.
function makeTimerHarness(){
  let clock = 0;
  const timers = [];
  let seq = 0;
  return {
    nowFn: () => clock,
    advance: (ms) => { clock += ms; },
    setTimeoutFn: (fn, delay) => { const t = { id: ++seq, fn, delay, at: clock + delay }; timers.push(t); return t; },
    clearTimeoutFn: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    // fire all currently-due timers (by registration order)
    fireDue: () => {
      const due = timers.filter((t) => t.at <= clock);
      for (const t of due){ const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
      for (const t of due){ t.fn(); }
      return due.length;
    },
    pending: () => timers.slice(),
  };
}

test('restarts with backoff after a crash, then reaches running again', () => {
  const harness = makeTimerHarness();
  const children = [];
  const proc = createServiceProcess({
    id: 'svc',
    servicePath: '/tmp/svc.mjs',
    ctx: {},
    logFile: '/dev/null',
    childPath: CHILD_PATH,
    backoffBaseMs: 100,
    crashWindowMs: 60000,
    maxRestarts: 5,
    forkFn: () => { const c = makeFakeChild(); children.push(c); return c; },
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    nowFn: harness.nowFn,
  });

  proc.start();
  assert.equal(children.length, 1, 'spawned once');
  assert.equal(proc.status().status, 'starting');
  // child reports ready
  children[0].emit('message', { type: 'ready' });
  assert.equal(proc.status().status, 'running');

  // child crashes
  harness.advance(1000);
  children[0].emit('exit', 1, null);
  assert.equal(proc.status().status, 'restarting');
  assert.equal(children.length, 1, 'no immediate respawn (waiting backoff)');

  // backoff for attempt 1 == 100ms
  harness.advance(100);
  harness.fireDue();
  assert.equal(children.length, 2, 'respawned after backoff');
  children[1].emit('message', { type: 'ready' });
  assert.equal(proc.status().status, 'running');
  assert.equal(proc.status().restarts, 1);
});

test('gives up after exceeding maxRestarts within the crash window', () => {
  const harness = makeTimerHarness();
  const children = [];
  const proc = createServiceProcess({
    id: 'flaky',
    servicePath: '/tmp/svc.mjs',
    ctx: {},
    logFile: '/dev/null',
    childPath: CHILD_PATH,
    backoffBaseMs: 10,
    backoffCapMs: 1000,
    crashWindowMs: 60000,
    maxRestarts: 3,
    forkFn: () => { const c = makeFakeChild(); children.push(c); return c; },
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    nowFn: harness.nowFn,
  });

  proc.start();
  // crash 4 times in a row within the window (maxRestarts=3 -> 4th gives up)
  for (let i = 0; i < 4; i += 1){
    const c = children[children.length - 1];
    c.emit('exit', 1, null);
    if (proc.status().status === 'crashed') break;
    harness.advance(2000);
    harness.fireDue(); // fire the backoff timer to respawn
  }
  assert.equal(proc.status().status, 'crashed');
  // no further spawns after giving up
  const spawnCount = children.length;
  harness.advance(10000);
  harness.fireDue();
  assert.equal(children.length, spawnCount, 'no respawn after crash-loop give-up');
});

test('a stable run resets the crash window so later crashes still restart', () => {
  const harness = makeTimerHarness();
  const children = [];
  const proc = createServiceProcess({
    id: 'svc',
    servicePath: '/tmp/svc.mjs',
    ctx: {},
    logFile: '/dev/null',
    childPath: CHILD_PATH,
    backoffBaseMs: 10,
    crashWindowMs: 60000,
    stableMs: 60000,
    maxRestarts: 2,
    forkFn: () => { const c = makeFakeChild(); children.push(c); return c; },
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    nowFn: harness.nowFn,
  });

  proc.start();
  children[0].emit('message', { type: 'ready' });
  // runs healthily for well over stableMs, then crashes
  harness.advance(120000);
  children[0].emit('exit', 1, null);
  assert.equal(proc.status().status, 'restarting', 'stable run resets crash window');
  harness.advance(10);
  harness.fireDue();
  assert.equal(children.length, 2);
});

test('heartbeat timeout kills a hung child', () => {
  const harness = makeTimerHarness();
  const children = [];
  const proc = createServiceProcess({
    id: 'hung',
    servicePath: '/tmp/svc.mjs',
    ctx: {},
    logFile: '/dev/null',
    childPath: CHILD_PATH,
    heartbeatTimeoutMs: 5000,
    forkFn: () => { const c = makeFakeChild(); children.push(c); return c; },
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    nowFn: harness.nowFn,
  });

  proc.start();
  children[0].emit('message', { type: 'ready' });
  // no heartbeats arrive; advance past the timeout and fire the health check
  harness.advance(5001);
  harness.fireDue();
  assert.deepEqual(children[0].killed, ['SIGTERM'], 'hung child is killed');
});

test('end-to-end: forks a real service, reaches running, then stops cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcana-svc-sup-'));
  const marker = join(dir, 'marker.txt');
  const servicePath = join(dir, 'svc.mjs');
  writeFileSync(servicePath, `
import { writeFileSync } from 'node:fs';
export async function start(ctx){
  writeFileSync(${JSON.stringify(marker)}, 'started');
  return { async stop(){ writeFileSync(${JSON.stringify(marker)}, 'stopped'); } };
}
`, 'utf-8');

  const proc = createServiceProcess({
    id: 'real',
    servicePath,
    ctx: { workspaceRoot: dir, serviceId: 'real' },
    logFile: join(dir, 'svc.log'),
    childPath: CHILD_PATH,
    heartbeatIntervalMs: 200,
    heartbeatTimeoutMs: 5000,
  });

  proc.start();
  // wait for the service to report ready
  const readyDeadline = Date.now() + 8000;
  while (proc.status().status !== 'running' && Date.now() < readyDeadline){
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(proc.status().status, 'running', 'service reached running');
  assert.equal(readFileSync(marker, 'utf-8'), 'started');

  await proc.stop({ timeoutMs: 4000 });
  assert.equal(proc.status().status, 'stopped');
  assert.equal(readFileSync(marker, 'utf-8'), 'stopped', 'stop() ran in the child');

  rmSync(dir, { recursive: true, force: true });
});
