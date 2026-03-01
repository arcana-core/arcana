// Arcana web chat (WeChat-like UI) — streaming via SSE
const messages = document.querySelector('#messages');
const input = document.querySelector('#input');
const sendBtn = document.querySelector('#send');
let activeAssistant = null; // current assistant bubble to stream text into

// --- Session-bound, layered Logs ---
const LOG_CAP = 400; // per session per tab
const logStore = new Map(); // sessionId -> { main:[], tools:[], subagents:[] }
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
let currentId = localStorage.getItem(CKEY) || '';
let streamingId = '';
const typing = new Map(); // sessionId -> boolean

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

async function listSessions(){ const j = await _fetchJsonExpectOk('/api/sessions', undefined, 'list'); return Array.isArray(j && j.sessions) ? j.sessions : [] }
async function createSession(title, workspace){ const payload = { title: title||'新会话', workspace: String(workspace||'') }; return await _fetchJsonExpectOk('/api/sessions', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) }, 'create') }
async function deleteSession(id){ if (!id) return { ok:false }; return await _fetchJsonExpectOk('/api/sessions/' + encodeURIComponent(id), { method:'DELETE' }, 'delete') }
async function loadSession(id){
  try{
    const url = '/api/sessions/' + encodeURIComponent(id);
    const r = await fetch(url);
    if (r.status === 404) return null;
    const ct = (r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';
    if (!r.ok){ try { const body = await r.clone().text(); if (body) appendLog('[sessions] load HTTP ' + r.status + ' ' + _collapse(body)) } catch {}; throw new Error('HTTP ' + r.status) }
    if (!ct.includes('application/json')){ let preview = ''; try { preview = await r.clone().text() } catch {}; appendLog('[sessions] load non-JSON response ' + r.status + (preview ? (': ' + _collapse(preview)) : '')) }
    try { return await r.json() } catch(e){ let preview = ''; try { preview = await r.clone().text() } catch {}; appendLog('[sessions] load JSON parse error' + (preview ? (': ' + _collapse(preview)) : '')); throw e }
  } catch(e){ appendLog('[sessions] load failed: ' + (((e && e.message) || e))); throw e }
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
        const resp = await deleteSession(it.id);
        if (!resp || resp.ok !== true){ appendLog('[sessions] delete failed: server rejected'); return }
        const deletedCurrent = (it.id === currentId);
        if (deletedCurrent) setCurrent('');
        try { await refreshList() } catch {}
        if (deletedCurrent){
          try { const remain = await listSessions(); if (Array.isArray(remain) && remain.length){ await openSession(remain[0].id) } else { const obj = await createSession('新会话', await pickWorkspace() || ''); await openSession(obj.id) } }
          catch(e){ appendLog('[sessions] delete fallback failed: ' + (((e && e.message) || e))) }
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
  const obj = await loadSession(id);
  renderMessages((obj && Array.isArray(obj.messages)) ? obj.messages : []);
  // Log session workspace only when it changes to avoid duplicate lines when switching
  try { if (obj && obj.workspace) { logWorkspaceIfChanged(id, 'workspace:', obj.workspace); } } catch {}
  refreshList().catch(()=>{});
  try { renderLogsFor(id, activeLogTab) } catch {}
}

function renderMessages(msgs){ messages.innerHTML = ''; for (const m of (msgs||[])) appendMessage(m.role, m.text); messages.scrollTop = messages.scrollHeight; }

async function refreshList(){ const items = await listSessions(); items.sort((a,b)=> String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))); renderSessionList(items); }

async function ensureSession(){
  if (currentId) return currentId;
  const ws = await pickWorkspace();
  if (!ws){ appendLog('[sessions] 未选择工作区'); throw new Error('workspace_required') }
  const created = await createSession('新会话', ws);
  setCurrent(created.id);
  await refreshList();
  return currentId;
}

