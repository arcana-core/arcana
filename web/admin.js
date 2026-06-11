// Arcana operator console. Standalone — does not depend on app.js.
'use strict';

const TOKEN_KEY = 'arcana.adminToken.v1';
const REFRESH_MS = 3000;

let adminToken = '';
let refreshTimer = null;
let currentLogService = '';

const $ = (id) => document.getElementById(id);

function authHeaders(){
  return adminToken ? { 'x-arcana-admin-token': adminToken } : {};
}

async function api(path, { method = 'GET' } = {}){
  const res = await fetch(path, { method, headers: authHeaders() });
  let json = null;
  try { json = await res.json(); } catch {}
  if (res.status === 401){
    setConn(false, '令牌无效或未授权');
    throw new Error('unauthorized');
  }
  if (!res.ok){
    throw new Error((json && (json.message || json.error)) || ('HTTP ' + res.status));
  }
  return json;
}

function setConn(ok, text){
  const el = $('connState');
  el.textContent = text || (ok ? '已连接' : '未连接');
  el.className = ok ? 'ok' : 'bad';
}

function fmtBytes(n){
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

function fmtUptime(ms){
  const s = Math.floor((Number(ms) || 0) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + (s % 60) + 's';
}

function fmtAgo(iso){
  if (!iso) return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  if (diff < 60000) return Math.floor(diff / 1000) + 's 前';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm 前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h 前';
  return Math.floor(diff / 86400000) + 'd 前';
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function card(k, v){
  return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
}

function renderOverview(o){
  const by = (o.services && o.services.byStatus) || {};
  const running = by.running || 0;
  const bad = (by.crashed || 0) + (by.error || 0);
  $('overviewCards').innerHTML = [
    card('运行时长', fmtUptime(o.uptimeMs)),
    card('内存 (RSS)', fmtBytes(o.memory && o.memory.rss)),
    card('WS 连接', String(o.wsClients || 0)),
    card('服务', running + ' 运行 / ' + (o.services ? o.services.count : 0) + ' 总' + (bad ? (' / ' + bad + ' 异常') : '')),
    card('Agents', String((o.agents || []).length)),
  ].join('');

  const agentsBody = $('agentsBody');
  const agents = o.agents || [];
  agentsBody.innerHTML = agents.length
    ? agents.map((a) => '<tr><td>' + esc(a.agentId) + '</td><td>' + esc(a.sessionCount) + '</td><td class="muted">' + esc(fmtAgo(a.lastActivity)) + '</td></tr>').join('')
    : '<tr><td colspan="3" class="muted">无</td></tr>';
}

function actionButtons(s){
  const st = String(s.status || '');
  const live = st === 'running' || st === 'starting' || st === 'restarting' || st === 'timeout';
  const btns = [];
  if (live){
    btns.push('<button data-act="stop" data-id="' + esc(s.id) + '">停止</button>');
    btns.push('<button data-act="restart" data-id="' + esc(s.id) + '">重启</button>');
  } else {
    btns.push('<button data-act="start" data-id="' + esc(s.id) + '">启动</button>');
  }
  btns.push('<button data-act="logs" data-id="' + esc(s.id) + '">日志</button>');
  return btns.join(' ');
}

function renderServices(list){
  const body = $('servicesBody');
  if (!list || !list.length){
    body.innerHTML = '<tr><td colspan="8" class="muted">没有发现服务（services/ 目录为空）</td></tr>';
    return;
  }
  body.innerHTML = list.map((s) => {
    const st = String(s.status || 'unknown');
    return '<tr>'
      + '<td><strong>' + esc(s.id) + '</strong></td>'
      + '<td class="muted">' + esc(s.mode === 'process' ? '隔离' : '进程内') + '</td>'
      + '<td><span class="pill ' + esc(st) + '">' + esc(st) + '</span></td>'
      + '<td class="muted">' + esc(s.pid || '—') + '</td>'
      + '<td class="muted">' + esc(s.restarts || 0) + '</td>'
      + '<td class="muted">' + esc(s.lastHeartbeatAt ? fmtAgo(s.lastHeartbeatAt) : '—') + '</td>'
      + '<td><span class="error-text" title="' + esc(s.error || '') + '">' + esc(s.error || '') + '</span></td>'
      + '<td>' + actionButtons(s) + '</td>'
      + '</tr>';
  }).join('');
}

async function refresh(){
  try {
    const [overview, services] = await Promise.all([
      api('/admin/overview'),
      api('/admin/services'),
    ]);
    setConn(true);
    renderOverview(overview);
    renderServices(services.services || []);
  } catch (e) {
    if (String(e && e.message) !== 'unauthorized') setConn(false, '连接失败');
  }
}

async function loadLogs(){
  if (!currentLogService) return;
  const file = $('logFileSel').value;
  try {
    const out = await api('/admin/services/' + encodeURIComponent(currentLogService) + '/logs?file=' + encodeURIComponent(file) + '&tailBytes=65536');
    $('logTitle').textContent = currentLogService + ' / ' + file + '.log' + (out.truncated ? '（已截断，显示末尾）' : '');
    const box = $('logBox');
    box.textContent = out.missing ? '（日志文件不存在）' : (out.content || '（空）');
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    $('logBox').textContent = '读取失败: ' + (e && e.message ? e.message : e);
  }
}

async function serviceAction(act, id){
  if (act === 'logs'){
    currentLogService = id;
    await loadLogs();
    return;
  }
  if (act === 'stop' && !confirm('停止服务 ' + id + '？')) return;
  try {
    await api('/admin/services/' + encodeURIComponent(id) + '/' + act, { method: 'POST' });
  } catch (e) {
    alert(act + ' 失败: ' + (e && e.message ? e.message : e));
  }
  refresh();
}

function startPolling(){
  if (refreshTimer) clearInterval(refreshTimer);
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

function connect(){
  adminToken = $('tokenInput').value.trim();
  try { localStorage.setItem(TOKEN_KEY, adminToken); } catch {}
  startPolling();
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const saved = localStorage.getItem(TOKEN_KEY) || '';
    if (saved){
      $('tokenInput').value = saved;
      adminToken = saved;
      startPolling();
    }
  } catch {}

  $('connectBtn').addEventListener('click', connect);
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  $('reloadBtn').addEventListener('click', async () => {
    try { await api('/admin/services/reload', { method: 'POST' }); } catch {}
    refresh();
  });
  $('logRefreshBtn').addEventListener('click', loadLogs);
  $('logFileSel').addEventListener('change', loadLogs);
  $('servicesBody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    serviceAction(btn.dataset.act, btn.dataset.id);
  });
});
