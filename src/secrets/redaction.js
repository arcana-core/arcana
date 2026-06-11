// Secret redaction registry.
//
// Whenever a secret value is resolved (via the Platform SDK or the store),
// it is registered here. Outbound event payloads and log lines are scrubbed
// against the registry so a secret that lands in tool output, an assistant
// message, or a service log does not leak to clients or disk.
//
// Only reasonably-long values are tracked (short ones cause false positives
// and aren't sensitive on their own). The registry is bounded.

const MIN_SECRET_LEN = 6;
const MAX_TRACKED = 1024;
const REDACTED = '[REDACTED]';

const tracked = new Set();
let pattern = null;

function escapeRegExp(s){
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rebuild(){
  if (!tracked.size){ pattern = null; return; }
  // Longest first so an overlapping shorter secret can't pre-empt a longer one.
  const parts = Array.from(tracked).sort((a, b) => b.length - a.length).map(escapeRegExp);
  pattern = new RegExp(parts.join('|'), 'g');
}

export function registerSecretValue(value){
  const v = typeof value === 'string' ? value : (value == null ? '' : String(value));
  if (v.length < MIN_SECRET_LEN) return false;
  if (tracked.has(v)) return false;
  if (tracked.size >= MAX_TRACKED){
    // Drop the oldest entry (insertion order) to stay bounded.
    const oldest = tracked.values().next().value;
    tracked.delete(oldest);
  }
  tracked.add(v);
  rebuild();
  return true;
}

export function redactString(text){
  if (!pattern || typeof text !== 'string' || !text) return text;
  pattern.lastIndex = 0;
  return text.replace(pattern, REDACTED);
}

// Deep-redact a JSON-serializable value, returning a scrubbed copy. Strings are
// replaced in place; objects/arrays are walked. Non-strings pass through.
export function redactValue(value){
  if (!pattern) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object'){
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactValue(value[k]);
    return out;
  }
  return value;
}

export function hasTrackedSecrets(){ return tracked.size > 0; }

// Test-only.
export function _reset(){ tracked.clear(); pattern = null; }

export default { registerSecretValue, redactString, redactValue, hasTrackedSecrets };
