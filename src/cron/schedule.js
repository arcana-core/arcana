// Minimal schedule parser and next-run calculator supporting:
// - at: ISO timestamp or +duration (e.g., +10m, +1h30m)
// - every: duration like 10m/1h/2d (first run = now + duration)
// - cron: 5-field minute hour dom month dow (subset: *, numbers, comma lists)
// Timezone: 'local' (default) or 'UTC'

function nowMs() { return Date.now(); }

// Parse a compact duration string like 1h30m10s, 15m, 2d.
export function parseDuration(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const re = /(\d+)\s*([smhdw])/gi;
  let m; let total = 0; let matched = false;
  while ((m = re.exec(s))) {
    matched = true;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    if (u === 's') total += n * 1000;
    else if (u === 'm') total += n * 60 * 1000;
    else if (u === 'h') total += n * 60 * 60 * 1000;
    else if (u === 'd') total += n * 24 * 60 * 60 * 1000;
    else if (u === 'w') total += n * 7 * 24 * 60 * 60 * 1000;
  }
  return matched ? total : null;
}

export function normalizeTimezone(tz) {
  const t = String(tz || 'local').toLowerCase();
  return t === 'utc' ? 'UTC' : 'local';
}

// ---- AT ----
export function nextAt(schedule, fromMs) {
  const tz = normalizeTimezone(schedule?.timezone);
  const spec = String(schedule?.value || schedule?.at || '').trim();
  if (!spec) return null;
  // +duration
  if (spec.startsWith('+')) {
    const dur = parseDuration(spec.slice(1));
    if (!dur) return null;
    const base = typeof fromMs === 'number' ? fromMs : nowMs();
    return base + dur;
  }
  // ISO timestamp; interpret in given timezone by parsing as Date (which is UTC internally)
  const t = Date.parse(spec);
  if (Number.isFinite(t)) return t; // Date.parse expects ISO in UTC
  return null;
}

// ---- EVERY ----
export function nextEvery(schedule, fromMs) {
  const dur = parseDuration(schedule?.value || schedule?.every || '');
  if (!dur) return null;
  const base = typeof fromMs === 'number' ? fromMs : nowMs();
  return base + dur;
}

// ---- CRON (subset) ----
// Cron fields: minute hour dom month dow
// Supported tokens per field (limited subset):
// - '*' wildcard (any)
// - '*/n' step across full range
// - 'x-y' inclusive range
// - 'x-y/n' ranged step
// - 'x' single number
// - comma-separated lists combining the above

function parseList(field, min, max) {
  const s = String(field || '').trim();
  if (!s || s === '*') return null; // null => wildcard
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  const vals = [];
  for (const p of parts) {
    // */n across full range
    let m = p.match(/^\*\/(\d+)$/);
    if (m) {
      const step = parseInt(m[1], 10);
      if (!(step >= 1)) return { error: 'invalid_step' };
      for (let v = min; v <= max; v += step) vals.push(v);
      continue;
    }
    // a-b or a-b/n
    m = p.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      const step = m[3] ? parseInt(m[3], 10) : 1;
      if (a > b) [a, b] = [b, a];
      if (a < min || b > max || !(step >= 1)) return { error: 'out_of_range' };
      for (let v = a; v <= b; v += step) vals.push(v);
      continue;
    }
    // x or x/n (start with x then step)
    m = p.match(/^(\d+)(?:\/(\d+))?$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const step = m[2] ? parseInt(m[2], 10) : null;
      if (start < min || start > max) return { error: 'out_of_range' };
      if (!step) { vals.push(start); continue; }
      if (!(step >= 1)) return { error: 'invalid_step' };
      for (let v = start; v <= max; v += step) vals.push(v);
      continue;
    }
    return { error: 'invalid_token' };
  }
  // de-dup
  return Array.from(new Set(vals)).sort((a, b) => a - b);
}

export function parseCron(expr) {
  const raw = String(expr || '').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { error: 'cron_arity' };
  const [minF, hourF, domF, monF, dowF] = parts;
  const minutes = parseList(minF, 0, 59); if (minutes?.error) return minutes;
  const hours = parseList(hourF, 0, 23); if (hours?.error) return hours;
  const dom = parseList(domF, 1, 31); if (dom?.error) return dom;
  const months = parseList(monF, 1, 12); if (months?.error) return months;
  let dow = parseList(dowF, 0, 7); if (dow?.error) return dow;
  if (Array.isArray(dow)) dow = dow.map((d) => (d === 7 ? 0 : d));
  return { minutes, hours, dom, months, dow, expr: raw };
}

function getParts(date, tz) {
  if (tz === 'UTC') {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
      ms: date.getUTCMilliseconds(),
      sec: date.getUTCSeconds(),
    };
  }
  return {
    minute: date.getMinutes(),
    hour: date.getHours(),
    dom: date.getDate(),
    month: date.getMonth() + 1,
    dow: date.getDay(),
    ms: date.getMilliseconds(),
    sec: date.getSeconds(),
  };
}

function setToMinuteBoundary(d, tz) {
  if (tz === 'UTC') {
    d.setUTCSeconds(0, 0);
  } else {
    d.setSeconds(0, 0);
  }
}

function addMinutes(d, n, tz) {
  if (tz === 'UTC') {
    d.setUTCMinutes(d.getUTCMinutes() + n);
  } else {
    d.setMinutes(d.getMinutes() + n);
  }
}

export function nextCron(schedule, fromMs) {
  const tz = normalizeTimezone(schedule?.timezone);
  const parsed = parseCron(schedule?.value || schedule?.cron || '');
  if (parsed?.error) return null;
  const base = typeof fromMs === 'number' ? fromMs : nowMs();
  // Search starting from the next minute
  const d = new Date(base);
  // Move to next minute strictly greater than base
  addMinutes(d, 1, tz);
  setToMinuteBoundary(d, tz);
  const limit = base + 366 * 24 * 60 * 60 * 1000; // 1 year safety
  for (let i = 0; i < 600000; i++) { // hard iteration cap
    const p = getParts(d, tz);
    const okMin = !Array.isArray(parsed.minutes) || parsed.minutes.includes(p.minute);
    const okHour = !Array.isArray(parsed.hours) || parsed.hours.includes(p.hour);
    const okDom = !Array.isArray(parsed.dom) || parsed.dom.includes(p.dom);
    const okMon = !Array.isArray(parsed.months) || parsed.months.includes(p.month);
    const okDow = !Array.isArray(parsed.dow) || parsed.dow.includes(p.dow);
    if (okMin && okHour && okDom && okMon && okDow) return d.getTime();
    addMinutes(d, 1, tz);
    if (d.getTime() > limit) break;
  }
  return null;
}

export function computeNextRun(schedule, fromMs) {
  if (!schedule || !schedule.type) return null;
  const type = String(schedule.type).toLowerCase();
  if (type === 'at') return nextAt(schedule, fromMs);
  if (type === 'every') return nextEvery(schedule, fromMs);
  if (type === 'cron') return nextCron(schedule, fromMs);
  return null;
}

export default {
  parseDuration,
  parseCron,
  normalizeTimezone,
  nextAt,
  nextEvery,
  nextCron,
  computeNextRun,
};
