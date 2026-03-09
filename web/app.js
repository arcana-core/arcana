// Arcana web chat (WeChat-like UI) — streaming via SSE
const messages = document.querySelector('#messages');
const input = document.querySelector('#input');
const sendBtn = document.querySelector('#send');
let activeAssistant = null; // current assistant bubble to stream text into

const GATEWAY_V2_SESSION_KEY_LS = 'arcana.v2.sessionKey.v1';
let gatewayV2Enabled = false;
let gatewayV2Detected = false;
let gatewayV2ProbePromise = null;
let gatewayV2SessionKey = '';
let gatewayV2Ws = null;
const gatewayV2Pending = new Map();

function ensureGatewayV2SessionKey(){
  try{
    let key = '';
    try { key = localStorage.getItem(GATEWAY_V2_SESSION_KEY_LS) || ''; } catch {}
    if (!key){
      let rand = '';
      try { rand = Math.random().toString(36).slice(2, 10); } catch { rand = String(Date.now() || '0'); }
      key = 'sess-' + rand;
      try { localStorage.setItem(GATEWAY_V2_SESSION_KEY_LS, key); } catch {}
    }
    return key;
  } catch { return 'session'; }
}

// --- Quota warning helper (alert once) ---
let __arcana_storageQuotaWarned = false;
function warnStorageQuota(){
  try{
    if (__arcana_storageQuotaWarned) return;
    __arcana_storageQuotaWarned = true;
    alert('本地存储空间已满。请删除不需要的会话来释放空间。');
  } catch {}
}


// --- Session-bound, layered Logs ---
const LOG_CAP = 400; // per session per tab
const logStore = new Map(); // sessionId -> { main:[], tools:[], subagents:[] }

const MAIN_LOGS_KEY = 'arcana.logs.main.v1';
const MAIN_LOGS_SAVE_DEBOUNCE_MS = 250;
const mainLogsSaveTimers = new Map(); // sessionId -> timeout id

// Tool actions/details model (per session)
// sessionId -> {
//   actions: Map<toolCallId, action>,
//   order: string[],
//   selectedId: string|null,
//   turnStatus: Map<turnIndex, 'running'|'done'>,
//   turnUsage: Map<turnIndex, { startSessionTokens:number, lastSessionTokens:number, lastContextTokens:number }>,
// }
const toolPanels = new Map();
const lastToolTurnBySession = new Map(); // sessionId -> current turn index (0-based)

// Local persistence for tool panels
const TOOL_PANELS_KEY = 'arcana.toolPanels.v2';
const TOOL_PANELS_MAX_ACTIONS = 200;
const TOOL_PANELS_MAX_TURNS = 200;
const TOOL_PANELS_MAX_LOG_CHARS = 50000;
const TOOL_PANELS_SAVE_DEBOUNCE_MS = 250;
const toolPanelSaveTimers = new Map(); // sessionId -> timeout id

function enforceToolPanelCaps(panel){
  try{
    if (!panel || !panel.order || !panel.actions) return;
    if (Array.isArray(panel.order) && panel.order.length > TOOL_PANELS_MAX_ACTIONS){
      const excess = panel.order.length - TOOL_PANELS_MAX_ACTIONS;
      const removedIds = panel.order.splice(0, excess);
      for (const rid of removedIds){
        try { panel.actions.delete(rid); } catch {}
      }
    }
    if (panel.actions && typeof panel.actions.forEach === 'function'){
      panel.actions.forEach((a)=>{
        if (a && typeof a.log === 'string' && a.log.length > TOOL_PANELS_MAX_LOG_CHARS){
          a.log = a.log.slice(-TOOL_PANELS_MAX_LOG_CHARS);
        }
      });
    }
  } catch {}
}

function serializeToolPanel(panel){
  const out = { actions: [], order: [], selectedId: null, turnStatus: [], turnUsage: [] };
  if (!panel) return out;
  try{
    enforceToolPanelCaps(panel);
    const order = Array.isArray(panel.order) ? panel.order : [];
    out.order = order.slice();
    const actionsArr = [];
    for (const id of order){
      const a = panel.actions && panel.actions.get ? panel.actions.get(id) : null;
      if (!a) continue;
      actionsArr.push({
        id: a.id,
        toolName: a.toolName,
        category: a.category,
        status: a.status,
        argsSummary: a.argsSummary,
        argsFull: a.argsFull,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        sessionId: a.sessionId,
        turnIndex: a.turnIndex,
        log: a.log,
      });
    }
    out.actions = actionsArr;
    out.selectedId = panel.selectedId || null;

    const turnStatusMap = (panel.turnStatus && typeof panel.turnStatus.forEach === 'function') ? panel.turnStatus : null;
    const turnUsageMap = (panel.turnUsage && typeof panel.turnUsage.forEach === 'function') ? panel.turnUsage : null;
    const allTurnKeysSet = new Set();
    if (turnStatusMap){
      turnStatusMap.forEach((v, k)=>{
        const idx = Number(k);
        if (!Number.isNaN(idx)) allTurnKeysSet.add(idx);
      });
    }
    if (turnUsageMap){
      turnUsageMap.forEach((v, k)=>{
        const idx = Number(k);
        if (!Number.isNaN(idx)) allTurnKeysSet.add(idx);
      });
    }
    const allTurnKeys = Array.from(allTurnKeysSet).sort((a,b)=>a-b);
    let keepKeys = allTurnKeys;
    if (allTurnKeys.length > TOOL_PANELS_MAX_TURNS){
      keepKeys = allTurnKeys.slice(allTurnKeys.length - TOOL_PANELS_MAX_TURNS);
    }
    const keepSet = new Set(keepKeys);

    if (turnStatusMap){
      const ts = [];
      turnStatusMap.forEach((v, k)=>{
        const idx = Number(k);
        if (!Number.isNaN(idx)){
          if (!keepSet.has(idx)){
            try{ turnStatusMap.delete(k); } catch {}
            return;
          }
          if (v === 'running' || v === 'done') ts.push([idx, v]);
        }
      });
      out.turnStatus = ts;
    }

    if (turnUsageMap){
      const tu = [];
      turnUsageMap.forEach((val, k)=>{
        const idx = Number(k);
        if (Number.isNaN(idx)){
          return;
        }
        if (!keepSet.has(idx)){
          try{ turnUsageMap.delete(k); } catch {}
          return;
        }
        const v = val || {};
        const s0 = (typeof v.startSessionTokens === 'number' && v.startSessionTokens >= 0) ? v.startSessionTokens : 0;
        const s1 = (typeof v.lastSessionTokens === 'number' && v.lastSessionTokens >= 0) ? v.lastSessionTokens : s0;
        const c1 = (typeof v.lastContextTokens === 'number' && v.lastContextTokens >= 0) ? v.lastContextTokens : 0;
        tu.push([idx, { startSessionTokens: s0, lastSessionTokens: s1, lastContextTokens: c1 }]);
      });
      out.turnUsage = tu;
    }
  } catch {}
  return out;
}


function deserializeToolPanel(obj){
  const panel = { actions: new Map(), order: [], selectedId: null, turnStatus: new Map(), turnUsage: new Map() };
  try{
    if (!obj || typeof obj !== 'object') return panel;
    const arr = Array.isArray(obj.actions) ? obj.actions : [];
    for (const raw of arr){
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || raw.toolCallId || '');
      if (!id) continue;
      const turnIndex = (typeof raw.turnIndex === 'number' && !Number.isNaN(raw.turnIndex)) ? raw.turnIndex : 0;
      let log = '';
      if (typeof raw.log === 'string'){
        log = raw.log.length > TOOL_PANELS_MAX_LOG_CHARS ? raw.log.slice(-TOOL_PANELS_MAX_LOG_CHARS) : raw.log;
      }
      const action = {
        id,
        toolName: String(raw.toolName || ''),
        category: String(raw.category || toolCategory(raw.toolName)),
        status: (raw.status === 'error' || raw.status === 'done' || raw.status === 'running') ? raw.status : 'done',
        argsSummary: String(raw.argsSummary || ''),
        argsFull: typeof raw.argsFull === 'string' ? raw.argsFull : '',
        startedAt: String(raw.startedAt || ''),
        endedAt: String(raw.endedAt || ''),
        sessionId: String(raw.sessionId || ''),
        turnIndex,
        log,
      };
      panel.actions.set(id, action);
    }
    const orderArr = Array.isArray(obj.order) ? obj.order.map((x)=>String(x || '')) : [];
    for (const id of orderArr){
      if (id && panel.actions.has(id)) panel.order.push(id);
    }
    if (!panel.order.length){
      for (const id of panel.actions.keys()) panel.order.push(id);
    }
    enforceToolPanelCaps(panel);
    const sel = obj.selectedId ? String(obj.selectedId) : '';
    panel.selectedId = (sel && panel.actions.has(sel)) ? sel : (panel.order[panel.order.length - 1] || null);

    const tsArr = Array.isArray(obj.turnStatus) ? obj.turnStatus : [];
    for (const entry of tsArr){
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const idx = Number(entry[0]);
      const v = entry[1];
      if (!Number.isNaN(idx) && (v === 'running' || v === 'done')) panel.turnStatus.set(idx, v);
    }

    const tuArr = Array.isArray(obj.turnUsage) ? obj.turnUsage : [];
    for (const entry of tuArr){
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const idx = Number(entry[0]);
      if (Number.isNaN(idx)) continue;
      const rawUsage = entry[1] || {};
      const s0 = (typeof rawUsage.startSessionTokens === 'number' && rawUsage.startSessionTokens >= 0) ? rawUsage.startSessionTokens : 0;
      const s1 = (typeof rawUsage.lastSessionTokens === 'number' && rawUsage.lastSessionTokens >= 0) ? rawUsage.lastSessionTokens : s0;
      const c1 = (typeof rawUsage.lastContextTokens === 'number' && rawUsage.lastContextTokens >= 0) ? rawUsage.lastContextTokens : 0;
      panel.turnUsage.set(idx, { startSessionTokens: s0, lastSessionTokens: s1, lastContextTokens: c1 });
    }

    try{
      const allTurnKeysSet = new Set();
      panel.turnStatus.forEach((v, k)=>{
        const idx = Number(k);
        if (!Number.isNaN(idx)) allTurnKeysSet.add(idx);
      });
      panel.turnUsage.forEach((v, k)=>{
        const idx = Number(k);
        if (!Number.isNaN(idx)) allTurnKeysSet.add(idx);
      });
      const keys = Array.from(allTurnKeysSet).sort((a,b)=>a-b);
      if (keys.length > TOOL_PANELS_MAX_TURNS){
        const keepSet = new Set(keys.slice(keys.length - TOOL_PANELS_MAX_TURNS));
        panel.turnStatus.forEach((v, k)=>{
          const idx = Number(k);
          if (!Number.isNaN(idx) && !keepSet.has(idx)) panel.turnStatus.delete(k);
        });
        panel.turnUsage.forEach((v, k)=>{
          const idx = Number(k);
          if (!Number.isNaN(idx) && !keepSet.has(idx)) panel.turnUsage.delete(k);
        });
      }
    } catch {}
  } catch {}
  return panel;
}


function scheduleSaveToolPanel(sessionId){
  try{
    const sid = String(sessionId || '');
    if (!sid) return;
    try{ if (typeof localStorage === 'undefined') return; } catch { return; }
    if (!toolPanels.has(sid)) return;
    const existing = toolPanelSaveTimers.get(sid);
    if (existing){
      try { clearTimeout(existing); } catch {}
    }
    const handle = setTimeout(()=>{
      try{
        toolPanelSaveTimers.delete(sid);
        const panel = toolPanels.get(sid);
        if (!panel) return;
        const payload = serializeToolPanel(panel);
        let root = {};
        try{
          const raw = localStorage.getItem(TOOL_PANELS_KEY);
          if (raw){
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') root = parsed;
          }
        } catch {}
        if (!root || typeof root !== 'object') root = {};
        root[sid] = payload;
        try{ localStorage.setItem(TOOL_PANELS_KEY, JSON.stringify(root)); } catch(e){ try{ warnStorageQuota(); } catch{} }
      } catch {}
    }, TOOL_PANELS_SAVE_DEBOUNCE_MS);
    toolPanelSaveTimers.set(sid, handle);
  } catch {}
}

