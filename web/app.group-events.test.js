import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP_JS_PATH = new URL('./app.js', import.meta.url);

function extractNamedFunction(source, name){
  const needle = `function ${name}(`;
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, `Expected to find ${name} in web/app.js`);

  let braceStart = -1;
  for (let i = start; i < source.length; i += 1){
    if (source[i] === '{'){
      braceStart = i;
      break;
    }
  }
  assert.notEqual(braceStart, -1, `Expected ${name} to have a function body`);

  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i += 1){
    const ch = source[i];
    if (ch === '{'){
      depth += 1;
    } else if (ch === '}'){
      depth -= 1;
      if (depth === 0){
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `Expected ${name} body to terminate`);
  return source.slice(start, end + 1);
}

function loadGroupEventHelpers(){
  const source = readFileSync(APP_JS_PATH, 'utf8');
  const fnNames = [
    'groupEventDedupKey',
    'dedupeGroupEvents',
    'appendUniqueGroupEvent',
  ];
  const fnSource = fnNames.map((name) => extractNamedFunction(source, name)).join('\n\n');
  const factory = new Function(`${fnSource}\nreturn { groupEventDedupKey, dedupeGroupEvents, appendUniqueGroupEvent };`);
  return factory();
}

test('appendUniqueGroupEvent ignores a websocket duplicate already present in the HTTP snapshot', () => {
  const { appendUniqueGroupEvent } = loadGroupEventHelpers();
  const existing = [
    { id: 'gevt_user_1', role: 'user', text: '@writer 帮我总结' },
    { id: 'gevt_assistant_1', role: 'assistant', agentId: 'writer', text: '@writer 已完成第一版可运行开发，并做了静态校验。' },
  ];

  const result = appendUniqueGroupEvent(existing, {
    id: 'gevt_assistant_1',
    role: 'assistant',
    agentId: 'writer',
    text: '@writer 已完成第一版可运行开发，并做了静态校验。',
  });

  assert.equal(result.length, 2);
  assert.deepEqual(result, existing);
});

test('dedupeGroupEvents also collapses duplicate events when ids are missing but payload matches', () => {
  const { dedupeGroupEvents } = loadGroupEventHelpers();
  const events = [
    { role: 'user', text: 'hello', ts: '2026-04-21T10:00:00.000Z' },
    { role: 'assistant', agentId: 'writer', text: '@writer hi', ts: '2026-04-21T10:00:01.000Z' },
    { role: 'assistant', agentId: 'writer', text: '@writer hi', ts: '2026-04-21T10:00:01.000Z' },
  ];

  const result = dedupeGroupEvents(events);

  assert.equal(result.length, 2);
  assert.deepEqual(result[1], events[1]);
});
