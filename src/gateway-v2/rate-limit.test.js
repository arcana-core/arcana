import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, clientKeyFromReq } from './rate-limit.js';

test('disabled when rpm is 0', () => {
  const rl = createRateLimiter({ rpm: 0 });
  assert.equal(rl.enabled, false);
  for (let i = 0; i < 100; i += 1) assert.equal(rl.take('x').allowed, true);
});

test('allows up to the burst then rejects with retryAfter', () => {
  let now = 0;
  const rl = createRateLimiter({ rpm: 60, burst: 3, nowFn: () => now });
  assert.equal(rl.take('ip1').allowed, true);
  assert.equal(rl.take('ip1').allowed, true);
  assert.equal(rl.take('ip1').allowed, true);
  const denied = rl.take('ip1');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);
});

test('refills over time', () => {
  let now = 0;
  const rl = createRateLimiter({ rpm: 60, burst: 1, nowFn: () => now }); // 1 token/sec
  assert.equal(rl.take('ip1').allowed, true);
  assert.equal(rl.take('ip1').allowed, false);
  now += 1000; // one second -> one token back
  assert.equal(rl.take('ip1').allowed, true);
});

test('keys are independent', () => {
  let now = 0;
  const rl = createRateLimiter({ rpm: 60, burst: 1, nowFn: () => now });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('b').allowed, true, 'separate bucket');
  assert.equal(rl.take('a').allowed, false);
});

test('clientKeyFromReq prefers x-forwarded-for then socket address', () => {
  assert.equal(clientKeyFromReq({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
  assert.equal(clientKeyFromReq({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9');
  assert.equal(clientKeyFromReq({ headers: {} }), 'anon');
});