function scheduleSaveMainLogs(sessionId){
  try{
    const sid = String(sessionId || '');
    if (!sid) return;
    try{ if (typeof localStorage === 'undefined') return; } catch { return; }
    const existing = mainLogsSaveTimers.get(sid);
    if (existing){
      try { clearTimeout(existing); } catch {}
    }
    const handle = setTimeout(()=>{
      try{
        mainLogsSaveTimers.delete(sid);
        const buckets = logStore.get(sid);
        if (!buckets || !Array.isArray(buckets.main)) return;
        const arr = buckets.main;
        const lines = Array.isArray(arr) ? arr.slice(-LOG_CAP) : [];
        let root = {};
        try{
          const raw = localStorage.getItem(MAIN_LOGS_KEY);
          if (raw){
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') root = parsed;
          }
        } catch {}
        if (!root || typeof root !== 'object') root = {};
        root[sid] = lines;
        try{ localStorage.setItem(MAIN_LOGS_KEY, JSON.stringify(root)); } catch(e){ try{ warnStorageQuota(); } catch{} }
      } catch {}
    }, MAIN_LOGS_SAVE_DEBOUNCE_MS);
    mainLogsSaveTimers.set(sid, handle);
  } catch {}
}
function loadMainLogsFromStorage(){
  try{
    try{ if (typeof localStorage === 'undefined') return; } catch { return; }
    let raw = null;
    try{ raw = localStorage.getItem(MAIN_LOGS_KEY); } catch { raw = null; }
    if (!raw) return;
    let obj;
    try{ obj = JSON.parse(raw); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') return;
    const entries = Object.entries(obj);
    for (const [sidRaw, lines] of entries){
      const sid = String(sidRaw || '');
      if (!sid) continue;
      const arr = Array.isArray(lines) ? lines.map((s)=>String(s||'')) : [];
      if (!arr.length) continue;
      const buckets = ensureBuckets(sid);
      const mainArr = buckets.main || (buckets.main = []);
      for (const line of arr){
        mainArr.push(line);
        if (mainArr.length > LOG_CAP) mainArr.splice(0, mainArr.length - LOG_CAP);
      }
    }
  } catch {}
}

function loadToolPanelsFromStorage(){
  try{
    try{ if (typeof localStorage === 'undefined') return; } catch { return; }
    let raw = null;
    try{ raw = localStorage.getItem(TOOL_PANELS_KEY); } catch { raw = null; }
    if (!raw) return;
    let obj;
    try{ obj = JSON.parse(raw); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') return;
    const entries = Object.entries(obj);
    for (const [sidRaw, stored] of entries){
      const sid = String(sidRaw || '');
      if (!sid) continue;
      try{
        const panel = deserializeToolPanel(stored || {});
        toolPanels.set(sid, panel);
        let maxTurn = -1;
        if (panel.turnStatus && typeof panel.turnStatus.forEach === 'function'){
          panel.turnStatus.forEach((v, k)=>{
            if (v !== 'running' && v !== 'done') return;
            const idx = Number(k);
            if (!Number.isNaN(idx) && idx > maxTurn) maxTurn = idx;
          });
        }
        if (panel.actions && typeof panel.actions.forEach === 'function'){
          panel.actions.forEach((a)=>{
            if (!a) return;
            const idx = (typeof a.turnIndex === 'number' && !Number.isNaN(a.turnIndex)) ? a.turnIndex : 0;
            if (idx > maxTurn) maxTurn = idx;
          });
        }
        if (maxTurn >= 0){
          lastToolTurnBySession.set(sid, maxTurn);
        }
      } catch {}
    }
  } catch {}
}

// Explicit tool name -> category mapping for the tools panel
const TOOL_CATEGORY_BY_NAME = {
  bash: 'cli',
  shell: 'cli',
  terminal: 'cli',
  cli: 'cli',
  command: 'cli',
  codex: 'code',
  claude_code: 'code',
  web_render: 'web',
  web_extract: 'web',
  web_search: 'web',
};

try{ loadToolPanelsFromStorage(); } catch {}
try{ loadMainLogsFromStorage(); } catch {}
const DEFAULT_AGENT_ID = 'default';
let activeLogTab = (localStorage.getItem('arcana.logs.activeTab') || 'main');
// Cache last logged workspace per session AND per label to avoid duplicates.
// Structure: Map<sessionId, Map<label, workspacePath>> so that
//   - workspace: and workspaceRoot: can both appear once even if paths match.
const lastWorkspaceBySession = new Map(); // sessionId -> Map<label, lastLoggedWorkspace>

function getCurrentSessionId(){ try { return window.__arcana_currentSessionId || '' } catch { return '' } }
function ensureBuckets(sessionId){
  const sid = String(sessionId || '');
  if (!logStore.has(sid)) logStore.set(sid, { main: [], tools: [], subagents: [] });
  return logStore.get(sid);
}
function sectionSelectorFor(tab){ return tab==='tools' ? '#logs-tools' : (tab==='details' ? '#logs-details' : '#logs-main-sys'); }
function renderLogsFor(sessionId, tab){
  const el = document.querySelector(sectionSelectorFor(tab)); if (!el) return;
  if (tab === 'tools'){
    renderToolsPanel(sessionId);
    return;
  }
  if (tab === 'details'){
    renderToolDetails(sessionId);
    return;
  }
  const buckets = ensureBuckets(sessionId);
  const lines = (buckets && buckets[tab]) ? buckets[tab] : [];
  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const s of lines){ const d=document.createElement('div'); d.textContent=String(s||''); frag.appendChild(d); }
  el.appendChild(frag); el.scrollTop = el.scrollHeight;
}
function addLogLine(sessionId, tab, text){
  const buckets = ensureBuckets(sessionId);
  const arr = buckets[tab] || (buckets[tab] = []);
  arr.push(String(text||''));
  if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
  if (tab === 'main'){ try{ scheduleSaveMainLogs(sessionId); } catch {} }
  if (sessionId === getCurrentSessionId() && tab === activeLogTab && tab !== 'tools'){
    const el = document.querySelector(sectionSelectorFor(tab));
    if (el){ const d = document.createElement('div'); d.textContent = String(text||''); el.appendChild(d); el.scrollTop = el.scrollHeight; }
  }
}
function setActiveLogTab(tab){
  activeLogTab = (tab==='tools' || tab==='details') ? tab : 'main';
  try{ localStorage.setItem('arcana.logs.activeTab', activeLogTab); } catch {}
  try{
    const bar = document.getElementById('tabs-bar');
    if (bar){
      const btns = Array.from(bar.querySelectorAll('.tab'));
      for (const b of btns){ b.classList.toggle('active', (b && b.dataset && b.dataset.tab) === activeLogTab); }
    }
    // toggle sections visibility (preserve CSS-driven display types)
    const mainEl = document.querySelector('#logs-main'); if (mainEl) mainEl.style.display = (activeLogTab==='main') ? '' : 'none';
    const toolsEl = document.querySelector('#logs-tools'); if (toolsEl) toolsEl.style.display = (activeLogTab==='tools') ? '' : 'none';
    const detailsEl = document.querySelector('#logs-details'); if (detailsEl) detailsEl.style.display = (activeLogTab==='details') ? '' : 'none';
  } catch {}
  renderLogsFor(getCurrentSessionId(), activeLogTab);
}
// Wire tab clicks
try{
  const bar = document.getElementById('tabs-bar');
  if (bar){
    bar.addEventListener('click', (ev)=>{
      const t = ev.target; if (!t || !t.classList || !t.classList.contains('tab')) return;
      const tab = (t.dataset && t.dataset.tab) || 'main'; setActiveLogTab(tab);
    });
  }
} catch {}

function logMain(sessionId, text){ addLogLine(sessionId, "main", text); }
function logTools(sessionId, text){ addLogLine(sessionId, "tools", text); }
function logSubagents(sessionId, text){ addLogLine(sessionId, "subagents", text); }

function getToolPanel(sessionId){
  const sid = String(sessionId || '');
  if (!sid) return null;
  if (!toolPanels.has(sid)){
    toolPanels.set(sid, { actions: new Map(), order: [], selectedId: null, turnStatus: new Map(), turnUsage: new Map() });
  }
  return toolPanels.get(sid);
}


function markTurnDone(sessionId){
  try{
    const sid = String(sessionId || '');
    if (!sid) return;
    const panel = getToolPanel(sid);
    if (!panel || !panel.turnStatus) return;
    let turnIdx = lastToolTurnBySession.get(sid);
    if (typeof turnIdx !== 'number' || Number.isNaN(turnIdx)){
      let maxKey = null;
      for (const k of panel.turnStatus.keys()){
        if (typeof k !== 'number' || Number.isNaN(k)) continue;
        if (maxKey === null || k > maxKey) maxKey = k;
      }
      if (maxKey === null) return;
      turnIdx = maxKey;
    }
    panel.turnStatus.set(turnIdx, 'done');
    try{ scheduleSaveToolPanel(sid); } catch {}
  } catch {}
}

function toolCategory(toolName){
  const name = String(toolName || '').toLowerCase();
  if (!name) return 'other';
  const direct = TOOL_CATEGORY_BY_NAME[name];
  if (direct) return direct;
  if (name.includes('http') || name.includes('fetch') || name.includes('web') || name.includes('browser')) return 'web';
  if (name.includes('shell') || name.includes('exec') || name.includes('command') || name.includes('cli') || name.includes('bash')) return 'cli';
  if (name.includes('code') || name.includes('file') || name.includes('git') || name.includes('repo') || name.includes('codex') || name.includes('claude')) return 'code';
  if (name.includes('slack') || name.includes('github') || name.includes('notion') || name.includes('jira') || name.includes('calendar')) return 'integrations';
  return 'other';
}

function formatCompactNumber(value){
  try{
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 10000) return (Math.round(n / 100) / 10) + 'k';
    if (n < 1000000) return String(Math.round(n / 1000)) + 'k';
    if (n < 10000000) return (Math.round(n / 100000) / 10) + 'm';
    return String(Math.round(n / 1000000)) + 'm';
  } catch { return '0'; }
}

function summarizeArgs(args){
  if (!args) return '';
  try{
    if (typeof args === 'string') return args.slice(0, 120);
    const keys = Object.keys(args);
    if (!keys.length) return '';
    const first = keys.slice(0, 3).map((k)=>{
      const v = args[k];
      if (v == null) return k + '=null';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return k + '=' + (s.length > 40 ? (s.slice(0, 37) + '...') : s);
    }).join(', ');
    return first;
  } catch { return ''; }
}

function formatToolUpdateInfo(raw){
  let info = '';
  try{
    if (typeof raw === 'string'){
      info = raw;
    } else if (raw && typeof raw === 'object' && typeof raw.stream === 'string' && Object.prototype.hasOwnProperty.call(raw, 'chunk')){
      const stream = raw.stream || '';
      const chunkVal = raw.chunk;
      let chunkStr = '';
      if (typeof chunkVal === 'string') chunkStr = chunkVal;
      else if (chunkVal != null) chunkStr = String(chunkVal);
      const trimmed = chunkStr.replace(/\s+$/, '');
      info = '[' + stream + '] ' + trimmed;
    } else if (raw != null){
      try { info = JSON.stringify(raw) }
      catch {
        try {
          const seen = new Set();
          info = JSON.stringify(raw, (k,v)=>{ if (typeof v === 'object' && v){ if (seen.has(v)) return '[Circular]'; seen.add(v); } return v; });
        } catch { info = String(raw) }
      }
    }
  } catch { info = ''; }
  return info;
}

function upsertToolAction(data){
  try{
    const sid = String(data.sessionId || getCurrentSessionId() || '');
    if (!sid) return;
    const panel = getToolPanel(sid); if (!panel) return;
    const id = String(data.toolCallId || data.id || data.toolName || (panel.order.length + 1));
    const now = new Date();
    const ts = now.toLocaleTimeString();
    const storedTurn = lastToolTurnBySession.get(sid);
    const turnIdx = (typeof storedTurn === 'number' && !Number.isNaN(storedTurn)) ? storedTurn : 0;
    const rawArgs = (typeof data.args !== 'undefined') ? data.args : (typeof data.input !== 'undefined') ? data.input : data.params;
    let action = panel.actions.get(id);
    if (!action){
      action = {
        id,
        toolName: String(data.toolName || ''),
        category: toolCategory(data.toolName),
        status: 'running',
        argsSummary: summarizeArgs(rawArgs),
        argsFull: '',
        startedAt: ts,
        endedAt: '',
        sessionId: sid,
        turnIndex: turnIdx,
        log: '',
      };
      panel.actions.set(id, action);
      panel.order.push(id);
      if (!panel.selectedId) panel.selectedId = id;
    }
    if (!action.argsFull && rawArgs != null){
      let full = '';
      if (typeof rawArgs === 'string'){ full = rawArgs; }
      else {
        try { full = JSON.stringify(rawArgs, null, 2); } catch { full = String(rawArgs); }
      }
      if (full && full.length > 20000){ full = full.slice(-20000); }
      action.argsFull = full;
    }
    if (data.type === 'tool_execution_start'){
      action.status = 'running';
      if (!action.startedAt) action.startedAt = ts;
      if (!action.argsSummary) action.argsSummary = summarizeArgs(rawArgs);
      if (!action.argsFull && rawArgs != null){
        let full = '';
        if (typeof rawArgs === 'string'){ full = rawArgs; }
        else {
          try { full = JSON.stringify(rawArgs, null, 2); } catch { full = String(rawArgs); }
        }
        if (full && full.length > 20000){ full = full.slice(-20000); }
        action.argsFull = full;
      }
    }
    if (data.type === 'tool_execution_end'){
      action.status = data.isError || data.error ? 'error' : 'done';
      action.endedAt = ts;
    }
    if (data.type === 'tool_execution_update'){
      const raw = (typeof data.partialResult !== 'undefined') ? data.partialResult : data.update;
      const info = formatToolUpdateInfo(raw);
      if (toolStreamEnabled && info){
        action.log = action.log ? (action.log + '\n' + info) : info;
      }
    }
    if (typeof action.log === 'string' && action.log.length > TOOL_PANELS_MAX_LOG_CHARS){
      action.log = action.log.slice(-TOOL_PANELS_MAX_LOG_CHARS);
    }
    try{ scheduleSaveToolPanel(sid); } catch {}
    if (sid === getCurrentSessionId()){
      if (activeLogTab === 'tools'){
        renderToolsPanel(sid);
      } else if (activeLogTab === 'details'){
        renderToolDetails(sid);
      }
    }
  } catch {}
}


function attachSubagentOutputToToolAction(sessionId, info){
  try{
    const sid = String(sessionId || getCurrentSessionId() || '');
    if (!sid) return;
    const panel = getToolPanel(sid);
    if (!panel || !panel.actions || typeof panel.actions.get !== 'function') return;

    const subId = info && (info.subagentId || info.id) ? String(info.subagentId || info.id || '') : '';
    const agentRaw = info && (info.agent || info.toolName) ? String(info.agent || info.toolName || '') : '';
    const agentLower = agentRaw.toLowerCase();

    let action = null;
    if (subId){
      try{ action = panel.actions.get(subId) || null; } catch { action = null; }
    }

    if (!action && agentLower && Array.isArray(panel.order)){
      for (let i = panel.order.length - 1; i >= 0; i--){
        const id = panel.order[i];
        if (!id) continue;
        let cand = null;
        try{ cand = panel.actions.get(id) || null; } catch { cand = null; }
        if (!cand || cand.status !== 'running') continue;
        const tname = (cand.toolName ? String(cand.toolName) : '').toLowerCase();
        if (tname && tname === agentLower){
          action = cand;
          break;
        }
      }
    }

    if (!action) return;

    const kind = info && info.kind ? String(info.kind) : '';
    let line = '';
    if (kind === 'start'){
      const ag = agentRaw || '?';
      const id = subId || '';
      line = '[subagent] start: ' + ag + ' id=' + id;
    } else if (kind === 'stream'){
      const stream = info && info.stream ? String(info.stream) : '';
      const rawChunk = (info && typeof info.chunk !== 'undefined') ? info.chunk : '';
      const chunkStr = typeof rawChunk === 'string' ? rawChunk : String(rawChunk || '');
      const short = chunkStr.length > 200 ? (chunkStr.slice(0, 200) + '...') : chunkStr;
      const body = short.replace(/\s+/g, ' ').trim();
      line = '[subagent ' + stream + '] ' + body;
    } else if (kind === 'error'){
      const ag = agentRaw || '?';
      const code = (info && typeof info.code !== 'undefined') ? info.code : (info && typeof info.errorCode !== 'undefined') ? info.errorCode : '';
      line = '[subagent] error: ' + ag + ' code=' + code;
    } else if (kind === 'end'){
      const ag = agentRaw || '?';
      const code = (info && typeof info.code !== 'undefined') ? info.code : '';
      let okVal = '';
      if (info && typeof info.ok !== 'undefined') okVal = String(info.ok);
      else if (info && typeof info.success !== 'undefined') okVal = String(info.success);
      line = '[subagent] end: ' + ag + ' code=' + code + ' ok=' + okVal;
    } else {
      const ag = agentRaw || '?';
      const parts = [];
      if (kind) parts.push(kind);
      if (info && info.stream) parts.push(String(info.stream));
      const prefix = parts.length ? ('[subagent ' + parts.join(' ') + ']') : '[subagent]';
      const rawChunk = (info && typeof info.chunk !== 'undefined') ? info.chunk : '';
      const chunkStr = typeof rawChunk === 'string' ? rawChunk : String(rawChunk || '');
      const short = chunkStr.length > 200 ? (chunkStr.slice(0, 200) + '...') : chunkStr;
      const body = short.replace(/\s+/g, ' ').trim();
      line = prefix + (body ? (' ' + body) : (' ' + ag));
    }

    if (!line) return;
    const existing = (action && typeof action.log === 'string') ? action.log : '';
    action.log = existing ? (existing + '\n' + line) : line;

    try{ scheduleSaveToolPanel(sid); } catch {}
    if (sid === getCurrentSessionId()){
      if (activeLogTab === 'tools'){
        renderToolsPanel(sid);
      } else if (activeLogTab === 'details'){
        renderToolDetails(sid);
      }
    }
  } catch {}
}



