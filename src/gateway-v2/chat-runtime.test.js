import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachChatEventBridge,
  attachLocalToolProxyHub,
  buildChatCaptureSummary,
  buildLocalAgentSignature,
  buildLocalToolDefinitionsSignature,
  cancelLocalToolProxyCallsForClient,
  estimateProjectedPromptTokens,
  emitUserMessageDelivered,
  ensureAssistantTextDelivered,
  ensureTurnEndDelivered,
  buildLlmUsageEvent,
  handleLocalToolProxyHeartbeat,
  handleLocalToolProxyMessage,
  isRequiredBillingUsageMissing,
  normalizeAgentHomeRootOverride,
  normalizeWorkspaceRootOverride,
  requestLocalToolExecution,
  selectUsageSnapshot,
  withSessionStreamRouting,
} from './chat-runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventBus } from '../event-bus.js';
import { createSession, loadSession } from '../sessions-store.js';

test('buildLocalAgentSignature returns a trimmed bounded string', () => {
  assert.equal(buildLocalAgentSignature(undefined), '');
  assert.equal(buildLocalAgentSignature('  abc  '), 'abc');
  assert.equal(buildLocalAgentSignature('x'.repeat(300)).length, 256);
});

test('buildLocalToolDefinitionsSignature returns an empty signature when definitions are missing', () => {
  assert.equal(buildLocalToolDefinitionsSignature(undefined), '');
  assert.equal(buildLocalToolDefinitionsSignature(null), '');
  assert.equal(buildLocalToolDefinitionsSignature([]), '');
});

test('buildLocalToolDefinitionsSignature is stable across order changes but changes when tool definitions change', () => {
  const first = buildLocalToolDefinitionsSignature([
    {
      name: 'subtitle_transcribe',
      description: 'Transcribe subtitle track from local media',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
        },
      },
    },
    {
      name: 'edl_patch_apply',
      description: 'Apply a patch to the timeline JSON',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          diff: { type: 'string' },
        },
      },
    },
  ]);

  const reordered = buildLocalToolDefinitionsSignature([
    {
      name: 'edl_patch_apply',
      description: 'Apply a patch to the timeline JSON',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          diff: { type: 'string' },
        },
      },
    },
    {
      name: 'subtitle_transcribe',
      description: 'Transcribe subtitle track from local media',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
        },
      },
    },
  ]);

  const changed = buildLocalToolDefinitionsSignature([
    {
      name: 'subtitle_transcribe',
      description: 'Transcribe subtitle track from local media',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          language: { type: 'string' },
        },
      },
    },
    {
      name: 'edl_patch_apply',
      description: 'Apply a patch to the timeline JSON',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          diff: { type: 'string' },
        },
      },
    },
  ]);

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test('estimateProjectedPromptTokens includes the pending current question on top of live context', () => {
  const largePrompt = 'x'.repeat(160000);
  const projected = estimateProjectedPromptTokens({
    liveContextTokens: 90000,
    preludeText: '',
    promptMessage: largePrompt,
  });

  assert.equal(projected.source, 'live_context_plus_prompt');
  assert.equal(projected.baseTokens, 90000);
  assert.ok(projected.promptTokens > 0);
  assert.ok(projected.tokens > 100000);
});

test('estimateProjectedPromptTokens estimates the full payload when only prelude text exists', () => {
  const preludeText = 'history '.repeat(20000);
  const promptMessage = 'current '.repeat(15000);
  const projected = estimateProjectedPromptTokens({
    liveContextTokens: 0,
    preludeText,
    promptMessage,
  });

  assert.equal(projected.source, 'prelude_plus_prompt');
  assert.ok(projected.baseTokens > 0);
  assert.ok(projected.promptTokens > 0);
  assert.equal(projected.tokens, projected.baseTokens + projected.promptTokens);
});

test('normalizeWorkspaceRootOverride accepts absolute filesystem and file URL roots only', () => {
  assert.equal(normalizeWorkspaceRootOverride('/tmp/cutpilot/project'), '/tmp/cutpilot/project');
  assert.equal(normalizeWorkspaceRootOverride('file:///tmp/cutpilot/project'), '/tmp/cutpilot/project');
  assert.equal(normalizeWorkspaceRootOverride('relative/project'), '');
  assert.equal(normalizeWorkspaceRootOverride(''), '');
});

