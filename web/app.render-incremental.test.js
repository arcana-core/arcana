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

function loadRenderHelpers(){
  const source = readFileSync(APP_JS_PATH, 'utf8');
  const fnNames = ['messageRenderKey', 'computeIncrementalRenderStart'];
  const fnSource = fnNames.map((name) => extractNamedFunction(source, name)).join('\n\n');
  const factory = new Function(`${fnSource}\nreturn { messageRenderKey, computeIncrementalRenderStart };`);
  return factory();
}

test('computeIncrementalRenderStart returns the tail index for append-only updates', () => {
  const { messageRenderKey, computeIncrementalRenderStart } = loadRenderHelpers();
  const oldMsgs = [
    { role: 'user', text: 'hi', ts: 't1' },
    { role: 'assistant', text: 'hello', ts: 't2', itemId: 'item-1' },
  ];
  const newMsgs = [
    ...oldMsgs,
    { role: 'user', text: 'more', ts: 't3' },
  ];
  const start = computeIncrementalRenderStart(
    oldMsgs.map(messageRenderKey),
    newMsgs.map(messageRenderKey),
  );
  assert.equal(start, 2, 'only the appended tail is rendered');
});

test('computeIncrementalRenderStart requests a rebuild when history changed in place', () => {
  const { messageRenderKey, computeIncrementalRenderStart } = loadRenderHelpers();
  const oldMsgs = [
    { role: 'user', text: 'hi', ts: 't1' },
    { role: 'assistant', text: 'hello', ts: 't2' },
  ];
  const editedMsgs = [
    { role: 'user', text: 'hi', ts: 't1' },
    { role: 'assistant', text: 'hello, edited', ts: 't2' },
  ];
  assert.equal(computeIncrementalRenderStart(
    oldMsgs.map(messageRenderKey),
    editedMsgs.map(messageRenderKey),
  ), -1);
});

test('computeIncrementalRenderStart requests a rebuild when the list shrank or was never rendered', () => {
  const { computeIncrementalRenderStart } = loadRenderHelpers();
  assert.equal(computeIncrementalRenderStart(null, ['a']), -1);
  assert.equal(computeIncrementalRenderStart([], ['a']), -1);
  assert.equal(computeIncrementalRenderStart(['a', 'b'], ['a']), -1);
});

test('computeIncrementalRenderStart returns the full length for identical lists (no-op render)', () => {
  const { computeIncrementalRenderStart } = loadRenderHelpers();
  assert.equal(computeIncrementalRenderStart(['a', 'b'], ['a', 'b']), 2);
});

test('messageRenderKey distinguishes items, roles, timestamps and text changes', () => {
  const { messageRenderKey } = loadRenderHelpers();
  const base = { role: 'assistant', text: 'hello', ts: 't1', itemId: 'i1' };
  assert.equal(messageRenderKey(base, 0), messageRenderKey({ ...base }, 0));
  assert.notEqual(messageRenderKey(base, 0), messageRenderKey({ ...base, role: 'user' }, 0));
  assert.notEqual(messageRenderKey(base, 0), messageRenderKey({ ...base, ts: 't2' }, 0));
  assert.notEqual(messageRenderKey(base, 0), messageRenderKey({ ...base, itemId: 'i2' }, 0));
  assert.notEqual(messageRenderKey(base, 0), messageRenderKey({ ...base, text: 'hello!' }, 0));
});