function renderToolsPanel(sessionId){
  const sid = String(sessionId || getCurrentSessionId() || '');
  const host = document.querySelector('#logs-tools'); if (!host) return;
  const panel = getToolPanel(sid);
  const listEl = document.getElementById('tools-actions-list');
  if (!panel || !listEl){
    return;
  }
  listEl.innerHTML = '';
  const byTurn = new Map(); // turnIndex -> action[]
  for (const id of panel.order){
    const a = panel.actions.get(id); if (!a) continue;
    const key = typeof a.turnIndex === 'number' ? a.turnIndex : 0;
    if (!byTurn.has(key)) byTurn.set(key, []);
    byTurn.get(key).push(a);
  }
  const frag = document.createDocumentFragment();
  const allTurnKeysSet = new Set();
  const tsMap = panel.turnStatus || new Map();
  const usageMap = panel.turnUsage || new Map();
  for (const k of byTurn.keys()) allTurnKeysSet.add(k);
  for (const k of tsMap.keys()) allTurnKeysSet.add(k);
  for (const k of usageMap.keys()) allTurnKeysSet.add(k);
  const sortedTurnKeys = Array.from(allTurnKeysSet).map((k)=>Number(k)).filter((n)=>!Number.isNaN(n)).sort((a,b)=>a-b);
  for (const turnKey of sortedTurnKeys){
    const group = document.createElement('div');
    group.className = 'tools-turn-group';
    const label = document.createElement('div');
    label.className = 'tools-turn-label';
    const labelText = document.createElement('div');
    labelText.className = 'tools-turn-label-text';
    labelText.textContent = 'Turn ' + (turnKey + 1);
    const status = tsMap.get(turnKey);
    if (status === 'running'){
      const spinner = document.createElement('div');
      spinner.className = 'tools-turn-spinner';
      label.appendChild(spinner);
    } else if (status === 'done'){
      const done = document.createElement('div');
      done.className = 'tools-turn-done';
      done.textContent = 'DONE';
      label.appendChild(done);
    }

    const usage = (usageMap && typeof usageMap.get === 'function') ? usageMap.get(turnKey) : null;
    let startSess = 0;
    let lastSess = 0;
    let lastCtx = 0;
    if (usage && typeof usage === 'object'){
      if (typeof usage.startSessionTokens === 'number' && usage.startSessionTokens >= 0) startSess = usage.startSessionTokens;
      if (typeof usage.lastSessionTokens === 'number' && usage.lastSessionTokens >= 0) lastSess = usage.lastSessionTokens;
      if (typeof usage.lastContextTokens === 'number' && usage.lastContextTokens >= 0) lastCtx = usage.lastContextTokens;
    }
    if (lastSess < startSess) lastSess = startSess;
    const delta = Math.max(0, lastSess - startSess);

    const badges = document.createElement('div');
    badges.className = 'tools-turn-badges';

    const tokBadge = document.createElement('div');
    tokBadge.className = 'tools-turn-badge tools-turn-badge-tok';
    tokBadge.textContent = 'TOK ' + formatCompactNumber(delta);

    const ctxBadge = document.createElement('div');
    ctxBadge.className = 'tools-turn-badge tools-turn-badge-ctx';
    ctxBadge.textContent = 'CTX ' + formatCompactNumber(lastCtx);

    badges.appendChild(tokBadge);
    badges.appendChild(ctxBadge);

    label.appendChild(labelText);
    label.appendChild(badges);
    group.appendChild(label);
    const items = byTurn.get(turnKey) || [];
    for (const a of items){
      const card = document.createElement('div');
      card.className = 'tools-card' + (panel.selectedId === a.id ? ' selected' : '');
      card.dataset.id = a.id;
      const header = document.createElement('div');
      header.className = 'tools-card-header';
      const pill = document.createElement('div');
      const cat = a.category || 'other';
      const pillCls = cat === 'web' ? 'tools-pill tools-pill-web' : cat === 'cli' ? 'tools-pill tools-pill-cli' : cat === 'code' ? 'tools-pill tools-pill-code' : cat === 'integrations' ? 'tools-pill tools-pill-int' : 'tools-pill tools-pill-other';
      pill.className = pillCls;
      pill.textContent = (cat === 'cli' ? 'CLI' : cat === 'web' ? 'WEB' : cat === 'code' ? 'CODE' : cat === 'integrations' ? 'INT' : 'TOOL');
      const nameEl = document.createElement('div');
      nameEl.className = 'tools-card-name';
      nameEl.textContent = a.toolName || '(unnamed)';
      const statusEl = document.createElement('div');
      statusEl.className = 'tools-card-status';
      statusEl.textContent = a.status === 'running' ? 'Running' : a.status === 'error' ? 'Error' : 'Done';
      header.appendChild(pill);
      header.appendChild(nameEl);
      header.appendChild(statusEl);
      const argsEl = document.createElement('div');
      argsEl.className = 'tools-card-args';
      argsEl.textContent = a.argsSummary || '';
      const metaRow = document.createElement('div');
      metaRow.className = 'tools-card-meta';
      const timeEl = document.createElement('div');
      timeEl.className = 'tools-card-time';
      timeEl.textContent = a.startedAt + (a.endedAt ? ' · ' + a.endedAt : '');
      const sidEl = document.createElement('div');
      sidEl.className = 'tools-card-session';
      sidEl.textContent = sid ? ('Session ' + sid.slice(0, 6)) : '';
      metaRow.appendChild(timeEl);
      metaRow.appendChild(sidEl);
      card.appendChild(header);
      if (a.argsSummary) card.appendChild(argsEl);
      card.appendChild(metaRow);
      card.addEventListener('click', ()=>{
        panel.selectedId = a.id;
        setActiveLogTab('details');
        renderToolDetails(sid);
      });
      group.appendChild(card);
    }
    frag.appendChild(group);
  }
  listEl.appendChild(frag);
}


function renderToolDetails(sessionId){
  const sid = String(sessionId || getCurrentSessionId() || '');
  const panel = getToolPanel(sid);
	  const titleEl = document.getElementById('tools-details-title');
	  const metaEl = document.getElementById('tools-details-meta');
	  const bodyEl = document.getElementById('tools-details-body');
    const argsEl = document.getElementById('tools-details-args');
    const argsWrap = document.querySelector('.tools-details-args-wrap');
	  if (!panel || !titleEl || !metaEl || !bodyEl){
	    return;
	  }
	  const atBottom = (bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight) <= 16;
	  const prevScrollTop = bodyEl.scrollTop;
	  const selected = panel.selectedId ? panel.actions.get(panel.selectedId) : null;
	  if (!selected){
	    titleEl.textContent = 'No action selected';
	    metaEl.textContent = '';
      if (argsEl) argsEl.textContent = '';
      if (argsWrap) argsWrap.removeAttribute('open');
	    bodyEl.textContent = 'When tools run, you can fetch their output on demand.';
	    if (atBottom){ bodyEl.scrollTop = bodyEl.scrollHeight; } else { bodyEl.scrollTop = prevScrollTop; }
	    return;
	  }
	  titleEl.textContent = selected.toolName || 'Tool action';
  const parts = [];
  if (selected.status === 'running') parts.push('Running');
  if (selected.status === 'done') parts.push('Done');
  if (selected.status === 'error') parts.push('Error');
  if (selected.startedAt) parts.push('Started ' + selected.startedAt);
	  if (selected.endedAt) parts.push('Ended ' + selected.endedAt);
	  metaEl.textContent = parts.join(' · ');
    const argsText = (selected.argsFull && typeof selected.argsFull === 'string') ? selected.argsFull : '';
    if (argsEl) argsEl.textContent = argsText;
    if (argsWrap){
      if (argsText){ argsWrap.setAttribute('open', ''); }
      else { argsWrap.removeAttribute('open'); }
    }
	  bodyEl.textContent = selected.log || '';
	  if (atBottom){ bodyEl.scrollTop = bodyEl.scrollHeight; } else { bodyEl.scrollTop = prevScrollTop; }
}

// Helper: only log workspace for a session when it changes
function logWorkspaceIfChanged(sessionId, label, workspace){
  try{
    const sid = String(sessionId || "");
    const ws = String(workspace || "");
    const lbl = String(label || "");
    if (!sid || !ws || !lbl) return;
    // Ensure per-session map exists
    let perLabel = lastWorkspaceBySession.get(sid);
    if (!perLabel){ perLabel = new Map(); lastWorkspaceBySession.set(sid, perLabel); }
    const prev = perLabel.get(lbl);
    if (prev === ws) return; // unchanged for this label; skip duplicate
    perLabel.set(lbl, ws);
    logMain(sid, label + " " + ws);
  } catch {}
}

// Initialize tabs display once
try{ setActiveLogTab(activeLogTab); } catch {}

function avatarPath(role){ return role === 'user' ? 'avatar-user.svg' : 'avatar-bot.svg'; }
// Workspace picker (desktop integration if available) — top-level so both
// new-session button and ensureSession() can access it.
async function pickWorkspace(){
  const last = localStorage.getItem('arcana.lastWorkspace') || '';
  const defaultPath = last || (window.process && window.process.cwd ? window.process.cwd() : '');
  // Desktop (Electron): use native folder chooser via preload API
  if (window.arcana && typeof window.arcana.pickWorkspace === 'function'){
    try{
      const res = await window.arcana.pickWorkspace({ defaultPath });
      const chosen = (res && Array.isArray(res.filePaths) && res.filePaths[0]) ? String(res.filePaths[0])
        : (Array.isArray(res) && res[0]) ? String(res[0]) : '';
      if (chosen){ try { localStorage.setItem('arcana.lastWorkspace', chosen) } catch {} ; return chosen; }
      return '';
    }catch{ return '' }
  }
  // Browser-only fallback: minimal modal (no true directory access in browsers)
  return await new Promise((resolve)=>{
    try{
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:10000;';
      const dialog = document.createElement('div');
      dialog.style.cssText = 'width:520px;max-width:90vw;background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.2);padding:16px;';
      dialog.innerHTML = '<div style="font-weight:600;margin-bottom:8px">选择工作区</div>' +
        '<div style="font-size:13px;color:#666;margin-bottom:8px">建议使用桌面应用获取系统级文件夹选择器。当前在浏览器环境下，仅支持手动输入工作区绝对路径。</div>' +
        '<input id="ws-input" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ddd;border-radius:6px" placeholder="/绝对/路径" />' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
        '  <button id="ws-cancel">取消</button>' +
        '  <button id="ws-ok">确定</button>' +
        '</div>';
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      const input = dialog.querySelector('#ws-input'); if (input) input.value = defaultPath || '/';
      dialog.querySelector('#ws-cancel').addEventListener('click', ()=>{ cleanup(); resolve(''); });
      dialog.querySelector('#ws-ok').addEventListener('click', ()=>{ const v = String((input && input.value) || '').trim(); cleanup(); resolve(v); });
      function cleanup(){ try { document.body.removeChild(overlay); } catch{} }
    }catch{ resolve('') }
  });
}

function appendMessage(role, text = ''){
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'me' : 'other');
  const avatar = document.createElement('img');
  avatar.className = 'avatar';
  avatar.alt = role;
  avatar.src = avatarPath(role);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

// Backward‑compatible helper used by non‑SSE UI bits (config/doctor/etc).
function appendLog(txt){ addLogLine(getCurrentSessionId() || '', 'main', String(txt||'')); }

function setTyping(bubble, on){
  if (!bubble) return;
  if (on){
    bubble.classList.add('typing');
    bubble.innerHTML = '正在思考 <span class=dots><span class=dot></span><span class=dot></span><span class=dot></span></span>';
  } else {
    bubble.classList.remove('typing');
  }
}

function autoResize(){
  input.style.height = 'auto';
  input.style.height = Math.min(120, Math.max(36, input.scrollHeight)) + 'px';
}
input.addEventListener('input', autoResize);

// Toggle advanced panel (more) + lazy-load config
try {
  let loaded = false;
  document.querySelector('.composer .icon').addEventListener('click', async ()=>{
    const p = document.querySelector('#more-panel'); if (!p) return;
    const show = (!p.style.display || p.style.display === 'none');
    p.style.display = show ? 'block' : 'none';
    if (show){
      if (!loaded){
        loaded = true;
        try { await loadConfigUI(); } catch(e){}
      }
      try { await loadTimerSettingsUI(); } catch(e){}
    }
  });
} catch {}

function qs(id){ return document.getElementById(id); }

async function loadTimerSettingsUI(){
  try{
    const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const url = '/api/timer-settings?agentId=' + encodeURIComponent(aid);
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const comp = j && j.settings && j.settings.compaction ? j.settings.compaction : (j && j.settings) ? j.settings : {};
    const t = (comp && typeof comp.thresholdTokens !== 'undefined') ? comp.thresholdTokens : '';
    let fb = (comp && typeof comp.fallbackBytes !== 'undefined') ? comp.fallbackBytes : '';
    const fcLegacy = (comp && typeof comp.fallbackChars !== 'undefined') ? comp.fallbackChars : '';
    if ((fb === '' || fb == null) && (fcLegacy || fcLegacy === 0)) fb = fcLegacy;
    if (qs('timer-threshold-tokens')) qs('timer-threshold-tokens').value = (t || t === 0) ? String(t) : '';
    if (qs('timer-fallback-bytes')) qs('timer-fallback-bytes').value = (fb || fb === 0) ? String(fb) : '';
  }catch(e){ appendLog('[cron] 读取定时器设置失败'); }
}

async function loadConfigUI(){
  try{
    // Global default config
    let globalCfg = {};
    try{
      const r = await fetch('/api/config');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      globalCfg = await r.json();
    }catch(e){ appendLog('[config] 读取全局配置失败'); globalCfg = {}; }

    if (qs('cfg-provider-global')) qs('cfg-provider-global').value = globalCfg.provider || '';
    if (qs('cfg-model-global')) qs('cfg-model-global').value = globalCfg.model || '';
    if (qs('cfg-base-url-global')) qs('cfg-base-url-global').value = globalCfg.base_url || '';
    if (qs('cfg-key-set-global')) qs('cfg-key-set-global').textContent = globalCfg.has_key ? '已设置' : '未设置';

    // Current agent override config
    try{
      const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
      const url = '/api/agent-config?agentId=' + encodeURIComponent(aid);
      const r2 = await fetch(url);
      if (!r2.ok) throw new Error('HTTP ' + r2.status);
      const agentCfg = await r2.json();
      if (qs('cfg-provider-agent')) qs('cfg-provider-agent').value = agentCfg.provider || '';
      if (qs('cfg-model-agent')) qs('cfg-model-agent').value = agentCfg.model || '';
      if (qs('cfg-base-url-agent')) qs('cfg-base-url-agent').value = agentCfg.base_url || '';
      if (qs('cfg-key-set-agent')) qs('cfg-key-set-agent').textContent = agentCfg.has_key ? '已设置' : '未设置';
    }catch(e){
      if (qs('cfg-provider-agent')) qs('cfg-provider-agent').value = '';
      if (qs('cfg-model-agent')) qs('cfg-model-agent').value = '';
      if (qs('cfg-base-url-agent')) qs('cfg-base-url-agent').value = '';
      if (qs('cfg-key-set-agent')) qs('cfg-key-set-agent').textContent = '未设置';
      appendLog('[config] 读取 Agent 配置失败');
    }
  }catch(e){ appendLog('[config] 读取失败'); }
}

