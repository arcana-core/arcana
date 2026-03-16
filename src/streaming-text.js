// Helper for merging streaming text chunks from models that may
// emit either full-message snapshots or incremental deltas.

export function mergeStreamingText(prev, next, opts = {}){
  let a;
  let b;
  try {
    a = typeof prev === 'string' ? prev : String(prev || '');
  } catch {
    a = '';
  }
  try {
    b = typeof next === 'string' ? next : String(next || '');
  } catch {
    b = '';
  }

  // Normalize newlines so CRLF streams behave consistently.
  if (a && a.indexOf('\r\n') !== -1){
    a = a.replace(/\r\n/g, '\n');
  }
  if (b && b.indexOf('\r\n') !== -1){
    b = b.replace(/\r\n/g, '\n');
  }

  const maxOverlapRaw = opts && typeof opts.maxOverlap === 'number' && Number.isFinite(opts.maxOverlap) && opts.maxOverlap > 0
    ? Math.floor(opts.maxOverlap)
    : 256;
  const maxLenRaw = opts && typeof opts.maxLen === 'number' && Number.isFinite(opts.maxLen) && opts.maxLen > 0
    ? Math.floor(opts.maxLen)
    : 0;

  const applyMaxLen = (value) => {
    if (!maxLenRaw || !value){
      return value;
    }
    if (value.length <= maxLenRaw){
      return value;
    }
    return value.slice(-maxLenRaw);
  };

  // Fast paths when one side is empty
  if (!a && !b){
    return '';
  }
  if (!a){
    return applyMaxLen(b);
  }
  if (!b){
    return applyMaxLen(a);
  }

  // If next starts with prev, treat as full snapshot.
  if (b.startsWith(a)){
    return applyMaxLen(b);
  }

  // If prev already ends with next, treat as duplicate resend.
  if (a.endsWith(b)){
    return applyMaxLen(a);
  }

  // Snapshot detection via high longest common prefix ratio.
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 64){
    let lcp = 0;
    const maxPrefix = minLen;
    while (lcp < maxPrefix && a.charCodeAt(lcp) === b.charCodeAt(lcp)){
      lcp += 1;
    }
    const lcpRatio = lcp / minLen;
    if (lcpRatio >= 0.85){
      const snapshot = b.length >= a.length ? b : a;
      return applyMaxLen(snapshot);
    }
  }

  // General case: find the largest suffix/prefix overlap (capped by maxOverlap)
  const maxOverlap = Math.min(maxOverlapRaw, a.length, b.length);
  let overlap = 0;
  for (let len = maxOverlap; len > 0; len -= 1){
    if (a.slice(-len) === b.slice(0, len)){
      overlap = len;
      break;
    }
  }

  // Guard against appending huge nearly-duplicate blocks when overlap is tiny.
  if (overlap < 8 && b.length >= 256 && b.length >= a.length / 2){
    return applyMaxLen(b);
  }

  let merged = a + b.slice(overlap);
  merged = applyMaxLen(merged);
  return merged;
}

export default { mergeStreamingText };