test('normalizeAgentHomeRootOverride accepts absolute filesystem and file URL roots only', () => {
  assert.equal(normalizeAgentHomeRootOverride('/tmp/cutpilot/agent'), '/tmp/cutpilot/agent');
  assert.equal(normalizeAgentHomeRootOverride('file:///tmp/cutpilot/agent'), '/tmp/cutpilot/agent');
  assert.equal(normalizeAgentHomeRootOverride('relative/agent'), '');
  assert.equal(normalizeAgentHomeRootOverride(''), '');
});

test('withSessionStreamRouting attaches sessionKey to assistant stream events', () => {
  const routed = withSessionStreamRouting(
    { type: 'assistant_text', text: 'done' },
    {
      agentId: 'cutpilot',
      sessionId: 'session-123',
      sessionKey: 'cp:cutpilot:project:ios-native',
    },
  );

  assert.deepEqual(routed, {
    type: 'assistant_text',
    text: 'done',
    agentId: 'cutpilot',
    sessionId: 'session-123',
    sessionKey: 'cp:cutpilot:project:ios-native',
  });
});

test('buildLlmUsageEvent includes clientTurnId for billing idempotency', () => {
  const event = buildLlmUsageEvent({
    usage: {
      inputTokens: 4,
      cacheReadTokens: 8,
      contextTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      lastCallInputTokens: 4,
      lastCallCacheReadTokens: 8,
      lastCallContextTokens: 12,
      lastCallTotalTokens: 17,
    },
    sessionId: 'session-123',
    sessionKey: 'cp:cutpilot:project:client',
    agentId: 'cutpilot',
    sessionTokens: 34,
    model: 'openai-compatible:gpt-5.5',
    clientTurnId: 'turn-abc',
    tsMs: 123456,
  });

  assert.deepEqual(event, {
    type: 'llm_usage',
    sessionId: 'session-123',
    sessionKey: 'cp:cutpilot:project:client',
    agentId: 'cutpilot',
    inputTokens: 4,
    cacheReadTokens: 8,
    cacheWriteTokens: 0,
    contextTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
    lastCallInputTokens: 4,
    lastCallCacheReadTokens: 8,
    lastCallCacheWriteTokens: 0,
    lastCallContextTokens: 12,
    lastCallTotalTokens: 17,
    sessionTokens: 34,
    tsMs: 123456,
    model: 'openai-compatible:gpt-5.5',
    clientTurnId: 'turn-abc',
  });
});

test('isRequiredBillingUsageMissing requires real usage for local tool proxy billing sessions', () => {
  assert.equal(isRequiredBillingUsageMissing(
    { localToolProxyEnabled: true },
    { contextTokens: 0, outputTokens: 0, totalTokens: 0 },
  ), true);

  assert.equal(isRequiredBillingUsageMissing(
    { localToolProxyEnabled: true },
    { contextTokens: 10, outputTokens: 3, totalTokens: 13 },
  ), false);

  assert.equal(isRequiredBillingUsageMissing(
    { localToolProxyEnabled: false },
    { contextTokens: 0, outputTokens: 0, totalTokens: 0 },
  ), false);
});

test('selectUsageSnapshot uses observed provider usage when bridge snapshot is empty', () => {
  assert.deepEqual(
    selectUsageSnapshot(
      { contextTokens: 0, outputTokens: 0, totalTokens: 0, lastCallContextTokens: 0, lastCallTotalTokens: 0 },
      { contextTokens: 1154, outputTokens: 5, totalTokens: 4871, lastCallContextTokens: 1154, lastCallTotalTokens: 4871 },
    ),
    { contextTokens: 1154, outputTokens: 5, totalTokens: 4871, lastCallContextTokens: 1154, lastCallTotalTokens: 4871 },
  );
});

