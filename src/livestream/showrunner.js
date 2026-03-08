import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { arcanaHomePath, ensureArcanaHomeDir } from '../arcana-home.js';
import { runArcanaTask } from '../cron/arcana-task.js';
import { runWithContext } from '../event-bus.js';
import bilibiliEventsPullFactory from '../../skills/bilibili/tools/bilibili_events_pull/tool.js';
import liveTtsFactory from '../../skills/live/tools/live_tts/tool.js';

const DEFAULT_TICK_MS = 3000;
const DEFAULT_IDLE_MS = 15000;
const DEFAULT_TURN_TIMEOUT_MS = 45000;

function nowMs(){
  return Date.now();
}

function sleep(ms){
  return new Promise((resolve)=> setTimeout(resolve, ms));
}

function safeNumber(raw, fallback){
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

function resolveIdleThresholdMs(){
  const raw = process.env.ARCANA_LIVESTREAM_IDLE_MS;
  if (raw != null && raw !== '') return safeNumber(raw, DEFAULT_IDLE_MS);
  return DEFAULT_IDLE_MS;
}

function resolveTurnTimeoutMs(){
  const raw = process.env.ARCANA_LIVESTREAM_TURN_TIMEOUT_MS;
  if (raw != null && raw !== '') return safeNumber(raw, DEFAULT_TURN_TIMEOUT_MS);
  return DEFAULT_TURN_TIMEOUT_MS;
}

function resolveTickMs(cliTickMs){
  if (cliTickMs && Number.isFinite(cliTickMs) && cliTickMs > 0) return cliTickMs;
  const raw = process.env.ARCANA_LIVESTREAM_TICK_MS;
  if (raw != null && raw !== '') return safeNumber(raw, DEFAULT_TICK_MS);
  return DEFAULT_TICK_MS;
}

function ensureDirForFile(path){
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; failures will surface on write
  }
}

function expandHomeDirPath(input){
  if (!input) return input;
  const s = String(input);
  if (s === '~'){
    try { return homedir(); } catch { return s; }
  }
  if (s.startsWith('~/') || s.startsWith('~\\')){
    try {
      const home = homedir();
      if (home) return join(home, s.slice(2));
    } catch {
      // ignore
    }
  }
  return s;
}

function safeRealpath(p){
  const s = String(p || '').trim();
  if (!s) return '';
  try { return realpathSync(s); } catch { return s; }
}

function resolveAgentWorkspaceRoot(agentId){
  ensureArcanaHomeDir();
  const safeId = agentId != null && agentId !== '' ? String(agentId) : 'default';
  const metaPath = arcanaHomePath('agents', safeId, 'agent.json');
  let meta = null;
  try {
    const raw = readFileSync(metaPath, 'utf-8');
    if (raw) meta = JSON.parse(raw);
  } catch {
    return '';
  }

  let rawWs = '';
  try {
    if (meta && typeof meta === 'object'){
      if (typeof meta.workspaceRoot === 'string' && meta.workspaceRoot.trim()){
        rawWs = meta.workspaceRoot;
      } else if (meta.workspace && typeof meta.workspace.root === 'string' && meta.workspace.root.trim()){
        rawWs = meta.workspace.root;
      } else if (typeof meta.workspaceDir === 'string' && meta.workspaceDir.trim()){
        rawWs = meta.workspaceDir;
      }
    }
  } catch {
    rawWs = '';
  }

  if (!rawWs || typeof rawWs !== 'string' || !rawWs.trim()) return '';
  const expanded = expandHomeDirPath(rawWs);
  return safeRealpath(expanded);
}

