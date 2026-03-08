import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { arcanaHomePath } from '../arcana-home.js';
import { ensureDir, nowMs, iso, randomId, safeJsonParse } from './util.js';

function normalizeId(raw, fallback){
  try {
    const s = String(raw || '').trim();
    if (!s) return fallback;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || fallback;
  } catch {
    return fallback;
  }
}

function baseDir(){
  return arcanaHomePath('gateway-v2', 'events');
}

function eventFilePath(agentId, sessionKey){
  const agentSafe = normalizeId(agentId, 'default');
  const sessSafe = normalizeId(sessionKey, 'session');
  const dir = join(baseDir(), agentSafe);
  return join(dir, sessSafe + '.jsonl');
}

export async function appendEvent(ev){
  if (!ev || typeof ev !== 'object') throw new Error('invalid_event');
  const agentId = ev.agentId || 'default';
  const sessionKey = ev.sessionKey || 'session';
  const filePath = eventFilePath(agentId, sessionKey);

  const now = nowMs();
  const tsMs = Number(ev.tsMs ?? ev.ts ?? now);
  const tsSafe = Number.isFinite(tsMs) && tsMs > 0 ? tsMs : now;

  const stored = {
    eventId: ev.eventId || ('evt-' + randomId(8)),
    agentId,
    sessionKey,
    type: ev.type || 'event',
    source: ev.source || 'gateway',
    tsMs: tsSafe,
    ts: iso(tsSafe),
    data: ev.data ?? null,
  };

  const line = JSON.stringify(stored) + '\n';
  const dir = dirname(filePath);
  await ensureDir(dir);
  await fsp.appendFile(filePath, line, 'utf8');
  return stored;
}

export async function readEventsSince({ agentId, sessionKey, sinceTs, limit }){
  const filePath = eventFilePath(agentId || 'default', sessionKey || 'session');
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }

  const lines = text.split(/\r?\n/);
  const out = [];
  const cutoff = Number(sinceTs || 0);
  const max = (() => {
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) return n;
    return 100;
  })();

  for (const line of lines){
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = safeJsonParse(trimmed, null);
    if (!obj || typeof obj !== 'object') continue;
    const tsMs = Number(obj.tsMs || 0);
    if (Number.isFinite(tsMs) && tsMs <= cutoff) continue;
    out.push(obj);
    if (out.length >= max) break;
  }

  return out;
}

export default { appendEvent, readEventsSince };

