import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createWsHub } from './ws-hub.js';

class FakeSocket extends EventEmitter {
  constructor(){
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
  }

  send(payload){
    this.sent.push(JSON.parse(payload));
  }

  ping(){}

  terminate(){
    this.readyState = 3;
    this.emit('close');
  }
}

test('broadcast sends session-scoped events only to matching subscribers', () => {
  const hub = createWsHub();
  const matching = new FakeSocket();
  const otherSession = new FakeSocket();
  const anonymous = new FakeSocket();

  hub.addClient(matching, {
    agentId: 'default',
    sessionKey: 'sess:default:a',
    sessionId: 'a',
    threadKind: 'session',
  });
  hub.addClient(otherSession, {
    agentId: 'default',
    sessionKey: 'sess:default:b',
    sessionId: 'b',
    threadKind: 'session',
  });
  hub.addClient(anonymous, {});

  const sent = hub.broadcast({
    type: 'assistant_text',
    agentId: 'default',
    sessionKey: 'sess:default:a',
    sessionId: 'a',
    text: 'hello',
  });

  assert.equal(sent, 1);
  assert.equal(matching.sent.length, 1);
  assert.equal(otherSession.sent.length, 0);
  assert.equal(anonymous.sent.length, 0);
  hub.stop();
});

test('broadcast reaches CutPilot clients subscribed by sessionKey before sessionId is known', () => {
  const hub = createWsHub();
  const cutpilot = new FakeSocket();

  hub.addClient(cutpilot, {
    agentId: 'cutpilot',
    sessionKey: 'cp:cutpilot:project-1:ios-native',
  });

  assert.equal(hub.broadcast({
    type: 'assistant_text',
    agentId: 'cutpilot',
    sessionId: 'session-1',
    text: 'dropped without sessionKey',
  }), 0);

  assert.equal(hub.broadcast({
    type: 'assistant_text',
    agentId: 'cutpilot',
    sessionKey: 'cp:cutpilot:project-1:ios-native',
    sessionId: 'session-1',
    text: 'delivered with sessionKey',
  }), 1);

  assert.equal(cutpilot.sent.length, 1);
  assert.equal(cutpilot.sent[0].text, 'delivered with sessionKey');
  hub.stop();
});

test('receiveAll clients receive targeted stream events as a terminal feed', () => {
  const hub = createWsHub();
  const terminal = new FakeSocket();

  hub.addClient(terminal, {
    agentId: 'cutpilot',
    sessionKey: 'cp:cutpilot:project-1:desktop-main',
    receiveAll: true,
  });

  assert.equal(hub.broadcast({
    type: 'assistant_text',
    agentId: 'other-agent',
    sessionKey: 'other-session',
    sessionId: 'other-session-id',
    text: 'visible in terminal',
  }), 1);

  assert.equal(terminal.sent.length, 1);
  assert.equal(terminal.sent[0].text, 'visible in terminal');
  hub.stop();
});

test('broadcast unwraps event.appended metadata before routing', () => {
  const hub = createWsHub();
  const matching = new FakeSocket();
  const other = new FakeSocket();

  hub.addClient(matching, {
    agentId: 'agent-a',
    sessionKey: 'thread-a',
    sessionId: 'sid-a',
  });
  hub.addClient(other, {
    agentId: 'agent-a',
    sessionKey: 'thread-b',
    sessionId: 'sid-b',
  });

  const sent = hub.broadcast({
    type: 'event.appended',
    event: {
      agentId: 'agent-a',
      sessionKey: 'thread-a',
      type: 'message',
    },
  });

  assert.equal(sent, 1);
  assert.equal(matching.sent[0].type, 'event.appended');
  assert.equal(other.sent.length, 0);
  hub.stop();
});

test('client subscribe messages update routing metadata', () => {
  const hub = createWsHub();
  const ws = new FakeSocket();

  hub.addClient(ws, {
    agentId: 'default',
    sessionKey: 'sess:default:a',
    sessionId: 'a',
  });

  ws.emit('message', JSON.stringify({
    type: 'subscribe',
    threadKind: 'session',
    agentId: 'default',
    sessionKey: 'sess:default:b',
    sessionId: 'b',
  }));

  assert.equal(hub.broadcast({ type: 'turn_start', agentId: 'default', sessionId: 'a' }), 0);
  assert.equal(hub.broadcast({ type: 'turn_start', agentId: 'default', sessionId: 'b' }), 1);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].sessionId, 'b');
  hub.stop();
});

test('group-scoped events are delivered only to the matching group subscriber', () => {
  const hub = createWsHub();
  const group = new FakeSocket();
  const session = new FakeSocket();

  hub.addClient(group, {
    threadKind: 'group',
    groupId: 'group-1',
  });
  hub.addClient(session, {
    agentId: 'default',
    sessionKey: 'sess:default:group-1',
    sessionId: 'group-1',
    threadKind: 'session',
  });

  const sent = hub.broadcast({
    type: 'group.event.appended',
    groupId: 'group-1',
    event: { id: 'evt-1', text: 'hi' },
  });

  assert.equal(sent, 1);
  assert.equal(group.sent.length, 1);
  assert.equal(session.sent.length, 0);
  hub.stop();
});

test('unscoped events remain process-wide notifications', () => {
  const hub = createWsHub();
  const first = new FakeSocket();
  const second = new FakeSocket();

  hub.addClient(first, { agentId: 'a', sessionId: 'one' });
  hub.addClient(second, { agentId: 'b', sessionId: 'two' });

  assert.equal(hub.broadcast({ type: 'secrets_refresh' }), 2);
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 1);
  hub.stop();
});

test('broadcast drops progressive events for a backpressured client but keeps lifecycle events', () => {
  const hub = createWsHub();
  const slow = new FakeSocket();
  slow.bufferedAmount = 2 * 1024 * 1024; // above soft limit, below hard
  const fast = new FakeSocket();

  hub.addClient(slow, { agentId: 'default', sessionId: 'a', threadKind: 'session' });
  hub.addClient(fast, { agentId: 'default', sessionId: 'a', threadKind: 'session' });

  const progressive = { type: 'item_updated', agentId: 'default', sessionId: 'a', itemId: 'i1', text: 'partial' };
  const lifecycle = { type: 'item_completed', agentId: 'default', sessionId: 'a', itemId: 'i1', text: 'final' };

  hub.broadcast(progressive);
  hub.broadcast(lifecycle);

  assert.deepEqual(slow.sent.map((m) => m.type), ['item_completed'], 'slow client skips progressive, gets lifecycle');
  assert.deepEqual(fast.sent.map((m) => m.type), ['item_updated', 'item_completed']);
  hub.stop();
});

test('broadcast sends nothing to a client past the hard buffer limit', () => {
  const hub = createWsHub();
  const dead = new FakeSocket();
  dead.bufferedAmount = 32 * 1024 * 1024;

  hub.addClient(dead, { agentId: 'default', sessionId: 'a', threadKind: 'session' });

  const sent = hub.broadcast({ type: 'item_completed', agentId: 'default', sessionId: 'a', text: 'final' });
  assert.equal(sent, 0);
  assert.equal(dead.sent.length, 0);
  hub.stop();
});