async function saveGlobalConfigUI(){
  try{
    const payload = {
      provider: (qs('cfg-provider-global')||{}).value || '',
      model: (qs('cfg-model-global')||{}).value || '',
      base_url: (qs('cfg-base-url-global')||{}).value || '',
    };
    const key = (qs('cfg-key-global')||{}).value || '';
    if (key) payload.key = key;
    const r = await fetch('/api/config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[config] 保存全局配置失败'); return; }
    if (qs('cfg-key-global')) qs('cfg-key-global').value = '';
    await loadConfigUI();
    appendLog('[config] 已保存全局配置');
  }catch(e){ appendLog('[config] 保存全局配置失败'); }
}

async function saveAgentConfigUI(){
  try{
    const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const payload = {
      agentId: aid,
      provider: (qs('cfg-provider-agent')||{}).value || '',
      model: (qs('cfg-model-agent')||{}).value || '',
      base_url: (qs('cfg-base-url-agent')||{}).value || '',
    };
    const key = (qs('cfg-key-agent')||{}).value || '';
    if (key) payload.key = key;
    const r = await fetch('/api/agent-config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[config] 保存 Agent 配置失败'); return; }
    if (qs('cfg-key-agent')) qs('cfg-key-agent').value = '';
    await loadConfigUI();
    appendLog('[config] 已保存 Agent 配置');
  }catch(e){ appendLog('[config] 保存 Agent 配置失败'); }
}

async function clearAgentConfigUI(){
  try{
    const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const body = { agentId: aid, clear: true };
    const r = await fetch('/api/agent-config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[config] 清除 Agent 配置失败'); return; }
    if (qs('cfg-key-agent')) qs('cfg-key-agent').value = '';
    await loadConfigUI();
    appendLog('[config] 已清除 Agent 配置');
  }catch(e){ appendLog('[config] 清除 Agent 配置失败'); }
}

async function saveTimerSettingsUI(){
  try{
    const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const tRaw = (qs('timer-threshold-tokens')||{}).value || '';
    const fRaw = (qs('timer-fallback-bytes')||{}).value || '';
    const tNum = Number(tRaw);
    const fNum = Number(fRaw);
    const comp = {};
    if (Number.isFinite(tNum) && tNum > 0) comp.thresholdTokens = tNum;
    if (Number.isFinite(fNum) && fNum > 0) comp.fallbackBytes = fNum;
    const body = { agentId: aid, settings: { compaction: comp } };
    const r = await fetch('/api/timer-settings', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[cron] 保存定时器设置失败'); return; }
    appendLog('[cron] 已保存定时器设置');
  }catch(e){ appendLog('[cron] 保存定时器设置失败'); }
}

async function runDoctorUI(){
  try{
    appendLog('[doctor] 正在运行...');
    const sid = getCurrentSessionId();
    const url = sid ? ('/api/doctor?sessionId=' + encodeURIComponent(sid)) : '/api/doctor';
    const r = await fetch(url);
    const j = await r.json();
    appendLog('[doctor] 结果: ok ' + (j.summary?.ok||0) + ' warn ' + (j.summary?.warn||0) + ' fail ' + (j.summary?.fail||0));
    ;(j.checks||[]).forEach(c=>{ appendLog(' - [' + c.status + '] ' + c.title + (c.details && c.details.model ? (': '+c.details.model) : '')); });
  }catch(e){ appendLog('[doctor] 失败'); }
}

async function createSupportBundleUI(){
  try{
    appendLog('[support] 创建中...');
    const sid = getCurrentSessionId();
    const r = await fetch('/api/support-bundle', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ sessionId: sid }) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[support] 失败'); return; }
    appendLog('[support] 完成: ' + (j.tarPath || j.dir));
    const linkWrap = qs('support-link');
    if (linkWrap){
      linkWrap.innerHTML = '';
      if (j.tarPath){
        const a = document.createElement('a');
        a.href = '/api/local-file?path=' + encodeURIComponent(j.tarPath) + (sid ? ('&sessionId=' + encodeURIComponent(sid)) : '');
        a.textContent = '下载支持包 (tar.gz)';
        a.target = '_blank';
        linkWrap.appendChild(a);
      }
    }
  }catch(e){ appendLog('[support] 失败'); }
}

// Wire config buttons
try { qs('cfg-save-global').addEventListener('click', ()=>{ saveGlobalConfigUI().catch(()=>{}) }) } catch {}
try { qs('cfg-save-agent').addEventListener('click', ()=>{ saveAgentConfigUI().catch(()=>{}) }) } catch {}
try { qs('cfg-clear-agent').addEventListener('click', ()=>{ clearAgentConfigUI().catch(()=>{}) }) } catch {}
try { qs('cfg-run-doctor').addEventListener('click', ()=>{ runDoctorUI().catch(()=>{}) }) } catch {}
try { qs('cfg-support-bundle').addEventListener('click', ()=>{ createSupportBundleUI().catch(()=>{}) }) } catch {}
try { qs('timer-save').addEventListener('click', ()=>{ saveTimerSettingsUI().catch(()=>{}) }) } catch {}

// --- Sessions state ---
const CKEY = 'arcana.currentSessionId';
const AKEY = 'arcana.currentAgentId';
const LSK_LAST_SEEN = 'arcana.sessions.lastSeen';
const LSK_BG_SESS_COLLAPSED = 'arcana.sessions.bgCollapsed.v1';
let currentId = '';
try { currentId = localStorage.getItem(CKEY) || '' } catch {}
let bgSessionsCollapsed = (()=>{
  try{
    const v = localStorage.getItem(LSK_BG_SESS_COLLAPSED);
    if (v === '0' || v === 'false') return false;
    if (v === '1' || v === 'true') return true;
  } catch {}
  return true;
})();
let streamingId = '';
const typing = new Map(); // sessionId -> boolean
let agents = [];
let currentAgentId = localStorage.getItem(AKEY) || '';
let hasAgents = false;
let currentWorkspace = '';

// Live Info backing state: global + per-session
const globalLiveInfo = {
  model: '',
  tools: [],
  skills: [],
  workspace: '',
};
const liveInfoBySession = new Map(); // sessionId -> snapshot

function nowIso(){ return new Date().toISOString() }
function setCurrent(id){
  currentId = id;
  try { localStorage.setItem(CKEY, id) } catch(e){ try{ warnStorageQuota(); } catch{} }
  try { window.__arcana_currentSessionId = id } catch {}
}

// Per-session lastSeen tracking (for unread indicators)
let lastSeenBySession = {};
try{
  const raw = localStorage.getItem(LSK_LAST_SEEN);
  if (raw){
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') lastSeenBySession = obj;
  }
} catch {}

function getLastSeenUpdatedAt(sessionId){
  try{
    const sid = String(sessionId || '');
    if (!sid || !lastSeenBySession || typeof lastSeenBySession !== 'object') return '';
    const v = lastSeenBySession[sid];
    return v ? String(v || '') : '';
  } catch { return '' }
}

function markSessionSeen(sessionId, updatedAt){
  try{
    const sid = String(sessionId || '');
    if (!sid) return;
    let stamp = '';
    if (updatedAt){
      stamp = String(updatedAt || '');
    } else {
      stamp = nowIso();
    }
    if (!stamp) return;
    const prev = getLastSeenUpdatedAt(sid);
    if (prev){
      const prevDate = new Date(prev);
      const nextDate = new Date(stamp);
      if (!Number.isNaN(prevDate.getTime()) && !Number.isNaN(nextDate.getTime()) && nextDate <= prevDate) return;
    }
    if (!lastSeenBySession || typeof lastSeenBySession !== 'object') lastSeenBySession = {};
    lastSeenBySession[sid] = stamp;
    try { localStorage.setItem(LSK_LAST_SEEN, JSON.stringify(lastSeenBySession)); } catch {}
  } catch {}
}

function isSessionUnread(it){
  try{
    if (!it || !it.id || !it.updatedAt) return false;
    const last = getLastSeenUpdatedAt(it.id);
    if (!last) return true;
    const lastDate = new Date(last);
    const updDate = new Date(it.updatedAt);
    if (Number.isNaN(lastDate.getTime()) || Number.isNaN(updDate.getTime())) return false;
    return updDate > lastDate;
  } catch { return false }
}

function primeLastSeenFromList(items){
  try{
    if (!Array.isArray(items) || !items.length) return;
    if (!lastSeenBySession || typeof lastSeenBySession !== 'object') lastSeenBySession = {};
    let changed = false;
    for (const it of (items||[])){
      const sid = (it && it.id) ? String(it.id) : '';
      const upd = (it && it.updatedAt) ? String(it.updatedAt) : '';
      if (!sid || !upd) continue;
      const existing = getLastSeenUpdatedAt(sid);
      if (!existing){
        lastSeenBySession[sid] = upd;
        changed = true;
      }
    }
    if (changed){
      try { localStorage.setItem(LSK_LAST_SEEN, JSON.stringify(lastSeenBySession)); } catch {}
    }
  } catch {}
}

