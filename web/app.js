// Arcana web chat (WeChat-like UI) — streaming via SSE
const messages = document.querySelector('#messages');
const input = document.querySelector('#input');
const sendBtn = document.querySelector('#send');
let activeAssistant = null; // current assistant bubble to stream text into

// --- Session-bound, layered Logs ---
const LOG_CAP = 400; // per session per tab
const logStore = new Map(); // sessionId -> { main:[], tools:[], subagents:[] }
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
function sectionSelectorFor(tab){ return tab==='tools' ? '#logs-tools' : (tab==='subagents' ? '#logs-subagents' : '#logs-main'); }
function renderLogsFor(sessionId, tab){
  const el = document.querySelector(sectionSelectorFor(tab)); if (!el) return;
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
  if (sessionId === getCurrentSessionId() && tab === activeLogTab){
    const el = document.querySelector(sectionSelectorFor(tab));
    if (el){ const d = document.createElement('div'); d.textContent = String(text||''); el.appendChild(d); el.scrollTop = el.scrollHeight; }
  }
}
function setActiveLogTab(tab){
  activeLogTab = (tab==='tools' || tab==='subagents') ? tab : 'main';
  try{ localStorage.setItem('arcana.logs.activeTab', activeLogTab); } catch {}
  try{
    const bar = document.getElementById('tabs-bar');
    if (bar){
      const btns = Array.from(bar.querySelectorAll('.tab'));
      for (const b of btns){ b.classList.toggle('active', (b && b.dataset && b.dataset.tab) === activeLogTab); }
    }
    // toggle sections visibility
    const mainEl = document.querySelector('#logs-main'); if (mainEl) mainEl.style.display = (activeLogTab==='main') ? 'block' : 'none';
    const toolsEl = document.querySelector('#logs-tools'); if (toolsEl) toolsEl.style.display = (activeLogTab==='tools') ? 'block' : 'none';
    const subEl = document.querySelector('#logs-subagents'); if (subEl) subEl.style.display = (activeLogTab==='subagents') ? 'block' : 'none';
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

// Legacy send (unused in session mode, retained for completeness)
async function send(){
  const text = input.value.trim();
  if (!text) return;
  appendMessage('user', text);
  input.value = '';
  autoResize();
  activeAssistant = appendMessage('assistant', '');
  setTyping(activeAssistant, true);
  try{
    const r = await fetch('/api/chat', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ message: text, policy: (document.querySelector('#fullshell') && document.querySelector('#fullshell').checked) ? 'open' : 'restricted' }) });
    const j = await r.json();
    if (activeAssistant && activeAssistant.classList.contains('typing')){ setTyping(activeAssistant, false); activeAssistant.textContent = j.text || '[无响应]'; }
  }catch(e){ if (activeAssistant) activeAssistant.textContent = '[错误] ' + (((e && e.message) || e)); }
  finally { messages.scrollTop = messages.scrollHeight; }
}

// Toggle advanced panel (more) + lazy-load config
try {
  let loaded = false;
  document.querySelector('.composer .icon').addEventListener('click', async ()=>{
    const p = document.querySelector('#more-panel'); if (!p) return;
    const show = (!p.style.display || p.style.display === 'none');
    p.style.display = show ? 'block' : 'none';
    if (show && !loaded){ loaded = true; try { await loadConfigUI(); } catch(e){} }
  });
} catch {}

function qs(id){ return document.getElementById(id); }

async function loadConfigUI(){
  try{
    const r = await fetch('/api/config');
    const j = await r.json();
    if (qs('cfg-provider')) qs('cfg-provider').value = j.provider || '';
    if (qs('cfg-model')) qs('cfg-model').value = j.model || '';
    if (qs('cfg-base-url')) qs('cfg-base-url').value = j.base_url || '';
    if (qs('cfg-key-set')) qs('cfg-key-set').textContent = j.has_key ? '已设置' : '未设置';
  }catch(e){ appendLog('[config] 读取失败'); }
}

