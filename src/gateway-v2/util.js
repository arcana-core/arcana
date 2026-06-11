import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

export function nowMs(){
  return Date.now();
}

export function iso(ts){
  try {
    if (typeof ts === 'number' && Number.isFinite(ts)){
      return new Date(ts).toISOString();
    }
    return new Date().toISOString();
  } catch {
    return String(new Date());
  }
}

export function safeJsonParse(text, fallback = null){
  try {
    if (text === undefined || text === null) return fallback;
    if (typeof text !== 'string') return JSON.parse(String(text));
    const trimmed = text.trim();
    if (!trimmed) return fallback;
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

export function randomId(bytes = 12){
  try {
    const n = (typeof bytes === 'number' && bytes > 0 && Number.isFinite(bytes)) ? bytes : 12;
    return randomBytes(n).toString('hex');
  } catch {
    // Best-effort only; fall back to timestamp-based id
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
}

export async function readBodyJson(req, { maxBytes = 1024 * 1024 } = {}){
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      let total = 0;

      const onData = (chunk) => {
        try {
          total += chunk.length;
          if (total > maxBytes){
            cleanup();
            reject(new Error('body_too_large'));
            try { req.destroy(); } catch {}
            return;
          }
          chunks.push(chunk);
        } catch (e) {
          cleanup();
          reject(e);
        }
      };

      const onEnd = () => {
        cleanup();
        try {
          if (!chunks.length){
            resolve(null);
            return;
          }
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          if (!text.trim()){
            resolve(null);
            return;
          }
          const obj = JSON.parse(text);
          resolve(obj);
        } catch {
          reject(new Error('invalid_json'));
        }
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      const onAborted = () => {
        cleanup();
        reject(new Error('aborted'));
      };

      function cleanup(){
        try { req.off('data', onData); } catch {}
        try { req.off('end', onEnd); } catch {}
        try { req.off('error', onError); } catch {}
        try { req.off('aborted', onAborted); } catch {}
      }

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('aborted', onAborted);
    } catch (e) {
      reject(e);
    }
  });
}

export async function ensureDir(dirPath){
  if (!dirPath) return dirPath;
  try {
    await fsp.mkdir(dirPath, { recursive: true });
  } catch {}
  return dirPath;
}

export async function atomicWriteJson(filePath, value){
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tmpPath = join(dir, '.' + randomId(6) + '.tmp');
  const data = JSON.stringify(value) + '\n';
  try {
    await fsp.writeFile(tmpPath, data, 'utf8');
    await fsp.rename(tmpPath, filePath);
  } catch {
    try { await fsp.unlink(tmpPath); } catch {}
    throw new Error('write_failed');
  }
}

export default { nowMs, iso, safeJsonParse, readBodyJson, ensureDir, atomicWriteJson, randomId };


// Slice a session object's messages for the paginated GET /api/sessions/:id.
// limit: newest N messages; before: page backwards (indexes < before).
// Returns null when no pagination was requested (caller sends the object as-is).
export function paginateSessionMessages(obj, limitRaw, beforeRaw){
  // Number(null/'') is 0, which would silently turn "no param" into before=0.
  const hasLimitParam = limitRaw !== null && limitRaw !== undefined && String(limitRaw).trim() !== '';
  const hasBeforeParam = beforeRaw !== null && beforeRaw !== undefined && String(beforeRaw).trim() !== '';
  const limit = hasLimitParam ? Number(limitRaw) : NaN;
  const before = hasBeforeParam ? Number(beforeRaw) : NaN;
  const wantsLimit = Number.isFinite(limit) && limit > 0;
  const wantsBefore = Number.isFinite(before) && before >= 0;
  if (!wantsLimit && !wantsBefore) return null;
  const messages = Array.isArray(obj && obj.messages) ? obj.messages : [];
  const total = messages.length;
  const end = wantsBefore ? Math.min(Math.floor(before), total) : total;
  const effectiveLimit = wantsLimit ? Math.floor(limit) : end;
  const start = Math.max(0, end - effectiveLimit);
  return {
    ...obj,
    messages: messages.slice(start, end),
    totalMessages: total,
    firstIndex: start,
    hasMore: start > 0,
  };
}
