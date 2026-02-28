import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';

// Simple process-wide event bus used by tools/subagents/etc.
export const eventBus = new EventEmitter();

// Async-local context { sessionId, workspaceRoot } so emit(ev) can auto-tag
// events and tools/subagents can resolve the correct workspace per-session.
const sessionContext = new AsyncLocalStorage();

export function runWithContext(ctx, fn) {
  // Execute fn inside an ALS scope carrying { sessionId, workspaceRoot }.
  // Accept both sync and async functions and return their result (or Promise).
  if (typeof fn !== 'function') return undefined;
  const store = ctx && typeof ctx === 'object' ? ctx : {};
  return sessionContext.run(store, fn);
}

// Back-compat shim: allow older callers to pass only sessionId.
export function runWithSession(sessionId, fn) {
  return runWithContext({ sessionId }, fn);
}

export function getContext() {
  try {
    return sessionContext.getStore?.() || null;
  } catch {
    return null;
  }
}

export function emit(ev) {
  try {
    // Attach sessionId from ALS when available and not explicitly set
    const cur = sessionContext.getStore?.() || null;
    const payload = cur && cur.sessionId && ev && typeof ev === 'object' && !ev.sessionId
      ? { ...ev, sessionId: cur.sessionId }
      : ev;
    // Required behavior: forward on the shared 'event' channel
    eventBus.emit('event', payload);
  } catch {}
}

export default { eventBus, runWithContext, runWithSession, getContext, emit };
