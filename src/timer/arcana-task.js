import { createArcanaSession } from '../session.js';
import { resolveWorkspaceRoot } from '../workspace-guard.js';
import { createSession, listSessions, appendMessage, loadSession } from '../sessions-store.js';
import { createWriteStream } from 'node:fs';

function tailLines(text, max=100){
  const lines = String(text||'').split('\n');
  return lines.slice(Math.max(0, lines.length - max)).join('\n');
}

function ensureSessionId({ sessionId, title }){
  const t = String(title||'').trim();
  const id = String(sessionId||'').trim();
  if (id) {
    const s = loadSession(id);
    if (s) return s.id;
  }
  if (t) {
    try {
      const arr = listSessions();
      const hit = arr.find((s)=> String(s.title||'').trim().toLowerCase() === t.toLowerCase());
      if (hit) return hit.id;
    } catch {}
    const created = createSession({ title: t });
    return created.id;
  }
  // fallback
  const created = createSession({ title: 'Arcana Timer' });
  return created.id;
}

export async function runArcanaTask({ prompt, sessionId, title, logPath }){
  const root = resolveWorkspaceRoot();
  const sid = ensureSessionId({ sessionId, title });
  const startedAtMs = Date.now();
  const log = createWriteStream(logPath, { flags: 'w' });
  const header = 'Arcana timer run at ' + (new Date(startedAtMs).toISOString()) + '\n' + 'sessionId: ' + sid + '\n';
  try { log.write(header + '\n'); } catch {}

  let textBuffer = '';
  try {
    appendMessage(sid, { role: 'user', text: String(prompt||'') });

    const { session } = await createArcanaSession({ cwd: root });
    // capture assistant text
    session.subscribe((ev)=>{
      if (ev.type === 'message_update' && ev.message.role === 'assistant'){
        const blocks = Array.isArray(ev.message.content) ? ev.message.content.filter(c=>c.type==='text') : [];
        const t = blocks.map(c=>c.text).join('');
        // Only keep tail to bound memory
        textBuffer = (textBuffer + t).slice(-20000);
      }
    });
    await session.prompt(String(prompt||''));

    appendMessage(sid, { role: 'assistant', text: textBuffer });

    try {
      log.write('Prompt:\n' + String(prompt||'') + '\n\n');
      log.write('Assistant:\n' + textBuffer + '\n');
    } catch {}

    return { ok: true, sessionId: sid, startedAtMs, finishedAtMs: Date.now(), outputTail: tailLines(textBuffer) };
  } catch (e) {
    try { log.write('Error: ' + (e?.message||String(e)) + '\n'); } catch {}
    return { ok: false, sessionId: sid, error: String(e?.message||e), startedAtMs, finishedAtMs: Date.now(), outputTail: tailLines(textBuffer) };
  } finally { try { log.end(); } catch {} }
}

export default { runArcanaTask };
