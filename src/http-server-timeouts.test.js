import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configureLongRunningHttpServer } from './http-server-timeouts.js';

test('configureLongRunningHttpServer disables request timeout for long-running turns', () => {
  const server = http.createServer(() => {});
  assert.equal(server.requestTimeout, 300000);

  configureLongRunningHttpServer(server);

  assert.equal(server.requestTimeout, 0);
  assert.equal(server.timeout, 0);
  server.close();
});
