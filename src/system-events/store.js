import { existsSync, mkdirSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { arcanaHomePath, ensureArcanaHomeDir } from '../arcana-home.js';

// JSON-backed system events store, persisted under Arcana home.
// Path per agent+session:
//   arcanaHomePath('agents', agentId, 'system-events', `${sessionId}.json`)
//
// State shape:
//   {
//     nextId: number,
//     ackedThroughId: number,
//     events: [
//       { id, ts, text, contextKey, dedupeKey, event }
//     ],
//     dedupe: { [dedupeKey: string]: number /* lastTs */ },
//   }

const DEFAULT_STATE = {
  nextId: 1,
  ackedThroughId: 0,
  events: [],
  dedupe: {},
};

function normalizeAgentId(raw) {
  try {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || null;
  } catch {
    return null;
  }
}

function normalizeSessionId(raw) {
  try {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || null;
  } catch {
    return null;
  }
}

function resolveEventsFilePath(agentIdRaw, sessionIdRaw) {
  const agentId = normalizeAgentId(agentIdRaw);
  const sessionId = normalizeSessionId(sessionIdRaw);
  if (!agentId) throw new Error('system-events: agentId required');
  if (!sessionId) throw new Error('system-events: sessionId required');

  // Ensure Arcana home base exists, then the per-agent system-events dir.
  const baseHome = ensureArcanaHomeDir();
  const dir = arcanaHomePath('agents', agentId, 'system-events');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Store path: ~/.arcana/agents/<agentId>/system-events/<sessionId>.json
  const filePath = arcanaHomePath('agents', agentId, 'system-events', sessionId + '.json');
  return { baseHome, filePath };
}

function cloneDefaultState() {
  return {
    nextId: DEFAULT_STATE.nextId,
    ackedThroughId: DEFAULT_STATE.ackedThroughId,
    events: [],
    dedupe: {},
  };
}

function normalizeEventRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;

  const ts = (() => {
    const t1 = Number(raw.ts);
    if (Number.isFinite(t1) && t1 > 0) return t1;
    const t2 = Number(raw.timestamp);
    if (Number.isFinite(t2) && t2 > 0) return t2;
    return Date.now();
  })();

  const text = typeof raw.text === 'string' ? raw.text : '';
  const contextKey = typeof raw.contextKey === 'string' ? raw.contextKey : '';
  const dedupeKey = typeof raw.dedupeKey === 'string' ? raw.dedupeKey : '';
  const event = Object.prototype.hasOwnProperty.call(raw, 'event') ? raw.event : undefined;

  return { id, ts, text, contextKey, dedupeKey, event };
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== 'object') return cloneDefaultState();

  const nextId = Number(parsed.nextId);
  const ackedThroughId = Number(parsed.ackedThroughId);

  const eventsRaw = Array.isArray(parsed.events) ? parsed.events : [];
  const events = [];
  for (const item of eventsRaw) {
    const norm = normalizeEventRecord(item);
    if (norm) events.push(norm);
  }

  const dedupeSrc = parsed.dedupe && typeof parsed.dedupe === 'object' ? parsed.dedupe : {};
  const dedupe = {};
  for (const [key, value] of Object.entries(dedupeSrc)) {
    const k = String(key || '').trim();
    if (!k) continue;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) continue;
    dedupe[k] = v;
  }

  return {
    nextId: Number.isFinite(nextId) && nextId > 0 ? nextId : DEFAULT_STATE.nextId,
    ackedThroughId: Number.isFinite(ackedThroughId) && ackedThroughId >= 0 ? ackedThroughId : DEFAULT_STATE.ackedThroughId,
    events,
    dedupe,
  };
}

async function readState(options = {}) {
  const { agentId, sessionId } = options || {};
  const { filePath } = resolveEventsFilePath(agentId, sessionId);

  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    // On ENOENT, parse, or other errors, fall back to a fresh state.
    if (error && error.code !== 'ENOENT') {
      // Swallow and reset state on corrupted data.
    }
    return cloneDefaultState();
  }
}

async function writeState(options = {}, state) {
  const { agentId, sessionId } = options || {};
  const { filePath } = resolveEventsFilePath(agentId, sessionId);
  const toWrite = state || cloneDefaultState();
  const data = JSON.stringify(toWrite, null, 2);
  await fsp.writeFile(filePath, data, 'utf8');
}

