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

function loadItemBubbleHelpers(context = {}){
  const source = readFileSync(APP_JS_PATH, 'utf8');
  const fnNames = ['resetItemBubbles', 'claimItemBubble'];
  const fnSource = fnNames.map((name) => extractNamedFunction(source, name)).join('\n\n');
  const keys = Object.keys(context);
  const values = Object.values(context);
  const factory = new Function(...keys, `${fnSource}\nreturn { resetItemBubbles, claimItemBubble };`);
  return factory(...values);
}

function makeBubble(id){
  return { id, isConnected: true };
}

test('claimItemBubble gives each itemId its own bubble within a turn', () => {
  const itemBubbles = new Map();
  let created = 0;
  const { claimItemBubble } = loadItemBubbleHelpers({
    itemBubbles,
    itemBubblesSession: 'sess-1',
    activeAssistant: null,
    appendMessage: () => makeBubble(`bubble-${++created}`),
  });

  const first = claimItemBubble('item-a', 'sess-1');
  const second = claimItemBubble('item-b', 'sess-1');

  assert.ok(first && second);
  assert.notEqual(first, second, 'text before and after a tool call gets separate bubbles');
  assert.equal(itemBubbles.size, 2);
});

test('claimItemBubble is idempotent for re-delivered events of the same item', () => {
  const itemBubbles = new Map();
  let created = 0;
  const { claimItemBubble } = loadItemBubbleHelpers({
    itemBubbles,
    itemBubblesSession: 'sess-1',
    activeAssistant: null,
    appendMessage: () => makeBubble(`bubble-${++created}`),
  });

  const first = claimItemBubble('item-a', 'sess-1');
  const again = claimItemBubble('item-a', 'sess-1');

  assert.equal(first, again, 're-delivered item_completed updates the same bubble');
  assert.equal(created, 1);
});

test('claimItemBubble lets the first item claim the pending typing bubble', () => {
  const itemBubbles = new Map();
  const pending = makeBubble('pending');
  let created = 0;
  const { claimItemBubble } = loadItemBubbleHelpers({
    itemBubbles,
    itemBubblesSession: 'sess-1',
    activeAssistant: pending,
    appendMessage: () => makeBubble(`bubble-${++created}`),
  });

  const first = claimItemBubble('item-a', 'sess-1');
  const second = claimItemBubble('item-b', 'sess-1');

  assert.equal(first, pending, 'first item reuses the bubble created on send');
  assert.notEqual(second, pending, 'subsequent items do not overwrite the claimed bubble');
  assert.equal(created, 1);
});

test('claimItemBubble clears the registry when the session changes', () => {
  const itemBubbles = new Map();
  let created = 0;
  const { claimItemBubble } = loadItemBubbleHelpers({
    itemBubbles,
    itemBubblesSession: '',
    activeAssistant: null,
    appendMessage: () => makeBubble(`bubble-${++created}`),
  });

  claimItemBubble('item-a', 'sess-1');
  assert.equal(itemBubbles.size, 1);
  claimItemBubble('item-b', 'sess-2');
  assert.equal(itemBubbles.size, 1, 'registry belongs to one session at a time');
  assert.equal(itemBubbles.has('item-b'), true);
});

test('claimItemBubble discards stale disconnected bubbles', () => {
  const itemBubbles = new Map();
  const stale = { id: 'stale', isConnected: false };
  itemBubbles.set('item-a', stale);
  let created = 0;
  const { claimItemBubble } = loadItemBubbleHelpers({
    itemBubbles,
    itemBubblesSession: 'sess-1',
    activeAssistant: null,
    appendMessage: () => makeBubble(`bubble-${++created}`),
  });

  const fresh = claimItemBubble('item-a', 'sess-1');
  assert.notEqual(fresh, stale, 'bubble removed by a re-render is replaced');
  assert.equal(created, 1);
});
