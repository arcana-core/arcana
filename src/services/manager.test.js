import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeServiceId,
  loadServiceConfig,
  resolveServiceOptions,
  startServicesOnce,
  stopService,
  getServicesStatus,
} from './manager.js';

test('normalizeServiceId accepts the documented tool-daemon alias', () => {
  assert.equal(normalizeServiceId('tool-daemon'), 'tool_daemon');
  assert.equal(normalizeServiceId('tool_daemon'), 'tool_daemon');
});

test('loadServiceConfig reads services.config.json and normalizes ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcana-svc-cfg-'));
  try {
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services', 'services.config.json'), JSON.stringify({
      'tool-daemon': { isolation: 'process' },
      cutpilot: { isolation: 'process', memoryLimitMB: 512 },
    }), 'utf-8');
    const cfg = loadServiceConfig(dir);
    assert.equal(cfg.tool_daemon.isolation, 'process', 'id alias normalized');
    assert.equal(cfg.cutpilot.memoryLimitMB, 512);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadServiceConfig also accepts a { services: {...} } envelope and ignores malformed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcana-svc-cfg-'));
  try {
    mkdirSync(join(dir, 'services'), { recursive: true });
    writeFileSync(join(dir, 'services', 'services.config.json'), JSON.stringify({
      services: { cutpilot: { isolation: 'in-process' } },
    }), 'utf-8');
    assert.equal(loadServiceConfig(dir).cutpilot.isolation, 'in-process');

    writeFileSync(join(dir, 'services', 'services.config.json'), 'not json{', 'utf-8');
    assert.deepEqual(loadServiceConfig(dir), {}, 'malformed config falls back to empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveServiceOptions honors per-service override over the global default', () => {
  const prev = process.env.ARCANA_SERVICE_ISOLATION;
  try {
    process.env.ARCANA_SERVICE_ISOLATION = 'process';
    const cfg = { cutpilot: { isolation: 'in-process' }, worker: { memoryLimitMB: 256, maxRestarts: 3 } };
    assert.equal(resolveServiceOptions('cutpilot', cfg).isolation, 'in-process', 'per-service opt-out wins');
    const worker = resolveServiceOptions('worker', cfg);
    assert.equal(worker.isolation, 'process', 'inherits global default');
    assert.equal(worker.memoryLimitMB, 256);
    assert.equal(worker.maxRestarts, 3);
  } finally {
    if (prev == null) delete process.env.ARCANA_SERVICE_ISOLATION;
    else process.env.ARCANA_SERVICE_ISOLATION = prev;
  }
});

test('resolveServiceOptions defaults to in-process when nothing is configured', () => {
  const prev = process.env.ARCANA_SERVICE_ISOLATION;
  try {
    delete process.env.ARCANA_SERVICE_ISOLATION;
    const opts = resolveServiceOptions('anything', {});
    assert.equal(opts.isolation, 'in-process');
    assert.equal(opts.restart, true);
    assert.equal(opts.maxRestarts, 5);
  } finally {
    if (prev == null) delete process.env.ARCANA_SERVICE_ISOLATION;
    else process.env.ARCANA_SERVICE_ISOLATION = prev;
  }
});

test('startServicesOnce runs a configured service in isolation and reports process status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcana-svc-mgr-'));
  const prevIso = process.env.ARCANA_SERVICE_ISOLATION;
  const prevDisable = process.env.ARCANA_DISABLE_CORE_SERVICES;
  try {
    delete process.env.ARCANA_DISABLE_CORE_SERVICES;
    process.env.ARCANA_SERVICE_ISOLATION = 'process';
    const servicesDir = join(dir, 'services');
    mkdirSync(servicesDir, { recursive: true });
    const marker = join(dir, 'started.txt');
    writeFileSync(join(servicesDir, 'demo.mjs'), `
import { writeFileSync } from 'node:fs';
export async function start(){
  writeFileSync(${JSON.stringify(marker)}, 'up');
  return { async stop(){} };
}
`, 'utf-8');

    await startServicesOnce({ workspaceRoot: dir });

    // wait for the isolated child to report running
    const deadline = Date.now() + 8000;
    let demo = null;
    while (Date.now() < deadline) {
      demo = getServicesStatus().services.find((s) => s.id === 'demo');
      if (demo && demo.status === 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(demo, 'demo service is tracked');
    assert.equal(demo.mode, 'process');
    assert.equal(demo.status, 'running');
    assert.ok(demo.pid, 'has a child pid');

    await stopService({ id: 'demo' });
    const after = getServicesStatus().services.find((s) => s.id === 'demo');
    assert.equal(after.status, 'stopped');
  } finally {
    try { await stopService({ id: 'demo' }); } catch {}
    if (prevIso == null) delete process.env.ARCANA_SERVICE_ISOLATION;
    else process.env.ARCANA_SERVICE_ISOLATION = prevIso;
    if (prevDisable == null) delete process.env.ARCANA_DISABLE_CORE_SERVICES;
    else process.env.ARCANA_DISABLE_CORE_SERVICES = prevDisable;
    rmSync(dir, { recursive: true, force: true });
  }
});
