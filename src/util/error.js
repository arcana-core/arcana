import { inspect } from "node:util";

export function buildErrorStack(err, { maxDepth = 8, cap = 8000 } = {}){
  try {
    const seen = new Set();
    const parts = [];
    let depth = 0;
    let cur = err;
    while (cur && depth < maxDepth){
      if (seen.has(cur)) break;
      seen.add(cur);
      let s = "";
      try {
        if (cur && typeof cur.stack === "string" && cur.stack) s = String(cur.stack);
        else if (cur && typeof cur.message === "string") s = (cur.name ? (cur.name + ": ") : "") + String(cur.message);
        else s = String(cur);
      } catch { s = String(cur); }
      if (depth === 0) parts.push(s);
      else parts.push("Caused by: " + s);
      let next = null;
      try { next = cur && cur.cause ? cur.cause : null; } catch { next = null; }
      cur = next;
      depth++;
    }
    let out = parts.join("\n");
    if (typeof out === "string" && out.length > cap){ out = out.slice(0, cap); }
    return out;
  } catch {
    try {
      const s = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
      return String(s || "").slice(0, cap || 8000);
    } catch { return ""; }
  }
}

export function formatErrorForLog(err, opts = {}){
  const maxDepth = typeof opts.maxDepth === "number" && opts.maxDepth > 0 ? opts.maxDepth : 8;
  const cap = typeof opts.cap === "number" && opts.cap > 0 ? opts.cap : 8000;

  try {
    if (err == null) return "";
    const hasStack = !!(err && typeof err === "object" && (err.stack || err.message || err.cause));
    if (hasStack){
      return buildErrorStack(err, { maxDepth, cap });
    }
    let text;
    try {
      text = inspect(err, { depth: 6, breakLength: 120, maxArrayLength: 50 });
    } catch {
      try { text = String(err); } catch { text = ""; }
    }
    if (text && text.length > cap) return text.slice(0, cap);
    return text || "";
  } catch {
    try {
      const s = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
      const txt = String(s || "");
      return cap && txt.length > cap ? txt.slice(0, cap) : txt;
    } catch { return ""; }
  }
}

export function logError(labelOrCtx, err, ...rest){
  try {
    let label = labelOrCtx;
    let mainErr = err;

    if ((err === undefined || err === null) && labelOrCtx && typeof labelOrCtx === "object" && (labelOrCtx.stack || labelOrCtx.message || labelOrCtx.cause || labelOrCtx instanceof Error)){
      label = "";
      mainErr = labelOrCtx;
    }

    const formatted = formatErrorForLog(mainErr);

    const extras = [];
    for (const item of rest){
      if (item && typeof item === "object" && (item.stack || item.message || item.cause)){
        extras.push(formatErrorForLog(item));
      } else {
        extras.push(item);
      }
    }

    if (extras.length){
      console.error(label, formatted, ...extras);
    } else {
      console.error(label, formatted);
    }
  } catch {
    try { console.error(labelOrCtx, err, ...rest); } catch {}
  }
}

export default { buildErrorStack, formatErrorForLog, logError };
