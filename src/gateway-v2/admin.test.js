import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdminRouter, tailFile } from './admin.js';

function fakeReq({ method = 'GET', url = '/admin/overview', headers = {} } = {}){
  return { method, url, headers };
}

function fakeRes(){
  const res = {
    statusCode: 0,
    body: null,
    writeHead(code){ res.statusCode = code; },
    end(payload){ try { res.body = payload ? JSON.parse(payload) : null; } catch { res.body = payload; } },
  };
  return res;
}

function makeRouter(overrides = {}){
  const manager = {
    normalizeServiceId: (id) => String(id || '').trim(),
    getServicesStatus: () => ({ started: true, count: 1, services: [
      { id: 'demo', path: '/x/demo.mjs', logDir: '/tmp/logs/demo', mode: 'process', status: 'running', pid: 42, restarts: 1, error: null, lastHeartbeatAt: 123 },
    ] }),
    reloadServices: async () => ({ started: true, count: 1, services: [] }),
    startService: async ({ id }) => ({ started: true, action: 'start:' + id, services: [] }),
    stopService: async ({ id }) => ({ started: true, action: 'stop:' + id, services: [] }),
    restartService: async ({ id }) => ({ started: true, action: 'restart:' + id, services: [] }),
    ...overrides.manager,
  };
  const router = createAdminRouter({
    manager,
    adminToken: 'admintok',
    wsHub: { countMatchingClients: () => 3 },
    agentsSnapshotFn: async () => [{ agentId: 'cutpilot' }],
    listSessionsFn: () => [{ id: 's1', updatedAt: '2026-06-11T00:00:00.000Z' }],
    startedAtMs: Date.now() - 60000,
    ...overrides.router,
  });
  return { router, manager };
}

const AUTH = { 'x-arcana-admin-token': 'admintok' };

test('admin routes reject requests without the admin token', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  const handled = await router.handle(fakeReq({ url: '/admin/services' }), res, new URL('http://x/admin/services'));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'unauthorized');
});

test('admin routes reject the regular api token in the wrong header', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  await router.handle(
    fakeReq({ url: '/admin/services', headers: { 'x-arcana-token': 'admintok' } }),
    res,
    new URL('http://x/admin/services'),
  );
  assert.equal(res.statusCode, 401, 'api-token header is not accepted for admin');
});

test('non-admin paths are not handled', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  const handled = await router.handle(fakeReq({ url: '/api/sessions' }), res, new URL('http://x/api/sessions'));
  assert.equal(handled, false);
});

test('GET /admin/services returns the status list with a byStatus summary', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  await router.handle(fakeReq({ url: '/admin/services', headers: AUTH }), res, new URL('http://x/admin/services'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.services[0].id, 'demo');
  assert.deepEqual(res.body.byStatus, { running: 1 });
});

test('GET /admin/overview aggregates services, agents and ws clients', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  await router.handle(fakeReq({ url: '/admin/overview', headers: AUTH }), res, new URL('http://x/admin/overview'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.wsClients, 3);
  assert.equal(res.body.services.count, 1);
  assert.deepEqual(res.body.agents, [{ agentId: 'cutpilot', sessionCount: 1, lastActivity: '2026-06-11T00:00:00.000Z' }]);
  assert.ok(res.body.uptimeMs >= 60000);
  assert.ok(res.body.memory.rss > 0);
});

test('service lifecycle actions route to the manager', async () => {
  const { router } = makeRouter();
  for (const act of ['start', 'stop', 'restart']){
    const res = fakeRes();
    await router.handle(
      fakeReq({ method: 'POST', url: '/admin/services/demo/' + act, headers: AUTH }),
      res,
      new URL('http://x/admin/services/demo/' + act),
    );
    assert.equal(res.statusCode, 200, act + ' ok');
    assert.equal(res.body.action, act + ':demo');
  }
});

test('lifecycle actions require POST', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  await router.handle(fakeReq({ method: 'GET', url: '/admin/services/demo/stop', headers: AUTH }), res, new URL('http://x/admin/services/demo/stop'));
  assert.equal(res.statusCode, 405);
});

test('manager errors surface as 500 with a message', async () => {
  const { router } = makeRouter({ manager: { restartService: async () => { throw new Error('unknown service: nope'); } } });
  const res = fakeRes();
  await router.handle(fakeReq({ method: 'POST', url: '/admin/services/nope/restart', headers: AUTH }), res, new URL('http://x/admin/services/nope/restart'));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, 'unknown service: nope');
});

test('GET logs tails the requested file and rejects unknown file keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcana-admin-test-'));
  try {
    const logDir = join(dir, 'logs', 'demo');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'manager.log'), 'line1\nline2\n', 'utf-8');
    const { router } = makeRouter({ manager: {
      getServicesStatus: () => ({ started: true, count: 1, services: [{ id: 'demo', logDir, status: 'running' }] }),
    } });

    let res = fakeRes();
    await router.handle(fakeReq({ url: '/admin/services/demo/logs?file=manager', headers: AUTH }), res, new URL('http://x/admin/services/demo/logs?file=manager'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.content, 'line1\nline2\n');

    res = fakeRes();
    await router.handle(fakeReq({ url: '/admin/services/demo/logs?file=../../etc/passwd', headers: AUTH }), res, new URL('http://x/admin/services/demo/logs?file=' + encodeURIComponent('../../etc/passwd')));
    assert.equal(res.statusCode, 400, 'file key is an enum, not a path');

    res = fakeRes();
    await router.handle(fakeReq({ url: '/admin/services/demo/logs?file=sdk', headers: AUTH }), res, new URL('http://x/admin/services/demo/logs?file=sdk'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.missing, true, 'missing log file reports missing, not an error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tailFile returns the last bytes starting on a line boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcana-tail-test-'));
  try {
    const p = join(dir, 'big.log');
    const lines = [];
    for (let i = 0; i < 200; i += 1) lines.push('line-' + i + '-' + 'x'.repeat(50));
    writeFileSync(p, lines.join('\n') + '\n', 'utf-8');
    const out = tailFile(p, 1024);
    assert.equal(out.truncated, true);
    assert.ok(out.content.startsWith('line-'), 'starts on a line boundary');
    assert.ok(out.content.includes('line-199'), 'includes the newest line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /admin/metrics returns prometheus text with service status gauges', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  // capture raw text body
  let raw = '';
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; };
  res.end = (payload) => { raw = payload; };
  await router.handle(fakeReq({ url: '/admin/metrics', headers: AUTH }), res, new URL('http://x/admin/metrics'));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(raw, /arcana_uptime_seconds \d+/);
  assert.match(raw, /arcana_ws_clients 3/);
  assert.match(raw, /arcana_services_status\{status="running"\} 1/);
});

test('admin metrics also require the admin token', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  await router.handle(fakeReq({ url: '/admin/metrics' }), res, new URL('http://x/admin/metrics'));
  assert.equal(res.statusCode, 401);
});
