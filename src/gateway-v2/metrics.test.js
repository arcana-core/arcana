import test from 'node:test';
import assert from 'node:assert/strict';

import { incCounter, renderMetrics, _reset } from './metrics.js';

test('renderMetrics emits gauges with HELP/TYPE lines', () => {
  _reset();
  const out = renderMetrics({
    arcana_uptime_seconds: { value: 42, help: 'Uptime' },
    arcana_ws_clients: { value: 3, help: 'Clients' },
  });
  assert.match(out, /# HELP arcana_uptime_seconds Uptime/);
  assert.match(out, /# TYPE arcana_uptime_seconds gauge/);
  assert.match(out, /arcana_uptime_seconds 42/);
  assert.match(out, /arcana_ws_clients 3/);
});

test('counters accumulate and render with labels', () => {
  _reset();
  incCounter('arcana_requests_rate_limited_total', null, 'Rejected requests');
  incCounter('arcana_requests_rate_limited_total', null, 'Rejected requests');
  incCounter('arcana_turns_total', { agent: 'cutpilot' }, 'Turns');
  const out = renderMetrics({});
  assert.match(out, /arcana_requests_rate_limited_total 2/);
  assert.match(out, /arcana_turns_total\{agent="cutpilot"\} 1/);
  assert.match(out, /# TYPE arcana_turns_total counter/);
});

test('skips non-finite gauge values', () => {
  _reset();
  const out = renderMetrics({ bad: { value: NaN, help: 'x' }, good: { value: 1, help: 'y' } });
  assert.doesNotMatch(out, /\bbad\b/);
  assert.match(out, /good 1/);
});
