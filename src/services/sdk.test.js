import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildServiceSdk,
  normalizeSecretsAllowlist,
  isSecretAllowed,
} from './sdk.js';
import { createSession, appendMessage } from '../sessions-store.js';

function withEnv(vars, fn){
  const prev = {};
  for (const [k, v] of Object.entries(vars)){
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)){
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

test('normalizeSecretsAllowlist handles star, arrays and junk', () => {
  assert.equal(normalizeSecretsAllowlist('*'), '*');
  assert.deepEqual(normalizeSecretsAllowlist(['A', ' B ', '', null]), ['A', 'B']);
  assert.deepEqual(normalizeSecretsAllowlist(undefined), []);
  assert.deepEqual(normalizeSecretsAllowlist('not-an-array'), []);
});

test('isSecretAllowed enforces exact names or star', () => {
  assert.equal(isSecretAllowed('*', 'ANYTHING'), true);
  assert.equal(isSecretAllowed(['A'], 'A'), true);
  assert.equal(isSecretAllowed(['A'], 'B'), false);
  assert.equal(isSecretAllowed([], 'A'), false);
});

test('secrets.get denies undeclared names without touching the backend (both modes)', async () => {
  let ipcCalls = 0;
  let storeCalls = 0;
  const childSdk = buildServiceSdk({
    mode: 'child', serviceId: 'svc', secretsAllowlist: ['ALLOWED'],
    ipcCall: async () => { ipcCalls += 1; return 'x'; },
  });
  await assert.rejects(childSdk.secrets.get('FORBIDDEN'), (e) => e.code === 'SECRET_NOT_ALLOWED');
  assert.equal(ipcCalls, 0, 'denied before IPC');

  const inprocSdk = buildServiceSdk({
    mode: 'in-process', serviceId: 'svc', secretsAllowlist: ['ALLOWED'],
    resolveSecretFn: async () => { storeCalls += 1; return 'x'; },
  });
  await assert.rejects(inprocSdk.secrets.get('FORBIDDEN'), (e) => e.code === 'SECRET_NOT_ALLOWED');
  assert.equal(storeCalls, 0, 'denied before store');
});

test('secrets.get routes through IPC in child mode and the store in-process', async () => {
  const ipcSeen = [];
  const childSdk = buildServiceSdk({
    mode: 'child', serviceId: 'svc', secretsAllowlist: ['TOKEN_A'],
    ipcCall: async (method, params) => { ipcSeen.push([method, params]); return 'from-parent'; },
  });
  assert.equal(await childSdk.secrets.get('TOKEN_A', { agentId: 'cutpilot' }), 'from-parent');
  assert.deepEqual(ipcSeen, [['secrets.get', { name: 'TOKEN_A', agentId: 'cutpilot' }]]);

  const inprocSdk = buildServiceSdk({
    mode: 'in-process', serviceId: 'svc', secretsAllowlist: '*',
    resolveSecretFn: async ({ name, agentId }) => name + ':' + (agentId || 'global'),
  });
  assert.equal(await inprocSdk.secrets.get('ANY', { agentId: 'a1' }), 'ANY:a1');
});

test('secrets.list returns the declared contract', async () => {
  const sdk = buildServiceSdk({ serviceId: 'svc', secretsAllowlist: ['A', 'B'] });
  assert.deepEqual(await sdk.secrets.list(), ['A', 'B']);
  const all = buildServiceSdk({ serviceId: 'svc', secretsAllowlist: '*' });
  assert.equal(await all.secrets.list(), '*');
});

test('agent.call posts JSON to the gateway with auth headers and parses the response', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, xtoken: req.headers['x-arcana-token'], body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await withEnv({ ARCANA_URL: 'http://127.0.0.1:' + port, ARCANA_API_TOKEN: 'tok123' }, async () => {
      const sdk = buildServiceSdk({ serviceId: 'svc' });
      const out = await sdk.agent.turnAsync({ agentId: 'cutpilot', text: 'hi' });
      assert.equal(out.ok, true);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, '/v2/turn-async');
      assert.equal(seen[0].auth, 'Bearer tok123');
      assert.equal(seen[0].xtoken, 'tok123');
      assert.deepEqual(seen[0].body, { agentId: 'cutpilot', text: 'hi' });
    });
  } finally {
    server.close();
  }
});

test('agent.call surfaces HTTP errors with a status code', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'overloaded' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await withEnv({ ARCANA_URL: 'http://127.0.0.1:' + port, ARCANA_API_TOKEN: 'tok' }, async () => {
      const sdk = buildServiceSdk({ serviceId: 'svc' });
      await assert.rejects(sdk.agent.turn({ text: 'x' }), (e) => e.code === 'GATEWAY_HTTP_503' && e.status === 503);
    });
  } finally {
    server.close();
  }
});

test('agent.streamUrl builds a ws url with token and params', () => {
  return withEnv({ ARCANA_URL: 'http://gateway.example:8787', ARCANA_API_TOKEN: 'tok' }, () => {
    const sdk = buildServiceSdk({ serviceId: 'svc' });
    const url = new URL(sdk.agent.streamUrl({ sessionId: 's1', agentId: 'cutpilot', empty: '' }));
    assert.equal(url.protocol, 'ws:');
    assert.equal(url.pathname, '/v2/stream');
    assert.equal(url.searchParams.get('token'), 'tok');
    assert.equal(url.searchParams.get('sessionId'), 's1');
    assert.equal(url.searchParams.get('agentId'), 'cutpilot');
    assert.equal(url.searchParams.has('empty'), false);
  });
});

test('sessions passthrough reads what the store wrote', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arcana-sdk-test-'));
  await withEnv({ ARCANA_HOME: home }, async () => {
    const session = createSession({ title: 'SDK', agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'user', text: 'hello sdk', agentId: 'cutpilot' });
    const sdk = buildServiceSdk({ serviceId: 'svc', workspaceRoot: home });
    const loaded = sdk.sessions.load(session.id, { agentId: 'cutpilot' });
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].text, 'hello sdk');
    const list = sdk.sessions.list('cutpilot');
    assert.ok(list.find((s) => s.id === session.id));
  });
  rmSync(home, { recursive: true, force: true });
});

test('agents helpers normalize ids and compute home roots', () => {
  const home = mkdtempSync(join(tmpdir(), 'arcana-sdk-test-'));
  return withEnv({ ARCANA_HOME: home }, () => {
    const sdk = buildServiceSdk({ serviceId: 'svc' });
    assert.equal(sdk.agents.normalizeId('my agent!'), 'my_agent_');
    assert.equal(sdk.agents.normalizeId(''), 'default');
    assert.ok(sdk.agents.homeRoot('cutpilot').endsWith(join('agents', 'cutpilot')));
    rmSync(home, { recursive: true, force: true });
  });
});
