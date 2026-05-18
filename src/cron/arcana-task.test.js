import test from 'node:test';
import assert from 'node:assert/strict';

import { withTaskStreamRouting } from './arcana-task.js';

test('withTaskStreamRouting attaches agent and session routing metadata', () => {
  assert.deepEqual(
    withTaskStreamRouting(
      { type: 'assistant_text', text: 'done' },
      { agentId: 'cutpilot', sessionKey: 'cp:cutpilot:project:ios-native', sessionId: 'session-1' },
    ),
    {
      type: 'assistant_text',
      text: 'done',
      agentId: 'cutpilot',
      sessionKey: 'cp:cutpilot:project:ios-native',
      sessionId: 'session-1',
    },
  );
});

test('withTaskStreamRouting preserves explicit event routing metadata', () => {
  assert.deepEqual(
    withTaskStreamRouting(
      { type: 'tool_execution_start', agentId: 'other', sessionKey: 'other-session', sessionId: 'other-id' },
      { agentId: 'cutpilot', sessionKey: 'cp:cutpilot:project:ios-native', sessionId: 'session-1' },
    ),
    {
      type: 'tool_execution_start',
      agentId: 'other',
      sessionKey: 'other-session',
      sessionId: 'other-id',
    },
  );
});
