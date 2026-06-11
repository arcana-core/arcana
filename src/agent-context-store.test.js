import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js';

test('rotateContextAfterCompaction replaces the active context and prunes older archives', async () => {
  const previousHome = process.env.ARCANA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'arcana-context-store-'));
  process.env.ARCANA_HOME = home;

  try {
    const {
      contextFilePath,
      rotateContextAfterCompaction,
    } = await import('./agent-context-store.js');

    const agentId = 'test-agent';
    const sessionId = 'session-1';
    const contextPath = contextFilePath({ agentId, sessionId });

    const initial = SessionManager.open(contextPath);
    initial.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'old user message' }],
      timestamp: Date.now(),
    });
    initial.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'old assistant message' }],
      api: 'test',
      provider: 'test',
      model: 'test-model',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    initial._rewriteFile();

    const historyObj = {
      summary: 'Compressed older work.',
      messages: [
        { role: 'user', text: 'old user message' },
        { role: 'assistant', text: 'old assistant message' },
        { role: 'user', text: 'recent user message' },
        { role: 'assistant', text: 'recent assistant message' },
      ],
    };

    const first = rotateContextAfterCompaction({
      agentId,
      sessionId,
      workspaceRoot: home,
      historyObj,
      keepRecentUserTurns: 1,
      config: { agent_context_cache: { disk_keep_archived_generations: 1 } },
    });

    assert.equal(first.ok, true);
    assert.equal(first.contextPath, contextPath);
    assert.ok(first.archivedPath);

    const opened = SessionManager.open(contextPath);
    const ctx = opened.buildSessionContext();
    const texts = ctx.messages.map((message) => {
      if (message.role === 'compactionSummary') return message.summary;
      const content = Array.isArray(message.content) ? message.content : [{ text: message.content }];
      return content.map((item) => item.text || '').join('');
    });

    assert.deepEqual(texts, [
      'Compressed older work.',
      'recent user message',
      'recent assistant message',
    ]);

    const second = rotateContextAfterCompaction({
      agentId,
      sessionId,
      workspaceRoot: home,
      historyObj: {
        summary: 'Compressed again.',
        messages: [{ role: 'user', text: 'latest user message' }],
      },
      keepRecentUserTurns: 1,
      config: { agent_context_cache: { disk_keep_archived_generations: 1 } },
    });

    assert.equal(second.ok, true);
    assert.ok(second.archivedPath);
  } finally {
    if (previousHome == null) delete process.env.ARCANA_HOME;
    else process.env.ARCANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