test('buildChatCaptureSummary identifies token-heavy model request payload paths', () => {
  const summary = buildChatCaptureSummary({
    promptText: 'hello',
    stats: { usageContextTokens: 123, usageOutputTokens: 4, usageTotalTokens: 127 },
    modelRequest: {
      context: {
        messages: [
          { role: 'user', content: 'short text' },
          { role: 'tool', toolResult: 'tool-result-' + 'x'.repeat(5000) },
          { role: 'user', image: 'data:image/png;base64,' + 'A'.repeat(6000) },
        ],
      },
      providerPayload: {
        input: [
          { type: 'text', text: 'provider text' },
        ],
      },
    },
  });

  assert.equal(summary.stats.usageTotalTokens, 127);
  assert.ok(summary.totals.bytes > 11000);
  assert.ok(summary.categoryBytes.data_image > 6000);
  assert.ok(summary.categoryBytes.tool > 5000);
  assert.equal(summary.topItems[0].path, 'modelRequest.context.messages[2].image');
});

test('selectUsageSnapshot keeps bridge snapshot when both sources observed the same turn', () => {
  const bridge = { contextTokens: 12, outputTokens: 5, totalTokens: 17, lastCallContextTokens: 12, lastCallTotalTokens: 17 };
  const observed = { contextTokens: 12, outputTokens: 5, totalTokens: 17, lastCallContextTokens: 12, lastCallTotalTokens: 17 };
  assert.equal(selectUsageSnapshot(bridge, observed), bridge);
});

test('requestLocalToolExecution resolves matching local tool results', async () => {
  let dispatched = null;
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  attachLocalToolProxyHub({
    broadcast(payload) {
      dispatched = payload;
      setImmediate(() => {
        handleLocalToolProxyMessage({
          type: 'local_tool_result',
          callId: payload.callId,
          sessionKey: payload.sessionKey,
          agentId: payload.agentId,
          ok: true,
          result: { content: [{ type: 'text', text: 'ok' }] },
        });
      });
      return 1;
    },
  });

  try {
    const result = await requestLocalToolExecution({
      agentId: 'cutpilot',
      sessionKey: 'cp:cutpilot:project:client',
      sessionId: 'session-123',
      toolName: 'read',
      args: { path: '/tmp/SOUL.md' },
      timeoutMs: 1000,
    });

    assert.equal(dispatched.type, 'local_tool_request');
    assert.equal(dispatched.tool, 'read');
    assert.equal(dispatched.timeoutMs, 1000);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });
    assert.equal(handleLocalToolProxyMessage({
      type: 'local_tool_result',
      callId: dispatched.callId,
      sessionKey: dispatched.sessionKey,
      agentId: dispatched.agentId,
      ok: true,
      result: { content: [{ type: 'text', text: 'ok' }] },
    }), true);

    const toolEvents = events.filter((event) => event.type === 'tool_execution_start' || event.type === 'tool_execution_end');
    assert.equal(toolEvents.length, 2);
    assert.deepEqual(toolEvents.map((event) => event.type), ['tool_execution_start', 'tool_execution_end']);
    assert.equal(toolEvents[0].toolName, 'read');
    assert.equal(toolEvents[0].source, 'local_tool_proxy');
    assert.equal(toolEvents[0].toolCallId, dispatched.callId);
    assert.equal(toolEvents[0].sessionId, 'session-123');
    assert.equal(toolEvents[0].sessionKey, 'cp:cutpilot:project:client');
    assert.equal(toolEvents[0].agentId, 'cutpilot');
    assert.equal(toolEvents[1].toolName, 'read');
    assert.equal(toolEvents[1].source, 'local_tool_proxy');
    assert.equal(toolEvents[1].toolCallId, dispatched.callId);
    assert.equal(toolEvents[1].isError, false);
    assert.deepEqual(toolEvents[1].result, { content: [{ type: 'text', text: 'ok' }] });
  } finally {
    eventBus.off('event', listener);
    attachLocalToolProxyHub(null);
  }
});