// --- fetch helpers (harden /api/sessions calls) ---
function _collapse(s, n){ try{ return String(s||'').replace(/\s+/g,' ').trim().slice(0, n||200) }catch{ return '' } }
async function _fetchJsonExpectOk(url, opts, label){
  try{
    const r = await fetch(url, opts);
    const ct = (r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';
    if (!ct.includes('application/json')){
      let preview = '';
      try { preview = await r.clone().text() } catch {}
      appendLog('[sessions] ' + (label||url) + ' non-JSON response ' + r.status + (preview ? (': ' + _collapse(preview)) : ''))
    }
    if (!r.ok){
      try { const body = await r.clone().text(); if (body) appendLog('[sessions] ' + (label||url) + ' HTTP ' + r.status + ' ' + _collapse(body)) } catch {}
      throw new Error('HTTP ' + r.status)
    }
    try { return await r.json() }
    catch(e){ let preview = ''; try { preview = await r.clone().text() } catch {}; appendLog('[sessions] ' + (label||url) + ' JSON parse error' + (preview ? (': ' + _collapse(preview)) : '')); throw e }
  } catch(e){ appendLog('[sessions] ' + (label||url) + ' fetch failed: ' + (((e && e.message) || e))); throw e }
}

async function listSessions(agentId){ const id = String(agentId || DEFAULT_AGENT_ID); const url = '/api/sessions?agentId=' + encodeURIComponent(id); const j = await _fetchJsonExpectOk(url, undefined, 'list'); return Array.isArray(j && j.sessions) ? j.sessions : [] }
async function createSession(title, workspace, agentId){ const id = String(agentId || DEFAULT_AGENT_ID); const payload = { title: title||'新会话', agentId: id }; if (workspace){ payload.workspace = String(workspace||''); } return await _fetchJsonExpectOk('/api/sessions', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) }, 'create') }
async function deleteSession(id, agentId){ if (!id) return { ok:false }; const aid = String(agentId || DEFAULT_AGENT_ID); const url = '/api/sessions/' + encodeURIComponent(id) + '?agentId=' + encodeURIComponent(aid); return await _fetchJsonExpectOk(url, { method:'DELETE' }, 'delete') }
async function listAgents(){ const j = await _fetchJsonExpectOk('/api/agents', undefined, 'agents'); return Array.isArray(j && j.agents) ? j.agents : [] }
async function loadSession(id, agentId){
  try{
    const aid = String(agentId || DEFAULT_AGENT_ID);
    const url = '/api/sessions/' + encodeURIComponent(id) + '?agentId=' + encodeURIComponent(aid);
    const r = await fetch(url);
    if (r.status === 404) return null;
    const ct = (r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';
    if (!r.ok){ try { const body = await r.clone().text(); if (body) appendLog('[sessions] load HTTP ' + r.status + ' ' + _collapse(body)) } catch {}; throw new Error('HTTP ' + r.status) }
    if (!ct.includes('application/json')){ let preview = ''; try { preview = await r.clone().text() } catch {}; appendLog('[sessions] load non-JSON response ' + r.status + (preview ? (': ' + _collapse(preview)) : '')) }
    try { return await r.json() } catch(e){ let preview = ''; try { preview = await r.clone().text() } catch {}; appendLog('[sessions] load JSON parse error' + (preview ? (': ' + _collapse(preview)) : '')); throw e }
  } catch(e){ appendLog('[sessions] load failed: ' + (((e && e.message) || e))); throw e }
}

function renderAgentsList(){
  const panel = qs('agents-panel');
  const box = qs('agents-list');
  if (!panel || !box) return;
  panel.style.display = '';
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  const current = String(currentAgentId || '');
  for (const a of (agents||[])){
    const id = a && a.agentId ? String(a.agentId) : '';
    if (!id) continue;
    const div = document.createElement('div');
    div.className = (id===current) ? 'agent-item active' : 'agent-item';
    div.dataset.agentId = id;
    const dot = document.createElement('span'); dot.className = 'agent-dot';
    const label = document.createElement('span'); label.className = 'agent-id'; label.textContent = id;
    div.appendChild(dot);
    div.appendChild(label);
    div.addEventListener('click', ()=>{ setCurrentAgent(id).catch(()=>{}); });
    frag.appendChild(div);
  }
  if (!frag.childNodes.length){
    const empty = document.createElement('div');
    empty.className = 'agent-empty';
    empty.textContent = 'No agents yet. Use the create_agent tool to create one.';
    box.appendChild(empty);
  } else {
    box.appendChild(frag);
  }
}

async function setCurrentAgent(id){
  const nextId = String(id || '');
  if (nextId === String(currentAgentId || '')) return;
  currentAgentId = nextId;
  try { localStorage.setItem(AKEY, currentAgentId); } catch {}
  renderAgentsList();

  // Best-effort refresh of config panel for new agent
  try {
    await loadConfigUI();
  } catch {}

  if (!hasAgents){
  requestRefreshList();
    return;
  }

  setCurrent('');
  try { renderMessages([]); } catch {}

  let items = [];
  try {
    items = await refreshList();
  } catch (e) {
    appendLog('[sessions] 切换代理刷新失败: ' + (((e && e.message) || e)));
  }

  if (Array.isArray(items) && items.length){
    try {
      await openSession(items[0].id);
    } catch (e) {
      appendLog('[sessions] 打开会话失败: ' + (((e && e.message) || e)));
    }
    return;
  }

  try {
    const created = await createSession('新会话', '', currentAgentId);
    await openSession(created.id);
  } catch (e) {
    appendLog('[sessions] 创建新会话失败: ' + (((e && e.message) || e)));
  }
}

async function loadAgents(){
  try{
    const list = await listAgents();
    agents = Array.isArray(list) ? list : [];
    hasAgents = agents.length > 0;
    if (!hasAgents){
      currentAgentId = '';
      try { localStorage.removeItem(AKEY); } catch {}
    } else {
      let desired = currentAgentId;
      if (!desired || !agents.some((a)=>a && a.agentId === desired)){
        desired = agents[0].agentId || '';
      }
      currentAgentId = String(desired || '');
      try { localStorage.setItem(AKEY, currentAgentId); } catch {}
    }
    renderAgentsList();
    // Ensure config UI reflects the resolved current agent on first load
    try { await loadConfigUI(); } catch {}
  } catch(e){
    hasAgents = false;
    agents = [];
    currentAgentId = '';
    try { localStorage.removeItem(AKEY); } catch {}
    const panel = qs('agents-panel');
    if (panel) panel.style.display = 'none';
    appendLog('[agents] 加载失败');
  }
}

function renderSessionList(items){
  const box = qs('session-list'); if (!box) return;
  box.innerHTML = '';
  const list = Array.isArray(items) ? items.slice() : [];
  const normal = [];
  const background = [];
  for (const it of list){
    if (!it) continue;
    const titleRaw = it.title || '';
    const t = String(titleRaw || '');
    const isCronRun = t.slice(0, 10) === '[cron-run]';
    const isCronAgentTurn = t.startsWith('Cron Agent Turn #');
    if (isCronRun || isCronAgentTurn){
      background.push(it);
    } else {
      normal.push(it);
    }
  }

  function renderOne(it, extraClass){
    const div = document.createElement('div');
    const baseCls = (it.id===currentId) ? 'sess-item active' : 'sess-item';
    div.className = extraClass ? (baseCls + ' ' + extraClass) : baseCls;
    div.dataset.id = it.id;
    const unread = isSessionUnread(it);
    const unreadDot = unread ? '<span class=sess-unread-dot></span>' : '';
    const running = !!typing.get(it.id);
    const runningSpinner = running ? '<span class=sess-running-spinner></span>' : '';
    const title = (it.title||'新会话');
    const metaTime = it.updatedAt ? ('<span class=meta>' + new Date(it.updatedAt).toLocaleString() + '</span>') : '';
    const metaWs = it.workspace ? ('<span class=meta ws>' + it.workspace + '</span>') : '';
    const prefix = unread ? unreadDot : (running ? runningSpinner : '');
    div.innerHTML = prefix + title + metaTime + metaWs;
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '删'; del.title = '删除会话';
    del.addEventListener('click', async (ev)=>{
      try{
        ev.stopPropagation && ev.stopPropagation(); ev.preventDefault && ev.preventDefault();
        const ok = confirm('确定删除该会话？此操作不可恢复。'); if (!ok) return;
        const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
        const resp = await deleteSession(it.id, aid);
        if (!resp || resp.ok !== true){ appendLog('[sessions] delete failed: server rejected'); return }
        try{
          const sid = String(it.id || '');
          if (!sid) { /* nothing to purge */ }
          else {
            // Purge in-memory caches
            try{ toolPanels.delete(sid); } catch {}
            try{ logStore.delete(sid); } catch {}
            try{ lastWorkspaceBySession.delete(sid); } catch {}
            try{ liveInfoBySession.delete(sid); } catch {}
            try{ typing.delete(sid); } catch {}

            // Purge persisted per-session data
            try{
              if (typeof localStorage !== 'undefined'){
                // Tool panels bucket
                try{
                  const raw = localStorage.getItem(TOOL_PANELS_KEY);
                  if (raw){
                    let obj;
                    try{ obj = JSON.parse(raw); } catch { obj = null; }
                    if (obj && typeof obj === 'object' && sid in obj){
                      delete obj[sid];
                      try{ localStorage.setItem(TOOL_PANELS_KEY, JSON.stringify(obj)); } catch{}
                    }
                  }
                } catch {}

                // Main logs bucket
                try{
                  const raw2 = localStorage.getItem(MAIN_LOGS_KEY);
                  if (raw2){
                    let obj2;
                    try{ obj2 = JSON.parse(raw2); } catch { obj2 = null; }
                    if (obj2 && typeof obj2 === 'object' && sid in obj2){
                      delete obj2[sid];
                      try{ localStorage.setItem(MAIN_LOGS_KEY, JSON.stringify(obj2)); } catch{}
                    }
                  }
                } catch {}

                // Last seen bucket
                try{
                  const raw3 = localStorage.getItem(LSK_LAST_SEEN);
                  if (raw3){
                    let obj3;
                    try{ obj3 = JSON.parse(raw3); } catch { obj3 = null; }
                    if (obj3 && typeof obj3 === 'object' && sid in obj3){
                      delete obj3[sid];
                      try{ localStorage.setItem(LSK_LAST_SEEN, JSON.stringify(obj3)); } catch{}
                    }
                  }
                } catch {}
              }
            } catch {}
          }
        } catch {}
        const deletedCurrent = (it.id === currentId);
        if (deletedCurrent) setCurrent('');
        try { await refreshList() } catch {}
        if (deletedCurrent){
          try {
            const remain = await listSessions(hasAgents && currentAgentId ? currentAgentId : undefined);
            if (Array.isArray(remain) && remain.length){
              await openSession(remain[0].id);
            } else {
              let obj;
              if (hasAgents && currentAgentId){
                obj = await createSession('新会话', '', currentAgentId);
              } else {
                const ws = await pickWorkspace() || '';
                if (!ws){ appendLog('[sessions] 未选择工作区'); return; }
                obj = await createSession('新会话', ws);
              }
              await openSession(obj.id);
            }
          } catch(e){ appendLog('[sessions] delete fallback failed: ' + (((e && e.message) || e))) }
        }
      } catch(e){ appendLog('[sessions] delete failed: ' + (((e && e.message) || e))) }
    });
    div.appendChild(del);
    div.addEventListener('click', async ()=>{ await openSession(it.id) });
    return div;
  }

  for (const it of normal){
    box.appendChild(renderOne(it));
  }

  if (background.length){
    const header = document.createElement('div');
    header.className = 'sess-bg-header';
    const label = document.createElement('span');
    label.className = 'sess-bg-title';
    label.textContent = 'Background (' + background.length + ')';
    const toggle = document.createElement('span');
    toggle.className = 'sess-bg-toggle';
    toggle.textContent = bgSessionsCollapsed ? '+' : '-';
    header.appendChild(label);
    header.appendChild(toggle);
    header.addEventListener('click', ()=>{
      bgSessionsCollapsed = !bgSessionsCollapsed;
      try{ localStorage.setItem(LSK_BG_SESS_COLLAPSED, bgSessionsCollapsed ? '1' : '0'); } catch {}
      renderSessionList(items);
    });
    box.appendChild(header);

    if (!bgSessionsCollapsed){
      for (const it of background){
        box.appendChild(renderOne(it, 'sess-item-bg'));
      }
    }
  }
}

async function openSession(id){
  setCurrent(id);
  renderMessages([]); // clear
  const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
  const obj = await loadSession(id, aid);
  try {
    if (obj && obj.updatedAt){
      markSessionSeen(id, obj.updatedAt);
    } else {
      markSessionSeen(id);
    }
  } catch {}
  if (obj && obj.workspace) {
    currentWorkspace = String(obj.workspace || '');
  } else {
    currentWorkspace = '';
  }
  try {
    const info = ensureLiveForSession(id);
    if (info){
      info.workspace = currentWorkspace;
      const tokensNum = Number(obj && obj.sessionTokens);
      if (Number.isFinite(tokensNum) && tokensNum >= 0){ info.sessionTokens = tokensNum; }
    }
  } catch {}
  renderMessages((obj && Array.isArray(obj.messages)) ? obj.messages : []);
  // Log session workspace only when it changes to avoid duplicate lines when switching
  try { if (obj && obj.workspace) { logWorkspaceIfChanged(id, 'workspace:', obj.workspace); } } catch {}
  requestRefreshList();
  try { renderLogsFor(id, activeLogTab) } catch {}
  try { renderLiveInfoFor(id); } catch {}
  try {
    if (toolStreamEnabled){
      try { ensureTransportReady().catch(()=>{}); } catch{}
    }
  } catch{}
}

function renderMessages(msgs){
  messages.innerHTML = '';
  for (const m of (msgs||[])){
    const isHb = m.role === 'assistant' && typeof m.text === 'string' && m.text.startsWith('[heartbeat]');
    const displayText = isHb ? '💓 ' + m.text.replace(/^\[heartbeat\]\n\n?/, '') : m.text;
    const bubble = appendMessage(m.role, displayText);
    if (isHb && bubble) bubble.classList.add('heartbeat-msg');
  }
  messages.scrollTop = messages.scrollHeight;
}

async function refreshList(){
  const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
  const items = await listSessions(aid);
  items.sort((a,b)=> String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
  primeLastSeenFromList(items);
  try{
    if (currentId){
      const currentItem = items.find((it)=> it && it.id === currentId);
      if (currentItem && currentItem.updatedAt){
        markSessionSeen(currentId, currentItem.updatedAt);
      }
    }
  } catch {}
  renderSessionList(items);
  return items;
}

// Coalesced/throttled list refresh for frequent events (SSE typing/text etc.)
let __arcana_rl_inflight = false;
let __arcana_rl_timer = null;
let __arcana_rl_queued = false;
function requestRefreshList(){
  try{
    // If a refresh is in flight, mark queued and return.
    if (__arcana_rl_inflight){ __arcana_rl_queued = true; return; }
    // Basic throttle: only allow one dispatch per 400ms.
    if (__arcana_rl_timer) return;
    __arcana_rl_timer = setTimeout(async ()=>{
      __arcana_rl_timer = null;
      if (__arcana_rl_inflight){ __arcana_rl_queued = true; return; }
      __arcana_rl_inflight = true;
      try{ await refreshList(); }
      catch{ /* noop */ }
      finally{
        __arcana_rl_inflight = false;
        if (__arcana_rl_queued){ __arcana_rl_queued = false; try{ requestRefreshList(); } catch{} }
      }
    }, 400);
  } catch {}
}

async function ensureSession(){
  if (currentId) return currentId;
  if (hasAgents && currentAgentId){
    const created = await createSession('新会话', '', currentAgentId);
    setCurrent(created.id);
    currentWorkspace = String(created.workspace || '');
    await refreshList();
    return currentId;
  }
  const ws = await pickWorkspace();
  if (!ws){ appendLog('[sessions] 未选择工作区'); throw new Error('workspace_required') }
  const created = await createSession('新会话', ws);
  setCurrent(created.id);
  currentWorkspace = String(created.workspace || ws || '');
  await refreshList();
  return currentId;
}

async function sendWithSession(){
  const text = input.value.trim();
  if (!text) return;
  await ensureSession();
  const sidAtSend = currentId;
  // For non-agent sessions, ensure we have a workspace so /api/chat2 accepts the request
  if (!hasAgents || !currentAgentId){
    if (!currentWorkspace && sidAtSend){
      try {
        const obj = await loadSession(sidAtSend, DEFAULT_AGENT_ID);
        if (obj && obj.workspace) currentWorkspace = String(obj.workspace || '');
      } catch {}
    }
  }
  appendMessage('user', text);
  input.value = ''; autoResize();
  activeAssistant = appendMessage('assistant','');
  setTyping(activeAssistant, true);
  streamingId = sidAtSend;
  try{
    const payload = { sessionId: sidAtSend, message: text, policy: (qs('fullshell') && qs('fullshell').checked) ? 'open' : 'restricted', agentId: currentAgentId || DEFAULT_AGENT_ID };
    if (!hasAgents || !currentAgentId){
      const ws = String(currentWorkspace || '').trim();
      if (ws) payload.workspace = ws;
    }
    const r = await fetch('/api/chat2', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    const j = await r.json();
    if (streamingId === currentId && activeAssistant && activeAssistant.classList.contains('typing')){ setTyping(activeAssistant, false); activeAssistant.textContent = j.text || '[无响应]'; }
    if (getCurrentSessionId() === sidAtSend || currentId === sidAtSend){
      await openSession(sidAtSend);
    } else {
    requestRefreshList();
    }
  } catch(e) { if (activeAssistant) activeAssistant.textContent = '[错误] ' + (((e && e.message) || e)); }
  finally { messages.scrollTop = messages.scrollHeight; }
}

async function sendWithGatewayV2(){
  const text = input.value.trim();
  if (!text) return;
  const mode = await ensureTransportReady();
  if (!gatewayV2Enabled || mode !== 'v2'){
    await sendWithSession();
    return;
  }
  const agentId = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
  try { gatewayV2SessionKey = gatewayV2SessionKey || ensureGatewayV2SessionKey(); } catch {}
  appendMessage('user', text);
  input.value = '';
  autoResize();
  const bubble = appendMessage('assistant', '');
  activeAssistant = bubble;
  setTyping(bubble, true);
  messages.scrollTop = messages.scrollHeight;
  try{
    const body = { agentId, sessionKey: gatewayV2SessionKey, text };
    const r = await fetch('/v2/turn', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok || !j || !j.ok || !j.event){
      setTyping(bubble, false);
      bubble.textContent = !r.ok ? ('[error] HTTP ' + r.status) : '[error] Bad response';
      return;
    }
    const ev = j.event || {};
    const evId = ev.eventId ? String(ev.eventId) : '';
    if (evId){
      gatewayV2Pending.set(evId, bubble);
    } else {
      setTyping(bubble, false);
    }
  } catch(e){
    setTyping(bubble, false);
    bubble.textContent = '[error] ' + (((e && e.message) || e));
  } finally {
    messages.scrollTop = messages.scrollHeight;
  }
}

async function handleSend(){
  const mode = await ensureTransportReady();
  if (mode === 'v2'){
    await sendWithGatewayV2();
  } else {
    await sendWithSession();
  }
}

// Hook send button + Enter to session mode
sendBtn.addEventListener('click', ()=>{ handleSend().catch(()=>{}) });
input.addEventListener('keydown', (e)=>{ if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); handleSend().catch(()=>{}) } });
// Stop button -> hard abort current run
try {
  const stopBtn = document.querySelector('#stop');
  if (stopBtn) stopBtn.addEventListener('click', async ()=>{
    try{
      const sid = getCurrentSessionId(); if (!sid) return;
      const aid = currentAgentId || DEFAULT_AGENT_ID;
      const ws = (!hasAgents || !currentAgentId) ? String(currentWorkspace || '').trim() : '';
      const policy = (qs('fullshell') && qs('fullshell').checked) ? 'open' : 'restricted';
      await fetch('/api/abort', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ sessionId: sid, agentId: aid, workspace: ws || undefined, policy }) });
    } catch {}
  });
} catch {}

// SSE: single connection; filter UI updates by sessionId
async function ensureTransportReady(){
  try{
    if (gatewayV2Detected){
      if (gatewayV2Enabled){
        try { if (!gatewayV2SessionKey) gatewayV2SessionKey = ensureGatewayV2SessionKey(); } catch {}
        try { setupGatewayV2WebSocket(); } catch {}
        return 'v2';
      }
      try {
        if (!window.__arcana_sse_initialized){
          setupSseConnection();
          try { window.__arcana_sse_initialized = true; } catch {}
        }
      } catch {}
      return 'legacy';
    }
    if (gatewayV2ProbePromise){
      try { return await gatewayV2ProbePromise; } catch { return 'legacy'; }
    }
    gatewayV2ProbePromise = (async ()=>{
      let isV2 = false;
      try{
        const r = await fetch('/v2/health', { method:'GET' });
        if (r && r.ok){
          let j = null;
          try { j = await r.json(); } catch {}
          if (j && j.ok && String(j.kind || '') === 'gateway-v2'){
            isV2 = true;
          }
        }
      } catch {}
      gatewayV2Detected = true;
      gatewayV2Enabled = isV2;
      if (isV2){
        try { gatewayV2SessionKey = ensureGatewayV2SessionKey(); } catch {}
        try { setupGatewayV2WebSocket(); } catch {}
        return 'v2';
      }
      try {
        if (!window.__arcana_sse_initialized){
          setupSseConnection();
          try { window.__arcana_sse_initialized = true; } catch {}
        }
      } catch {}
      return 'legacy';
    })();
    try { return await gatewayV2ProbePromise; } catch { return 'legacy'; }
  } catch { return 'legacy'; }
}