async function sendWithSession(){
  const text = input.value.trim();
  if (!text) return;
  await ensureSession();
  appendMessage('user', text);
  input.value = ''; autoResize();
  activeAssistant = appendMessage('assistant','');
  setTyping(activeAssistant, true);
  streamingId = currentId;
  try{
    const r = await fetch('/api/chat2', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ sessionId: currentId, message: text, policy: (qs('fullshell') && qs('fullshell').checked) ? 'open' : 'restricted' }) });
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
      try { const em = (data && data.message && data.message.errorMessage) ? String(data.message.errorMessage) : null; if (em) { logMain(sid, '[error] ' + em); } } catch {}
      if (data.type === 'server_info'){
        logMain(sid, 'model: ' + data.model);
        logMain(sid, 'tools: ' + (data.tools||[]).join(', '));
        logMain(sid, 'plugins: ' + (data.plugins||[]).length);
        // Use a distinct label for the server-reported root and cache to avoid repeats
        logWorkspaceIfChanged(sid, 'workspaceRoot:', data.workspace);
        return;
      }
      if (data.type === 'turn_start'){ logMain(sid, 'turn start'); return }
      if (data.type === 'turn_end'){ logMain(sid, 'turn end'); activeAssistant = null; return }
      if (data.type === 'tool_execution_start'){ logTools(sid, 'tool start: ' + data.toolName + (data.args ? (' ' + JSON.stringify(data.args)) : '')); return }
      if (data.type === 'tool_execution_end'){
        const isErr = !!(data.isError || data.error);
        let errMsg = '';
        if (isErr){ const cand = data.error?.message || data.error || data.result?.error?.message || data.result?.error || data.result?.stderr || data.result?.stdout; if (typeof cand === 'string') errMsg = cand; else if (cand) { try { errMsg = JSON.stringify(cand) } catch { errMsg = String(cand) } } }
        logTools(sid, 'tool end: ' + data.toolName + (isErr ? (' error: ' + (errMsg||'')) : ' ok'));
        return;
      }
      if (data.type === 'tool_repeat'){ logTools(sid, 'repeat: ' + data.toolName + ' x' + data.count + (data.args ? (' ' + JSON.stringify(data.args)) : '')); return }
      if (data.type === 'tool_execution_update'){
        const raw = (typeof data.partialResult !== 'undefined') ? data.partialResult : data.update;
        let info = '';
        if (typeof raw === 'string') info = raw; else if (raw != null) { try { info = JSON.stringify(raw) } catch { try { const seen = new Set(); info = JSON.stringify(raw, (k,v)=>{ if (typeof v === 'object' && v){ if (seen.has(v)) return '[Circular]'; seen.add(v); } return v; }) } catch { info = String(raw) } } }
        logTools(sid, 'update: ' + (data.toolName||'') + (info ? (' ' + info) : ''));
        return;
      }

      // Thinking bubbles for active chat
      if (data.type === 'thinking_start'){ if (!activeAssistant) { activeAssistant = appendMessage('assistant','') } setTyping(activeAssistant, true); logMain(sid, 'thinking start'); return }
      if (data.type === 'thinking_progress'){ if (typeof data.chars === 'number') logMain(sid, 'thinking progress: ' + data.chars + ' chars'); return }
      if (data.type === 'thinking_end'){ if (activeAssistant) setTyping(activeAssistant, false); if (typeof data.chars !== 'undefined' || typeof data.tookMs !== 'undefined') logMain(sid, 'thinking end: ' + (data.chars || 0) + ' chars, ' + (data.tookMs || 0) + ' ms'); return }

      // Stream assistant text/images to the open chat only
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
    const ws = await pickWorkspace(); if (!ws){ appendLog('[sessions] 未选择工作区'); return }
    const obj = await createSession('新会话', ws); await openSession(obj.id);
  });
} else {
  try { document.addEventListener('click', async (ev)=>{ const t = ev.target; if (t && t.id === 'new-session'){ const ws = await pickWorkspace(); if (!ws){ appendLog('[sessions] 未选择工作区'); return } const obj = await createSession('新会话', ws); await openSession(obj.id); } }); } catch {}
}

// Initial with small retry/backoff
(async ()=>{
  const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
  const attempts = 3; let delay = 300;
  for (let i=1; i<=attempts; i++){
    try{
      await refreshList();
      if (!currentId){ const items = await listSessions(); if (items && items[0]) setCurrent(items[0].id) }
      if (currentId) await openSession(currentId);
      return;
    } catch(e){ appendLog('[sessions] 初始加载失败(' + i + '/' + attempts + '): ' + (((e && e.message) || e))); if (i < attempts) { await sleep(delay); delay = Math.min(2000, delay * 2) } }
  }
})().catch((e)=>{ appendLog('[sessions] 初始加载异常: ' + (((e && e.message) || e))) });