test('requestLocalToolExecution has no default timeout and accepts tool heartbeats', async () => {
  let dispatched = null;
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  attachLocalToolProxyHub({
    broadcast(payload) {
      dispatched = payload;
      setTimeout(() => {
        assert.equal(handleLocalToolProxyHeartbeat({
          type: 'local_tool_heartbeat',
          callId: payload.callId,
          sessionKey: payload.sessionKey,
          agentId: payload.agentId,
          tool: payload.tool,
        }), true);
      }, 20);
      setTimeout(() => {
        handleLocalToolProxyMessage({
          type: 'local_tool_result',
          callId: payload.callId,
          sessionKey: payload.sessionKey,
          agentId: payload.agentId,
          ok: true,
          result: { content: [{ type: 'text', text: 'slow ok' }] },
        });
      }, 150);
      return 1;
    },
  });

  try {
    const result = await requestLocalToolExecution({
      agentId: 'cutpilot',
      sessionKey: 'cp:cutpilot:project:client',
      sessionId: 'session-heartbeat',
      toolName: 'subtitle_transcribe',
      args: { assetId: 'A001' },
    });

    assert.equal(dispatched.timeoutMs, 0);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'slow ok' }] });
    const updates = events.filter((event) => event.type === 'tool_execution_update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].source, 'local_tool_proxy');
    assert.equal(updates[0].toolName, 'subtitle_transcribe');
    assert.equal(updates[0].toolCallId, dispatched.callId);
    assert.equal(updates[0].sessionId, 'session-heartbeat');
    assert.equal(updates[0].sessionKey, 'cp:cutpilot:project:client');
    assert.equal(updates[0].update.type, 'heartbeat');
    assert.equal(updates[0].update.heartbeatCount, 1);
  } finally {
    eventBus.off('event', listener);
    attachLocalToolProxyHub(null);
  }
});

test('requestLocalToolExecution fails immediately when no websocket client receives the request', async () => {
  attachLocalToolProxyHub({
    broadcast() {
      return 0;
    },
  });

  await assert.rejects(
    requestLocalToolExecution({
      agentId: 'cutpilot',
      sessionKey: 'cp:cutpilot:project:client',
      toolName: 'read',
      args: { path: '/tmp/SOUL.md' },
      timeoutMs: 1000,
    }),
    (error) => error && error.code === 'local_tool_proxy_no_client',
  );
  attachLocalToolProxyHub(null);
});

test('requestLocalToolExecution times out unmatched local tool requests', async () => {
  let dispatched = null;
  attachLocalToolProxyHub({
    broadcast(payload) {
      dispatched = payload;
      return 1;
    },
  });

  await assert.rejects(
    requestLocalToolExecution({
      agentId: 'cutpilot',
      sessionKey: 'cp:cutpilot:project:client',
      toolName: 'read',
      args: { path: '/tmp/SOUL.md' },
      timeoutMs: 100,
    }),
    (error) => error && error.code === 'local_tool_proxy_timeout',
  );

  assert.equal(handleLocalToolProxyMessage({
    type: 'local_tool_result',
    callId: dispatched.callId,
    sessionKey: dispatched.sessionKey,
    agentId: dispatched.agentId,
    ok: true,
    result: { content: [{ type: 'text', text: 'late' }] },
  }), false);
  attachLocalToolProxyHub(null);
});

test('requestLocalToolExecution rejects when matching websocket client disconnects', async () => {
  let dispatched = null;
  attachLocalToolProxyHub({
    broadcast(payload) {
      dispatched = payload;
      setImmediate(() => {
        const cancelled = cancelLocalToolProxyCallsForClient({
          agentId: payload.agentId,
          sessionKey: payload.sessionKey,
          reason: 'close',
        });
        assert.equal(cancelled, 1);
      });
      return 1;
    },
  });

  await assert.rejects(
    requestLocalToolExecution({
      agentId: 'cutpilot',
      sessionKey: 'cp:cutpilot:project:client',
      toolName: 'read',
      args: { path: '/tmp/SOUL.md' },
      timeoutMs: 1000,
    }),
    (error) => error && error.code === 'local_tool_proxy_client_disconnected',
  );

  assert.equal(typeof dispatched.callId, 'string');
  assert.equal(handleLocalToolProxyMessage({
    type: 'local_tool_result',
    callId: dispatched.callId,
    sessionKey: dispatched.sessionKey,
    agentId: dispatched.agentId,
    ok: true,
    result: { content: [{ type: 'text', text: 'late' }] },
  }), false);
  attachLocalToolProxyHub(null);
});

