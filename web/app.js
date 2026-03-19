// Arcana web chat (WeChat-like UI) — streaming via SSE
const messages = document.querySelector('#messages');
const input = document.querySelector('#input');
const sendBtn = document.querySelector('#send');
let activeAssistant = null; // current assistant bubble to stream text into

// Detect Electron + macOS to enable custom draggable titlebar
let __arcana_isElectron = false;
let __arcana_isElectronMac = false;
try{
  const hasArcanaBridge = (typeof window !== 'undefined') && !!(window.arcana);
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
  const platform = (typeof navigator !== 'undefined' && navigator.platform) ? navigator.platform : '';
  __arcana_isElectron = !!(hasArcanaBridge || (ua && ua.includes('Electron')));
  if (__arcana_isElectron){
    try{ document.documentElement.classList.add('is-electron'); } catch {}
    if (platform && platform.includes('Mac')){
      __arcana_isElectronMac = true;
      try{ document.documentElement.classList.add('is-electron-mac'); } catch {}
    }
  }
} catch {}

const GATEWAY_V2_SESSION_KEY_LS = 'arcana.v2.sessionKey.v1';
const API_TOKEN_LS_KEY = 'arcana.apiToken.v1';
const VOICE_INGRESS_BASE_URL = 'http://127.0.0.1:28920/voice';
const VOICE_TRIGGER_CN = '\u6253\u5f00\u8bed\u97f3';
let gatewayV2Enabled = false;
let gatewayV2Detected = false;
let gatewayV2ProbePromise = null;
let gatewayV2SessionKey = '';
let gatewayV2Ws = null;
const gatewayV2Pending = new Map();
let __apiTokenPromptedOnce = false;
let __apiTokenHydratedOnce = false;

// Gateway v2 runner auto-start dedupe cache
let __v2RunnerLastKey = '';
let __v2RunnerInFlight = null;

async function ensureV2RunnerStarted(){
  try{
    if (!gatewayV2Enabled) return;
    const agentId = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    let sessionId = '';
    try {
      const sidFn = (typeof getCurrentSessionId === 'function') ? getCurrentSessionId : null;
      sessionId = String((sidFn ? sidFn() : currentId) || '');
    } catch {}
    const sessionKey = getGatewayV2SessionKeyFor(agentId, sessionId);
    if (!sessionKey) return;
    const key = String(agentId || '') + '|' + sessionKey;
    if (__v2RunnerLastKey === key){
      // already attempted for this key; if a start is in-flight, await best-effort
      if (__v2RunnerInFlight){ try { await __v2RunnerInFlight; } catch {} }
      return;
    }
    __v2RunnerLastKey = key;
    const body = { agentId, sessionKey, runnerId: 'reactor' };
    const p = (async ()=>{
      try{
        const token = getStoredApiToken();
        const headers = token ? { 'content-type':'application/json', 'authorization':'Bearer ' + token } : { 'content-type':'application/json' };
        const r = await fetch('/v2/runners/start', { method:'POST', headers, body: JSON.stringify(body) });
        if (!r || !r.ok){
          try{ const preview = r ? await r.clone().text() : ''; appendLog('[v2] runner start failed: HTTP ' + (r ? r.status : '?') + (preview ? (' ' + _collapse(preview)) : '')); } catch { appendLog('[v2] runner start failed: HTTP ' + ((r && r.status) || '?')); }
          return;
        }
        // Try parse JSON, but tolerate non-JSON responses
        let j = null;
        try { j = await r.json(); } catch {
          // Non-JSON is acceptable: just log and return silently
          // Avoid throwing to keep UX smooth
          return;
        }
        if (!j || j.ok !== true){ appendLog('[v2] runner start failed: server rejected'); }
      } catch(e){
        try { appendLog('[v2] runner start failed: ' + (((e && e.message) || e))); } catch {}
      }
    })();
    __v2RunnerInFlight = p;
    try { await p; } catch {}
  } catch {}
}

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

function getGatewayV2SessionKeyFor(agentId, sessionId){
  try{
    const aid = String(agentId || DEFAULT_AGENT_ID);
    const sid = String(sessionId || '').trim();
    if (sid){
      const key = 'sess:' + aid + ':' + sid;
      try { localStorage.setItem(GATEWAY_V2_SESSION_KEY_LS, key); } catch {}
      try { gatewayV2SessionKey = key; } catch {}
      return key;
    }
  } catch {}
  try { gatewayV2SessionKey = gatewayV2SessionKey || ensureGatewayV2SessionKey(); } catch {}
  return String(gatewayV2SessionKey || 'session');
}

function getGatewayV2SessionKeyForCurrent(){
  try{
    const agentId = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    let sid = '';
    try {
      const sidFn = (typeof getCurrentSessionId === 'function') ? getCurrentSessionId : null;
      sid = String((sidFn ? sidFn() : currentId) || '');
    } catch {}
    return getGatewayV2SessionKeyFor(agentId, sid);
  } catch {
    try { gatewayV2SessionKey = gatewayV2SessionKey || ensureGatewayV2SessionKey(); } catch {}
    return String(gatewayV2SessionKey || 'session');
  }
}

function hasVoiceOpenIntent(text){
  try{
    const raw = String(text || '');
    const t = raw.trim();
    if (!t) return false;
    const lower = t.toLowerCase();

    // Preserve legacy exact triggers
    if (t === VOICE_TRIGGER_CN || lower === '/voice' || lower === '/mic') return true;

    const compact = t.replace(/\s+/g, '');
    if (!compact) return false;

    // Guard against explicit negatives combined with voice
    const hasVoiceWord = compact.includes('\u8bed\u97f3'); // "\u8bed\u97f3" = "voice (CN)"
    const hasNegation = (
      compact.includes('\u4e0d\u8981') || // "\u4e0d\u8981" = "do not want"
      compact.includes('\u4e0d\u60f3') || // "\u4e0d\u60f3" = "do not want"
      compact.includes('\u5173\u95ed') || // "\u5173\u95ed" = "close"
      compact.includes('\u5173\u6389')    // "\u5173\u6389" = "shut down"
    );
    if (hasVoiceWord && hasNegation) return false;

    // Chinese intent patterns, matched as substrings (not exact matches)
    const cnPhrases = [
      '\u6253\u5f00\u8bed\u97f3\u901a\u8bdd', // "open voice call"
      '\u5f00\u542f\u8bed\u97f3\u901a\u8bdd', // "enable voice call"
      '\u5f00\u59cb\u8bed\u97f3\u901a\u8bdd', // "start voice call"
      '\u6253\u5f00\u8bed\u97f3',           // "open voice"
      '\u5f00\u542f\u8bed\u97f3',           // "enable voice"
      '\u5f00\u59cb\u8bed\u97f3',           // "start voice"
      '\u8bed\u97f3\u8f93\u5165'            // "voice input"
    ];
    for (let i = 0; i < cnPhrases.length; i++){
      if (compact.includes(cnPhrases[i])) return true;
    }

    // English intent patterns, matched case-insensitively
    const lowerNormalized = lower.replace(/\s+/g, ' ').trim();
    const enPhrases = [
      'voice input',
      'start voice',
      'start voice input',
      'open voice',
      'enable voice',
      'voice mode'
    ];
    for (let i = 0; i < enPhrases.length; i++){
      if (lowerNormalized.includes(enPhrases[i])) return true;
    }

    return false;
  } catch { return false; }
}

function maybeOpenVoiceIngress(trimmedText){
  try{
    const raw = String(trimmedText || '');
    const t = raw.trim();
    if (!t) return false;
    if (!hasVoiceOpenIntent(t)) return false;
    const agentId = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const sessionKey = getGatewayV2SessionKeyForCurrent();
    const base = VOICE_INGRESS_BASE_URL || '';
    if (!base || !agentId || !sessionKey) return false;
    let url = base;
    let sep = '?';
    if (url.indexOf('?') !== -1) sep = '&';
    url = url + sep + 'agentId=' + encodeURIComponent(agentId) + '&sessionKey=' + encodeURIComponent(sessionKey);
    let win = null;
    try { win = window.open(url, '_blank', 'noopener'); } catch {}
    if (!win){
      let navigated = false;
      try{
        if (window && window.location && typeof window.location.assign === 'function'){
          window.location.assign(url);
          navigated = true;
        }
      } catch {}
      if (!navigated){
        try { alert('Voice console URL: ' + url); } catch {}
      }
    }
    try{
      if (input){
        input.value = '';
        autoResize();
      }
    } catch {}
    return true;
  } catch { return false; }
}

async function bindGatewayV2ReactorToSession(sessionId){
  try{
    if (!gatewayV2Enabled) return;
    const sid = String(sessionId || '');
    if (!sid) return;
    const agentId = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const sk = getGatewayV2SessionKeyFor(agentId, sid);
    if (!sk) return;
    const qs = 'agentId=' + encodeURIComponent(agentId) + '&sessionKey=' + encodeURIComponent(sk) + '&scope=reactor';

    let value = null;
    let version = undefined;
    let canPatch = false;
    try{
      const token = getStoredApiToken();
      const headers = token ? { 'authorization':'Bearer ' + token } : undefined;
      const r = await fetch('/v2/state?' + qs, headers ? { method:'GET', headers } : { method:'GET' });
      let j = null;
      try { j = await r.json(); } catch {}
      if (r && r.ok && j && typeof j === 'object' && j.ok === true && j.state && typeof j.state === 'object'){
        const s = j.state;
        const hasVersion = Object.prototype.hasOwnProperty.call(s, 'version');
        const hasObjectValue = s.value && typeof s.value === 'object';
        if (hasObjectValue) value = s.value;
        if (hasVersion) version = s.version;
        if (hasVersion && (hasObjectValue || s.value === null)) canPatch = true;
      }
    } catch {}

    if (!canPatch) return;

    const next = { ...(value || {}), sessionId: sid };
    const body = { agentId, sessionKey: sk, scope:'reactor', expectedVersion: version, value: next };
    const token2 = getStoredApiToken();
    const headers2 = token2 ? { 'content-type':'application/json', 'authorization':'Bearer ' + token2 } : { 'content-type':'application/json' };
    const r2 = await fetch('/v2/state', { method:'PATCH', headers: headers2, body: JSON.stringify(body) });
    if (r2 && r2.status === 409){
      try{
        let value2 = null;
        let version2 = undefined;
        let canPatch2 = false;
        const token3 = getStoredApiToken();
        const headers3 = token3 ? { 'authorization':'Bearer ' + token3 } : undefined;
        const r3 = await fetch('/v2/state?' + qs, headers3 ? { method:'GET', headers: headers3 } : { method:'GET' });
        let j3 = null;
        try { j3 = await r3.json(); } catch {}
        if (r3 && r3.ok && j3 && typeof j3 === 'object' && j3.ok === true && j3.state && typeof j3.state === 'object'){
          const s3 = j3.state;
          const hasVersion2 = Object.prototype.hasOwnProperty.call(s3, 'version');
          const hasObjectValue2 = s3.value && typeof s3.value === 'object';
          if (hasObjectValue2) value2 = s3.value;
          if (hasVersion2) version2 = s3.version;
          if (hasVersion2 && (hasObjectValue2 || s3.value === null)) canPatch2 = true;
        }
        if (!canPatch2) return;
        const next2 = { ...(value2 || {}), sessionId: sid };
        const body2 = { agentId, sessionKey: sk, scope:'reactor', expectedVersion: version2, value: next2 };
        const token4 = getStoredApiToken();
        const headers4 = token4 ? { 'content-type':'application/json', 'authorization':'Bearer ' + token4 } : { 'content-type':'application/json' };
        try { await fetch('/v2/state', { method:'PATCH', headers: headers4, body: JSON.stringify(body2) }); } catch {}
      } catch {}
    }
  } catch {}
}

