import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registerSecretValue,
  redactString,
  redactValue,
  hasTrackedSecrets,
  _reset,
} from './redaction.js';

test('redactString scrubs registered secrets from text', () => {
  _reset();
  registerSecretValue('sk-live-supersecret-123');
  const out = redactString('using key sk-live-supersecret-123 in the call');
  assert.equal(out, 'using key [REDACTED] in the call');
});

test('redactValue walks nested objects and arrays', () => {
  _reset();
  registerSecretValue('topsecretvalue');
  const scrubbed = redactValue({
    type: 'tool_execution_end',
    result: { stdout: 'echo topsecretvalue', items: ['a', 'topsecretvalue'] },
  });
  assert.equal(scrubbed.result.stdout, 'echo [REDACTED]');
  assert.deepEqual(scrubbed.result.items, ['a', '[REDACTED]']);
});

test('short values are not tracked (avoid false positives)', () => {
  _reset();
  assert.equal(registerSecretValue('abc'), false);
  assert.equal(hasTrackedSecrets(), false);
  assert.equal(redactString('abc def'), 'abc def');
});

test('longer secrets take precedence over overlapping shorter ones', () => {
  _reset();
  registerSecretValue('secret');
  registerSecretValue('secret-extended-key');
  const out = redactString('value=secret-extended-key end');
  assert.equal(out, 'value=[REDACTED] end', 'longest match wins, no partial leftovers');
});

test('no-op when nothing registered', () => {
  _reset();
  assert.equal(hasTrackedSecrets(), false);
  assert.equal(redactString('plain text'), 'plain text');
  assert.deepEqual(redactValue({ a: 1 }), { a: 1 });
});

test('idempotent registration', () => {
  _reset();
  assert.equal(registerSecretValue('repeated-secret-x'), true);
  assert.equal(registerSecretValue('repeated-secret-x'), false);
});
