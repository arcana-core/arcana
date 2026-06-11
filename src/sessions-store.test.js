import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSession,
  listSessions,
  loadSession,
  saveSession,
  appendMessage,
  deleteSession,
} from './sessions-store.js';

function withTempHome(fn){
  const previousHome = process.env.ARCANA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'arcana-sessions-store-test-'));
  process.env.ARCANA_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previousHome == null) delete process.env.ARCANA_HOME;
    else process.env.ARCANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function sessionsDirFor(home, agentId){
  return join(home, 'agents', agentId, 'sessions');
}

test('appendMessage writes messages to an append-only jsonl, not the meta json', () => {
  withTempHome((home) => {
    const session = createSession({ title: 'Split', workspace: home, agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'user', text: 'hello', agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'assistant', text: 'world', agentId: 'cutpilot', itemId: 'item-1' });

    const dir = sessionsDirFor(home, 'cutpilot');
    const metaRaw = JSON.parse(readFileSync(join(dir, session.id + '.json'), 'utf-8'));
    assert.equal(metaRaw.messages, undefined, 'meta json carries no messages');
    assert.equal(metaRaw.schema, 2);

    const lines = readFileSync(join(dir, session.id + '.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).text, 'hello');
    assert.equal(JSON.parse(lines[1]).itemId, 'item-1');

    const loaded = loadSession(session.id, { agentId: 'cutpilot' });
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[1].text, 'world');
  });
});

test('appendMessage dedupes consecutive rows with the same itemId', () => {
  withTempHome(() => {
    const session = createSession({ title: 'Dedup', agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'assistant', text: 'final text', agentId: 'cutpilot', itemId: 'item-x' });
    const second = appendMessage(session.id, { role: 'assistant', text: 'final text (redelivered)', agentId: 'cutpilot', itemId: 'item-x' });
    assert.equal(second.deduped, true);

    const loaded = loadSession(session.id, { agentId: 'cutpilot' });
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].text, 'final text');
  });
});

test('appendMessage derives a title from the first user message', () => {
  withTempHome(() => {
    const session = createSession({ title: '', agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'user', text: '帮我剪一段视频\n第二行', agentId: 'cutpilot' });
    const loaded = loadSession(session.id, { agentId: 'cutpilot' });
    assert.equal(loaded.title, '帮我剪一段视频');
  });
});

test('legacy combined session files load transparently and migrate on first append', () => {
  withTempHome((home) => {
    const dir = sessionsDirFor(home, 'cutpilot');
    const legacy = {
      id: 'legacy-1',
      title: 'Old format',
      agentId: 'cutpilot',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messages: [
        { role: 'user', text: 'old question', ts: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', text: 'old answer', ts: '2026-01-01T00:00:01.000Z' },
      ],
    };
    // sessionsDir is created lazily; createSession ensures it exists.
    createSession({ title: 'seed', agentId: 'cutpilot' });
    writeFileSync(join(dir, 'legacy-1.json'), JSON.stringify(legacy), 'utf-8');

    const before = loadSession('legacy-1', { agentId: 'cutpilot' });
    assert.equal(before.messages.length, 2, 'legacy file loads without migration');
    assert.equal(existsSync(join(dir, 'legacy-1.jsonl')), false);

    appendMessage('legacy-1', { role: 'user', text: 'new question', agentId: 'cutpilot' });

    assert.equal(existsSync(join(dir, 'legacy-1.jsonl')), true, 'first append migrates to split layout');
    const metaAfter = JSON.parse(readFileSync(join(dir, 'legacy-1.json'), 'utf-8'));
    assert.equal(metaAfter.messages, undefined);
    const after = loadSession('legacy-1', { agentId: 'cutpilot' });
    assert.deepEqual(after.messages.map((m) => m.text), ['old question', 'old answer', 'new question']);
  });
});

test('loadSession survives a partially written trailing line', () => {
  withTempHome((home) => {
    const session = createSession({ title: 'Crash', agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'user', text: 'intact', agentId: 'cutpilot' });
    const dir = sessionsDirFor(home, 'cutpilot');
    const path = join(dir, session.id + '.jsonl');
    writeFileSync(path, readFileSync(path, 'utf-8') + '{"role":"assistant","text":"trunc', 'utf-8');

    const loaded = loadSession(session.id, { agentId: 'cutpilot' });
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].text, 'intact');
  });
});

test('saveSession rewrites meta and messages for compaction-style updates', () => {
  withTempHome(() => {
    const session = createSession({ title: 'Compact', agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'user', text: 'q1', agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'assistant', text: 'a1', agentId: 'cutpilot' });

    const obj = loadSession(session.id, { agentId: 'cutpilot' });
    obj.summary = 'condensed history';
    obj.summaryUpToIndex = 1;
    assert.equal(saveSession(obj, { agentId: 'cutpilot' }), true);

    const reloaded = loadSession(session.id, { agentId: 'cutpilot' });
    assert.equal(reloaded.summary, 'condensed history');
    assert.equal(reloaded.summaryUpToIndex, 1);
    assert.equal(reloaded.messages.length, 2, 'messages preserved across meta save');
  });
});

test('listSessions previews the last message and sorts by activity', () => {
  withTempHome(() => {
    const a = createSession({ title: 'A', agentId: 'cutpilot' });
    const b = createSession({ title: 'B', agentId: 'cutpilot' });
    appendMessage(a.id, { role: 'user', text: 'first', agentId: 'cutpilot' });
    appendMessage(b.id, { role: 'user', text: 'second', agentId: 'cutpilot' });
    appendMessage(a.id, { role: 'assistant', text: 'latest activity', agentId: 'cutpilot' });

    const list = listSessions('cutpilot');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, a.id, 'most recently active first');
    assert.equal(list[0].last.text, 'latest activity');
    assert.equal(list[1].last.text, 'second');
  });
});

test('deleteSession removes both files', () => {
  withTempHome((home) => {
    const session = createSession({ title: 'Gone', agentId: 'cutpilot' });
    appendMessage(session.id, { role: 'user', text: 'bye', agentId: 'cutpilot' });
    assert.equal(deleteSession(session.id, { agentId: 'cutpilot' }), true);
    const dir = sessionsDirFor(home, 'cutpilot');
    const leftovers = readdirSync(dir).filter((n) => n.startsWith(session.id));
    assert.deepEqual(leftovers, []);
    assert.equal(loadSession(session.id, { agentId: 'cutpilot' }), null);
  });
});
