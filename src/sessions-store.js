import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { arcanaHomePath, ensureArcanaHomeDir } from './arcana-home.js'
import { fileURLToPath } from 'node:url'

// Simple JSON-backed chat session store under /sessions
// Schema: { id, title, workspace, createdAt, updatedAt, messages: [{ role: 'user'|'assistant', text, ts }] }

// Internal: compute arcana package root (arcana/)
function arcanaPkgRoot(){
  try { const here = fileURLToPath(new URL('.', import.meta.url)); return join(here, '..'); } catch { return process.cwd(); }
}

let migrationChecked = false;

// Best-effort one-time migration from legacy .sessions folders to ARCANA_HOME/sessions
function migrateLegacySessions(targetDir){
  if (migrationChecked) return; migrationChecked = true;
  try{
    // If target already has sessions, skip migration
    try { const names = readdirSync(targetDir).filter(n=>n.endsWith('.json')); if (names.length) return; } catch {}
    const legacyRoots = [
      join(arcanaPkgRoot(), '.sessions'),          // arcana/.sessions when running from repo
      join(process.cwd(), '.sessions'),            // project root .sessions (if any)
    ];
    for (const root of legacyRoots){
      if (!existsSync(root)) continue;
      let migrated = 0;
      try{
        const names = readdirSync(root).filter(n=>n.endsWith('.json'));
        for (const name of names){
          const src = join(root, name);
          const dst = join(targetDir, name);
          if (existsSync(dst)) continue;
          try { copyFileSync(src, dst); migrated++; } catch {}
        }
      } catch {}
      if (migrated > 0) return; // stop after first legacy root with files
    }
  } catch {}
}

// Session store directory: /sessions
function dir(){
  const home = ensureArcanaHomeDir()
  const d = arcanaHomePath('sessions')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  // Attempt legacy migration when the store is first touched
  migrateLegacySessions(d)
  return d
}

function nowIso(){ return new Date().toISOString() }

function slug(s){
  return String(s||'').toLowerCase().trim()
    .replace(/[^a-z0-9\-\_\s]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'session'
}

export function createSession({ title, workspace }={}){
  const t = String(title||'新会话').trim()
  const stamp = nowIso().replace(/[:.]/g,'-').replace('T','_').replace('Z','')
  const id = stamp + '--' + slug(t)
  const obj = { id, title: t, workspace: String(workspace||'').trim() || undefined, createdAt: nowIso(), updatedAt: nowIso(), messages: [] }
  const path = join(dir(), id + '.json')
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8')
  return obj
}

export function listSessions(){
  const d = dir()
  const out = []
  for (const name of readdirSync(d)){
    if (!name.endsWith('.json')) continue
    const p = join(d, name)
    try {
      const st = statSync(p)
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      out.push({
        id: raw.id || name.replace(/\.json$/,''),
        title: raw.title || '新会话',
        workspace: raw.workspace || '',
        createdAt: raw.createdAt || new Date(st.ctimeMs).toISOString(),
        updatedAt: raw.updatedAt || new Date(st.mtimeMs).toISOString(),
        last: (Array.isArray(raw.messages) && raw.messages.length) ? raw.messages[raw.messages.length-1] : null,
      })
    } catch {}
  }
  out.sort((a,b)=> String(b.updatedAt).localeCompare(String(a.updatedAt)) )
  return out
}

export function loadSession(id){
  const p = join(dir(), String(id||'').trim() + '.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
}

export function saveSession(obj){
  if (!obj || !obj.id) return false
  obj.updatedAt = nowIso()
  const p = join(dir(), obj.id + '.json')
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8')
  return true
}

export function appendMessage(sessionId, { role, text }){
  const id = String(sessionId||'').trim()
  if (!id) return null
  const obj = loadSession(id) || { id, title:'新会话', createdAt: nowIso(), updatedAt: nowIso(), messages: [] }
  obj.messages = Array.isArray(obj.messages) ? obj.messages : []
  obj.messages.push({ role: String(role||'user'), text: String(text||''), ts: nowIso() })
  saveSession(obj)
  return obj
}

export function deleteSession(id){
  const p = join(dir(), String(id||'').trim() + '.json')
  try { unlinkSync(p); return true } catch { return false }
}

export function buildHistoryPreludeText(obj){
  if (!obj || !Array.isArray(obj.messages) || !obj.messages.length) return ''
  const lines = []
  lines.push('[Conversation History — keep for context]\n')
  for (const m of obj.messages){
    const role = (m.role === 'assistant' ? 'Assistant' : 'User')
    const t = String(m.text||'')
    const chunk = t.length > 3000 ? ('…' + t.slice(-3000)) : t
    lines.push(role + ': ' + chunk)
  }
  return lines.join('\n')
}

export default {
  createSession,
  listSessions,
  loadSession,
  saveSession,
  appendMessage,
  deleteSession,
  buildHistoryPreludeText,
}