async function saveConfigUI(){
  try{
    const payload = {
      provider: (qs('cfg-provider')||{}).value || '',
      model: (qs('cfg-model')||{}).value || '',
      base_url: (qs('cfg-base-url')||{}).value || '',
    };
    const key = (qs('cfg-key')||{}).value || '';
    if (key) payload.key = key;
    const r = await fetch('/api/config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok || !j.ok){ appendLog('[config] 保存失败'); return; }
    if (qs('cfg-key')) qs('cfg-key').value = '';
    await loadConfigUI();
    appendLog('[config] 已保存');
  }catch(e){ appendLog('[config] 保存失败'); }
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
try { qs('cfg-save').addEventListener('click', ()=>{ saveConfigUI().catch(()=>{}) }) } catch {}
try { qs('cfg-run-doctor').addEventListener('click', ()=>{ runDoctorUI().catch(()=>{}) }) } catch {}
try { qs('cfg-support-bundle').addEventListener('click', ()=>{ createSupportBundleUI().catch(()=>{}) }) } catch {}

// --- Sessions state ---
const CKEY = 'arcana.currentSessionId';
const AKEY = 'arcana.currentAgentId';
let currentId = localStorage.getItem(CKEY) || '';
let streamingId = '';
const typing = new Map(); // sessionId -> boolean
let agents = [];
let currentAgentId = localStorage.getItem(AKEY) || '';
let hasAgents = false;
let currentWorkspace = '';

function nowIso(){ return new Date().toISOString() }
function setCurrent(id){ currentId = id; localStorage.setItem(CKEY, id); try { window.__arcana_currentSessionId = id } catch {} }

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

  if (!hasAgents){
    refreshList().catch(()=>{});
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
  for (const it of (items||[])){
    const div = document.createElement('div');
    div.className = (it.id===currentId) ? 'sess-item active' : 'sess-item';
    div.dataset.id = it.id;
    const dot = typing.get(it.id) ? '<span class=dot></span>' : '';
    const title = (it.title||'新会话');
    const metaTime = it.updatedAt ? ('<span class=meta>' + new Date(it.updatedAt).toLocaleString() + '</span>') : '';
    const metaWs = it.workspace ? ('<span class=meta ws>' + it.workspace + '</span>') : '';
    div.innerHTML = dot + title + metaTime + metaWs;
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '删'; del.title = '删除会话';
    del.addEventListener('click', async (ev)=>{
      try{
        ev.stopPropagation && ev.stopPropagation(); ev.preventDefault && ev.preventDefault();
        const ok = confirm('确定删除该会话？此操作不可恢复。'); if (!ok) return;
        const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
        const resp = await deleteSession(it.id, aid);
        if (!resp || resp.ok !== true){ appendLog('[sessions] delete failed: server rejected'); return }
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
    box.appendChild(div);
  }
}

async function openSession(id){
  setCurrent(id);
  renderMessages([]); // clear
  const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID;
  const obj = await loadSession(id, aid);
  if (obj && obj.workspace) {
    currentWorkspace = String(obj.workspace || '');
  } else {
    currentWorkspace = '';
  }
  renderMessages((obj && Array.isArray(obj.messages)) ? obj.messages : []);
  // Log session workspace only when it changes to avoid duplicate lines when switching
  try { if (obj && obj.workspace) { logWorkspaceIfChanged(id, 'workspace:', obj.workspace); } } catch {}
  refreshList().catch(()=>{});
  try { renderLogsFor(id, activeLogTab) } catch {}
}

function renderMessages(msgs){ messages.innerHTML = ''; for (const m of (msgs||[])) appendMessage(m.role, m.text); messages.scrollTop = messages.scrollHeight; }

async function refreshList(){ const aid = (hasAgents && currentAgentId) ? currentAgentId : DEFAULT_AGENT_ID; const items = await listSessions(aid); items.sort((a,b)=> String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))); renderSessionList(items); return items; }

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
  // For non-agent sessions, ensure we have a workspace so /api/chat2 accepts the request
  if (!hasAgents || !currentAgentId){
    if (!currentWorkspace && currentId){
      try {
        const obj = await loadSession(currentId, DEFAULT_AGENT_ID);
        if (obj && obj.workspace) currentWorkspace = String(obj.workspace || '');
      } catch {}
    }
  }
  appendMessage('user', text);
  input.value = ''; autoResize();
  activeAssistant = appendMessage('assistant','');
  setTyping(activeAssistant, true);
  streamingId = currentId;
  try{
    const payload = { sessionId: currentId, message: text, policy: (qs('fullshell') && qs('fullshell').checked) ? 'open' : 'restricted', agentId: currentAgentId || DEFAULT_AGENT_ID };
    if (!hasAgents || !currentAgentId){
      const ws = String(currentWorkspace || '').trim();
      if (ws) payload.workspace = ws;
    }
    const r = await fetch('/api/chat2', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    const j = await r.json();
    if (streamingId === currentId && activeAssistant && activeAssistant.classList.contains('typing')){ setTyping(activeAssistant, false); activeAssistant.textContent = j.text || '[无响应]'; }
    await openSession(currentId);
  } catch(e) { if (activeAssistant) activeAssistant.textContent = '[错误] ' + (((e && e.message) || e)); }
  finally { messages.scrollTop = messages.scrollHeight; }
}

// Hook send to session mode
try { sendBtn.removeEventListener('click', send) } catch {}
try { input.removeEventListener('keydown', ()=>{}) } catch {}
sendBtn.addEventListener('click', ()=>{ sendWithSession().catch(()=>{}) });
input.addEventListener('keydown', (e)=>{ if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendWithSession().catch(()=>{}) } });
// Stop button -> hard abort current run
try {
  const stopBtn = document.querySelector('#stop');
  if (stopBtn) stopBtn.addEventListener('click', async ()=>{
    try{
      const sid = getCurrentSessionId(); if (!sid) return;
      const aid = currentAgentId || DEFAULT_AGENT_ID;
      await fetch('/api/abort', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ sessionId: sid, agentId: aid }) });
    } catch {}
  });
} catch {}