function setupGatewayV2WebSocket(){
  try{
    if (!gatewayV2Enabled) return;
    if (gatewayV2Ws && gatewayV2Ws.readyState === 1) return;
    let url = '';
    try{
      const loc = window.location;
      const proto = (loc.protocol === 'https:') ? 'wss:' : 'ws:';
      url = proto + '//' + loc.host + '/v2/stream';
    } catch{
      url = '/v2/stream';
    }
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    gatewayV2Ws = ws;
    ws.onmessage = (ev)=>{
      try {
        const payload = JSON.parse(ev.data);
        handleGatewayV2Envelope(payload);
      } catch {}
    };
    ws.onclose = ()=>{
      try{
        if (!gatewayV2Enabled) return;
        setTimeout(()=>{ try { setupGatewayV2WebSocket(); } catch {} }, 1000);
      } catch {}
    };
    ws.onerror = ()=>{};
  } catch {}
}

function handleGatewayV2Envelope(payload){
  try{
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'event.appended'){
      const ev = payload.event;
      if (!ev || typeof ev !== 'object') return;
      const evType = ev.type;
      if (!evType) return;
      const agentId = ev.agentId || DEFAULT_AGENT_ID;
      const sessionKey = ev.sessionKey || '';
      const currentAgent = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
      const expectedKey = gatewayV2SessionKey || ensureGatewayV2SessionKey();
      if (agentId !== currentAgent) return;
      if (sessionKey && expectedKey && sessionKey !== expectedKey) return;
      if (evType === 'assistant_message'){
        const data = ev.data || {};
        const replyId = data && data.replyToEventId ? String(data.replyToEventId) : '';
        const text = data && data.text ? String(data.text) : '';
        let bubble = null;
        if (replyId && gatewayV2Pending.has(replyId)){
          bubble = gatewayV2Pending.get(replyId) || null;
          gatewayV2Pending.delete(replyId);
        }
        if (!bubble){
          bubble = appendMessage('assistant', '');
        }
        setTyping(bubble, false);
        if (text){
          bubble.textContent = text;
        }
        messages.scrollTop = messages.scrollHeight;
        return;
      }
      if (evType === 'message'){
        return;
      }
    }
  } catch {}
}


const TOOL_STREAM_LS_KEY = 'arcana.toolStreamEnabled.v1';
let toolStreamEnabled = (()=>{ try{ const v = localStorage.getItem(TOOL_STREAM_LS_KEY); return v === '1' || v === 'true'; } catch{ return false } })();

function buildEventsUrl(){
  try{
    if (toolStreamEnabled){
      const sid = getCurrentSessionId() || currentId || '';
      if (sid){
        return '/api/events?toolStream=1&toolStreamSessionId=' + encodeURIComponent(sid);
      }
    }
  } catch{}
  return '/api/events';
}

function updateToolStreamToggleLabel(){
  try{
    const btn = document.getElementById('toggle-tool-stream');
    if (!btn) return;
    const label = toolStreamEnabled ? '实时工具输出: 开' : '实时工具输出: 关';
    btn.textContent = label;
  } catch{}
}

function setupToolStreamToggle(){
  try{
    const btn = document.getElementById('toggle-tool-stream');
    if (!btn || !btn.addEventListener) return;
    updateToolStreamToggleLabel();
    btn.addEventListener('click', ()=>{
      toolStreamEnabled = !toolStreamEnabled;
      try{ localStorage.setItem(TOOL_STREAM_LS_KEY, toolStreamEnabled ? '1' : '0'); } catch{}
      updateToolStreamToggleLabel();
      try{ setupSseConnection(); } catch{}
    });
  } catch{}
}

async function fetchSelectedToolOutput(){
  try{
    const sid = getCurrentSessionId() || currentId || '';
    if (!sid) return;
    const panel = getToolPanel(sid);
    if (!panel || !panel.selectedId) return;
    const action = panel.actions.get(panel.selectedId);
    if (!action) return;
    const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const params = new URLSearchParams();
    params.set('agentId', aid);
    params.set('sessionId', sid);
    params.set('toolCallId', action.id);
    params.set('tailBytes', '200000');
    const url = '/api/tool-output?' + params.toString();
    const r = await fetch(url);
    const bodyEl = document.getElementById('tools-details-body');
    if (!r.ok){
      if (bodyEl) bodyEl.textContent = 'Failed to fetch tool output: HTTP ' + r.status;
      return;
    }
    let j = null;
    try { j = await r.json(); } catch {
      if (bodyEl) bodyEl.textContent = 'Failed to parse tool output response.';
      return;
    }
    if (!j || j.ok !== true){
      if (bodyEl) bodyEl.textContent = 'Tool output not available.';
      return;
    }
    const parts = [];
    if (j.meta){
      try{ parts.push('Meta:\n' + JSON.stringify(j.meta, null, 2)); } catch{}
    }
    if (j.result){
      try{ parts.push('Result:\n' + JSON.stringify(j.result, null, 2)); } catch{}
    }
    if (typeof j.streamTail === 'string' && j.streamTail){
      parts.push('Stream tail:\n' + j.streamTail);
    }
    const text = parts.length ? parts.join('\n\n') : 'No cached output.';
    if (bodyEl){
      const atBottom = (bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight) <= 16;
      const prevScrollTop = bodyEl.scrollTop;
      bodyEl.textContent = text;
      if (atBottom){ bodyEl.scrollTop = bodyEl.scrollHeight; } else { bodyEl.scrollTop = prevScrollTop; }
    }
  } catch(e){
    const bodyEl = document.getElementById('tools-details-body');
    if (bodyEl) bodyEl.textContent = 'Error fetching tool output: ' + (((e && e.message) || e));
  }
}

function setupSseConnection(){
  try {
    if (gatewayV2Enabled) return;
    try { if (window.__arcana_global_es){ try { window.__arcana_global_es.close() } catch {} window.__arcana_global_es = null } } catch {}
    const es = new EventSource(buildEventsUrl()); window.__arcana_global_es = es;
    es.onmessage = (ev)=>{
    try{
      const data = JSON.parse(ev.data);

      // Logs panel + lifecycle
      const sid = data.sessionId || currentId;
            if (data.type === 'open_vault'){
        try { openVault(Array.isArray(data.names) ? data.names : []).catch(()=>{}) } catch {}
        logMain(sid, 'open vault' + (Array.isArray(data.names) && data.names.length ? (': ' + data.names.join(', ')) : ''));
        return;
      }
      try { const em = (data && data.message && data.message.errorMessage) ? String(data.message.errorMessage) : null; if (em) { logMain(sid, '[error] ' + em); } } catch {}
      if (data.type === 'server_info'){
        logMain(sid, 'model: ' + data.model);
        logMain(sid, 'tools: ' + (data.tools||[]).join(', '));
        if (Array.isArray(data.skills)) logMain(sid, 'skills: ' + data.skills.join(', '));
        // Live Info: treat as global capabilities/model
        try {
          globalLiveInfo.model = String(data.model || '');
          globalLiveInfo.tools = Array.isArray(data.tools) ? data.tools.slice() : [];
          globalLiveInfo.skills = Array.isArray(data.skills) ? data.skills.slice() : [];
          globalLiveInfo.workspace = String(data.workspace || '');
          if (currentId){ renderLiveInfoFor(currentId); }
        } catch {}
        // Use a distinct label for the server-reported root and cache to avoid repeats
        logWorkspaceIfChanged(sid, 'workspaceRoot:', data.workspace);
        return;
      }
      if (data.type === 'error'){
        try { if (data.message) logMain(sid, '[error] ' + data.message); } catch {}
        return;
      }
      if (data.type === 'turn_start'){
        const targetId = data.sessionId || sid;
        try { if (data.sessionId) { typing.set(data.sessionId, true); try { requestRefreshList(); } catch {} } } catch {}
        try {
          const snap = ensureLiveForSession(targetId);
          if (snap){
            snap.usedThisTurn = new Set();
            snap.turns = (snap.turns || 0) + 1;
          }
          try {
            const sid2 = String(targetId || '');
            if (sid2){
              let prev = lastToolTurnBySession.get(sid2);
              if (typeof prev !== 'number' || Number.isNaN(prev)) prev = -1;
              const idx = prev + 1;
              lastToolTurnBySession.set(sid2, idx);
              const panel = getToolPanel(sid2);
              if (panel){
                if (!panel.turnStatus) panel.turnStatus = new Map();
                panel.turnStatus.set(idx, 'running');
                if (!panel.turnUsage) panel.turnUsage = new Map();
                if (snap){
                  const start = (typeof snap.sessionTokens === 'number' && snap.sessionTokens >= 0) ? snap.sessionTokens : 0;
                  const ctx = (typeof snap.contextTokens === 'number' && snap.contextTokens >= 0) ? snap.contextTokens : 0;
                  panel.turnUsage.set(idx, {
                    startSessionTokens: start,
                    lastSessionTokens: start,
                    lastContextTokens: ctx,
                  });
                }
                try{ scheduleSaveToolPanel(sid2); } catch {}
              }
            }
          } catch {}
        } catch {}
        logMain(sid, 'turn start');
        if (targetId === currentId){
          try { renderLiveInfoFor(targetId); } catch {}
          if (activeLogTab === 'tools'){ try { renderToolsPanel(targetId); } catch {} }
        }
        return;
      }

      if (data.type === 'turn_end'){
        const targetId = data.sessionId || sid;
        try { if (data.sessionId) { typing.delete(data.sessionId); try { requestRefreshList(); } catch {} } } catch {}
        try {
          const snap = ensureLiveForSession(targetId);
          if (snap){
            if (typeof data.sessionTokens === 'number') snap.sessionTokens = Number(data.sessionTokens) || 0;
            if (typeof data.contextTokens === 'number') snap.contextTokens = Number(data.contextTokens) || 0;
          }
          const sid2 = String(targetId || '');
          if (sid2){
            const idx = lastToolTurnBySession.get(sid2);
            if (typeof idx === 'number' && !Number.isNaN(idx)){
              const panel = getToolPanel(sid2);
              if (panel){
                if (!panel.turnUsage) panel.turnUsage = new Map();
                const existing = panel.turnUsage.get(idx) || {};
                let start = 0;
                if (typeof existing.startSessionTokens === 'number' && existing.startSessionTokens >= 0){
                  start = existing.startSessionTokens;
                } else if (snap && typeof snap.sessionTokens === 'number' && snap.sessionTokens >= 0){
                  start = snap.sessionTokens;
                }
                const lastSessionTokens = (snap && typeof snap.sessionTokens === 'number' && snap.sessionTokens >= 0) ? snap.sessionTokens : start;
                const lastContextTokens = (snap && typeof snap.contextTokens === 'number' && snap.contextTokens >= 0) ? snap.contextTokens : 0;
                panel.turnUsage.set(idx, {
                  startSessionTokens: start,
                  lastSessionTokens,
                  lastContextTokens,
                });
                try{ scheduleSaveToolPanel(sid2); } catch {}
              }
            }
          }
        } catch {}
        try { markTurnDone(targetId); } catch {}
        // For background sessions, just refresh the list/unread state.
        if (targetId && targetId !== currentId){
          try { requestRefreshList(); } catch {}
          return;
        }
        try {
          const info = ensureLiveForSession(targetId);
          if (info){
            if (typeof data.sessionTokens === 'number') info.sessionTokens = Number(data.sessionTokens) || 0;
            if (typeof data.contextTokens === 'number') info.contextTokens = Number(data.contextTokens) || 0;
          }
          if (targetId === currentId){
            renderLiveInfoFor(targetId);
            try {
              const sid2 = String(targetId || '');
              if (sid2 && activeLogTab === 'tools'){
                renderToolsPanel(targetId);
              }
            } catch {}
          }
        } catch {}
        logMain(sid, 'turn end');
        activeAssistant = null;
        return;
      }

      if (data.type === 'tool_execution_start'){
        const targetId = data.sessionId || sid;
        try {
          const info = ensureLiveForSession(targetId);
          if (info && data.toolName){
            if (!info.usedThisTurn || !(info.usedThisTurn instanceof Set)) info.usedThisTurn = new Set();
            info.usedThisTurn.add(String(data.toolName));
          }
          if (targetId === currentId){ renderLiveInfoFor(targetId); }
        } catch {}
        try { upsertToolAction(data); } catch {}
        const summary = summarizeArgs(data.args || {});
        logTools(sid, 'tool start: ' + (data.toolName||'') + (summary ? (' ' + summary) : ''));
        return;
      }
      if (data.type === 'tool_execution_end'){
        const isErr = !!(data.isError || data.error);
        let errMsg = '';
        if (isErr){ const cand = data.error?.message || data.error || data.result?.error?.message || data.result?.error || data.result?.stderr || data.result?.stdout; if (typeof cand === 'string') errMsg = cand; else if (cand) { try { errMsg = JSON.stringify(cand) } catch { errMsg = String(cand) } } }
        try { upsertToolAction(data); } catch {}
        const cachedFlag = data.cached ? ' cached' : '';
        logTools(sid, 'tool end: ' + (data.toolName||'') + (isErr ? (' error: ' + (errMsg||'')) : ' ok') + cachedFlag);
        return;
      }
      if (data.type === 'tool_repeat'){
        logTools(sid, 'repeat: ' + data.toolName + ' x' + data.count + (data.args ? (' ' + JSON.stringify(data.args)) : ''));
        return;
      }
      if (data.type === 'skills_refresh'){
        try {
          if (Array.isArray(data.skills)){
            globalLiveInfo.skills = data.skills.slice();
          }
          if (currentId){ renderLiveInfoFor(currentId); }
        } catch {}
        return;
      }
      if (data.type === 'env_refresh'){
        try { appendLog('[vault] 已刷新环境变量'); } catch {}
        return;
      }
      if (data.type === 'tool_execution_update'){
        const raw = (typeof data.partialResult !== 'undefined') ? data.partialResult : data.update;
        const info = formatToolUpdateInfo(raw);
        try { upsertToolAction(data); } catch {}
        if (info){
          logTools(sid, 'update: ' + (data.toolName||'') + ' ' + info);
        } else {
          logTools(sid, 'update: ' + (data.toolName||''));
        }
        return;
      }

      if (data.type === 'tools_active'){
        const targetId = data.sessionId || sid;
        try {
          const info = ensureLiveForSession(targetId);
          if (info && Array.isArray(data.tools)){
            info.tools = data.tools.slice();
          }
          if (targetId === currentId){ renderLiveInfoFor(targetId); }
        } catch {}
        logTools(sid, 'tools active: ' + (Array.isArray(data.tools) ? data.tools.join(', ') : ''));
        return;
      }


      // New events: steer enqueued / abort done
      if (data.type === 'steer_enqueued') { logMain(sid, 'steer enqueued: ' + (data.text||'')); return }
      if (data.type === 'abort_done') {
        logMain(sid, 'aborted');
        if (!data.sessionId || data.sessionId === currentId){
          if (activeAssistant) setTyping(activeAssistant, false);
        }
        return;
      }

      // Thinking bubbles for active chat
      if (data.type === 'thinking_start'){
        const isBackground = !!(data.sessionId && data.sessionId !== currentId);
        if (isBackground){
          logMain(sid, 'thinking start');
          return;
        }
        if (!activeAssistant) { activeAssistant = appendMessage('assistant','') }
        setTyping(activeAssistant, true);
        logMain(sid, 'thinking start');
        return;
      }
      if (data.type === 'thinking_progress'){
        logMain(sid, 'thinking progress: ' + (data.chars||0) + ' chars');
        return;
      }
      if (data.type === 'thinking_end'){
        const isBackground = !!(data.sessionId && data.sessionId !== currentId);
        if (isBackground){
          if (typeof data.chars !== 'undefined' || typeof data.tookMs !== 'undefined')
            logMain(sid, 'thinking end: ' + (data.chars || 0) + ' chars, ' + (data.tookMs || 0) + ' ms');
          return;
        }
        if (activeAssistant) setTyping(activeAssistant, false);
        if (typeof data.chars !== 'undefined' || typeof data.tookMs !== 'undefined')
          logMain(sid, 'thinking end: ' + (data.chars || 0) + ' chars, ' + (data.tookMs || 0) + ' ms');
        return;
      }

      if (data.type === 'skills_refresh'){ try { LI.skillsHint = '技能已刷新'; } catch {} return }
      if (data.type === 'llm_usage'){
        const targetId = data.sessionId || sid;
        try {
          const snap = ensureLiveForSession(targetId);
          if (snap){
            if (typeof data.contextTokens === 'number') snap.contextTokens = Number(data.contextTokens) || 0;
            if (typeof data.sessionTokens === 'number') snap.sessionTokens = Number(data.sessionTokens) || 0;
          }
          const sid2 = String(targetId || '');
          if (sid2){
            const idx = lastToolTurnBySession.get(sid2);
            if (typeof idx === 'number' && !Number.isNaN(idx)){
              const panel = getToolPanel(sid2);
              if (panel){
                if (!panel.turnUsage) panel.turnUsage = new Map();
                const existing = panel.turnUsage.get(idx) || {};
                let start = 0;
                if (typeof existing.startSessionTokens === 'number' && existing.startSessionTokens >= 0){
                  start = existing.startSessionTokens;
                } else if (snap && typeof snap.sessionTokens === 'number' && snap.sessionTokens >= 0){
                  start = snap.sessionTokens;
                }
                const lastSessionTokens = (snap && typeof snap.sessionTokens === 'number' && snap.sessionTokens >= 0) ? snap.sessionTokens : start;
                const lastContextTokens = (snap && typeof snap.contextTokens === 'number' && snap.contextTokens >= 0) ? snap.contextTokens : 0;
                panel.turnUsage.set(idx, {
                  startSessionTokens: start,
                  lastSessionTokens,
                  lastContextTokens,
                });
                try{ scheduleSaveToolPanel(sid2); } catch {}
              }
            }
          }
          if (targetId === currentId){ renderLiveInfoFor(targetId); }
        } catch {}
        return;
      }

      if (data.type === 'heartbeat_message'){
        // Heartbeat delivered a message to a session.
        if (data.sessionId && data.sessionId !== currentId){
          // Another session received a heartbeat — update unread/list.
          try { requestRefreshList(); } catch {}
          return;
        }
        // Current session received a heartbeat message — append with visual distinction.
        const hbText = typeof data.text === 'string' ? data.text : '';
        // Strip the '[heartbeat]\n\n' prefix for display; the label is shown via CSS class.
        const displayText = hbText.replace(/^\[heartbeat\]\n\n?/, '');
        if (displayText) {
          const bubble = appendMessage('assistant', '💓 ' + displayText);
          if (bubble) bubble.classList.add('heartbeat-msg');
          messages.scrollTop = messages.scrollHeight;
          try { if (currentId) markSessionSeen(currentId); } catch {}
        }
        return;
      }

      if (data.type === 'assistant_text'){
        // For non-current sessions, refresh list/unread and skip UI updates.
        if (data.sessionId && data.sessionId !== currentId){
        try { requestRefreshList(); } catch {}
          return;
        }
        const sid2 = data.sessionId || streamingId; if (sid2 !== currentId) return;
        if (!activeAssistant) activeAssistant = appendMessage('assistant','');
        setTyping(activeAssistant, false);
        activeAssistant.textContent = data.text || '';
        messages.scrollTop = messages.scrollHeight;
        try { if (currentId) markSessionSeen(currentId); } catch {}
        return;
      }
      if (data.type === 'assistant_image'){
        // For non-current sessions, refresh list/unread and skip UI updates.
        if (data.sessionId && data.sessionId !== currentId){
          try { requestRefreshList(); } catch {}
          return;
        }
        const sid2 = data.sessionId || streamingId; if (sid2 !== currentId) return;
        if (!activeAssistant) activeAssistant = appendMessage('assistant','');
        setTyping(activeAssistant, false);
        const img = document.createElement('img');
        img.src = data.url; img.style.maxWidth = '100%'; img.style.borderRadius = '6px';
        if (activeAssistant.textContent){ const txt = activeAssistant.textContent; activeAssistant.textContent = ''; const tdiv = document.createElement('div'); tdiv.textContent = txt; activeAssistant.appendChild(tdiv); }
        activeAssistant.appendChild(img);
        messages.scrollTop = messages.scrollHeight;
        try { if (currentId) markSessionSeen(currentId); } catch {}
        return;
      }

      // Subagent logs (global) + attach to tool actions for Details view
      if (data.type === 'subagent_start'){
        const sid2 = data.sessionId || currentId;
        logSubagents(sid2, '[subagent] start: ' + (data.agent||'?') + ' id=' + (data.id||''));
        try{ attachSubagentOutputToToolAction(sid2, { subagentId: data.id, agent: data.agent, kind: 'start' }); } catch {}
        return;
      }
      if (data.type === 'subagent_stream'){
        const sid2 = data.sessionId || currentId;
        const chunk = String(data.chunk || '');
        const short = chunk.length > 200 ? (chunk.slice(0,200) + '...') : chunk;
        const msg = '[subagent ' + (data.stream||'') + '] ' + short.replace(/\s+/g,' ').trim();
        logSubagents(sid2, msg);
        try{ attachSubagentOutputToToolAction(sid2, { subagentId: data.id, agent: data.agent, stream: data.stream, chunk: data.chunk, kind: 'stream' }); } catch {}
        return;
      }
      if (data.type === 'subagent_error'){
        const sid2 = data.sessionId || currentId;
        logSubagents(sid2, '[subagent] error: ' + (data.agent||'?') + ' code=' + data.code);
        try{ attachSubagentOutputToToolAction(sid2, { subagentId: data.id, agent: data.agent, code: data.code, kind: 'error' }); } catch {}
        return;
      }
      if (data.type === 'subagent_end'){
        const sid2 = data.sessionId || currentId;
        logSubagents(sid2, '[subagent] end: ' + (data.agent||'?') + ' code=' + data.code + ' ok=' + data.ok);
        try{ attachSubagentOutputToToolAction(sid2, { subagentId: data.id, agent: data.agent, code: data.code, ok: data.ok, kind: 'end' }); } catch {}
        return;
      }
    }catch{}
  };
} catch {}
}