function coerceLimit(limitRaw) {
  const n = Number(limitRaw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

// Public API
// enqueueSystemEvent({ agentId, sessionId, text, contextKey, dedupeKey, event })
// - Requires agentId and sessionId.
// - If event object is provided, derives text/contextKey/dedupeKey from it when missing.
// - Dedupe rules:
//   * If dedupeKey exists and last event with that key was within 60s, skip.
//   * Also dedupe exact same (text+contextKey) as last event within 10s.
// - Enforces max 200 pending events (id > ackedThroughId).

export async function enqueueSystemEvent(options = {}) {
  const opts = { ...(options || {}) };
  if (!opts.agentId || !opts.sessionId) {
    throw new Error('enqueueSystemEvent requires agentId and sessionId');
  }

  let { text, contextKey, dedupeKey, event } = opts;
  const now = Date.now();

  const ev = event && typeof event === 'object' ? event : undefined;

  // Derive text/contextKey/dedupeKey from event payload when missing.
  if (!text && ev && typeof ev.text === 'string') text = ev.text;
  if (!contextKey && ev && typeof ev.contextKey === 'string') contextKey = ev.contextKey;
  if (!dedupeKey && ev && typeof ev.dedupeKey === 'string') dedupeKey = ev.dedupeKey;
  if (!dedupeKey && ev && typeof ev.key === 'string') dedupeKey = ev.key;
  if (!dedupeKey && ev && typeof ev.type === 'string' && contextKey) {
    dedupeKey = `${ev.type}:${contextKey}`;
  }
  if (!text && ev) {
    const cand = ev.message || ev.reason || ev.type;
    if (typeof cand === 'string') text = cand;
  }

  const textStr = String(text || '').trim();
  const contextKeyStr = typeof contextKey === 'string' ? contextKey : '';
  const dedupeKeyStr = typeof dedupeKey === 'string' ? dedupeKey : '';

  if (!textStr && !ev) {
    throw new Error('enqueueSystemEvent requires text or event');
  }

  const state = await readState(opts);

  // Simple dedupe by dedupeKey within 60s.
  if (dedupeKeyStr) {
    const lastTs = state.dedupe && typeof state.dedupe[dedupeKeyStr] === 'number' ? state.dedupe[dedupeKeyStr] : 0;
    if (lastTs && now - lastTs <= 60_000) {
      return { skipped: true, reason: 'dedupe', dedupeKey: dedupeKeyStr };
    }
  }

  // Dedupe exact same (text+contextKey) as last event within 10s.
  if (state.events.length) {
    const last = state.events[state.events.length - 1];
    const lastText = String(last.text || '').trim();
    const lastContext = typeof last.contextKey === 'string' ? last.contextKey : '';
    if (lastText === textStr && lastContext === contextKeyStr) {
      const lastTs = typeof last.ts === 'number' ? last.ts : 0;
      if (lastTs && now - lastTs <= 10_000) {
        return { skipped: true, reason: 'dedupe', dedupeKey: dedupeKeyStr || undefined };
      }
    }
  }

  const baseId = Number.isFinite(state.nextId) && state.nextId > 0 ? state.nextId : DEFAULT_STATE.nextId;
  const id = baseId;
  state.nextId = id + 1;

  const record = {
    id,
    ts: now,
    text: textStr,
    contextKey: contextKeyStr,
    dedupeKey: dedupeKeyStr,
    event: event,
  };

  if (!state.dedupe) state.dedupe = {};
  if (dedupeKeyStr) state.dedupe[dedupeKeyStr] = now;

  state.events.push(record);

  // Enforce max 200 events retained beyond ackedThroughId.
  const ackedId = Number.isFinite(state.ackedThroughId) && state.ackedThroughId >= 0 ? state.ackedThroughId : 0;
  const pending = state.events.filter((item) => typeof item.id === 'number' && item.id > ackedId);
  if (pending.length > 200) {
    const overflow = pending.length - 200;
    const cutoff = pending[overflow - 1]?.id;
    if (typeof cutoff === 'number') {
      state.events = state.events.filter((item) => typeof item.id === 'number' && item.id > cutoff);
    }
  }

  await writeState(opts, state);
  return record;
}

export async function peekSystemEvents(options = {}) {
  const opts = { ...(options || {}) };
  if (!opts.agentId || !opts.sessionId) {
    throw new Error('peekSystemEvents requires agentId and sessionId');
  }

  const limit = coerceLimit(opts.limit);
  const state = await readState(opts);
  const ackedId = Number.isFinite(state.ackedThroughId) && state.ackedThroughId >= 0 ? state.ackedThroughId : 0;
  const pending = state.events.filter((item) => typeof item.id === 'number' && item.id > ackedId);

  if (limit) return pending.slice(0, limit);
  return pending;
}

export async function ackSystemEvents(options = {}) {
  const opts = { ...(options || {}) };
  if (!opts.agentId || !opts.sessionId) {
    throw new Error('ackSystemEvents requires agentId and sessionId');
  }

  const state = await readState(opts);
  if (!state.events.length) {
    return {
      ackedThroughId: state.ackedThroughId,
    };
  }

  let targetId;
  if (typeof opts.upToId === 'number' && Number.isFinite(opts.upToId)) {
    targetId = opts.upToId;
  } else {
    const last = state.events[state.events.length - 1];
    targetId = typeof last.id === 'number' ? last.id : state.ackedThroughId;
  }

  if (targetId > state.ackedThroughId) {
    state.ackedThroughId = targetId;
    state.events = state.events.filter((item) => typeof item.id === 'number' && item.id > state.ackedThroughId);
    await writeState(opts, state);
  }

  return {
    ackedThroughId: state.ackedThroughId,
  };
}

export default {
  enqueueSystemEvent,
  peekSystemEvents,
  ackSystemEvents,
};
