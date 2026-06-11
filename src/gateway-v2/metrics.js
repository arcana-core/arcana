// Lightweight in-process metrics, exported in Prometheus text format at
// GET /admin/metrics. No external dependency — just counters/gauges and a
// renderer. Cardinality is kept low (status labels only) on purpose.

const counters = new Map(); // name -> { help, type, values: Map<labelKey, number> }

function ensure(name, help, type){
  let m = counters.get(name);
  if (!m){
    m = { help, type, values: new Map() };
    counters.set(name, m);
  }
  return m;
}

function labelKey(labels){
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return keys.map((k) => k + '=' + String(labels[k])).join(',');
}

export function incCounter(name, labels, help){
  const m = ensure(name, help || name, 'counter');
  const key = labelKey(labels);
  m.values.set(key, (m.values.get(key) || 0) + 1);
  if (!m._labels) m._labels = new Map();
  m._labels.set(key, labels || {});
}

function renderLabels(labels){
  if (!labels) return '';
  const keys = Object.keys(labels);
  if (!keys.length) return '';
  return '{' + keys.map((k) => k + '="' + String(labels[k]).replace(/"/g, '\\"') + '"').join(',') + '}';
}

// Render Prometheus text. `gauges` is a flat object of name -> { value, help }
// computed at scrape time (uptime, memory, ws clients, service counts).
export function renderMetrics(gauges = {}){
  const lines = [];
  for (const [name, def] of Object.entries(gauges)){
    const value = Number(def && def.value);
    if (!Number.isFinite(value)) continue;
    if (def.help) lines.push('# HELP ' + name + ' ' + def.help);
    lines.push('# TYPE ' + name + ' gauge');
    lines.push(name + (def.labels ? renderLabels(def.labels) : '') + ' ' + value);
  }
  for (const [name, m] of counters){
    lines.push('# HELP ' + name + ' ' + m.help);
    lines.push('# TYPE ' + name + ' ' + m.type);
    if (!m.values.size){
      lines.push(name + ' 0');
      continue;
    }
    for (const [key, value] of m.values){
      const labels = m._labels ? m._labels.get(key) : null;
      lines.push(name + renderLabels(labels) + ' ' + value);
    }
  }
  return lines.join('\n') + '\n';
}

// Test-only.
export function _reset(){ counters.clear(); }

export default { incCounter, renderMetrics };
