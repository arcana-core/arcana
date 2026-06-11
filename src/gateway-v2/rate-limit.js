// Optional per-client request rate limiter (token bucket per key).
//
// Disabled unless ARCANA_RATE_LIMIT_RPM > 0. Keying is by client IP by
// default; the gateway can pass a custom key (e.g. api token hash) instead.
// This is a coarse safety valve against a single misbehaving client, not a
// billing/quota system.

export function createRateLimiter(opts = {}){
  const rpm = Number(opts.rpm != null ? opts.rpm : process.env.ARCANA_RATE_LIMIT_RPM) || 0;
  const burst = Number(opts.burst) > 0 ? Number(opts.burst) : Math.max(1, Math.ceil(rpm / 6));
  const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : Date.now;
  const enabled = rpm > 0;
  const refillPerMs = rpm / 60000;
  const buckets = new Map(); // key -> { tokens, last }
  const MAX_KEYS = 50000;

  function take(key){
    if (!enabled) return { allowed: true, remaining: Infinity };
    const k = String(key || 'anon');
    const now = nowFn();
    let b = buckets.get(k);
    if (!b){
      if (buckets.size >= MAX_KEYS){
        // Evict the least-recently-seen bucket to stay bounded.
        let oldestKey = null;
        let oldest = Infinity;
        for (const [bk, bv] of buckets){ if (bv.last < oldest){ oldest = bv.last; oldestKey = bk; } }
        if (oldestKey != null) buckets.delete(oldestKey);
      }
      b = { tokens: burst, last: now };
      buckets.set(k, b);
    } else {
      const elapsed = now - b.last;
      if (elapsed > 0){
        b.tokens = Math.min(burst, b.tokens + elapsed * refillPerMs);
        b.last = now;
      }
    }
    if (b.tokens >= 1){
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens) };
    }
    const retryAfterMs = Math.ceil((1 - b.tokens) / refillPerMs);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  return { enabled, rpm, burst, take, _size: () => buckets.size };
}

export function clientKeyFromReq(req){
  try {
    const xff = req && req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
    if (xff){
      const first = String(Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
      if (first) return first;
    }
    const ra = req && req.socket && req.socket.remoteAddress;
    if (ra) return String(ra);
  } catch {}
  return 'anon';
}

export default { createRateLimiter, clientKeyFromReq };
