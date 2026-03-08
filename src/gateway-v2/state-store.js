import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { arcanaHomePath } from '../arcana-home.js';
import { ensureDir, nowMs, atomicWriteJson, safeJsonParse } from './util.js';
import { runInLane } from './lane.js';

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

function stateBaseDir(){
  return arcanaHomePath('gateway-v2', 'state');
}

function stateFilePath(agentId, sessionKey, scope){
  const agentSafe = normalizeId(agentId, 'default');
  const sessSafe = normalizeId(sessionKey, 'session');
  const scopeSafe = normalizeId(scope, 'default');
  const dir = join(stateBaseDir(), agentSafe, sessSafe);
  return join(dir, scopeSafe + '.json');
}

export async function getState({ agentId, sessionKey, scope }){
  const filePath = stateFilePath(agentId || 'default', sessionKey || 'session', scope || 'default');
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT'){
      return { value: null, version: 0, updatedAtMs: 0 };
    }
    throw e;
  }
  const parsed = safeJsonParse(text, null) || {};
  const version = Number(parsed.version || 0);
  const updatedAtMs = Number(parsed.updatedAtMs || 0);
  return {
    value: parsed.value ?? null,
    version: Number.isFinite(version) && version >= 0 ? version : 0,
    updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs >= 0 ? updatedAtMs : 0,
  };
}

export async function patchState({ agentId, sessionKey, scope, expectedVersion, mutator }){
  const aId = agentId || 'default';
  const sKey = sessionKey || 'session';
  const sc = scope || 'default';
  const filePath = stateFilePath(aId, sKey, sc);
  const laneKey = ['state', aId, sKey, sc];

  return runInLane(laneKey, async () => {
    let current;
    try {
      current = await getState({ agentId: aId, sessionKey: sKey, scope: sc });
    } catch {
      current = { value: null, version: 0, updatedAtMs: 0 };
    }

    if (expectedVersion != null && current.version !== expectedVersion){
      return { ok: false, conflict: true, current };
    }

    const fn = typeof mutator === 'function' ? mutator : (v) => v;
    const nextValue = await fn(current.value, current);
    const updatedAtMs = nowMs();
    const nextVersion = current.version + 1;
    const record = { value: nextValue, version: nextVersion, updatedAtMs };

    const dir = dirname(filePath);
    await ensureDir(dir);
    await atomicWriteJson(filePath, record);

    return { ok: true, conflict: false, value: nextValue, version: nextVersion, updatedAtMs };
  });
}

export default { getState, patchState };

