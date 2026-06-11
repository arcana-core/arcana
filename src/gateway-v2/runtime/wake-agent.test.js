import assert from 'node:assert/strict';
import test from 'node:test';

import { decideWakeLLM } from './wake-agent.js';

test('decideWakeLLM uses the rules stop guard when a turn completed with output', async () => {
  const decision = await decideWakeLLM({
    ok: true,
    completed: true,
    hasOutput: true,
    kind: 'normal',
    retryCount: 0,
    maxRetries: 6,
    attemptsInWindow: 0,
    maxAttemptsInWindow: 20,
    nowMs: Date.now(),
  }, {
    agentId: '__test__',
    sessionKey: '__normal_output__',
    timeoutMs: 1,
  });

  assert.equal(decision.action, 'stop');
  assert.equal(decision.delayMs, 0);
  assert.equal(decision.source, 'rules');
  assert.match(decision.reason, /turn_ok_with_output/);
});