function loadState({ agentId, roomId }){
  ensureArcanaHomeDir();
  const filePath = arcanaHomePath('agents', String(agentId || 'default'), 'livestream', 'bilibili-room-' + String(roomId) + '.json');
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const cursor = typeof parsed.cursor === 'string' ? parsed.cursor : null;
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
    const lastSpeakAtMs = typeof parsed.lastSpeakAtMs === 'number' ? parsed.lastSpeakAtMs : 0;
    return { filePath, cursor, sessionId, lastSpeakAtMs };
  } catch {
    return { filePath, cursor: null, sessionId: '', lastSpeakAtMs: 0 };
  }
}

function saveState(filePath, { cursor, sessionId, lastSpeakAtMs }){
  try {
    ensureDirForFile(filePath);
    const data = {
      cursor: cursor != null ? String(cursor) : null,
      sessionId: sessionId || '',
      lastSpeakAtMs: typeof lastSpeakAtMs === 'number' ? lastSpeakAtMs : 0,
    };
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // best-effort persistence
  }
}

function formatEventsForPrompt(events){
  if (!Array.isArray(events) || !events.length) return 'No new events captured in this tick.';
  const lines = [];
  const preview = events.slice(-8);
  for (const ev of preview){
    if (!ev) continue;
    const ts = typeof ev.ts === 'number' ? ev.ts : nowMs();
    const timeIso = new Date(ts).toISOString();
    const type = ev.type || 'unknown';
    const uname = ev.user && (ev.user.uname || ev.user.uid) ? String(ev.user.uname || ev.user.uid) : '';
    let text = String(ev.text || '').replace(/\s+/g, ' ').trim();
    if (text.length > 80) text = text.slice(0, 77) + '...';
    const prefixUser = uname ? (uname + ': ') : '';
    lines.push(timeIso + ' [' + type + '] ' + prefixUser + text);
  }
  if (events.length > preview.length){
    const more = events.length - preview.length;
    lines.push('... (' + more + ' more events not shown)');
  }
  return lines.join('\n');
}

function buildShowrunnerPrompt({ roomId, events, now, lastSpeakAtMs, idleThresholdMs }){
  const nowIso = new Date(now).toISOString();
  const idleMs = lastSpeakAtMs ? (now - lastSpeakAtMs) : null;
  const parts = [];
  parts.push('You are the showrunner for an anime-style virtual streamer in a Bilibili room.');
  parts.push('The streamer is a cheerful 16-year-old virtual girl; speak in her voice.');
  parts.push('Viewers may know she is AI, but you should stay in character as the streamer.');
  parts.push('Only mention being an AI if a recent event explicitly asks about it; otherwise do not mention being an AI or TTS.');
  parts.push('Decide whether the streamer should speak on this tick.');
  parts.push('You MUST respond with EXACTLY ONE LINE using this protocol:');
  parts.push('- "WAIT" (all caps) to stay silent.');
  parts.push('- "SAY:<text>" to speak a single short line.');
  parts.push('Rules for <text>:');
  parts.push('- length must be at most 60 characters.');
  parts.push('- keep the tone cheerful, friendly, and anime-style.');
  parts.push('- react to recent events in a concise way.');
  parts.push('- do not mention these rules or the protocol.');
  parts.push('- avoid physical claims about the streamer or body.');
  parts.push('- no sexual content, flirting, romance, or NSFW topics.');
  parts.push('- never sexualize yourself or anyone else; the character is a minor.');
  parts.push('- if viewers ask for sexual, explicit, or NSFW content, respond with SAY:<a short friendly refusal plus a wholesome redirect>, without repeating explicit keywords.');
  parts.push('- do not output WAIT in response to sexual or explicit requests; always refuse using SAY as described above.');
  parts.push('- do not engage with minors in a personal or sexual way.');
  parts.push('Context:');
  parts.push('- roomId: ' + String(roomId));
  parts.push('- now (UTC): ' + nowIso);
  if (idleMs != null){
    parts.push('- ms since last spoken line: ' + idleMs);
    parts.push('- idle threshold ms: ' + idleThresholdMs);
  }
  parts.push('Recent live events (new since last cursor):');
  parts.push(formatEventsForPrompt(events));
  parts.push('Now decide whether to speak. Respond with EXACTLY one of:');
  parts.push('- WAIT');
  parts.push('- SAY:<text>');
  parts.push('Do not add any other words or lines.');
  return parts.join('\n');
}