test('requestLocalToolExecution rejects immediately on same-call session mismatch result', async () => {
  let dispatched = null;
  attachLocalToolProxyHub({
    broadcast(payload) {
      dispatched = payload;
      setImmediate(() => {
        handleLocalToolProxyMessage({
          type: 'local_tool_result',
          callId: payload.callId,
          sessionKey: 'cp:cutpilot:different:desktop-main',
          agentId: payload.agentId,
          ok: false,
          error: 'path_not_found',
          message: 'path_not_found',
        });
      });
      return 1;
    },
  });

  await assert.rejects(
    requestLocalToolExecution({
      agentId: 'cutpilot',
      sessionKey: 'sess:cutpilot:expected',
      toolName: 'grep',
      args: { path: '/tmp/project', pattern: 'assetId' },
      timeoutMs: 1000,
    }),
    (error) => error && error.code === 'local_tool_proxy_session_mismatch',
  );
  assert.equal(typeof dispatched.callId, 'string');
  attachLocalToolProxyHub(null);
});

test('ensureAssistantTextDelivered broadcasts and persists final text once', () => {
  const previousHome = process.env.ARCANA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'arcana-chat-runtime-test-'));
  process.env.ARCANA_HOME = home;
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  try {
    const session = createSession({
      title: 'Probe',
      workspace: home,
      agentId: 'cutpilot',
    });
    const record = {};

    assert.equal(ensureAssistantTextDelivered({
      record,
      sessionId: session.id,
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      text: 'CUTPILOT_PROBE_OK',
    }), true);
    assert.equal(ensureAssistantTextDelivered({
      record,
      sessionId: session.id,
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      text: 'CUTPILOT_PROBE_OK',
    }), false);

    const loaded = loadSession(session.id, { agentId: 'cutpilot' });
    const assistantMessages = loaded.messages.filter((message) => message.role === 'assistant');
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0].text, 'CUTPILOT_PROBE_OK');
    assert.deepEqual(events.filter((event) => event.type === 'assistant_text'), [{
      type: 'assistant_text',
      text: 'CUTPILOT_PROBE_OK',
      sessionId: session.id,
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
    }]);
  } finally {
    eventBus.off('event', listener);
    if (previousHome == null) delete process.env.ARCANA_HOME;
    else process.env.ARCANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureAssistantTextDelivered does not duplicate when streaming already emitted the clean text', () => {
  const previousHome = process.env.ARCANA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'arcana-chat-runtime-test-'));
  process.env.ARCANA_HOME = home;
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  try {
    const session = createSession({
      title: 'Probe',
      workspace: home,
      agentId: 'cutpilot',
    });
    // Simulate what the streaming bridge records at message_end: the
    // media-extracted clean text was emitted and persisted.
    const cleanText = 'Here is the result.';
    const record = {
      __arcana_lastAssistantTextEmitted: cleanText,
      __arcana_lastAssistantTextPersisted: cleanText,
    };
    // runPromptSync hands over the RAW text (with MEDIA refs). Before the fix
    // the raw-vs-clean mismatch re-emitted and re-persisted a duplicate.
    const rawText = 'Here is the result.\nMEDIA: /tmp/out/clip.png';
    assert.equal(ensureAssistantTextDelivered({
      record,
      sessionId: session.id,
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      text: rawText,
    }), false);
    assert.deepEqual(events.filter((event) => event.type === 'assistant_text'), []);
    const loaded = loadSession(session.id, { agentId: 'cutpilot' });
    assert.deepEqual((loaded.messages || []).filter((m) => m.role === 'assistant'), []);
  } finally {
    eventBus.off('event', listener);
    if (previousHome == null) delete process.env.ARCANA_HOME;
    else process.env.ARCANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureAssistantTextDelivered emits clean text and persists media refs when streaming missed it', () => {
  const previousHome = process.env.ARCANA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'arcana-chat-runtime-test-'));
  process.env.ARCANA_HOME = home;
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  try {
    const session = createSession({
      title: 'Probe',
      workspace: home,
      agentId: 'cutpilot',
    });
    const record = {};
    assert.equal(ensureAssistantTextDelivered({
      record,
      sessionId: session.id,
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      text: 'Done.\nMEDIA: /tmp/out/clip.png',
    }), true);
    const emitted = events.filter((event) => event.type === 'assistant_text');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].text, 'Done.');
    const loaded = loadSession(session.id, { agentId: 'cutpilot' });
    const assistantMessages = (loaded.messages || []).filter((m) => m.role === 'assistant');
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0].text, 'Done.');
    assert.deepEqual(assistantMessages[0].mediaRefs, ['/tmp/out/clip.png']);
  } finally {
    eventBus.off('event', listener);
    if (previousHome == null) delete process.env.ARCANA_HOME;
    else process.env.ARCANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureTurnEndDelivered emits only when the bridge missed turn_end', () => {
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  try {
    const record = { __arcana_turnEndCount: 2 };
    assert.equal(ensureTurnEndDelivered({
      record,
      sessionId: 'session-123',
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      turnEndCountBefore: 2,
    }), true);
    assert.equal(record.__arcana_turnEndCount, 3);
    assert.equal(ensureTurnEndDelivered({
      record,
      sessionId: 'session-123',
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      turnEndCountBefore: 2,
    }), false);
    assert.deepEqual(events.filter((event) => event.type === 'turn_end'), [{
      type: 'turn_end',
      sessionId: 'session-123',
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
    }]);
  } finally {
    eventBus.off('event', listener);
  }
});