setupToolStreamToggle();
try{
  const btn = document.getElementById('fetch-tool-output');
  if (btn && btn.addEventListener){
    btn.addEventListener('click', ()=>{ fetchSelectedToolOutput().catch(()=>{}); });
  }
} catch{}
try { ensureTransportReady().catch(()=>{}); } catch{}

// Sidebar actions
const newBtn = qs('new-session');
if (newBtn && typeof newBtn.addEventListener === 'function'){
  newBtn.addEventListener('click', async ()=>{
    try{
      let obj;
      if (hasAgents && currentAgentId){
        obj = await createSession('新会话', '', currentAgentId);
      } else {
        const ws = await pickWorkspace(); if (!ws){ appendLog('[sessions] 未选择工作区'); return }
        obj = await createSession('新会话', ws);
      }
      await openSession(obj.id);
    } catch(e){ appendLog('[sessions] new session failed: ' + (((e && e.message) || e))); }
  });
} else {
  try { document.addEventListener('click', async (ev)=>{
    const t = ev.target;
    if (t && t.id === 'new-session'){
      try{
        let obj;
        if (hasAgents && currentAgentId){
          obj = await createSession('新会话', '', currentAgentId);
        } else {
          const ws = await pickWorkspace(); if (!ws){ appendLog('[sessions] 未选择工作区'); return }
          obj = await createSession('新会话', ws);
        }
        await openSession(obj.id);
      } catch(e){ appendLog('[sessions] new session failed: ' + (((e && e.message) || e))); }
    }
  }); } catch {}
}

// Initial with small retry/backoff
(async ()=>{
  const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
  const attempts = 3; let delay = 300;
  for (let i=1; i<=attempts; i++){
    try{
      try { await loadAgents(); } catch {}
      await refreshList();
      if (!currentId){
        const aid = (hasAgents && currentAgentId) ? currentAgentId : undefined;
        const items = await listSessions(aid);
        if (items && items[0]) setCurrent(items[0].id);
      }
      if (currentId) await openSession(currentId);
      return;
    } catch(e){ appendLog('[sessions] 初始加载失败(' + i + '/' + attempts + '): ' + (((e && e.message) || e))); if (i < attempts) { await sleep(delay); delay = Math.min(2000, delay * 2) } }
  }
})().catch((e)=>{ appendLog('[sessions] 初始加载异常: ' + (((e && e.message) || e))) });


// ---- Live Info Panel ----
const LI = {
  model: '',
  workspace: '',
  tools: [],
  skills: [],
  usedThisTurn: new Set(),
  turns: 0,
  sessionTokens: 0,
  skillsHint: '',
};

function ensureLiveForSession(sessionId){
  try {
    const sid = String(sessionId || '');
    if (!sid) return null;
    if (!liveInfoBySession.has(sid)){
      liveInfoBySession.set(sid, {
        sessionId: sid,
        sessionTokens: 0,
        contextTokens: 0,
        usedThisTurn: new Set(),
        turns: 0,
      });
    }
    return liveInfoBySession.get(sid);
  } catch { return null }
}

function renderLiveInfoFor(sessionId){
  try {
    const sid = String(sessionId || '');
    const snap = sid ? ensureLiveForSession(sid) : null;
    LI.model = globalLiveInfo.model || '';
    LI.workspace = (snap && snap.workspace) || globalLiveInfo.workspace || '';
    LI.tools = (snap && Array.isArray(snap.tools)) ? snap.tools.slice() : (globalLiveInfo.tools || []);
    LI.skills = (snap && Array.isArray(snap.skills)) ? snap.skills.slice() : (globalLiveInfo.skills || []);
    LI.usedThisTurn = (snap && snap.usedThisTurn) ? new Set(snap.usedThisTurn) : new Set();
    LI.turns = (snap && typeof snap.turns === 'number') ? snap.turns : 0;
    LI.sessionTokens = (snap && typeof snap.sessionTokens === 'number') ? snap.sessionTokens : 0;
  } catch {}
  renderLiveInfo();
}
function liSet(id, text){ const el=document.getElementById(id); if (el) el.textContent=String((text===undefined||text===null)? '—' : text); }
function renderLiveInfo(){
  liSet('li-model', LI.model || '—');
  liSet('li-workspace', LI.workspace || '—');
  liSet('li-tools', (LI.tools && LI.tools.length) ? LI.tools.join(', ') : '—');
  liSet('li-tools-used', (LI.usedThisTurn && LI.usedThisTurn.size) ? Array.from(LI.usedThisTurn).join(', ') : '—');
  liSet('li-skills', (LI.skills && LI.skills.length) ? LI.skills.join(', ') : '—');
  liSet('li-session-tokens', (typeof LI.sessionTokens === 'number' && LI.sessionTokens >= 0) ? String(LI.sessionTokens) : '—');
}

// --- Vault (Env) UI ---
let VAULT_PASSPHRASE_CACHE = '';

function buildVaultRow(v, globalVault, agentVault, section){
  const tr = document.createElement('div');
  tr.className = 'vault-row';
  tr.style.cssText = 'display:grid;grid-template-columns: 180px 1fr 90px;gap:8px;align-items:center;margin:4px 0;';
  const name = String(v && v.name || '');
  const has = !!(v && v.hasValue);
  const storedGlobal = !!(v && v.storedGlobal);
  const storedAgent = !!(v && v.storedAgent);
  const gEncrypted = !!(globalVault && globalVault.encrypted);
  const gLocked = !!(globalVault && globalVault.locked);
  const aEncrypted = !!(agentVault && agentVault.encrypted);
  const aLocked = !!(agentVault && agentVault.locked);
  const isGlobalRow = section === 'global';
  const storedHere = isGlobalRow ? storedGlobal : storedAgent;
  const encryptedHere = isGlobalRow ? gEncrypted : aEncrypted;
  const lockedHere = isGlobalRow ? gLocked : aLocked;

  const nameEl = document.createElement('div');
  nameEl.textContent = name || '(未命名)';
  nameEl.style.cssText = 'font-family:monospace;font-size:12px;word-break:break-all;';

  const valWrap = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = has ? '已设置（留空保持不变）' : '未设置（输入新值）';
  input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px;border:1px solid #ddd;border-radius:6px;';

  const extra = document.createElement('div');
  extra.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const clear = document.createElement('input'); clear.type = 'checkbox'; clear.id = 'clear-' + name + '-' + (isGlobalRow ? 'global' : 'agent'); clear.dataset.kind = 'clear';
  const clearLbl = document.createElement('label'); clearLbl.htmlFor = clear.id; clearLbl.textContent = '清除'; clearLbl.style.fontSize = '12px';
  clear.addEventListener('change', ()=>{ input.disabled = clear.checked; if (clear.checked) input.value = ''; });
  extra.appendChild(clear); extra.appendChild(clearLbl);

  valWrap.appendChild(input);
  valWrap.appendChild(extra);

  const status = document.createElement('div');
  let statusText = '';
  let statusColor = '';
  const storedAny = storedHere;
  const lockedSome = storedHere && encryptedHere && lockedHere;
  if (has && storedHere){
    statusText = '已设置';
    statusColor = '#0a0';
  } else if (storedAny && lockedSome){
    statusText = '已保存(需解锁)';
    statusColor = '#b58900';
  } else if (storedAny){
    statusText = '已保存';
    statusColor = '#666';
  } else {
    statusText = '未设置';
    statusColor = '#a00';
  }
  status.textContent = statusText;
  status.style.cssText='font-size:12px;color:' + statusColor;

  tr.appendChild(nameEl);
  tr.appendChild(valWrap);
  tr.appendChild(status);

  tr.dataset.varName = name;
  tr.dataset.storedGlobal = storedGlobal ? '1' : '0';
  tr.dataset.storedAgent = storedAgent ? '1' : '0';
  tr.dataset.section = isGlobalRow ? 'global' : 'agent';
  tr.querySelector = tr.querySelector.bind(tr);
  return tr;
}