function getStoredApiToken(){
  try{
    if (typeof localStorage === 'undefined') return '';
    const v = localStorage.getItem(API_TOKEN_LS_KEY) || '';
    return String(v || '').trim();
  } catch { return ''; }
}

function setStoredApiToken(token){
  let stored = false;
  try{
    if (typeof localStorage === 'undefined') return;
    const v = String(token || '').trim();
    if (!v) return;
    localStorage.setItem(API_TOKEN_LS_KEY, v);
    stored = true;
  } catch {}
  if (!stored) return;
  try{
    // Best-effort: once a token is stored, try to hydrate agents and sessions.
    (async ()=>{
      try { await loadAgents(); } catch {}
      try { await refreshList(); } catch {}
    })();
  } catch {}
}

// Monkey-patch fetch early so all API calls automatically attach Authorization
// and trigger a one-time token prompt on 401.
try{
  const __origFetch = window.fetch;
  if (typeof __origFetch === 'function'){
    window.fetch = async function patchedFetch(input, init){
      let url = '';
      try{
        if (typeof input === 'string') url = input;
        else if (input && typeof input.url === 'string') url = input.url;
      } catch {}

      const isApi = (typeof url === 'string') && (url.startsWith('/api/') || url.startsWith('/v2/'));

      let firstOpts = init || {};
      if (isApi){
        let token = getStoredApiToken();
        if (!token && !__apiTokenHydratedOnce && __arcana_isElectron){
          __apiTokenHydratedOnce = true;
          try{
            if (window.arcana && typeof window.arcana.getApiToken === 'function'){
              const hydrated = await window.arcana.getApiToken();
              if (hydrated){
                setStoredApiToken(hydrated);
                token = getStoredApiToken();
              }
            }
          } catch {}
        }
        if (token){
          const baseHeaders = (firstOpts && firstOpts.headers) ? firstOpts.headers : {};
          const headers = (baseHeaders && typeof baseHeaders === 'object' && !Array.isArray(baseHeaders)) ? { ...baseHeaders } : {};
          if (!headers['authorization'] && !headers['Authorization']){
            headers['authorization'] = 'Bearer ' + token;
          }
          firstOpts = { ...firstOpts, headers };
        }
      }

      let res = await __origFetch(input, firstOpts);

      if (isApi && res && res.status === 401 && !getStoredApiToken()){
        if (!__apiTokenPromptedOnce){
          __apiTokenPromptedOnce = true;
          let entered = '';
          try{
            entered = window.prompt('请输入 Arcana API Token，用于访问 /api 和 /v2 接口：', '');
          } catch {}
          if (entered){
            setStoredApiToken(entered);
            const token2 = getStoredApiToken();
            if (token2){
              const baseHeaders2 = (init && init.headers) ? init.headers : {};
              const headers2 = (baseHeaders2 && typeof baseHeaders2 === 'object' && !Array.isArray(baseHeaders2)) ? { ...baseHeaders2 } : {};
              if (!headers2['authorization'] && !headers2['Authorization']){
                headers2['authorization'] = 'Bearer ' + token2;
              }
              const retryOpts = { ...(init || {}), headers: headers2 };
              try{
                res = await __origFetch(input, retryOpts);
              } catch {}
            }
          }
        }
      }

      return res;
    };
  }
} catch {}

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
//   // Per-turn usage, indexed by turn index
//   //   startSessionTokens: number (session total at turn start)
//   //   lastSessionTokens: number (latest known session total)
//   //   lastContextTokens: number (latest known context window)
//   //   turnTokens: number (LLM + tools tokens this turn)
//   //   toolTokens: number (tool-only tokens this turn)
//   //   llmTokens: number (LLM-only tokens this turn)
//   turnUsage: Map<turnIndex, { startSessionTokens:number, lastSessionTokens:number, lastContextTokens:number, turnTokens:number, toolTokens:number, llmTokens:number }>,
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
        ctxTokens: (typeof a.ctxTokens === 'number' && a.ctxTokens >= 0) ? a.ctxTokens : undefined,
        tokTokens: (typeof a.tokTokens === 'number' && a.tokTokens >= 0) ? a.tokTokens : undefined,
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
        const tt = (typeof v.turnTokens === 'number' && v.turnTokens >= 0) ? v.turnTokens : 0;
        const toolT = (typeof v.toolTokens === 'number' && v.toolTokens >= 0) ? v.toolTokens : 0;
        const llmT = (typeof v.llmTokens === 'number' && v.llmTokens >= 0) ? v.llmTokens : 0;
        tu.push([idx, { startSessionTokens: s0, lastSessionTokens: s1, lastContextTokens: c1, turnTokens: tt, toolTokens: toolT, llmTokens: llmT }]);
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
      const ctxTokens = (typeof raw.ctxTokens === 'number' && raw.ctxTokens >= 0) ? raw.ctxTokens : undefined;
      const tokTokens = (typeof raw.tokTokens === 'number' && raw.tokTokens >= 0) ? raw.tokTokens : undefined;
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
        ctxTokens,
        tokTokens,
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
      const tt = (typeof rawUsage.turnTokens === 'number' && rawUsage.turnTokens >= 0) ? rawUsage.turnTokens : 0;
      const toolT = (typeof rawUsage.toolTokens === 'number' && rawUsage.toolTokens >= 0) ? rawUsage.toolTokens : 0;
      const llmT = (typeof rawUsage.llmTokens === 'number' && rawUsage.llmTokens >= 0) ? rawUsage.llmTokens : 0;
      panel.turnUsage.set(idx, { startSessionTokens: s0, lastSessionTokens: s1, lastContextTokens: c1, turnTokens: tt, toolTokens: toolT, llmTokens: llmT });
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
        ctxTokens: undefined,
        tokTokens: undefined,
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
      try{
        const usage = data && data.usage ? data.usage : null;
        if (usage && typeof usage.totalTokens === 'number' && usage.totalTokens >= 0){
          action.tokTokens = Number(usage.totalTokens) || 0;
        }
        let ctxVal = undefined;
        if (typeof data.contextTokens === 'number' && data.contextTokens >= 0){
          ctxVal = Number(data.contextTokens) || 0;
        } else {
          try{
            const snap = ensureLiveForSession(sid);
            if (snap && typeof snap.contextTokens === 'number' && snap.contextTokens >= 0){
              ctxVal = Number(snap.contextTokens) || 0;
            }
          } catch {}
        }
        if (typeof ctxVal === 'number' && ctxVal >= 0){
          action.ctxTokens = ctxVal;
        }
      } catch {}
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
  // Newest-first: iterate action ids in reverse so latest actions render on top
  for (const id of Array.from(panel.order).slice().reverse()){
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
  // Newest-first: show latest turns first (descending by turn index)
  const sortedTurnKeys = Array.from(allTurnKeysSet).map((k)=>Number(k)).filter((n)=>!Number.isNaN(n)).sort((a,b)=>b-a);
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
    let turnTokens = 0;
    if (usage && typeof usage === 'object'){
      if (typeof usage.startSessionTokens === 'number' && usage.startSessionTokens >= 0) startSess = usage.startSessionTokens;
      if (typeof usage.lastSessionTokens === 'number' && usage.lastSessionTokens >= 0) lastSess = usage.lastSessionTokens;
      if (typeof usage.lastContextTokens === 'number' && usage.lastContextTokens >= 0) lastCtx = usage.lastContextTokens;
      if (typeof usage.turnTokens === 'number' && usage.turnTokens >= 0) turnTokens = usage.turnTokens;
    }
    if (lastSess < startSess) lastSess = startSess;
    const delta = Math.max(0, lastSess - startSess);
    const tokValue = (typeof turnTokens === 'number' && turnTokens > 0) ? turnTokens : delta;

    const badges = document.createElement('div');
    badges.className = 'tools-turn-badges';

    const tokBadge = document.createElement('div');
    tokBadge.className = 'tools-turn-badge tools-turn-badge-tok';
    tokBadge.textContent = 'TOK ' + formatCompactNumber(tokValue);

    badges.appendChild(tokBadge);

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
      const pillCls =
        cat === 'web' ? 'tools-pill tools-pill-web' :
        cat === 'cli' ? 'tools-pill tools-pill-cli' :
        cat === 'think' ? 'tools-pill tools-pill-think' :
        cat === 'code' ? 'tools-pill tools-pill-code' :
        cat === 'integrations' ? 'tools-pill tools-pill-int' :
        'tools-pill tools-pill-other';
      pill.className = pillCls;
      pill.textContent = (
        cat === 'cli' ? 'CLI' :
        cat === 'web' ? 'WEB' :
        cat === 'think' ? 'THINK' :
        cat === 'code' ? 'CODE' :
        cat === 'integrations' ? 'INT' :
        'TOOL'
      );
      const nameEl = document.createElement('div');
      nameEl.className = 'tools-card-name';
      nameEl.textContent = a.toolName || '(unnamed)';

      const headerRight = document.createElement('div');
      headerRight.className = 'tools-card-header-right';
      const statusEl = document.createElement('div');
      statusEl.className = 'tools-card-status';
      statusEl.textContent = a.status === 'running' ? 'Running' : a.status === 'error' ? 'Error' : 'Done';

      const badgeRow = document.createElement('div');
      badgeRow.className = 'tools-card-badges';
      const tokForCard = (typeof a.tokTokens === 'number' && a.tokTokens > 0) ? a.tokTokens : null;
      const ctxForCard = (typeof a.ctxTokens === 'number' && a.ctxTokens >= 0) ? a.ctxTokens : null;
      if (tokForCard != null){
        const tokBadge = document.createElement('div');
        tokBadge.className = 'tools-turn-badge tools-turn-badge-tok tools-card-badge';
        tokBadge.textContent = 'TOK ' + formatCompactNumber(tokForCard);
        badgeRow.appendChild(tokBadge);
      }
      if (ctxForCard != null){
        const ctxBadge = document.createElement('div');
        ctxBadge.className = 'tools-turn-badge tools-turn-badge-ctx tools-card-badge';
        ctxBadge.textContent = 'CTX ' + formatCompactNumber(ctxForCard);
        badgeRow.appendChild(ctxBadge);
      }
      if (badgeRow.childNodes.length){
        headerRight.appendChild(badgeRow);
      }

      header.appendChild(pill);
      header.appendChild(nameEl);
      header.appendChild(statusEl);
      if (headerRight.childNodes.length){
        header.appendChild(headerRight);
      }
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

function appendMessage(role, text = '', ts = ''){
	const wrap = document.createElement('div');
	wrap.className = 'msg ' + (role === 'user' ? 'me' : 'other');
	const avatar = document.createElement('img');
	avatar.className = 'avatar';
	avatar.alt = role;
	avatar.src = avatarPath(role);
	const col = document.createElement('div');
	col.className = 'msg-col';
	const bubble = document.createElement('div');
	bubble.className = 'bubble';
	bubble.textContent = text;
	col.appendChild(bubble);
	const timeEl = document.createElement('div');
	timeEl.className = 'msg-time';
	if (ts) {
		try { const d = new Date(ts); if (!isNaN(d.getTime())) timeEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch {}
	}
	if (!timeEl.textContent) {
		try { timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch {}
	}
	col.appendChild(timeEl);
	wrap.appendChild(avatar);
	wrap.appendChild(col);
	messages.appendChild(wrap);
	messages.scrollTop = messages.scrollHeight;
	return bubble;
}

function ensureBubbleParts(bubble){
  if (!bubble) return null;
  try {
    if (bubble.__arcanaParts && bubble.__arcanaParts.text && bubble.__arcanaParts.media) return bubble.__arcanaParts;
  } catch {}

  let textEl = null;
  let mediaEl = null;
  try {
    for (const ch of Array.from(bubble.children || [])){
      if (!textEl && ch.classList && ch.classList.contains('bubble-text')) textEl = ch;
      if (!mediaEl && ch.classList && ch.classList.contains('bubble-media')) mediaEl = ch;
    }
  } catch {}

  if (!textEl || !mediaEl){
    const initial = (bubble.textContent || '');
    bubble.textContent = '';
    textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = initial;
    mediaEl = document.createElement('div');
    mediaEl.className = 'bubble-media';
    bubble.appendChild(textEl);
    bubble.appendChild(mediaEl);
  }

  const parts = { text: textEl, media: mediaEl };
  try { bubble.__arcanaParts = parts; } catch {}
  return parts;
}

// Client-side MEDIA: helpers (mirror server/server.mjs behavior)
function normalizeMediaRef(raw){
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  const mdMatch = s.match(/^\[[^\]]*]\(([^)]+)\)/);
  if (mdMatch && mdMatch[1]){
    s = mdMatch[1].trim();
  } else {
    const first = s[0];
    const last = s[s.length - 1];
    if (!(first && first === last && (first === '"' || first === '\'' || first === '`'))){
      s = s.split(/\s+/)[0];
    }
  }
  const strip = new Set(["'", '"', '`', '(', ')', '[', ']', '<', '>', ',', ';']);
  while (s.length && strip.has(s[0])){
    s = s.slice(1).trimStart();
  }
  while (s.length && strip.has(s[s.length - 1])){
    s = s.slice(0, -1).trimEnd();
  }
  while (s.length && strip.has(s[0])){
    s = s.slice(1).trimStart();
  }
  while (s.length && strip.has(s[s.length - 1])){
    s = s.slice(0, -1).trimEnd();
  }
  return s;
}

function extractMediaFromAssistantText(text){
  const mediaRefs = [];
  if (!text) return { text: '', mediaRefs };
  const lines = String(text || '').split(/\r?\n/);
  let inFence = false;
  const outLines = [];
  for (const line of lines){
    const trimmed = line.trim();
    if (trimmed.startsWith('```')){
      const count = (line.match(/```/g) || []).length;
      if (count % 2 === 1) inFence = !inFence;
      outLines.push(line);
      continue;
    }
    if (inFence){
      outLines.push(line);
      continue;
    }
    if (trimmed.startsWith('MEDIA:')){
      const idx = line.indexOf('MEDIA:');
      const raw = idx >= 0 ? line.slice(idx + 6) : '';
      const ref = normalizeMediaRef(raw);
      if (ref) mediaRefs.push(ref);
      continue;
    }
    outLines.push(line);
  }
  return { text: outLines.join('\n'), mediaRefs };
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
    }
  });
} catch {}

function qs(id){ return document.getElementById(id); }

// --- Full Shell (policy=open) persistence + UI ---
// Storage keys
const FULLSHELL_LS_PREFIX = 'arcana.fullshell.v1:'; // format: arcana.fullshell.v1:<agentId>:<sessionId>
const FULLSHELL_PENDING_SS = 'arcana.fullshell.pending.v1'; // sessionStorage flag when no session yet

function fullshellKey(agentId, sessionId){
  try{ return FULLSHELL_LS_PREFIX + String(agentId || DEFAULT_AGENT_ID) + ':' + String(sessionId || ''); } catch { return FULLSHELL_LS_PREFIX + (agentId || DEFAULT_AGENT_ID) + ':' + (sessionId || '') }
}

function loadFullshellPolicy(agentId, sessionId){
  try{
    if (typeof localStorage === 'undefined') return null;
    const key = fullshellKey(agentId, sessionId);
    const v = localStorage.getItem(key);
    if (v == null) return null;
    return (v === '1' || v === 'true' || v === 'open');
  } catch { return null }
}

function saveFullshellPolicy(agentId, sessionId, checked){
  try{
    if (typeof localStorage === 'undefined') return;
    const key = fullshellKey(agentId, sessionId);
    localStorage.setItem(key, checked ? '1' : '0');
  } catch(e){ try{ warnStorageQuota(); } catch{} }
}

function getPendingFullshell(){
  try{
    if (typeof sessionStorage === 'undefined') return null;
    const v = sessionStorage.getItem(FULLSHELL_PENDING_SS);
    if (v == null) return null;
    return (v === '1' || v === 'true' || v === 'open');
  } catch { return null }
}

function setPendingFullshell(checked){
  try{ if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(FULLSHELL_PENDING_SS, checked ? '1' : '0'); } catch {}
}

function clearPendingFullshell(){
  try{ if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(FULLSHELL_PENDING_SS); } catch {}
}

function applyFullshellUi(checked){
  try{ document.body && document.body.classList && document.body.classList.toggle('fullshell-open', !!checked); } catch {}
}

function persistPendingFullshellFor(sessionId, agentId){
  try{
    const sid = String(sessionId || ''); if (!sid) return;
    const fallbackAid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const aid = String(agentId || fallbackAid || DEFAULT_AGENT_ID);
    const pending = getPendingFullshell();
    if (pending == null) return;
    saveFullshellPolicy(aid, sid, !!pending);
    clearPendingFullshell();
    const el = qs('fullshell'); if (el) el.checked = !!pending;
    applyFullshellUi(!!pending);
  } catch {}
}

// Wire checkbox change handler
try{
  const cb = qs('fullshell');
  if (cb && cb.addEventListener){
    cb.addEventListener('change', ()=>{
      try{
        const checked = !!cb.checked;
        applyFullshellUi(checked);
        let sid = '';
        try{ sid = getCurrentSessionId() || currentId || ''; } catch {}
        const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
        if (sid){ saveFullshellPolicy(aid, sid, checked); }
        else { setPendingFullshell(checked); }
      } catch {}
    });
  }
} catch {}

const HISTORY_COMPRESSION_DEFAULT_ENABLED = true;
const HISTORY_COMPRESSION_DEFAULT_THRESHOLD = 100000;
const HISTORY_COMPRESSION_DEFAULT_KEEP_TURNS = 10;

function parseHistoryCompressionEnabled(raw, fallback){
  let out = !!fallback;
  try{
    if (typeof raw === 'boolean'){
      out = raw;
    } else if (raw != null){
      const s = String(raw).trim().toLowerCase();
      if (s){
        if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'none' || s === 'null') out = false;
        else if (s === '1' || s === 'true' || s === 'yes' || s === 'on') out = true;
      }
    }
  } catch {}
  return out;
}

function parseHistoryCompressionNumber(raw, fallback){
  let out = fallback;
  try{
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0){
      out = Math.floor(num);
    }
  } catch {}
  return out;
}

async function loadConfigUI(){
  try{
    // Global default config
    let globalCfg = {};
    try{
      const token = getStoredApiToken();
      const headers = token ? { 'authorization':'Bearer ' + token } : undefined;
      const r = await fetch('/api/config', headers ? { headers } : undefined);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      globalCfg = await r.json();
    }catch(e){ appendLog('[config] 读取全局配置失败'); globalCfg = {}; }

    if (qs('cfg-provider-global')) qs('cfg-provider-global').value = globalCfg.provider || '';
    if (qs('cfg-model-global')) qs('cfg-model-global').value = globalCfg.model || '';
    if (qs('cfg-base-url-global')) qs('cfg-base-url-global').value = globalCfg.base_url || '';
    if (qs('cfg-key-set-global')) qs('cfg-key-set-global').textContent = globalCfg.has_key ? '已设置' : '未设置';

    const globalEnabledRaw = (globalCfg && Object.prototype.hasOwnProperty.call(globalCfg, 'history_compression_enabled'))
      ? globalCfg.history_compression_enabled
      : HISTORY_COMPRESSION_DEFAULT_ENABLED;
    const globalCompressEnabled = parseHistoryCompressionEnabled(globalEnabledRaw, HISTORY_COMPRESSION_DEFAULT_ENABLED);

    const globalThresholdRaw = (globalCfg && Object.prototype.hasOwnProperty.call(globalCfg, 'history_compression_threshold_tokens'))
      ? globalCfg.history_compression_threshold_tokens
      : HISTORY_COMPRESSION_DEFAULT_THRESHOLD;
    const globalCompressThreshold = parseHistoryCompressionNumber(globalThresholdRaw, HISTORY_COMPRESSION_DEFAULT_THRESHOLD);

    const globalKeepRaw = (globalCfg && Object.prototype.hasOwnProperty.call(globalCfg, 'history_compression_keep_user_turns'))
      ? globalCfg.history_compression_keep_user_turns
      : HISTORY_COMPRESSION_DEFAULT_KEEP_TURNS;
    const globalCompressKeep = parseHistoryCompressionNumber(globalKeepRaw, HISTORY_COMPRESSION_DEFAULT_KEEP_TURNS);

    const gEnabledEl = qs('cfg-compress-enabled-global'); if (gEnabledEl) gEnabledEl.checked = !!globalCompressEnabled;
    const gThreshEl = qs('cfg-compress-threshold-global'); if (gThreshEl) gThreshEl.value = String(globalCompressThreshold);
    const gKeepEl = qs('cfg-compress-keep-user-turns-global'); if (gKeepEl) gKeepEl.value = String(globalCompressKeep);
    // Update default (global) model label cache
    try { __setCachedModelLabel(DEFAULT_AGENT_ID, globalCfg); } catch {}

    // Current agent override config
    try{
      const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
      const url = '/api/agent-config?agentId=' + encodeURIComponent(aid);
      const token2 = getStoredApiToken();
      const headers2 = token2 ? { 'authorization':'Bearer ' + token2 } : undefined;
      const r2 = await fetch(url, headers2 ? { headers: headers2 } : undefined);
      if (!r2.ok) throw new Error('HTTP ' + r2.status);
      const agentCfg = await r2.json();
      if (qs('cfg-provider-agent')) qs('cfg-provider-agent').value = agentCfg.provider || '';
      if (qs('cfg-model-agent')) qs('cfg-model-agent').value = agentCfg.model || '';
      // Update per-agent model label cache
      try { __setCachedModelLabel(aid, agentCfg); } catch {}
      if (qs('cfg-base-url-agent')) qs('cfg-base-url-agent').value = agentCfg.base_url || '';
      if (qs('cfg-key-set-agent')) qs('cfg-key-set-agent').textContent = agentCfg.has_key ? '已设置' : '未设置';

      let agentCompressEnabled = globalCompressEnabled;
      try{
        if (agentCfg && Object.prototype.hasOwnProperty.call(agentCfg, 'history_compression_enabled')){
          agentCompressEnabled = parseHistoryCompressionEnabled(agentCfg.history_compression_enabled, globalCompressEnabled);
        }
      } catch {}

      let agentCompressThreshold = globalCompressThreshold;
      try{
        if (agentCfg && Object.prototype.hasOwnProperty.call(agentCfg, 'history_compression_threshold_tokens')){
          agentCompressThreshold = parseHistoryCompressionNumber(agentCfg.history_compression_threshold_tokens, globalCompressThreshold);
        }
      } catch {}

      let agentCompressKeep = globalCompressKeep;
      try{
        if (agentCfg && Object.prototype.hasOwnProperty.call(agentCfg, 'history_compression_keep_user_turns')){
          agentCompressKeep = parseHistoryCompressionNumber(agentCfg.history_compression_keep_user_turns, globalCompressKeep);
        }
      } catch {}

      const aEnabledEl = qs('cfg-compress-enabled-agent'); if (aEnabledEl) aEnabledEl.checked = !!agentCompressEnabled;
      const aThreshEl = qs('cfg-compress-threshold-agent'); if (aThreshEl) aThreshEl.value = String(agentCompressThreshold);
      const aKeepEl = qs('cfg-compress-keep-user-turns-agent'); if (aKeepEl) aKeepEl.value = String(agentCompressKeep);
    }catch(e){
      if (qs('cfg-provider-agent')) qs('cfg-provider-agent').value = '';
      if (qs('cfg-model-agent')) qs('cfg-model-agent').value = '';
      if (qs('cfg-base-url-agent')) qs('cfg-base-url-agent').value = '';
      if (qs('cfg-key-set-agent')) qs('cfg-key-set-agent').textContent = '未设置';
      const aEnabledEl = qs('cfg-compress-enabled-agent'); if (aEnabledEl) aEnabledEl.checked = !!globalCompressEnabled;
      const aThreshEl = qs('cfg-compress-threshold-agent'); if (aThreshEl) aThreshEl.value = String(globalCompressThreshold);
      const aKeepEl = qs('cfg-compress-keep-user-turns-agent'); if (aKeepEl) aKeepEl.value = String(globalCompressKeep);
      appendLog('[config] 读取 Agent 配置失败');
    }
    // Best-effort: refresh live info model label immediately
    try { if (currentId) renderLiveInfoFor(currentId); } catch {}
  }catch(e){ appendLog('[config] 读取失败'); }
}

async function saveGlobalConfigUI(){
  try{
    const payload = {
      provider: (qs('cfg-provider-global')||{}).value || '',
      model: (qs('cfg-model-global')||{}).value || '',
      base_url: (qs('cfg-base-url-global')||{}).value || '',
    };

    const gEnabledEl = qs('cfg-compress-enabled-global');
    const historyCompressionEnabled = (gEnabledEl && typeof gEnabledEl.checked !== 'undefined') ? !!gEnabledEl.checked : HISTORY_COMPRESSION_DEFAULT_ENABLED;

    const gThreshEl = qs('cfg-compress-threshold-global');
    const threshRaw = gThreshEl ? String(gThreshEl.value || '').trim() : '';
    const historyCompressionThreshold = parseHistoryCompressionNumber(threshRaw || HISTORY_COMPRESSION_DEFAULT_THRESHOLD, HISTORY_COMPRESSION_DEFAULT_THRESHOLD);

    const gKeepEl = qs('cfg-compress-keep-user-turns-global');
    const keepRaw = gKeepEl ? String(gKeepEl.value || '').trim() : '';
    const historyCompressionKeep = parseHistoryCompressionNumber(keepRaw || HISTORY_COMPRESSION_DEFAULT_KEEP_TURNS, HISTORY_COMPRESSION_DEFAULT_KEEP_TURNS);

    payload.history_compression_enabled = historyCompressionEnabled;
    payload.history_compression_threshold_tokens = historyCompressionThreshold;
    payload.history_compression_keep_user_turns = historyCompressionKeep;

    const key = (qs('cfg-key-global')||{}).value || '';
    if (key) payload.key = key;
    const token = getStoredApiToken();
    const headers = token ? { 'content-type':'application/json', 'authorization':'Bearer ' + token } : { 'content-type':'application/json' };
    const r = await fetch('/api/config', { method:'POST', headers, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[config] 保存全局配置失败'); return; }
    if (qs('cfg-key-global')) qs('cfg-key-global').value = '';
    await loadConfigUI();
    try { if (currentId) renderLiveInfoFor(currentId); } catch {}
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

    const aEnabledEl = qs('cfg-compress-enabled-agent');
    if (aEnabledEl && typeof aEnabledEl.checked !== 'undefined'){
      payload.history_compression_enabled = !!aEnabledEl.checked;
    }

    const aThreshEl = qs('cfg-compress-threshold-agent');
    if (aThreshEl){
      const threshRaw = String(aThreshEl.value || '').trim();
      if (threshRaw){
        const num = Number(threshRaw);
        if (Number.isFinite(num) && num > 0){
          payload.history_compression_threshold_tokens = Math.floor(num);
        }
      }
    }

    const aKeepEl = qs('cfg-compress-keep-user-turns-agent');
    if (aKeepEl){
      const keepRaw = String(aKeepEl.value || '').trim();
      if (keepRaw){
        const num = Number(keepRaw);
        if (Number.isFinite(num) && num > 0){
          payload.history_compression_keep_user_turns = Math.floor(num);
        }
      }
    }

    const key = (qs('cfg-key-agent')||{}).value || '';
    if (key) payload.key = key;
    const token = getStoredApiToken();
    const headers = token ? { 'content-type':'application/json', 'authorization':'Bearer ' + token } : { 'content-type':'application/json' };
    const r = await fetch('/api/agent-config', { method:'POST', headers, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[config] 保存 Agent 配置失败'); return; }
    if (qs('cfg-key-agent')) qs('cfg-key-agent').value = '';
    try { if (currentId) renderLiveInfoFor(currentId); } catch {}
    await loadConfigUI();
    appendLog('[config] 已保存 Agent 配置');
  }catch(e){ appendLog('[config] 保存 Agent 配置失败'); }
}

async function clearAgentConfigUI(){
  try{
    const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    const body = { agentId: aid, clear: true };
    const token = getStoredApiToken();
    const headers = token ? { 'content-type':'application/json', 'authorization':'Bearer ' + token } : { 'content-type':'application/json' };
    const r = await fetch('/api/agent-config', { method:'POST', headers, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[config] 清除 Agent 配置失败'); return; }
    try { if (currentId) renderLiveInfoFor(currentId); } catch {}
    if (qs('cfg-key-agent')) qs('cfg-key-agent').value = '';
    await loadConfigUI();
    appendLog('[config] 已清除 Agent 配置');
  }catch(e){ appendLog('[config] 清除 Agent 配置失败'); }
}

async function runDoctorUI(){
  try{
    appendLog('[doctor] 正在运行...');
    const sid = getCurrentSessionId();
    const url = sid ? ('/api/doctor?sessionId=' + encodeURIComponent(sid)) : '/api/doctor';
    const token = getStoredApiToken();
    const headers = token ? { 'authorization':'Bearer ' + token } : undefined;
    const r = await fetch(url, headers ? { headers } : undefined);
    const j = await r.json();
    appendLog('[doctor] 结果: ok ' + (j.summary?.ok||0) + ' warn ' + (j.summary?.warn||0) + ' fail ' + (j.summary?.fail||0));
    ;(j.checks||[]).forEach(c=>{ appendLog(' - [' + c.status + '] ' + c.title + (c.details && c.details.model ? (': '+c.details.model) : '')); });
  }catch(e){ appendLog('[doctor] 失败'); }
}

async function createSupportBundleUI(){
  try{
    appendLog('[support] 创建中...');
    const sid = getCurrentSessionId();
    const token = getStoredApiToken();
    const headers = token ? { 'content-type':'application/json', 'authorization':'Bearer ' + token } : { 'content-type':'application/json' };
    const r = await fetch('/api/support-bundle', { method:'POST', headers, body: JSON.stringify({ sessionId: sid }) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[support] 失败'); return; }
    appendLog('[support] 完成: ' + (j.tarPath || j.dir));
    const linkWrap = qs('support-link');
    if (linkWrap){
      linkWrap.innerHTML = '';
      if (j.tarPath){
        const tarPath = String(j.tarPath || '');
        const url = '/api/local-file?path=' + encodeURIComponent(tarPath) + (sid ? ('&sessionId=' + encodeURIComponent(sid)) : '');
        const a = document.createElement('a');
        a.textContent = '下载支持包 (tar.gz)';

        const tokenForDownload = getStoredApiToken();
        if (tokenForDownload){
          a.href = '#';
          a.addEventListener('click', async (ev)=>{
            try{ ev.preventDefault(); } catch {}
            try{
              const tokenNow = getStoredApiToken();
              if (!tokenNow){
                try{ window.open(url, '_blank'); } catch {}
                return;
              }
              const headersDl = { 'authorization':'Bearer ' + tokenNow };
              const res = await fetch(url, { headers: headersDl });
              if (!res || !res.ok){
                try{ appendLog('[support] 下载失败 HTTP ' + (res ? res.status : '?')); } catch {}
                return;
              }
              const blob = await res.blob();
              let filename = '';
              try{
                const idx = tarPath.lastIndexOf('/');
                filename = (idx >= 0) ? tarPath.slice(idx + 1) : tarPath;
              } catch {}
              if (!filename) filename = 'support-bundle.tar.gz';
              const blobUrl = URL.createObjectURL(blob);
              const tmpA = document.createElement('a');
              tmpA.href = blobUrl;
              tmpA.download = filename;
              try{ document.body.appendChild(tmpA); } catch {}
              try{ tmpA.click(); } catch {}
              setTimeout(()=>{
                try{ if (tmpA.parentNode) tmpA.parentNode.removeChild(tmpA); } catch {}
                try{ URL.revokeObjectURL(blobUrl); } catch {}
              }, 0);
            } catch(e){
              try{ appendLog('[support] 下载失败'); } catch {}
            }
          });
        } else {
          a.href = url;
          a.target = '_blank';
        }
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

// Small retry/backoff for agents loading (primarily for Electron)
const AGENTS_RETRY_BASE_MS = 300;
const AGENTS_RETRY_MAX_MS = 2000;
const AGENTS_RETRY_MAX_ATTEMPTS = 3;
let __agentsRetryAttempt = 0;
let __agentsRetryBackoffMs = 0;
let __agentsRetryTimer = null;

// Live Info backing state: global + per-session
// Per-agent model label cache (from config UI fetches)
// Keyed by agentId; use DEFAULT_AGENT_ID for global default.
const __modelLabelByAgent = new Map();

function __formatModelLabelFromConfig(cfg){
  try{
    const provider = String((cfg && cfg.provider) || '').trim();
    const model = String((cfg && cfg.model) || '').trim();
    const base = String((cfg && (cfg.base_url || cfg.baseUrl)) || '').trim();
    const isEmpty = !provider && !model && !base;
    if (isEmpty) return '<auto>';
    let head = '';
    if (provider && model) head = provider + ':' + model;
    else if (provider) head = provider;
    else if (model) head = model;
    else head = '<auto>';
    if (base) head += ' @ ' + base;
    return head;
  } catch { return '<auto>' }
}

function __setCachedModelLabel(agentId, cfg){
  try{
    const aid = String(agentId || DEFAULT_AGENT_ID);
    const label = __formatModelLabelFromConfig(cfg||{});
    __modelLabelByAgent.set(aid, label);
  } catch {}
}

function __getCachedModelLabel(agentId){
  try{
    const aid = String(agentId || DEFAULT_AGENT_ID);
    const v = __modelLabelByAgent.get(aid);
    return (typeof v === 'string') ? v : '';
  } catch { return '' }
}

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
    const token = getStoredApiToken();
    const headers = (opts && opts.headers) ? { ...opts.headers } : {};
    if (token){ headers['authorization'] = 'Bearer ' + token; }
    const finalOpts = opts ? { ...opts, headers } : { headers };
    const r = await fetch(url, finalOpts);
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
    const token = getStoredApiToken();
    const headers = token ? { 'authorization':'Bearer ' + token } : undefined;
    const r = await fetch(url, headers ? { headers } : undefined);
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
  try { if (currentId) renderLiveInfoFor(currentId); } catch {}
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

function __resetAgentsRetryState(){
  try{
    __agentsRetryAttempt = 0;
    __agentsRetryBackoffMs = 0;
    if (__agentsRetryTimer){
      try{ clearTimeout(__agentsRetryTimer); } catch{}
      __agentsRetryTimer = null;
    }
  } catch {}
}

function __scheduleAgentsRetry(){
  try{
    if (!__arcana_isElectron) return;
    if (AGENTS_RETRY_MAX_ATTEMPTS && __agentsRetryAttempt >= AGENTS_RETRY_MAX_ATTEMPTS) return;
    const base = (typeof __agentsRetryBackoffMs === 'number' && __agentsRetryBackoffMs > 0) ? __agentsRetryBackoffMs : AGENTS_RETRY_BASE_MS;
    const delay = base > 0 ? base : AGENTS_RETRY_BASE_MS;
    __agentsRetryBackoffMs = Math.min(AGENTS_RETRY_MAX_MS, delay * 2);
    __agentsRetryAttempt++;
    if (__agentsRetryTimer){
      try{ clearTimeout(__agentsRetryTimer); } catch{}
    }
    __agentsRetryTimer = setTimeout(()=>{
      try{ loadAgents().catch(()=>{}); } catch{}
    }, delay);
  } catch {}
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
    try{ __resetAgentsRetryState(); } catch {}
  } catch(e){
    hasAgents = false;
    agents = [];
    currentAgentId = '';
    try { localStorage.removeItem(AKEY); } catch {}
    try{
      const panel = qs('agents-panel');
      const box = qs('agents-list');
      if (panel) panel.style.display = '';
      if (box){
        box.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'agent-empty';
        err.textContent = '加载 Agent 列表失败，请检查 Arcana API Token 或服务器设置。';
        box.appendChild(err);
      }
    } catch {}
    try{ __scheduleAgentsRetry(); } catch {}
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
    div.innerHTML = '<div class=sess-row>' + prefix + '<span class="sess-title">' + title + '</span></div>' + metaTime + metaWs;
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '×'; del.title = '删除会话';
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
  const prevId = currentId;
  setCurrent(id);
  renderMessages([]); // clear
  if (prevId && prevId !== id){
    try{ gatewayV2Pending.clear(); } catch{}
    activeAssistant = null;
  }
  try{
    bindGatewayV2ReactorToSession(id).catch(()=>{});
  } catch{}
  const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
  // Restore fullshell policy for this session (or pending fallback)
  try{
    const cb = qs('fullshell');
    const stored = loadFullshellPolicy(aid, id);
    if (stored !== null){
      if (cb) cb.checked = !!stored;
      applyFullshellUi(!!stored);
    } else {
      const pend = getPendingFullshell();
      if (pend !== null){
        if (cb) cb.checked = !!pend;
        applyFullshellUi(!!pend);
        clearPendingFullshell();
        saveFullshellPolicy(aid, id, !!pend);
      } else {
        if (cb) cb.checked = false;
        applyFullshellUi(false);
      }
    }
  } catch {}
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
    const role = (m && m.role) ? m.role : '';
    const rawText = (m && typeof m.text === 'string') ? m.text : '';
    if (role === 'assistant'){
      const isHb = rawText.startsWith('[heartbeat]');
      let body = rawText;
      if (isHb){
        const p1 = '[heartbeat]\n\n';
        const p2 = '[heartbeat]\n';
        if (body.startsWith(p1)) body = body.slice(p1.length);
        else if (body.startsWith(p2)) body = body.slice(p2.length);
      }
      const extracted = extractMediaFromAssistantText(body);
      const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : '';
      const mediaRefs = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
      const displayText = isHb ? '💓 ' + cleanText : cleanText;
      const bubble = appendMessage('assistant', displayText, m.ts || '');
      if (isHb && bubble) bubble.classList.add('heartbeat-msg');
      if (bubble && mediaRefs.length){
        const parts = ensureBubbleParts(bubble) || {};
        const mediaEl = parts.media || bubble;
        let sidCurrent = '';
        try{
          const sidFn = (typeof getCurrentSessionId === 'function') ? getCurrentSessionId : null;
          const sid = sidFn ? sidFn() : (currentId || '');
          sidCurrent = String(sid || '');
        } catch{}
        for (const refRaw of mediaRefs){
          const ref = String(refRaw || '').trim();
          if (!ref) continue;
          const lower = ref.toLowerCase();
          let src = ref;
          if (!(lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:'))){
            const pathParam = encodeURIComponent(ref);
            const sidParam = sidCurrent ? '&sessionId=' + encodeURIComponent(sidCurrent) : '';
            src = '/api/local-file?path=' + pathParam + sidParam;
          }
          const img = document.createElement('img');
          img.src = src;
          img.style.maxWidth = '100%';
          img.style.borderRadius = '6px';
          img.style.display = 'block';
          img.style.marginTop = '8px';
          mediaEl.appendChild(img);
        }
      }
    } else {
      appendMessage(role || 'user', rawText, m.ts || '');
    }
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
    // If the user toggled before a session existed, persist pending now
    try{ persistPendingFullshellFor(created.id, currentAgentId || DEFAULT_AGENT_ID); } catch {}
    currentWorkspace = String(created.workspace || '');
    await refreshList();
    return currentId;
  }
  const ws = await pickWorkspace();
  if (!ws){ appendLog('[sessions] 未选择工作区'); throw new Error('workspace_required') }
  const created = await createSession('新会话', ws);
  setCurrent(created.id);
  // Persist pending fullshell for this newly created session
  try{ persistPendingFullshellFor(created.id, DEFAULT_AGENT_ID); } catch {}
  currentWorkspace = String(created.workspace || ws || '');
  await refreshList();
  return currentId;
}

async function sendWithSession(){
  const text = input.value.trim();
  if (!text) return;
  await ensureSession();
  const sidAtSend = currentId;
  // For non-agent sessions, ensure we have a workspace so legacy HTTP chat APIs accept the request
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
    const r = await fetch('/v2/turn-sync', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ agentId: payload.agentId, sessionKey: payload.sessionId, sessionId: payload.sessionId, text: payload.message, policy: payload.policy }) });
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok){
      const parts = [];
      let head = '';
      try { head = (j && (j.message || j.error)) ? String(j.message || j.error) : ''; } catch { head = ''; }
      if (!head) head = 'HTTP ' + (r.status || '?');
      parts.push(head);
      try { if (j && typeof j.stack === 'string' && j.stack) parts.push(String(j.stack)); } catch {}
      const text = parts.join('\n');
      if (streamingId === currentId && activeAssistant && activeAssistant.classList.contains('typing')){
        setTyping(activeAssistant, false);
        activeAssistant.textContent = text;
      }
      // Also log the server error for visibility in the logs panel
      try{ logMain(sidAtSend, text.startsWith('[error]') ? text : ('[error] ' + text)); } catch{}
      return;
    }
    if (streamingId === currentId && activeAssistant && activeAssistant.classList.contains('typing')){ setTyping(activeAssistant, false); activeAssistant.textContent = (j && j.text) || '[无响应]'; }
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
  const sessionKey = getGatewayV2SessionKeyForCurrent();
  if (!sessionKey){
    await sendWithSession();
    return;
  }
  // Ensure reactor runner is started (best-effort)
  try { await ensureV2RunnerStarted(); } catch {}
  appendMessage('user', text);
  input.value = '';
  autoResize();
  const bubble = appendMessage('assistant', '');
  activeAssistant = bubble;
  setTyping(bubble, true);
  messages.scrollTop = messages.scrollHeight;
  try{
    const policy = (qs('fullshell') && qs('fullshell').checked) ? 'open' : 'restricted';
    const sessionId = (typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : currentId) || '';
    const body = { agentId, sessionKey, sessionId, text, policy };
    const token = getStoredApiToken();
    const headers = token ? { 'content-type':'application/json', 'authorization':'Bearer ' + token } : { 'content-type':'application/json' };
    const r = await fetch('/v2/turn', { method:'POST', headers, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok || !j || j.ok === false){
      setTyping(bubble, false);
      const sid = getCurrentSessionId() || currentId || '';
      const bodyErr = j && j.error ? String(j.error) : '';
      let msg = '';
      if (!r.ok){
        msg = '[error] HTTP ' + r.status + (bodyErr ? (' ' + bodyErr) : '');
      } else {
        msg = '[error] ' + (bodyErr || 'Bad response');
      }
      bubble.textContent = msg;
      try { if (sid) logMain(sid, msg); } catch {}
      return;
    }
    // On success, still rely on Gateway v2 event stream (assistant_text/thinking_*)
    // for streaming updates, but perform a final sync so the last message
    // is never lost even if some events were dropped.
    try{
      const sidFromServer = j && j.sessionId ? String(j.sessionId) : '';
      if (sidFromServer){
        // Keep current session in sync with the backing Gateway session.
        if (!currentId || currentId !== sidFromServer){
          setCurrent(sidFromServer);
        }
        // Reload messages from the server so the final assistant message
        // matches persisted history (covers rare event-stream drops).
        await openSession(sidFromServer);
      } else {
        // Fallback: if we did not get a sessionId, at least refresh the list.
        requestRefreshList();
      }
    } catch{}
  } catch(e){
    setTyping(bubble, false);
    const sid = getCurrentSessionId() || currentId || '';
    const msg = '[error] ' + (((e && e.message) || e));
    bubble.textContent = msg;
    try { if (sid) logMain(sid, msg); } catch {}
  } finally {
    messages.scrollTop = messages.scrollHeight;
  }
}

async function handleSend(){
  const trimmed = String((input && input.value) || '').trim();
  if (!trimmed) return;
  if (maybeOpenVoiceIngress(trimmed)) return;
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
      const mode = await ensureTransportReady();
      if (mode === 'v2'){
        const agentId = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
        const sessionKey = getGatewayV2SessionKeyForCurrent();
        if (!sessionKey) return;
        const token = getStoredApiToken();
        const headers = token ? { 'content-type':'application/json', 'authorization':'Bearer ' + token } : { 'content-type':'application/json' };
        await fetch('/v2/abort', { method:'POST', headers, body: JSON.stringify({ agentId, sessionKey }) });
        return;
      }
      const sid = getCurrentSessionId(); if (!sid) return;
      const aid = currentAgentId || DEFAULT_AGENT_ID;
      const ws = (!hasAgents || !currentAgentId) ? String(currentWorkspace || '').trim() : '';
      const policy = (qs('fullshell') && qs('fullshell').checked) ? 'open' : 'restricted';
      const token = getStoredApiToken();
      const headers = token ? { 'content-type':'application/json', 'authorization':'Bearer ' + token } : { 'content-type':'application/json' };
      await fetch('/api/abort', { method:'POST', headers, body: JSON.stringify({ sessionId: sid, agentId: aid, workspace: ws || undefined, policy }) });
    } catch {}
  });
} catch {}

// SSE: single connection; filter UI updates by sessionId
async function ensureTransportReady(){
  try{
    if (gatewayV2Detected){
    if (gatewayV2Enabled){
      try { setupGatewayV2WebSocket(); } catch {}
      try { ensureV2RunnerStarted().catch(()=>{}); } catch {}
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
        const token = getStoredApiToken();
        const headers = token ? { 'authorization':'Bearer ' + token } : undefined;
        const r = await fetch('/v2/health', headers ? { method:'GET', headers } : { method:'GET' });
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
        try { setupGatewayV2WebSocket(); } catch {}
        try { ensureV2RunnerStarted().catch(()=>{}); } catch {}
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
    try{
      const token = getStoredApiToken();
      if (token){
        const sep = url.includes('?') ? '&' : '?';
        url = url + sep + 'token=' + encodeURIComponent(token);
      }
    } catch{}
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
    // Top-level gateway v2 error events
    if (payload.type === 'turn.error' || payload.type === 'scheduler.wake_error'){
      const curAgent = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
      const a = String(payload.agentId || curAgent);
      const s = String(payload.sessionKey || '');
      const expectedKey = getGatewayV2SessionKeyForCurrent();
      if (a !== curAgent) return;
      if (s && expectedKey && s !== expectedKey) return;
      const err = (typeof payload.error === 'string' && payload.error) ? payload.error : (typeof payload.message === 'string' ? payload.message : 'error');
      const st = (typeof payload.errorStack === 'string' && payload.errorStack) ? payload.errorStack : (typeof payload.stack === 'string' ? payload.stack : '');
      const sid = getCurrentSessionId() || currentId || '';
      const text = '[error] ' + String(err || 'error') + (st ? ('\n' + String(st)) : '');
      logMain(sid, text);
      return;
    }
    if (payload.type === 'event.appended'){
      const ev = payload.event;
      if (!ev || typeof ev !== 'object') return;
      const evType = ev.type;
      if (!evType) return;
      const agentId = ev.agentId || DEFAULT_AGENT_ID;
      const sessionKey = ev.sessionKey || '';
      const currentAgent = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
      const expectedKey = getGatewayV2SessionKeyForCurrent();
      if (agentId !== currentAgent) return;
      if (sessionKey && expectedKey && sessionKey !== expectedKey) return;
      if (evType === 'assistant_message'){
        const data = ev.data || {};
        const replyId = data && data.replyToEventId ? String(data.replyToEventId) : '';
        const msgSessionId = data && data.sessionId ? String(data.sessionId) : '';
        if (!msgSessionId || msgSessionId !== currentId){
          if (replyId && gatewayV2Pending.has(replyId)){
            gatewayV2Pending.delete(replyId);
          }
          try{ requestRefreshList(); } catch{}
          return;
        }
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
      if (evType === 'turn.error' || evType === 'scheduler.wake_error'){
        const d = ev.data || {};
        const err = (typeof d.error === 'string' && d.error) ? d.error : (typeof d.message === 'string' ? d.message : 'error');
        const st = (typeof d.errorStack === 'string' && d.errorStack) ? d.errorStack : (typeof d.stack === 'string' ? d.stack : '');
        const sid = getCurrentSessionId() || currentId || '';
        const msg = '[error] ' + String(err || 'error') + (st ? ('\n' + String(st)) : '');
        logMain(sid, msg);
        return;
      }
      if (evType === 'message'){
        return;
      }
    }
    // Fallback: treat other payloads as SSE-style events from the event bus
    handleArcanaEvent(payload);
  } catch {}
}


const TOOL_STREAM_LS_KEY = 'arcana.toolStreamEnabled.v1';
let toolStreamEnabled = (()=>{ try{ const v = localStorage.getItem(TOOL_STREAM_LS_KEY); return v === '1' || v === 'true'; } catch{ return false } })();

const SSE_BACKOFF_BASE_MS = 1000;
const SSE_BACKOFF_MAX_MS = 15000;
let sseBackoffMs = SSE_BACKOFF_BASE_MS;
let sseReconnectTimer = null;

function buildEventsUrl(){
  try{
    const token = getStoredApiToken();
    if (toolStreamEnabled){
      const sid = getCurrentSessionId() || currentId || '';
      if (sid){
        let url = '/api/events?toolStream=1&toolStreamSessionId=' + encodeURIComponent(sid);
        if (token){ url += '&token=' + encodeURIComponent(token); }
        return url;
      }
    }
    if (token){ return '/api/events?token=' + encodeURIComponent(token); }
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


function handleArcanaEvent(data){
      // Logs panel + lifecycle
      const sid = data.sessionId || currentId;
      if (data.type === 'open_vault'){
        try { openSecrets(Array.isArray(data.names) ? data.names : undefined, { autoCloseOnUnlock:true }).catch(()=>{}) } catch {}
        logMain(sid, 'open vault (unlock-only)' + (Array.isArray(data.names) && data.names.length ? (': ' + data.names.join(', ')) : ''));
        return;
      }
      if (data.type === 'open_secrets'){
        try { openSecrets(Array.isArray(data.names) ? data.names : []).catch(()=>{}) } catch {}
        logMain(sid, 'open secrets' + (Array.isArray(data.names) && data.names.length ? (': ' + data.names.join(', ')) : ''));
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
        try {
          const msg = typeof data.message === 'string' ? data.message : '';
          if (data.stack){ logMain(sid, (msg || '[error]') + '\n' + String(data.stack)); }
          else if (msg){ logMain(sid, '[error] ' + msg); }
          else { logMain(sid, '[error]'); }
        } catch {}
        return;
      }
      if (data.type === 'turn_start'){
        if (!data.sessionId) { return; }
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
                const start = (snap && typeof snap.sessionTokens === 'number' && snap.sessionTokens >= 0) ? snap.sessionTokens : 0;
                const ctx = (snap && typeof snap.contextTokens === 'number' && snap.contextTokens >= 0) ? snap.contextTokens : 0;
                panel.turnUsage.set(idx, {
                  startSessionTokens: start,
                  lastSessionTokens: start,
                  lastContextTokens: ctx,
                  turnTokens: 0,
                  toolTokens: 0,
                  llmTokens: 0,
                });
                try{ scheduleSaveToolPanel(sid2); } catch {}
              }
            }
          } catch {}
        } catch {}
        logMain(sid, 'turn start');
        try {
          const sid3 = String(targetId || "");
          let idx2 = Number(lastToolTurnBySession.get(sid3));
          if (!Number.isFinite(idx2)) idx2 = 0;
          upsertLlmAction(sid3, idx2, { status: "running", argsSummary: "Generating…" });
        } catch {}

        if (targetId === currentId){
          try { renderLiveInfoFor(targetId); } catch {}
          if (activeLogTab === 'tools'){ try { renderToolsPanel(targetId); } catch {} }
        }
        return;
      }

      if (data.type === 'turn_end'){
        if (!data.sessionId) { return; }
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
                const curTurn = (typeof existing.turnTokens === 'number' && existing.turnTokens >= 0) ? existing.turnTokens : 0;
                const curTool = (typeof existing.toolTokens === 'number' && existing.toolTokens >= 0) ? existing.toolTokens : 0;
                const curLlm = (typeof existing.llmTokens === 'number' && existing.llmTokens >= 0) ? existing.llmTokens : 0;
                panel.turnUsage.set(idx, {
                  startSessionTokens: start,
                  lastSessionTokens,
                  lastContextTokens,
                  turnTokens: curTurn,
                  toolTokens: curTool,
                  llmTokens: curLlm,
                });
                try{ scheduleSaveToolPanel(sid2); } catch {}
              }
            }
          }
        } catch {}
        try { markTurnDone(targetId); } catch {}
        try {
          const sid3 = String(targetId || "");
          let ti = Number(lastToolTurnBySession.get(sid3));
          if (Number.isFinite(ti)) upsertLlmAction(sid3, ti, { status: "done", setEndedAt: true });
        } catch {}

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
        try {
          const targetId = data.sessionId || sid;
          const sid2 = String(targetId || '');
          if (sid2 && data.usage && typeof data.usage.totalTokens === 'number'){
            const idx = lastToolTurnBySession.get(sid2);
            if (typeof idx === 'number' && !Number.isNaN(idx)){
              const panel = getToolPanel(sid2);
              if (panel){
                if (!panel.turnUsage) panel.turnUsage = new Map();
                const existing = panel.turnUsage.get(idx) || {};
                const curTurn = (typeof existing.turnTokens === 'number' && existing.turnTokens >= 0) ? existing.turnTokens : 0;
                const curTool = (typeof existing.toolTokens === 'number' && existing.toolTokens >= 0) ? existing.toolTokens : 0;
                const curLlm = (typeof existing.llmTokens === 'number' && existing.llmTokens >= 0) ? existing.llmTokens : 0;
                const add = Number(data.usage.totalTokens) || 0;
                const nextTurn = curTurn + (add > 0 ? add : 0);
                const nextTool = curTool + (add > 0 ? add : 0);
                panel.turnUsage.set(idx, {
                  startSessionTokens: (typeof existing.startSessionTokens === 'number' && existing.startSessionTokens >= 0) ? existing.startSessionTokens : 0,
                  lastSessionTokens: (typeof existing.lastSessionTokens === 'number' && existing.lastSessionTokens >= 0) ? existing.lastSessionTokens : 0,
                  lastContextTokens: (typeof existing.lastContextTokens === 'number' && existing.lastContextTokens >= 0) ? existing.lastContextTokens : 0,
                  turnTokens: nextTurn,
                  toolTokens: nextTool,
                  llmTokens: curLlm,
                });
                try{ scheduleSaveToolPanel(sid2); } catch {}
              }
            }
          }
        } catch {}
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
        try {
          const target = data.sessionId || sid;
          const ss = String(target || "");
          if (ss){
            let ti = Number(lastToolTurnBySession.get(ss));
            if (!Number.isFinite(ti)) ti = 0;
            upsertLlmAction(ss, ti, { appendLog: "thinking start" });
          }
        } catch {}

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
        try {
          const target = data.sessionId || sid;
          const ss = String(target || "");
          if (ss){
            let ti = Number(lastToolTurnBySession.get(ss));
            if (!Number.isFinite(ti)) ti = 0;
            const n = (typeof data.chars === "number" && data.chars >= 0) ? data.chars : 0;
            upsertLlmAction(ss, ti, { appendLog: "thinking +" + n + " chars" });
          }
        } catch {}

        logMain(sid, 'thinking progress: ' + (data.chars||0) + ' chars');
        return;
      }
      if (data.type === 'thinking_end'){
        try {
          const target = data.sessionId || sid;
          const ss = String(target || "");
          if (ss){
            let ti = Number(lastToolTurnBySession.get(ss));
            if (!Number.isFinite(ti)) ti = 0;
            const n = (typeof data.chars === "number") ? (data.chars||0) : 0;
            const ms = (typeof data.tookMs === "number") ? (data.tookMs||0) : undefined;
            const line = "thinking end: " + n + " chars" + (typeof ms === "number" ? ", " + ms + " ms" : "");
            upsertLlmAction(ss, ti, { appendLog: line });
          }
        } catch {}

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
                const add = (typeof data.totalTokens === 'number' && data.totalTokens > 0) ? Number(data.totalTokens) || 0 : 0;
                const curTurn = (typeof existing.turnTokens === 'number' && existing.turnTokens >= 0) ? existing.turnTokens : 0;
                const curTool = (typeof existing.toolTokens === 'number' && existing.toolTokens >= 0) ? existing.toolTokens : 0;
                const curLlm = (typeof existing.llmTokens === 'number' && existing.llmTokens >= 0) ? existing.llmTokens : 0;
                const nextLlm = curLlm + add;
                const nextTurn = curTurn + add;
                panel.turnUsage.set(idx, {
                  startSessionTokens: start,
                  lastSessionTokens,
                  lastContextTokens,
                  turnTokens: nextTurn,
                  toolTokens: curTool,
                  llmTokens: nextLlm,
                });
                try{ scheduleSaveToolPanel(sid2); } catch {}
                if (sid2 === getCurrentSessionId()){
                  if (activeLogTab === 'tools'){
                    renderToolsPanel(sid2);
                  } else if (activeLogTab === 'details'){
                    renderToolDetails(sid2);
                  }
                }
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
        // For non-current sessions, skip UI updates; list refresh happens on turn_end.
        if (data.sessionId && data.sessionId !== currentId){
          return;
        }
        const sid2 = data.sessionId || streamingId; if (sid2 !== currentId) return;
        // Extract MEDIA refs from text so they render as images instead of raw text
        const extracted = extractMediaFromAssistantText(data.text || '');
        const cleanText = extracted && typeof extracted.text === 'string' ? extracted.text : (data.text || '');
        const mediaRefsFromText = (extracted && Array.isArray(extracted.mediaRefs)) ? extracted.mediaRefs : [];
        try {
          const txt = typeof cleanText === "string" ? cleanText : "";
          let ti = Number(lastToolTurnBySession.get(String(sid2)));
          if (!Number.isFinite(ti)) ti = 0;
          upsertLlmAction(String(sid2), ti, { argsSummary: "Output: " + txt.length + " chars" });
        } catch {}

        if (!activeAssistant) activeAssistant = appendMessage('assistant','');
        setTyping(activeAssistant, false);
        {
        const parts = ensureBubbleParts(activeAssistant);
        if (parts && parts.text) parts.text.textContent = cleanText;
        else activeAssistant.textContent = cleanText;
        // Render MEDIA refs as images (client-side fallback for missing assistant_image events)
        if (parts && parts.media && mediaRefsFromText.length){
          let sidCurrent = '';
          try { sidCurrent = String((typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : currentId) || ''); } catch{}
          for (const refRaw of mediaRefsFromText){
            const ref = String(refRaw || '').trim();
            if (!ref) continue;
            // Skip if this image is already rendered (avoid duplicates with assistant_image SSE)
            const existingSrcs = new Set();
            try { for (const img of parts.media.querySelectorAll('img')) existingSrcs.add(img.src); } catch{}
            const lower = ref.toLowerCase();
            let src = ref;
            if (!(lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:'))){
              const pathParam = encodeURIComponent(ref);
              const sidParam = sidCurrent ? '&sessionId=' + encodeURIComponent(sidCurrent) : '';
              src = '/api/local-file?path=' + pathParam + sidParam;
            }
            // Check for duplicate by comparing the path portion
            let isDup = false;
            try { for (const existing of existingSrcs) { if (existing.includes(encodeURIComponent(ref)) || existing === src) { isDup = true; break; } } } catch{}
            if (!isDup){
              const img = document.createElement('img');
              img.src = src;
              img.style.maxWidth = '100%';
              img.style.borderRadius = '6px';
              img.style.display = 'block';
              img.style.marginTop = '8px';
              parts.media.appendChild(img);
            }
          }
        }
      }
        messages.scrollTop = messages.scrollHeight;
        try { if (currentId) markSessionSeen(currentId); } catch {}
        return;
      }
      if (data.type === 'assistant_image'){
        // For non-current sessions, skip UI updates; list refresh happens on turn_end.
        if (data.sessionId && data.sessionId !== currentId){
          return;
        }
        const sid2 = data.sessionId || streamingId; if (sid2 !== currentId) return;
        if (!activeAssistant) activeAssistant = appendMessage('assistant','');
        setTyping(activeAssistant, false);
        const parts = ensureBubbleParts(activeAssistant);
        const img = document.createElement('img');
        img.src = data.url;
        img.style.maxWidth = '100%';
        img.style.borderRadius = '6px';
        img.style.display = 'block';
        img.style.marginTop = '8px';
        if (parts && parts.media) parts.media.appendChild(img);
        else activeAssistant.appendChild(img);
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
}

function setupSseConnection(){
  try {
    if (gatewayV2Enabled) return;
    try { if (window.__arcana_global_es){ try { window.__arcana_global_es.close() } catch {} window.__arcana_global_es = null } } catch {}
    const es = new EventSource(buildEventsUrl()); window.__arcana_global_es = es;
    es.onmessage = (ev)=>{
    try{
      sseBackoffMs = SSE_BACKOFF_BASE_MS;
      const data = JSON.parse(ev.data);

      handleArcanaEvent(data);
    }catch{}
  };
  es.onerror = ()=>{
  try{
    if (gatewayV2Enabled) return;
    if (!es || es.readyState !== 2) return;
    if (typeof sseBackoffMs !== 'number' || sseBackoffMs <= 0) sseBackoffMs = SSE_BACKOFF_BASE_MS;
    const delay = sseBackoffMs;
    sseBackoffMs = Math.min(SSE_BACKOFF_MAX_MS, sseBackoffMs * 2);
    if (sseReconnectTimer){
      try{ clearTimeout(sseReconnectTimer); } catch{}
    }
    sseReconnectTimer = setTimeout(()=>{
      try{
        if (!gatewayV2Enabled) setupSseConnection();
      } catch{}
    }, delay);
  } catch{}
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

    // Prefer per-session label; treat cached '<auto>' as empty to avoid overriding richer server info.
    const selAgent = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
    let cachedSel = __getCachedModelLabel(selAgent);
    if (cachedSel === '<auto>') cachedSel = '';
    let cachedDef = __getCachedModelLabel(DEFAULT_AGENT_ID);
    if (cachedDef === '<auto>') cachedDef = '';

    let modelLabel = '';
    if (snap && typeof snap.model === 'string' && snap.model) modelLabel = String(snap.model);
    else if (cachedSel) modelLabel = cachedSel;
    else if (cachedDef) modelLabel = cachedDef;
    else if (globalLiveInfo.model) modelLabel = String(globalLiveInfo.model);
    // Final fallback should show '<auto>' if everything is empty.
    LI.model = modelLabel || '<auto>';

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

let __arcana_secretsStartupCheckScheduled = false;

function scheduleSecretsStartupCheck(){
  try{
    if (__arcana_secretsStartupCheckScheduled) return;
    __arcana_secretsStartupCheckScheduled = true;
  } catch {}
  try{
    setTimeout(async ()=>{
      try{
        const r = await fetch('/api/secrets/status', { method:'GET', cache:'no-store' });
        if (!r || !r.ok) return;
        let j = null;
        try { j = await r.json(); } catch { j = null; }
        if (!j || typeof j !== 'object') return;
        const initialized = !!j.initialized;
        const locked = !!j.locked;
        if (!initialized){
          // For uninitialized vault, always show full secrets manager so user can set it up.
          try { openSecrets().catch(()=>{}) } catch {}
        } else if (locked){
          // On startup when vault is locked, only prompt for unlock and auto-close afterwards.
          try { openSecrets(undefined, { reason:'startup', autoCloseOnUnlock:true }).catch(()=>{}) } catch {}
        }
      } catch {}
    }, 250);
  } catch {}
}

async function openSecrets(requestedNames, opts){
  // Idempotent: if a secrets overlay is already present, do nothing.
  try{
    const existing = document.querySelector('[data-arcana-secrets-overlay="1"]');
    if (existing) return;
  } catch {}

  // Backwards-compatible argument handling: openSecrets(), openSecrets(namesArray), openSecrets(opts).
  const requested = Array.isArray(requestedNames) ? requestedNames.slice() : [];
  let optsObj = opts;
  if (!optsObj && requestedNames && typeof requestedNames === 'object' && !Array.isArray(requestedNames)){
    optsObj = requestedNames;
  }
  const openOpts = (optsObj && typeof optsObj === 'object') ? optsObj : {};

  const overlay = document.createElement('div');
  try { overlay.dataset.arcanaSecretsOverlay = '1'; } catch {}
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:10000;';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'width:640px;max-width:95vw;max-height:90vh;overflow:auto;background:#fff;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.25);padding:14px;';
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  function close(){ try { document.body.removeChild(overlay); } catch {} }

  const agentId = currentAgentId || DEFAULT_AGENT_ID;

  async function render(){
    dialog.innerHTML = '<div style="font-size:12px;color:#666;">加载中…</div>';

    let data;
    try {
      const r = await fetch('/api/secrets?agentId=' + encodeURIComponent(agentId));
      data = await r.json();
    } catch (e) {
      dialog.innerHTML = '<div style="color:red;">加载失败: ' + String(e) + '</div><div style="margin-top:8px;"><button id="sec-close">关闭</button></div>';
      dialog.querySelector('#sec-close').addEventListener('click', close);
      return;
    }

    const bindings = (data && data.bindings && typeof data.bindings === 'object') ? data.bindings : {};
    const wellKnown = Array.isArray(data && data.wellKnown) ? data.wellKnown : [];
    const meta = (data && data.meta && typeof data.meta === 'object') ? data.meta : {};
    const globalMeta = (meta.global && typeof meta.global === 'object') ? meta.global : {};
    const initialized = !!globalMeta.initialized;
    const locked = !!globalMeta.locked;

    let html = '<div style="display:flex;align-items:center;gap:8px;">' +
      '<div style="font-weight:600;font-size:15px;">🔐 密钥箱（Secrets）</div>' +
      '<div id="sec-status" style="font-size:12px;color:#666;"></div>' +
      '<div style="margin-left:auto;"><button id="sec-close-top">×</button></div>' +
      '</div>';

    if (!initialized) {
      html += '<div style="margin-top:12px;background:#fff7e0;border-radius:8px;padding:12px;">' +
        '<div style="font-size:13px;font-weight:600;color:#b58900;margin-bottom:8px;">⚠ 密钥箱尚未初始化</div>' +
        '<div style="font-size:12px;color:#666;margin-bottom:8px;">首次使用需要设置口令。口令用于加密所有密钥，请牢记。</div>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
        '  <input id="sec-pass" type="password" placeholder="设置密钥箱口令" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;" />' +
        '  <button id="sec-init" style="padding:8px 16px;background:#2d7ff9;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;">初始化密钥箱</button>' +
        '</div>' +
        '</div>';
    } else if (locked) {
      html += '<div style="margin-top:12px;background:#f0f4ff;border-radius:8px;padding:12px;">' +
        '<div style="font-size:13px;font-weight:600;color:#2d7ff9;margin-bottom:8px;">🔒 密钥箱已锁定</div>' +
        '<div style="font-size:12px;color:#666;margin-bottom:8px;">输入口令解锁后才能查看或管理密钥。</div>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
        '  <input id="sec-pass" type="password" placeholder="输入密钥箱口令" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;" />' +
        '  <button id="sec-unlock" style="padding:8px 16px;background:#2d7ff9;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;">解锁</button>' +
        '  <button id="sec-reset-locked" style="padding:8px 16px;background:#e74c3c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;">重置密钥箱</button>' +
        '</div>' +
        '</div>';
    } else {
      const names = Object.keys(bindings).sort();
      const statusText = '已解锁 · ' + names.length + ' 个密钥';

      html += '<div style="margin-top:12px;">' +
        '<div style="font-size:12px;color:#27ae60;margin-bottom:8px;">🔓 ' + statusText + '</div>';
      html += '<div style="margin:8px 0 12px 0;text-align:right;">' +
        '<button id="sec-reset" style="padding:6px 10px;background:#e74c3c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">重置密钥箱</button>' +
      '</div>';

      if (names.length > 0) {
        html += '<div style="font-size:12px;font-weight:600;color:#333;margin-bottom:4px;">已保存的密钥</div>';
        html += '<div style="max-height:200px;overflow-y:auto;border:1px solid #e7e7e7;border-radius:6px;">';
        for (const n of names) {
          const b = bindings[n];
          const scopeLabel = b.hasAgent ? '代理' : (b.hasGlobal ? '全局' : '');
          const scopeColor = b.hasAgent ? '#8e44ad' : '#2d7ff9';
          html += '<div class="sec-row" data-name="' + n + '" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:12px;">' +
            '<span style="flex:1;font-family:monospace;color:#333;">' + n + '</span>' +
            '<span style="font-size:11px;color:' + scopeColor + ';background:' + scopeColor + '20;padding:1px 6px;border-radius:4px;">' + scopeLabel + '</span>' +
            '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;color:#999;"><input type="checkbox" class="sec-del-check" data-name="' + n + '" data-scope="' + (b.hasAgent ? 'agent' : 'global') + '" /><span style="font-size:11px;">删除</span></label>' +
            '</div>';
        }
        html += '</div>';
        html += '<div style="margin-top:6px;text-align:right;"><button id="sec-batch-delete" style="font-size:12px;padding:4px 12px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;">删除选中</button></div>';
      } else {
        html += '<div style="font-size:12px;color:#999;margin-bottom:8px;">暂无密钥，请在下方添加。</div>';
      }

      html += '<div style="margin-top:12px;border-top:1px solid #e7e7e7;padding-top:12px;">' +
        '<div style="font-size:12px;font-weight:600;color:#333;margin-bottom:6px;">添加密钥</div>' +
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
        '  <input id="sec-add-name" list="sec-well-known" placeholder="密钥名称（如 services/aliyun/dashscope_api_key）" style="flex:1;min-width:200px;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;font-family:monospace;" />' +
        '  <datalist id="sec-well-known">';
      for (const wk of wellKnown) {
        html += '<option value="' + wk.name + '">';
      }
      html += '</datalist>' +
        '  <input id="sec-add-value" type="password" placeholder="密钥值" style="flex:1;min-width:150px;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;" />' +
        '  <select id="sec-add-scope" style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;">' +
        '    <option value="global">全局</option>' +
        '    <option value="agent">代理</option>' +
        '  </select>' +
        '  <button id="sec-add-btn" style="padding:6px 14px;background:#27ae60;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">添加</button>' +
        '</div>' +
        '</div>';

      html += '</div>';
    }

    html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">' +
      '<button id="sec-close-bottom">关闭</button>' +
      '</div>';

    dialog.innerHTML = html;

    // Event listeners
    try { dialog.querySelector('#sec-close-top').addEventListener('click', close); } catch {}
    try { dialog.querySelector('#sec-close-bottom').addEventListener('click', close); } catch {}

    // Init button
    const initBtn = dialog.querySelector('#sec-init');
    if (initBtn) {
      initBtn.addEventListener('click', async () => {
        const pass = String((dialog.querySelector('#sec-pass') || {}).value || '').trim();
        if (!pass) { appendLog('[secrets] 请输入口令'); return; }
        initBtn.disabled = true;
        initBtn.textContent = '初始化中…';
        try {
          const r = await fetch('/api/secrets/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pass }) });
          const j = await r.json();
          if (!r.ok) {
            const parts = [];
            if (j && j.error) parts.push(String(j.error));
            if (j && j.message) parts.push(String(j.message));
            if (j && j.code) parts.push(String(j.code));
            const msg = parts.length ? parts.join(' · ') : '未知错误';
            appendLog('[secrets] 初始化失败: ' + msg);
            initBtn.disabled = false; initBtn.textContent = '初始化密钥箱'; return;
          }
          appendLog('[secrets] 密钥箱初始化成功');
          await render();
        } catch (e) { appendLog('[secrets] 初始化失败: ' + e); initBtn.disabled = false; initBtn.textContent = '初始化密钥箱'; }
      });
    }

    // Unlock button
    const unlockBtn = dialog.querySelector('#sec-unlock');
    if (unlockBtn) {
      unlockBtn.addEventListener('click', async () => {
        const pass = String((dialog.querySelector('#sec-pass') || {}).value || '').trim();
        if (!pass) { appendLog('[secrets] 请输入口令'); return; }
        unlockBtn.disabled = true;
        unlockBtn.textContent = '解锁中…';
        try {
          const r = await fetch('/api/secrets/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pass }) });
          const j = await r.json();
          if (r.status === 403) { appendLog('[secrets] 口令不正确'); unlockBtn.disabled = false; unlockBtn.textContent = '解锁'; return; }
          if (r.status === 409) { appendLog('[secrets] 密钥箱未初始化'); unlockBtn.disabled = false; unlockBtn.textContent = '解锁'; return; }
          if (!r.ok) { appendLog('[secrets] 解锁失败: ' + (j.error || j.message || '未知错误')); unlockBtn.disabled = false; unlockBtn.textContent = '解锁'; return; }
          appendLog('[secrets] 已解锁');
          if (openOpts && openOpts.autoCloseOnUnlock){
            try { close(); } catch {}
            return;
          }
          await render();
        } catch (e) { appendLog('[secrets] 解锁失败: ' + e); unlockBtn.disabled = false; unlockBtn.textContent = '解锁'; }
      });
    }

    // Reset buttons (locked and unlocked states)
    const resetBtn1 = dialog.querySelector('#sec-reset');
    const resetBtn2 = dialog.querySelector('#sec-reset-locked');
    const onReset = async () => {
      try {
        const step1 = prompt('危险操作：将永久删除所有密钥并清空记忆的口令。\n请输入大写 RESET 以确认:');
        if (!step1 || step1.trim() !== 'RESET') { appendLog('[secrets] 已取消重置（未输入 RESET）'); return; }
        if (!confirm('再次确认：是否重置密钥箱？该操作不可撤销。')) { appendLog('[secrets] 已取消重置'); return; }
        const body = { agentId };
        const r = await fetch('/api/secrets/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch {}
        if (!r.ok || !(j && j.ok)) { appendLog('[secrets] 重置失败'); return; }
        appendLog('[secrets] 已重置密钥箱（全局: ' + (j.deleted && j.deleted.global ? '删除' : '无') + '，代理: ' + (j.deleted && j.deleted.agent ? '删除' : '无') + '）');
        await render();
      } catch (e) { appendLog('[secrets] 重置失败: ' + (((e && e.message) || e))); }
    };
    if (resetBtn1) resetBtn1.addEventListener('click', ()=>{ onReset().catch(()=>{}) });
    if (resetBtn2) resetBtn2.addEventListener('click', ()=>{ onReset().catch(()=>{}) });

    // Add secret button
    const addBtn = dialog.querySelector('#sec-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const nameInput = dialog.querySelector('#sec-add-name');
        const valueInput = dialog.querySelector('#sec-add-value');
        const scopeSelect = dialog.querySelector('#sec-add-scope');
        const name = String((nameInput || {}).value || '').trim();
        const value = String((valueInput || {}).value || '');
        const scope = String((scopeSelect || {}).value || 'global');
        if (!name) { appendLog('[secrets] 请输入密钥名称'); return; }
        if (!value) { appendLog('[secrets] 请输入密钥值'); return; }
        addBtn.disabled = true;
        addBtn.textContent = '添加中…';
        try {
          const r = await fetch('/api/secrets/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, name, scope, value }) });
          const j = await r.json();
          if (r.status === 409) { appendLog('[secrets] 密钥箱未初始化'); addBtn.disabled = false; addBtn.textContent = '添加'; return; }
          if (r.status === 423) { appendLog('[secrets] 密钥箱已锁定，请先解锁'); addBtn.disabled = false; addBtn.textContent = '添加'; return; }
          if (!r.ok) { appendLog('[secrets] 添加失败: ' + (j.error || j.message || '未知错误')); addBtn.disabled = false; addBtn.textContent = '添加'; return; }
          appendLog('[secrets] 已添加: ' + name);
          await render();
        } catch (e) { appendLog('[secrets] 添加失败: ' + e); addBtn.disabled = false; addBtn.textContent = '添加'; }
      });
    }

    // Batch delete button
    const delBtn = dialog.querySelector('#sec-batch-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const checks = dialog.querySelectorAll('.sec-del-check:checked');
        if (!checks.length) { appendLog('[secrets] 未选中任何密钥'); return; }
        const delBindings = {};
        for (const c of checks) {
          const n = c.dataset.name;
          const s = c.dataset.scope || 'global';
          delBindings[n] = { scope: s, delete: true };
        }
        delBtn.disabled = true;
        delBtn.textContent = '删除中…';
        try {
          const r = await fetch('/api/secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, bindings: delBindings }) });
          const j = await r.json();
          if (!r.ok) { appendLog('[secrets] 删除失败: ' + (j.error || j.message || '未知错误')); delBtn.disabled = false; delBtn.textContent = '删除选中'; return; }
          appendLog('[secrets] 已删除 ' + checks.length + ' 个密钥');
          await render();
        } catch (e) { appendLog('[secrets] 删除失败: ' + e); delBtn.disabled = false; delBtn.textContent = '删除选中'; }
      });
    }

    // Enter key support for password inputs
    const passInput = dialog.querySelector('#sec-pass');
    if (passInput) {
      passInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const btn = dialog.querySelector('#sec-init') || dialog.querySelector('#sec-unlock');
          if (btn) btn.click();
        }
      });
      setTimeout(() => { try { passInput.focus(); } catch {} }, 100);
    }
  }

  await render();
}

try { (document.getElementById('cfg-secrets')||{}).addEventListener('click', ()=>{ openSecrets().catch(()=>{}) }) } catch {}
try { scheduleSecretsStartupCheck(); } catch {}


// Virtual LLM action per turn (no actual tool events)
function upsertLlmAction(sessionId, turnIndex, update){
  try{
    const sid = String(sessionId || getCurrentSessionId() || "");
    if (!sid) return null;
    const panel = getToolPanel(sid); if (!panel) return null;
    const idx = (typeof turnIndex === "number" && !Number.isNaN(turnIndex)) ? turnIndex : (Number(lastToolTurnBySession.get(sid))||0);
    const id = "v:llm:" + String(idx);
    const now = new Date();
    const ts = now.toLocaleTimeString();
    let a = panel.actions.get(id);
    if (!a){
      a = {
        id,
        toolName: "LLM",
        category: "think",
        status: "running",
        argsSummary: (update && update.argsSummary) ? String(update.argsSummary) : "Generating…",
        argsFull: "",
        startedAt: ts,
        endedAt: "",
        sessionId: sid,
        turnIndex: idx,
        log: "",
      };
      panel.actions.set(id, a);
      panel.order.push(id);
      if (!panel.selectedId) panel.selectedId = id;
    }
    if (update){
      if (update.status){ a.status = String(update.status); }
      if (typeof update.argsSummary !== "undefined"){ a.argsSummary = String(update.argsSummary || ""); }
      if (update.setEndedAt){ a.endedAt = ts; }
      if (typeof update.appendLog === "string" && update.appendLog){
        a.log = a.log ? (a.log + "\n" + update.appendLog) : update.appendLog;
      }
    }
    if (typeof a.log === "string" && a.log.length > TOOL_PANELS_MAX_LOG_CHARS){
      a.log = a.log.slice(-TOOL_PANELS_MAX_LOG_CHARS);
    }
    try{ scheduleSaveToolPanel(sid); } catch {}
    if (sid === getCurrentSessionId()){
      if (activeLogTab === "tools"){
        renderToolsPanel(sid);
      } else if (activeLogTab === "details"){
        renderToolDetails(sid);
      }
    }
    return a;
  } catch { return null }
}