test('ensureTurnEndDelivered can force the final turn_end after a completed turn', () => {
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  try {
    const record = { __arcana_turnEndCount: 3 };
    assert.equal(ensureTurnEndDelivered({
      record,
      sessionId: 'session-456',
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      turnEndCountBefore: 2,
      force: true,
    }), true);
    assert.equal(record.__arcana_turnEndCount, 4);
    assert.deepEqual(events.filter((event) => event.type === 'turn_end'), [{
      type: 'turn_end',
      sessionId: 'session-456',
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
    }]);
  } finally {
    eventBus.off('event', listener);
  }
});

test('emitUserMessageDelivered broadcasts a session-scoped user message', () => {
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  try {
    assert.equal(emitUserMessageDelivered({
      sessionId: 'session-789',
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      text: 'edit the current timeline',
      mediaRefs: ['file://asset.png'],
    }), true);
    assert.deepEqual(events.filter((event) => event.type === 'user_message'), [{
      type: 'user_message',
      text: 'edit the current timeline',
      mediaRefs: ['file://asset.png'],
      sessionId: 'session-789',
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
    }]);
  } finally {
    eventBus.off('event', listener);
  }
});

function setupBridgeProbe(){
  const previousHome = process.env.ARCANA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'arcana-chat-runtime-test-'));
  process.env.ARCANA_HOME = home;
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  let handler = null;
  const session = createSession({ title: 'Probe', workspace: home, agentId: 'cutpilot' });
  const fakeSess = { subscribe(fn){ handler = fn; } };
  const record = {
    session: fakeSess,
    agentId: 'cutpilot',
    sessionKey: 'cp:cutpilot:project:client',
    agentHomeDir: home,
    workspaceRoot: home,
  };
  const cleanup = () => {
    eventBus.off('event', listener);
    if (previousHome == null) delete process.env.ARCANA_HOME;
    else process.env.ARCANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  };
  return {
    events,
    record,
    sessionId: session.id,
    attach(){ attachChatEventBridge(record, session.id); return handler; },
    cleanup,
  };
}

