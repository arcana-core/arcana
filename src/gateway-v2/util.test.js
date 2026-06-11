import test from 'node:test';
import assert from 'node:assert/strict';

import { paginateSessionMessages } from './util.js';

function makeSession(count){
  return {
    id: 's1',
    title: 'T',
    messages: Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'm' + i })),
  };
}

test('paginateSessionMessages returns null when no pagination requested', () => {
  assert.equal(paginateSessionMessages(makeSession(5), null, null), null);
  assert.equal(paginateSessionMessages(makeSession(5), '0', ''), null);
  assert.equal(paginateSessionMessages(makeSession(5), 'abc', 'xyz'), null);
});

test('paginateSessionMessages limit returns the newest N messages', () => {
  const out = paginateSessionMessages(makeSession(10), '3', null);
  assert.deepEqual(out.messages.map((m) => m.text), ['m7', 'm8', 'm9']);
  assert.equal(out.totalMessages, 10);
  assert.equal(out.firstIndex, 7);
  assert.equal(out.hasMore, true);
  assert.equal(out.title, 'T', 'meta fields preserved');
});

test('paginateSessionMessages before pages backwards', () => {
  const out = paginateSessionMessages(makeSession(10), '3', '7');
  assert.deepEqual(out.messages.map((m) => m.text), ['m4', 'm5', 'm6']);
  assert.equal(out.firstIndex, 4);
  assert.equal(out.hasMore, true);
});

test('paginateSessionMessages reaches the beginning with hasMore=false', () => {
  const out = paginateSessionMessages(makeSession(10), '5', '4');
  assert.deepEqual(out.messages.map((m) => m.text), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(out.firstIndex, 0);
  assert.equal(out.hasMore, false);
});

test('paginateSessionMessages tolerates limit larger than the history', () => {
  const out = paginateSessionMessages(makeSession(3), '100', null);
  assert.equal(out.messages.length, 3);
  assert.equal(out.hasMore, false);
});

test('paginateSessionMessages with before only returns everything before the index', () => {
  const out = paginateSessionMessages(makeSession(5), null, '2');
  assert.deepEqual(out.messages.map((m) => m.text), ['m0', 'm1']);
  assert.equal(out.hasMore, false);
});
