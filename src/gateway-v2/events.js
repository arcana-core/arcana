// Stream event identity helpers for the gateway item-lifecycle protocol.
//
// Every streamed output unit ("item": one assistant message, later tool calls
// etc.) gets a stable itemId, every turn a turnId, and every emitted stream
// event a per-session monotonic seq. Clients key UI state (chat bubbles) off
// itemId instead of guessing from event order, which makes re-delivery
// idempotent and lets multiple assistant messages in one turn render as
// separate bubbles.
import { randomUUID } from 'node:crypto';

const sessionSeqCounters = new Map();
const MAX_TRACKED_SESSIONS = 4096;

export function nextEventSeq(sessionId){
  const sid = String(sessionId || 'default');
  const next = (sessionSeqCounters.get(sid) || 0) + 1;
  if (!sessionSeqCounters.has(sid) && sessionSeqCounters.size >= MAX_TRACKED_SESSIONS){
    const oldest = sessionSeqCounters.keys().next().value;
    sessionSeqCounters.delete(oldest);
  }
  sessionSeqCounters.set(sid, next);
  return next;
}

export function newTurnId(){
  return randomUUID();
}

export function newItemId(){
  return randomUUID();
}

export default { nextEventSeq, newTurnId, newItemId };
