import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

import { arcanaHomePath } from '../../arcana-home.js';
import { ensureDir, nowMs, iso } from '../util.js';

function auditBaseDir(){
  return arcanaHomePath('gateway-v2', 'audit');
}

function auditFilePath(tsMs){
  const stamp = iso(typeof tsMs === 'number' && Number.isFinite(tsMs) ? tsMs : nowMs()).slice(0, 10);
  return join(auditBaseDir(), 'audit-' + stamp + '.jsonl');
}

export async function appendAudit(record){
  if (!record || typeof record !== 'object') return null;

  const tsMs = nowMs();
  const payload = { ...record };

  if (!Object.prototype.hasOwnProperty.call(payload, 'tsMs')) payload.tsMs = tsMs;
  if (!Object.prototype.hasOwnProperty.call(payload, 'ts')) payload.ts = iso(payload.tsMs);

  const filePath = auditFilePath(payload.tsMs);
  const dir = dirname(filePath);
  await ensureDir(dir);

  const line = JSON.stringify(payload) + '\n';
  try {
    await fsp.appendFile(filePath, line, 'utf8');
  } catch {
    // best-effort only
  }

  return payload;
}

export default { appendAudit };