function parseShowrunnerResponse(raw){
  const text = String(raw || '').trim();
  if (!text) return { mode: 'wait' };
  const lines = text.split(/\r?\n/);
  let first = '';
  for (const line of lines){
    const trimmed = String(line || '').trim();
    if (trimmed){ first = trimmed; break; }
  }
  if (!first) return { mode: 'wait' };
  const upper = first.toUpperCase();
  if (upper === 'WAIT') return { mode: 'wait' };
  const m = /^SAY\s*:(.*)$/i.exec(first);
  if (!m) return { mode: 'wait' };
  const spoken = String(m[1] || '').trim();
  if (!spoken) return { mode: 'wait' };
  return { mode: 'say', text: spoken };
}

function sanitizeSpokenText(raw){
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > 60) text = text.slice(0, 60);
  const lower = text.toLowerCase();
  const banned = [
    'sex', 'sexual', 'porn', 'naked', 'nude', 'nsfw',
    'erotic', 'xxx', 'horny', 'boobs', 'breasts', 'ass',
    'penis', 'vagina', 'dick', 'nipple', 'orgasm', 'bdsm',
    '色情', '性爱', '做爱', '约炮', '脱衣', '裸露',
    '胸部', '乳房', '奶头', '阴道', '阴茎', '鸡巴',
    '屌', '自慰', '黄片',
  ];
  for (const word of banned){
    if (lower.includes(word)) return null;
  }
  return text;
}

async function pollBilibiliEvents({ roomId, cursor }){
  const factory = bilibiliEventsPullFactory;
  const tool = typeof factory === 'function' ? factory() : null;
  if (!tool || typeof tool.execute !== 'function'){
    throw new Error('bilibili_events_pull tool not available');
  }
  const args = {
    roomId,
    cursor: cursor || undefined,
  };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  try {
    const res = await tool.execute('livestream-bilibili', args, ctrl ? ctrl.signal : undefined, null, {});
    const details = res && res.details ? res.details : {};
    if (!details || details.ok === false){
      return { cursor, events: [] };
    }
    const nextCursor = typeof details.cursor === 'string' && details.cursor ? details.cursor : cursor;
    const events = Array.isArray(details.events) ? details.events : [];
    return { cursor: nextCursor, events };
  } catch {
    return { cursor, events: [] };
  }
}

async function speakViaTts({ text, provider, play, subtitle }){
  const factory = liveTtsFactory;
  const tool = typeof factory === 'function' ? factory() : null;
  if (!tool || typeof tool.execute !== 'function'){
    throw new Error('live_tts tool not available');
  }
  const args = {
    action: 'say',
    provider,
    text,
  };
  if (play !== undefined) args.play = !!play;
  if (subtitle !== undefined) args.subtitle = !!subtitle;
  if (String(provider || '').toLowerCase() === 'aliyun_cosyvoice_ws' && (play === undefined || play === true)){
    args.stream = true;
  }
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  try {
    await tool.execute('livestream-tts', args, ctrl ? ctrl.signal : undefined, null, {});
  } catch {
    // best-effort; speech failures should not crash the loop
  }
}

function buildLogPath({ agentId, roomId }){
  const base = arcanaHomePath('agents', String(agentId || 'default'), 'livestream', 'logs');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = 'room-' + String(roomId) + '-' + stamp + '.log';
  const p = join(base, fileName);
  return p;
}

