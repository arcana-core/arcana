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

function loadPendingBubbleHelpers(context = {}){
  const source = readFileSync(APP_JS_PATH, 'utf8');
  const fnNames = [
    'rememberPendingAssistantBubble',
    'takePendingAssistantBubble',
  ];
  const fnSource = fnNames.map((name) => extractNamedFunction(source, name)).join('\n\n');
  const keys = Object.keys(context);
  const values = Object.values(context);
  const factory = new Function(...keys, `${fnSource}\nreturn { rememberPendingAssistantBubble, takePendingAssistantBubble };`);
  return factory(...values);
}

function loadAbortHelpers(context = {}){
  const source = readFileSync(APP_JS_PATH, 'utf8');
  const fnSource = extractNamedFunction(source, 'getGatewayV2AbortBody');
  const keys = Object.keys(context);
  const values = Object.values(context);
  const factory = new Function(...keys, `${fnSource}\nreturn { getGatewayV2AbortBody };`);
  return factory(...values);
}

test('takePendingAssistantBubble reuses the stream bubble matched by replyToEventId', () => {
  const gatewayV2Pending = new Map();
  const liveBubble = { id: 'live-bubble' };
  const { rememberPendingAssistantBubble, takePendingAssistantBubble } = loadPendingBubbleHelpers({
    gatewayV2Pending,
    activeAssistant: null,
    currentId: 'sess-1',
    streamingId: 'sess-1',
  });

  rememberPendingAssistantBubble('evt_user_1', liveBubble);
  const reused = takePendingAssistantBubble('evt_user_1', 'sess-1');

  assert.equal(reused, liveBubble);
  assert.equal(gatewayV2Pending.has('evt_user_1'), false);
});

test('takePendingAssistantBubble falls back to the active streaming bubble for the current session', () => {
  const gatewayV2Pending = new Map();
  const liveBubble = { id: 'active-bubble', isConnected: true };
  const { takePendingAssistantBubble } = loadPendingBubbleHelpers({
    gatewayV2Pending,
    activeAssistant: liveBubble,
    currentId: 'sess-2',
    streamingId: 'sess-2',
  });

  const reused = takePendingAssistantBubble('', 'sess-2');

  assert.equal(reused, liveBubble);
});

test('getGatewayV2AbortBody includes sessionId for sessions with externally managed session keys', () => {
  const { getGatewayV2AbortBody } = loadAbortHelpers({
    hasAgents: true,
    currentAgentId: 'cutpilot',
    DEFAULT_AGENT_ID: 'default',
    currentId: 'fallback-session',
    getCurrentSessionId: () => 'cutpilot-session-1',
    getGatewayV2SessionKeyForCurrent: () => 'sess:cutpilot:cutpilot-session-1',
  });

  assert.deepEqual(getGatewayV2AbortBody(), {
    agentId: 'cutpilot',
    sessionKey: 'sess:cutpilot:cutpilot-session-1',
    sessionId: 'cutpilot-session-1',
  });
});