// SSE: single connection; filter UI updates by sessionId
try {
  try { if (window.__arcana_global_es){ try { window.__arcana_global_es.close() } catch {} window.__arcana_global_es = null } } catch {}
  const es = new EventSource('/api/events'); window.__arcana_global_es = es;
  es.onmessage = (ev)=>{
    try{
      const data = JSON.parse(ev.data);

      // Maintain typing dots in the session list (update even for other sessions)
      if (data.type === 'thinking_start' && data.sessionId){ typing.set(data.sessionId, true); refreshList().catch(()=>{}) }
      if (data.type === 'thinking_end' && data.sessionId){ typing.delete(data.sessionId); refreshList().catch(()=>{}) }

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
        // Live Info
        try { LI.model = String(data.model||''); LI.tools = Array.isArray(data.tools)? data.tools.slice() : []; LI.workspace = String(data.workspace||''); LI.skills = Array.isArray(data.skills) ? data.skills.slice() : []; renderLiveInfo(); } catch {}
        // Use a distinct label for the server-reported root and cache to avoid repeats
        logWorkspaceIfChanged(sid, 'workspaceRoot:', data.workspace);
        return;
      }
      if (data.type === 'turn_start'){
        try {
          LI.usedThisTurn = new Set();
          LI.turns += 1;
        } catch {}
        logMain(sid, 'turn start');
        return;
      }
      if (data.type === 'turn_end'){ try { if (typeof data.sessionTokens === 'number') LI.sessionTokens = Number(data.sessionTokens)||0; renderLiveInfo(); } catch {} logMain(sid, 'turn end'); activeAssistant = null; return }
      if (data.type === 'tool_execution_start'){
        try { if (data.toolName) LI.usedThisTurn.add(String(data.toolName)); renderLiveInfo(); } catch {}
        logTools(sid, 'tool start: ' + data.toolName + (data.args ? (' ' + JSON.stringify(data.args)) : ''));
        return;
      }
      if (data.type === 'tool_execution_end'){
        const isErr = !!(data.isError || data.error);
        let errMsg = '';
        if (isErr){ const cand = data.error?.message || data.error || data.result?.error?.message || data.result?.error || data.result?.stderr || data.result?.stdout; if (typeof cand === 'string') errMsg = cand; else if (cand) { try { errMsg = JSON.stringify(cand) } catch { errMsg = String(cand) } } }
        logTools(sid, 'tool end: ' + data.toolName + (isErr ? (' error: ' + (errMsg||'')) : ' ok'));
        return;
      }
      if (data.type === 'tool_repeat'){
        logTools(sid, 'repeat: ' + data.toolName + ' x' + data.count + (data.args ? (' ' + JSON.stringify(data.args)) : ''));
        return;
      }
      if (data.type === 'skills_refresh'){
        try {
          renderLiveInfo();
        } catch {}
        return;
      }
      if (data.type === 'env_refresh'){
        try { appendLog('[vault] 已刷新环境变量'); } catch {}
        return;
      }
      if (data.type === 'tool_execution_update'){
        const raw = (typeof data.partialResult !== 'undefined') ? data.partialResult : data.update;
        let info = '';
        if (typeof raw === 'string') info = raw; else if (raw != null) { try { info = JSON.stringify(raw) } catch { try { const seen = new Set(); info = JSON.stringify(raw, (k,v)=>{ if (typeof v === 'object' && v){ if (seen.has(v)) return '[Circular]'; seen.add(v); } return v; }) } catch { info = String(raw) } } }
        logTools(sid, 'update: ' + (data.toolName||'') + (info ? (' ' + info) : ''));
        return;
      }


      // New events: steer enqueued / abort done
      if (data.type === 'steer_enqueued') { logMain(sid, 'steer enqueued: ' + (data.text||'')); return }
      if (data.type === 'abort_done') { logMain(sid, 'aborted'); if (activeAssistant) setTyping(activeAssistant, false); return }

      // Thinking bubbles for active chat
      if (data.type === 'thinking_start'){ if (!activeAssistant) { activeAssistant = appendMessage('assistant','') } setTyping(activeAssistant, true); try { LI.thinkingChars = 0; LI.thinkingMs = 0; renderLiveInfo(); } catch {} logMain(sid, 'thinking start'); return }
      if (data.type === 'thinking_progress'){ if (typeof data.chars === 'number') { try { LI.thinkingChars = Number(data.chars)||0; renderLiveInfo(); } catch {} } logMain(sid, 'thinking progress: ' + (data.chars||0) + ' chars'); return }
      if (data.type === 'thinking_end'){ if (activeAssistant) setTyping(activeAssistant, false); try { if (typeof data.chars !== 'undefined') LI.thinkingChars = Number(data.chars)||0; if (typeof data.tookMs !== 'undefined') LI.thinkingMs = Number(data.tookMs)||0; renderLiveInfo(); } catch {} if (typeof data.chars !== 'undefined' || typeof data.tookMs !== 'undefined') logMain(sid, 'thinking end: ' + (data.chars || 0) + ' chars, ' + (data.tookMs || 0) + ' ms'); return }

      if (data.type === 'skills_refresh'){ try { LI.skillsHint = '技能已刷新'; renderLiveInfo(); } catch {} return }
      if (data.type === 'llm_usage'){ try { if (typeof data.contextTokens === 'number') LI.contextTokens = Number(data.contextTokens)||0; if (typeof data.sessionTokens === 'number') LI.sessionTokens = Number(data.sessionTokens)||0; renderLiveInfo(); } catch {} return }
      if (data.type === 'assistant_text'){
        const sid2 = data.sessionId || streamingId; if (sid2 !== currentId) return;
        if (!activeAssistant) activeAssistant = appendMessage('assistant','');
        setTyping(activeAssistant, false);
        activeAssistant.textContent = data.text || '';
        messages.scrollTop = messages.scrollHeight; return;
      }
      if (data.type === 'assistant_image'){
        const sid2 = data.sessionId || streamingId; if (sid2 !== currentId) return;
        if (!activeAssistant) activeAssistant = appendMessage('assistant','');
        setTyping(activeAssistant, false);
        const img = document.createElement('img');
        img.src = data.url; img.style.maxWidth = '100%'; img.style.borderRadius = '6px';
        if (activeAssistant.textContent){ const txt = activeAssistant.textContent; activeAssistant.textContent = ''; const tdiv = document.createElement('div'); tdiv.textContent = txt; activeAssistant.appendChild(tdiv); }
        activeAssistant.appendChild(img);
        messages.scrollTop = messages.scrollHeight; return;
      }

      // Subagent logs (global)
      if (data.type === 'subagent_start'){ logSubagents((data.sessionId || currentId), '[subagent] start: ' + (data.agent||'?') + ' id=' + (data.id||'')); return }
      if (data.type === 'subagent_stream'){ const chunk = String(data.chunk || ''); const short = chunk.length > 200 ? (chunk.slice(0,200) + '...') : chunk; logSubagents((data.sessionId || currentId), '[subagent ' + (data.stream||'') + '] ' + short.replace(/\s+/g,' ').trim()); return }
      if (data.type === 'subagent_error'){ logSubagents((data.sessionId || currentId), '[subagent] error: ' + (data.agent||'?') + ' code=' + data.code); return }
      if (data.type === 'subagent_end'){ logSubagents((data.sessionId || currentId), '[subagent] end: ' + (data.agent||'?') + ' code=' + data.code + ' ok=' + data.ok); return }
    }catch{}
  };
} catch {}

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
  contextTokens: 0,
skillsHint: '',
};
function liSet(id, text){ const el=document.getElementById(id); if (el) el.textContent=String((text===undefined||text===null)? '—' : text); }
function renderLiveInfo(){
  liSet('li-model', LI.model || '—');
  liSet('li-workspace', LI.workspace || '—');
  liSet('li-tools', (LI.tools && LI.tools.length) ? LI.tools.join(', ') : '—');
  liSet('li-tools-used', (LI.usedThisTurn && LI.usedThisTurn.size) ? Array.from(LI.usedThisTurn).join(', ') : '—');
  liSet('li-skills', (LI.skills && LI.skills.length) ? LI.skills.join(', ') : '—');
  liSet('li-session-tokens', (typeof LI.sessionTokens === 'number' && LI.sessionTokens >= 0) ? String(LI.sessionTokens) : '—');
  liSet('li-context', (typeof LI.contextTokens === 'number' && LI.contextTokens >= 0) ? String(LI.contextTokens) : '—');
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