export async function startLivestreamShowrunner({
  roomId,
  agentId,
  tickMs,
  sessionId,
  ttsProvider,
  ttsPlay,
  subtitle,
} = {}){
  const room = roomId != null ? String(roomId) : '';
  if (!room){
    throw new Error('roomId is required');
  }
  const agent = agentId != null && agentId !== '' ? String(agentId) : 'default';
  const tickIntervalMs = resolveTickMs(tickMs);
  const idleThresholdMs = resolveIdleThresholdMs();
  const turnTimeoutMs = resolveTurnTimeoutMs();
  const workspaceRoot = resolveAgentWorkspaceRoot(agent);

  const state = loadState({ agentId: agent, roomId: room });
  let cursor = state.cursor;
  let activeSessionId = sessionId || state.sessionId || '';
  let lastSpeakAtMs = state.lastSpeakAtMs || 0;

  const statePath = state.filePath;

  console.log('[arcana] livestream: showrunner started');
  console.log('[arcana] livestream: roomId=' + room + ' agentId=' + agent);
  console.log('[arcana] livestream: tickMs=' + tickIntervalMs + ' idleMs=' + idleThresholdMs + ' timeoutMs=' + turnTimeoutMs);
  console.log('[arcana] livestream: state file=' + statePath);
  console.log('[arcana] livestream: tts provider=' + (ttsProvider || '<none>'));
  console.log('[arcana] livestream: workspaceRoot=' + (workspaceRoot || '<none>'));

  let stopped = false;
  const handleSigInt = () => {
    if (stopped) return;
    stopped = true;
    console.log('\n[arcana] livestream: received SIGINT, shutting down...');
  };
  process.on('SIGINT', handleSigInt);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true){
      if (stopped) break;
      const loopStart = nowMs();
      let events = [];

      try {
        const polled = await pollBilibiliEvents({ roomId: room, cursor });
        cursor = polled.cursor;
        events = polled.events || [];
      } catch {
        events = [];
      }

      const now = nowMs();
      const idleMs = lastSpeakAtMs ? (now - lastSpeakAtMs) : null;

      let shouldRunTurn = false;
      if (events.length > 0){
        shouldRunTurn = true;
      } else if (idleMs != null && idleMs >= idleThresholdMs){
        shouldRunTurn = true;
      }

      if (shouldRunTurn){
        const prompt = buildShowrunnerPrompt({ roomId: room, events, now, lastSpeakAtMs, idleThresholdMs });
        const logPath = buildLogPath({ agentId: agent, roomId: room });
        const title = 'Livestream room ' + room;

        let res = null;
        try {
          const ctx = {
            agentId: agent,
            sessionId: activeSessionId || undefined,
            workspaceRoot: workspaceRoot || undefined,
          };
          res = await runWithContext(ctx, () => runArcanaTask({ prompt, sessionId: activeSessionId, title, logPath, agentId: agent, timeoutMs: turnTimeoutMs }));
        } catch {
          res = null;
        }

        if (res && res.sessionId && !sessionId){
          activeSessionId = String(res.sessionId);
        }

        const assistantText = res && typeof res.assistantText === 'string' ? res.assistantText : '';
        const parsed = parseShowrunnerResponse(assistantText);

        if (parsed.mode === 'say' && parsed.text){
          const spoken = sanitizeSpokenText(parsed.text);
          if (spoken){
            if (ttsProvider){
              await speakViaTts({ text: spoken, provider: ttsProvider, play: ttsPlay, subtitle });
            } else {
              console.log('[arcana] livestream: SAY ' + spoken);
            }
            lastSpeakAtMs = nowMs();
          } else {
            console.log('[arcana] livestream: filtered unsafe or long text, skipping SAY');
          }
        }
      }

      saveState(statePath, { cursor, sessionId: activeSessionId, lastSpeakAtMs });

      const elapsed = nowMs() - loopStart;
      const delay = Math.max(0, tickIntervalMs - elapsed);
      if (delay > 0){
        // eslint-disable-next-line no-await-in-loop
        await sleep(delay);
      }
    }
  } finally {
    try { process.off('SIGINT', handleSigInt); } catch {}
  }
}

export default { startLivestreamShowrunner };
