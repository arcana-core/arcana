import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServiceId } from './manager.js';

test('normalizeServiceId accepts the documented tool-daemon alias', () => {
  assert.equal(normalizeServiceId('tool-daemon'), 'tool_daemon');
  assert.equal(normalizeServiceId('tool_daemon'), 'tool_daemon');
});
