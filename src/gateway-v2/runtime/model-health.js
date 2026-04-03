import { nowMs } from '../util.js';

const DEFAULT_DECAY_MS = 5 * 60 * 1000; // 5 minutes

function classifyError(err, finishReason, stopReason) {
  try {
    const out = { category: 'unknown', code: '', retryable: false };

    const reasons = [finishReason, stopReason].filter(Boolean).map((r) => String(r).toLowerCase());
    for (const r of reasons) {
      if (r.includes('content_filter') || r.includes('content-filter') || r.includes('blocked')) {
        out.category = 'content_blocked';
        out.retryable = false;
        return out;
      }
      if (r.includes('overloaded') || r.includes('rate_limit') || r.includes('rate-limit')) {
        out.category = 'rate_limit';
        out.retryable = true;
        return out;
      }
      if (r.includes('timeout')) {
        out.category = 'network';
        out.code = 'TIMEOUT';
        out.retryable = true;
        return out;
      }
      if (r.includes('error')) {
        out.category = 'server_error';
        out.retryable = true;
      }
    }

    if (err) {
      const status = typeof err.status === 'number' ? err.status : (typeof err.statusCode === 'number' ? err.statusCode : 0);
      const code = String(err.code || err.type || '').toUpperCase();
      const msg = String(err.message || err || '').toLowerCase();
      if (status === 429) {
        out.category = 'rate_limit';
        out.code = code || 'HTTP_429';
        out.retryable = true;
        return out;
      }
      if (status >= 500 && status <= 599) {
        out.category = 'server_error';
        out.code = code || ('HTTP_' + String(status));
        out.retryable = true;
        return out;
      }
      const networkPhrases = ['timeout', 'econnreset', 'econnrefused', 'socket hang up', 'fetch failed', 'network error'];
      if (networkPhrases.some((p) => msg.includes(p.toLowerCase()))) {
        out.category = 'network';
        out.code = code || 'NETWORK_ERROR';
        out.retryable = true;
        return out;
      }
    }

    return out;
  } catch {
    return { category: 'unknown', code: '', retryable: false };
  }
}

function createModelHealthStore() {
  const byKey = new Map();

  function getKey(spec = {}) {
    const provider = spec.provider || 'default';
    const model = spec.model || 'default';
    const endpoint = spec.endpoint || '';
    return `${provider}::${model}::${endpoint}`;
  }

  function recordResult(spec, { ok, errorCategory }) {
    const key = getKey(spec);
    const now = nowMs();
    const entry = byKey.get(key) || {
      failStreak: 0,
      successStreak: 0,
      lastFailAt: 0,
      lastSuccessAt: 0,
      state: 'unknown',
    };

    if (ok) {
      entry.successStreak += 1;
      entry.failStreak = 0;
      entry.lastSuccessAt = now;
    } else if (errorCategory === 'network' || errorCategory === 'rate_limit' || errorCategory === 'server_error') {
      entry.failStreak += 1;
      entry.successStreak = 0;
      entry.lastFailAt = now;
    }

    let nextState = entry.state || 'unknown';
    if (entry.failStreak >= 3) {
      nextState = 'down';
    } else if (entry.failStreak > 0) {
      nextState = 'degraded';
    } else if (entry.successStreak > 0) {
      nextState = 'up';
    }

    entry.state = nextState;
    byKey.set(key, entry);
    return { key, state: entry.state, failStreak: entry.failStreak, successStreak: entry.successStreak };
  }

  function getStatus(spec) {
    const key = getKey(spec);
    const entry = byKey.get(key);
    if (!entry) return { state: 'unknown', failStreak: 0, successStreak: 0, lastFailAt: 0, lastSuccessAt: 0 };

    const now = nowMs();
    if (entry.state === 'down' && entry.lastFailAt && (now - entry.lastFailAt) > DEFAULT_DECAY_MS) {
      entry.state = 'degraded';
      byKey.set(key, entry);
    }

    return { state: entry.state, failStreak: entry.failStreak, successStreak: entry.successStreak, lastFailAt: entry.lastFailAt, lastSuccessAt: entry.lastSuccessAt };
  }

  return { recordResult, getStatus };
}

export { classifyError, createModelHealthStore };

export default { classifyError, createModelHealthStore };