async function openVault(){
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:10000;';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'width:720px;max-width:95vw;max-height:90vh;overflow:auto;background:#fff;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.25);padding:14px;';
  dialog.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;">' +
    '<div style="font-weight:600;font-size:15px;">密码箱（环境变量）</div>' +
    '<div id="vault-sub" style="font-size:12px;color:#666;">加载中…</div>' +
    '<div style="margin-left:auto;"><button id="vault-close">×</button></div>' +
    '</div>' +
    '<div id="vault-body" style="margin-top:8px;"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">' +
    '  <button id="vault-cancel">取消</button>' +
    '  <button id="vault-save">保存</button>' +
    '</div>';
  overlay.appendChild(dialog); document.body.appendChild(overlay);

  function close(){ try { document.body.removeChild(overlay); } catch {} }

  async function postVaultEnv(payload){
    const resp = await fetch('/api/env', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(payload) });
    if (!resp.ok){
      if (resp.status === 423){ appendLog('[vault] 已加密且锁定：请输入口令再保存/解锁'); return false; }
      if (resp.status === 403){ appendLog('[vault] 口令不正确'); return false; }
      appendLog('[vault] 保存失败'); return false; }
    const j = await resp.json();
    if (!j || j.ok !== true){ appendLog('[vault] 保存失败'); return false; }
    return true;
  }

  try { dialog.querySelector('#vault-close').addEventListener('click', close) } catch {}
  try { dialog.querySelector('#vault-cancel').addEventListener('click', close) } catch {}

  const bodyEl = dialog.querySelector('#vault-body');
  bodyEl.innerHTML = '<div style="font-size:12px;color:#666;">加载中…</div>';
  let vars = [];
  let vaultGlobal = {};
  let vaultAgent = {};
  let inheritEffective = true;
  let legacyMode = false;
  const agentId = currentAgentId || DEFAULT_AGENT_ID;
  try {
    const r = await fetch('/api/env?agentId=' + encodeURIComponent(agentId));
    const j = await r.json();
    const rawVars = Array.isArray(j && j.vars) ? j.vars : [];
    const vMetaRaw = j && typeof j.vault === 'object' && j.vault ? j.vault : {};
    const hasLayered = !!(vMetaRaw && typeof vMetaRaw.global === 'object' && vMetaRaw.global);
    if (hasLayered){
      legacyMode = false;
      vars = rawVars;
      const vMeta = vMetaRaw;
      vaultGlobal = vMeta && typeof vMeta.global === 'object' && vMeta.global ? vMeta.global : {};
      vaultAgent = vMeta && typeof vMeta.agent === 'object' && vMeta.agent ? vMeta.agent : {};
      if (typeof vMeta.inheritGlobal === 'boolean') inheritEffective = vMeta.inheritGlobal;
      else if (typeof vaultAgent.inheritGlobal === 'boolean') inheritEffective = vaultAgent.inheritGlobal;
      else inheritEffective = true;
    } else {
      legacyMode = true;
      vars = rawVars.map((v)=>({
        name: v && v.name ? String(v.name) : '',
        hasValue: !!(v && v.hasValue),
        storedGlobal: !!(v && (v.storedGlobal || v.stored)),
        storedAgent: false,
      }));
      vaultGlobal = (vMetaRaw && typeof vMetaRaw === 'object') ? vMetaRaw : {};
      vaultAgent = {
        path: '',
        hasFile: false,
        encrypted: false,
        locked: false,
        names: [],
        inheritGlobal: true,
      };
      inheritEffective = true;
    }
  } catch {
    bodyEl.innerHTML = '<div style="color:#a00;font-size:12px;">读取失败</div>';
    return;
  }

  try {
    const subEl = dialog.querySelector('#vault-sub');
    if (subEl){
      function metaText(vm){
        if (!vm || !vm.hasFile) return '未创建';
        const encrypted = !!vm.encrypted;
        const locked = !!vm.locked;
        if (encrypted && locked) return '已加密·已锁定';
        if (encrypted) return '已加密';
        return '未加密';
      }
      let text = '';
      if (legacyMode){
        text += '后端: legacy(仅全局) · ';
      }
      text += '全局：' + metaText(vaultGlobal) + ' · 代理(' + (agentId || DEFAULT_AGENT_ID) + ')：' + metaText(vaultAgent);
      if (vaultGlobal && vaultGlobal.path){ text += ' · 全局文件: ' + String(vaultGlobal.path); }
      if (vaultAgent && vaultAgent.path){ text += ' · 代理文件: ' + String(vaultAgent.path); }
      subEl.textContent = text;
    }
  } catch {}

  bodyEl.innerHTML = '';
  const container = document.createElement('div');
  container.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

  const globalSection = document.createElement('div');
  const globalHeader = document.createElement('div');
  globalHeader.style.cssText = 'font-size:13px;font-weight:600;color:#333;margin-bottom:4px;';
  globalHeader.textContent = '全局';
  const globalList = document.createElement('div');
  globalList.id = 'vault-list-global';
  for (const v of vars){
    if (v && v.storedGlobal){
      globalList.appendChild(buildVaultRow(v, vaultGlobal, vaultAgent, 'global'));
    }
  }
  if (vaultGlobal && vaultGlobal.hasFile && !globalList.querySelector('.vault-row')){
    const warn = document.createElement('div');
    warn.style.cssText = 'font-size:12px;color:#b58900;background:#fff7e0;border-radius:6px;padding:6px 8px;margin-top:4px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const msg = document.createElement('span');
    msg.textContent = '检测到全局保险箱文件，但当前未显示任何变量，可能是已加密且锁定或旧版创建的文件。';
    const btn = document.createElement('button');
    btn.textContent = '解锁并加载已保存变量';
    btn.addEventListener('click', async ()=>{
      try {
        const passEl = dialog.querySelector('#vault-passphrase');
        const pass = String((passEl && passEl.value) || '').trim();
        if (!pass){
          appendLog('[vault] 请输入保险箱口令后再解锁');
          if (passEl && typeof passEl.focus === 'function'){ try { passEl.focus(); } catch {} }
          return;
        }
        const ok = await postVaultEnv({ scope:'global', set:{}, unset:[], passphrase: pass });
        if (!ok) return;
        appendLog('[vault] 已解锁全局变量');
        close();
        try { openVault().catch(()=>{}) } catch {}
      } catch {
        appendLog('[vault] 解锁失败');
      }
    });
    warn.appendChild(msg);
    warn.appendChild(btn);
    globalList.appendChild(warn);
  }

  const addGlobal = document.createElement('div');
  addGlobal.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px;';
  addGlobal.innerHTML = 
    '<span style="font-size:12px;color:#666;">新增全局变量</span>' +
    '<input id="vault-new-global-name" placeholder="名称（仅限 ARCANA_* 或 *_API_KEY）" style="flex:0 0 280px;padding:6px;border:1px solid #ddd;border-radius:6px;" />' +
    '<input id="vault-new-global-value" placeholder="值" type="password" style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;" />' +
    '<button id="vault-add-global">添加</button>';
  addGlobal.querySelector('#vault-add-global').addEventListener('click', ()=>{
    const nInput = addGlobal.querySelector('#vault-new-global-name');
    const vInput = addGlobal.querySelector('#vault-new-global-value');
    const n = String((nInput||{}).value || '').trim();
    const v = String((vInput||{}).value || '');
    if (!n) return;
    const row = buildVaultRow({ name:n, hasValue:false, storedGlobal:false, storedAgent:false }, vaultGlobal, vaultAgent, 'global');
    const pwd = row.querySelector('input[type=password]');
    if (pwd){ pwd.value = v; }
    globalList.appendChild(row);
    if (nInput) nInput.value = '';
    if (vInput) vInput.value = '';
  });

  globalSection.appendChild(globalHeader);
  globalSection.appendChild(globalList);
  globalSection.appendChild(addGlobal);

  const agentSection = document.createElement('div');
  const agentHeader = document.createElement('div');
  agentHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:4px;';
  const agentTitle = document.createElement('div');
  agentTitle.style.cssText = 'font-size:13px;font-weight:600;color:#333;';
  agentTitle.textContent = '代理';
  const inheritWrap = document.createElement('div');
  inheritWrap.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;color:#666;';
  inheritWrap.innerHTML = 
    '<label style="display:flex;align-items:center;gap:4px;">' +
    '  <input id="vault-inherit-global" type="checkbox" />' +
    '  <span>继承全局密码</span>' +
    '</label>' +
    '<span style="margin-left:8px;color:#999;">仅作用于代理：' + String(agentId || DEFAULT_AGENT_ID) + '</span>';
  const inheritBox = inheritWrap.querySelector('#vault-inherit-global');
  if (inheritBox){ inheritBox.checked = !!inheritEffective; }
  if (legacyMode){
    inheritWrap.style.display = 'none';
    inheritWrap.style.pointerEvents = 'none';
    inheritWrap.style.opacity = '0.6';
  }
  agentHeader.appendChild(agentTitle);
  agentHeader.appendChild(inheritWrap);

  const agentList = document.createElement('div');
  agentList.id = 'vault-list-agent';
  if (legacyMode){
    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;color:#666;background:#f5f5f5;border-radius:6px;padding:6px 8px;margin-top:4px;';
    info.textContent = '当前服务端不支持代理级密码箱；请重启/升级后端以启用。';
    agentList.appendChild(info);
  } else {
    for (const v of vars){
      if (v && v.storedAgent){
        agentList.appendChild(buildVaultRow(v, vaultGlobal, vaultAgent, 'agent'));
      }
    }
    if (vaultAgent && vaultAgent.hasFile && !agentList.querySelector('.vault-row')){
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:12px;color:#b58900;background:#fff7e0;border-radius:6px;padding:6px 8px;margin-top:4px;display:flex;align-items:center;justify-content:space-between;gap:8px;';
      const msg = document.createElement('span');
      msg.textContent = '检测到代理保险箱文件，但当前未显示任何变量，可能是已加密且锁定或旧版创建的文件。';
      const btn = document.createElement('button');
      btn.textContent = '解锁并加载已保存变量';
      btn.addEventListener('click', async ()=>{
        try {
          const passEl = dialog.querySelector('#vault-passphrase');
          const pass = String((passEl && passEl.value) || '').trim();
          if (!pass){
            appendLog('[vault] 请输入保险箱口令后再解锁');
            if (passEl && typeof passEl.focus === 'function'){ try { passEl.focus(); } catch {} }
            return;
          }
          const payload = { scope:'agent', agentId, set:{}, unset:[], passphrase: pass };
          const ok = await postVaultEnv(payload);
          if (!ok) return;
          appendLog('[vault] 已解锁代理变量');
          close();
          try { openVault().catch(()=>{}) } catch {}
        } catch {
          appendLog('[vault] 解锁失败');
        }
      });
      warn.appendChild(msg);
      warn.appendChild(btn);
      agentList.appendChild(warn);
    }
  }

  const addAgent = document.createElement('div');
  addAgent.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px;';
  if (!legacyMode){
    addAgent.innerHTML = 
      '<span style="font-size:12px;color:#666;">新增代理变量</span>' +
      '<input id="vault-new-agent-name" placeholder="名称（仅限 ARCANA_* 或 *_API_KEY）" style="flex:0 0 280px;padding:6px;border:1px solid #ddd;border-radius:6px;" />' +
      '<input id="vault-new-agent-value" placeholder="值" type="password" style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;" />' +
      '<button id="vault-add-agent">添加</button>';
    addAgent.querySelector('#vault-add-agent').addEventListener('click', ()=>{
      const nInput = addAgent.querySelector('#vault-new-agent-name');
      const vInput = addAgent.querySelector('#vault-new-agent-value');
      const n = String((nInput||{}).value || '').trim();
      const v = String((vInput||{}).value || '');
      if (!n) return;
      const row = buildVaultRow({ name:n, hasValue:false, storedGlobal:false, storedAgent:false }, vaultGlobal, vaultAgent, 'agent');
      const pwd = row.querySelector('input[type=password]');
      if (pwd){ pwd.value = v; }
      agentList.appendChild(row);
      if (nInput) nInput.value = '';
      if (vInput) vInput.value = '';
    });
  } else {
    addAgent.style.display = 'none';
  }

  agentSection.appendChild(agentHeader);
  agentSection.appendChild(agentList);
  if (!legacyMode) agentSection.appendChild(addAgent);

  container.appendChild(globalSection);
  container.appendChild(agentSection);

  const passWrap = document.createElement('div');
  passWrap.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:8px;font-size:12px;color:#666;';
  passWrap.innerHTML = 
    '<span style="flex:0 0 auto;">保险箱口令</span>' +
    '<input id="vault-passphrase" type="password" placeholder="用于解锁/加密持久化文件" style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;" />' +
    '<label style="display:flex;align-items:center;gap:4px;flex:0 0 auto;">' +
    '  <input id="vault-remember-pass" type="checkbox" />' +
    '  <span>记住（本页会话）</span>' +
    '</label>';
  const passInput = passWrap.querySelector('#vault-passphrase');
  if (passInput){ passInput.value = VAULT_PASSPHRASE_CACHE || ''; }

  container.appendChild(passWrap);
  bodyEl.appendChild(container);

  dialog.querySelector('#vault-save').addEventListener('click', async ()=>{
    try {
      const globalListEl = dialog.querySelector('#vault-list-global');
      const agentListEl = dialog.querySelector('#vault-list-agent');
      const globalRows = globalListEl ? Array.from(globalListEl.querySelectorAll('.vault-row')) : [];
      const agentRows = agentListEl ? Array.from(agentListEl.querySelectorAll('.vault-row')) : [];
      const allRows = globalRows.concat(agentRows);

      const setGlobal = {}; const unsetGlobal = [];
      const setAgent = {}; const unsetAgent = [];
      const clearAll = new Set();

      for (const r of allRows){
        const name = String(r.dataset.varName || '').trim(); if (!name) continue;
        const clear = r.querySelector('input[type=checkbox][data-kind=clear]');
        if (clear && clear.checked){
          clearAll.add(name);
        }
      }

      for (const name of clearAll){
        unsetGlobal.push(name);
        unsetAgent.push(name);
      }

      for (const r of globalRows){
        const name = String(r.dataset.varName || '').trim(); if (!name) continue;
        if (clearAll.has(name)) continue;
        const val = r.querySelector('input[type=password]');
        const v = String((val && val.value) || '');
        if (!v) continue;
        setGlobal[name] = v;
      }

      for (const r of agentRows){
        const name = String(r.dataset.varName || '').trim(); if (!name) continue;
        if (clearAll.has(name)) continue;
        const val = r.querySelector('input[type=password]');
        const v = String((val && val.value) || '');
        if (!v) continue;
        setAgent[name] = v;
      }

      const passEl = dialog.querySelector('#vault-passphrase');
      const rememberEl = dialog.querySelector('#vault-remember-pass');
      const pass = String((passEl && passEl.value) || '');
      if (rememberEl && rememberEl.checked){
        VAULT_PASSPHRASE_CACHE = pass;
      } else {
        VAULT_PASSPHRASE_CACHE = '';
      }
      const inheritEl = dialog.querySelector('#vault-inherit-global');
      const inheritGlobal = inheritEl ? !!inheritEl.checked : true;

      if (Object.keys(setGlobal).length || unsetGlobal.length){
        const payloadGlobal = { scope:'global', set:setGlobal, unset:unsetGlobal };
        if (pass) payloadGlobal.passphrase = pass;
        const okGlobal = await postVaultEnv(payloadGlobal);
        if (!okGlobal) return;
      }

      if (!legacyMode){
        const payloadAgent = { scope:'agent', agentId, set:setAgent, unset:unsetAgent, inheritGlobal };
        if (pass) payloadAgent.passphrase = pass;
        const okAgent = await postVaultEnv(payloadAgent);
        if (!okAgent) return;
      }

      appendLog('[vault] 已保存');
      close();
    } catch { appendLog('[vault] 保存失败'); }
  });
}

try { (document.getElementById('cfg-vault')||{}).addEventListener('click', ()=>{ openVault().catch(()=>{}) }) } catch {}