test('chat event bridge assigns one itemId per assistant message in a turn', () => {
  const probe = setupBridgeProbe();
  try {
    const handler = probe.attach();
    handler({ type: 'turn_start' });
    handler({ type: 'message_start', message: { role: 'assistant', content: [] } });
    handler({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'First' }] } });
    handler({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] } });
    handler({ type: 'message_start', message: { role: 'assistant', content: [] } });
    handler({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Second' }] } });
    handler({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] } });
    handler({ type: 'turn_end' });

    const itemEvents = probe.events.filter((ev) => String(ev.type || '').startsWith('item_'));
    assert.deepEqual(itemEvents.map((ev) => ev.type), [
      'item_started', 'item_updated', 'item_completed',
      'item_started', 'item_updated', 'item_completed',
    ]);
    const firstId = itemEvents[0].itemId;
    const secondId = itemEvents[3].itemId;
    assert.ok(firstId && secondId, 'item ids assigned');
    assert.notEqual(firstId, secondId, 'each assistant message gets its own item');
    assert.deepEqual(itemEvents.slice(0, 3).map((ev) => ev.itemId), [firstId, firstId, firstId]);
    assert.deepEqual(itemEvents.slice(3).map((ev) => ev.itemId), [secondId, secondId, secondId]);
    assert.equal(itemEvents[2].text, 'First answer');
    assert.equal(itemEvents[5].text, 'Second answer');

    const turnStart = probe.events.find((ev) => ev.type === 'turn_start');
    const turnEnd = probe.events.find((ev) => ev.type === 'turn_end');
    assert.ok(turnStart.turnId, 'turn_start carries turnId');
    assert.equal(turnEnd.turnId, turnStart.turnId);
    for (const ev of itemEvents){
      assert.equal(ev.turnId, turnStart.turnId);
    }

    const seqs = probe.events.filter((ev) => typeof ev.seq === 'number').map((ev) => ev.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    assert.deepEqual(seqs, sorted, 'seq is monotonic');
    assert.equal(new Set(seqs).size, seqs.length, 'seq has no duplicates');

    // Legacy snapshots still flow for older consumers.
    assert.deepEqual(
      probe.events.filter((ev) => ev.type === 'assistant_text').map((ev) => ev.text),
      ['First', 'First answer', 'Second', 'Second answer'],
    );

    // History rows carry the itemId for future uuid-based dedup.
    const loaded = loadSession(probe.sessionId, { agentId: 'cutpilot' });
    const assistantRows = (loaded.messages || []).filter((m) => m.role === 'assistant');
    assert.deepEqual(assistantRows.map((m) => m.text), ['First answer', 'Second answer']);
    assert.deepEqual(assistantRows.map((m) => m.itemId), [firstId, secondId]);
  } finally {
    probe.cleanup();
  }
});

test('chat event bridge skips SDK tool events for locally proxied tools', () => {
  const probe = setupBridgeProbe();
  try {
    probe.record.localToolProxyEnabled = true;
    probe.record.injectedLocalToolNames = new Set(['client_tool']);
    probe.record.toolRouting = { tools: { routed_local: { execution: 'local', fallback: 'deny' } } };
    const handler = probe.attach();
    handler({ type: 'tool_execution_start', toolName: 'client_tool', toolCallId: 'c1', args: {} });
    handler({ type: 'tool_execution_end', toolName: 'client_tool', toolCallId: 'c1' });
    handler({ type: 'tool_execution_start', toolName: 'routed_local', toolCallId: 'c2', args: {} });
    handler({ type: 'tool_execution_start', toolName: 'host_tool', toolCallId: 'c3', args: {} });

    const toolEvents = probe.events.filter((ev) => String(ev.type || '').startsWith('tool_execution'));
    assert.deepEqual(toolEvents.map((ev) => [ev.type, ev.toolName]), [
      ['tool_execution_start', 'host_tool'],
    ]);
  } finally {
    probe.cleanup();
  }
});

test('ensureAssistantTextDelivered re-delivers as idempotent item_completed', () => {
  const previousHome = process.env.ARCANA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'arcana-chat-runtime-test-'));
  process.env.ARCANA_HOME = home;
  const events = [];
  const listener = (event) => events.push(event);
  eventBus.on('event', listener);
  try {
    const session = createSession({ title: 'Probe', workspace: home, agentId: 'cutpilot' });
    const record = {
      __arcana_lastAssistantItemId: 'item-abc',
      __arcana_currentTurnId: 'turn-xyz',
    };
    assert.equal(ensureAssistantTextDelivered({
      record,
      sessionId: session.id,
      sessionKey: 'cp:cutpilot:project:client',
      agentId: 'cutpilot',
      text: 'Recovered final text',
    }), true);
    const completed = events.filter((ev) => ev.type === 'item_completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].itemId, 'item-abc');
    assert.equal(completed[0].turnId, 'turn-xyz');
    assert.equal(completed[0].text, 'Recovered final text');
  } finally {
    eventBus.off('event', listener);
    if (previousHome == null) delete process.env.ARCANA_HOME;
    else process.env.ARCANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
