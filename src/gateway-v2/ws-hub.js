import { safeJsonParse } from './util.js';

const ARCANA_WS_DEBUG = (() => {
  try {
    const raw = String(process.env.ARCANA_WS_DEBUG || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  } catch {
    return false;
  }
})();

function wsDebugLog(...args){
  if (!ARCANA_WS_DEBUG) return;
  try {
    console.log('[arcana:gateway-v2:ws:debug]', ...args);
  } catch {}
}

function envByteLimit(name, fallback){
  try {
    const n = Number(process.env[name] || 0);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {}
  return fallback;
}

// Above the soft limit, high-frequency progressive events are dropped for
// that client (the next snapshot supersedes them). Above the hard limit the
// client is effectively dead and nothing more is queued for it.
const WS_BUFFER_SOFT_LIMIT = envByteLimit('ARCANA_WS_BUFFER_SOFT_LIMIT', 1 * 1024 * 1024);
const WS_BUFFER_HARD_LIMIT = envByteLimit('ARCANA_WS_BUFFER_HARD_LIMIT', 16 * 1024 * 1024);
const DROPPABLE_EVENT_TYPES = new Set([
  'item_updated',
  'assistant_text',
  'thinking_delta',
  'tool_execution_update',
]);

export function createWsHub(options = {}){
  const getInitialMessages = (options && typeof options.getInitialMessages === 'function')
    ? options.getInitialMessages
    : null;
  const onMessage = (options && typeof options.onMessage === 'function')
    ? options.onMessage
    : null;
  const onDisconnect = (options && typeof options.onDisconnect === 'function')
    ? options.onDisconnect
    : null;
  // Optional payload scrubber (e.g. secret redaction) applied to the
  // serialized broadcast string. Identity by default.
  const redact = (options && typeof options.redact === 'function')
    ? options.redact
    : null;

  const clients = new Set();
  let pingInterval = null;

  function normalizeClientMeta(meta = {}){
    const threadKindRaw = String(meta && meta.threadKind || '').trim();
    const threadKind = threadKindRaw === 'group' ? 'group' : 'session';
    return {
      agentId: String(meta && meta.agentId || '').trim(),
      sessionKey: String(meta && meta.sessionKey || '').trim(),
      sessionId: String(meta && meta.sessionId || '').trim(),
      groupId: String(meta && meta.groupId || '').trim(),
      clientId: String(meta && meta.clientId || '').trim(),
      receiveAll: meta && (meta.receiveAll === true || meta.receiveAll === '1' || meta.receiveAll === 1),
      threadKind,
    };
  }

  function applyClientMeta(client, meta = {}){
    if (!client) return client;
    const normalized = normalizeClientMeta(meta);
    client.agentId = normalized.agentId;
    client.sessionKey = normalized.sessionKey;
    client.sessionId = normalized.sessionId;
    client.groupId = normalized.groupId;
    client.clientId = normalized.clientId;
    client.receiveAll = normalized.receiveAll;
    client.threadKind = normalized.threadKind;
    return client;
  }

  function ensurePingLoop(){
    try{
      if (pingInterval || !clients.size) return;
      pingInterval = setInterval(()=>{
        try{
          if (!clients.size){
            try{ clearInterval(pingInterval); } catch {}
            pingInterval = null;
            return;
          }
          for (const client of Array.from(clients)){
            const ws = client && client.ws;
            if (!ws){
              clients.delete(client);
              continue;
            }
            if (client.isAlive === false){
              try{
                ws.terminate();
              } catch {}
              continue;
            }
            client.isAlive = false;
            try{
              if (typeof ws.ping === 'function') ws.ping();
            } catch {}
          }
          if (!clients.size){
            try{ clearInterval(pingInterval); } catch {}
            pingInterval = null;
          }
        } catch{}
      }, 30000);
    } catch{}
  }

  function countMatchingClients(meta = {}){
    const agentId = String(meta && meta.agentId || '').trim();
    const sessionKey = String(meta && meta.sessionKey || '').trim();
    const sessionId = String(meta && meta.sessionId || '').trim();
    const groupId = String(meta && meta.groupId || '').trim();
    const clientId = String(meta && meta.clientId || '').trim();
    let count = 0;
    for (const client of clients) {
      if (!client) continue;
      if (agentId && String(client.agentId || '').trim() !== agentId) continue;
      if (sessionKey && String(client.sessionKey || '').trim() !== sessionKey) continue;
      if (sessionId && String(client.sessionId || '').trim() !== sessionId) continue;
      if (groupId && String(client.groupId || '').trim() !== groupId) continue;
      if (clientId && String(client.clientId || '').trim() !== clientId) continue;
      count += 1;
    }
    return count;
  }

  function addClient(ws, meta = {}){
    if (!ws) return;
    const client = {
      ws,
      isAlive: true,
      agentId: '',
      sessionKey: '',
      sessionId: '',
      groupId: '',
      clientId: '',
      receiveAll: false,
      threadKind: 'session',
    };
    applyClientMeta(client, meta);
    clients.add(client);

    try{
      if (getInitialMessages){
        const initial = getInitialMessages();
        try {
          if (Array.isArray(initial)) {
            for (const msg of initial) {
              if (!msg) continue;
              const payload = JSON.stringify(msg);
              try { ws.send(payload); } catch {}
            }
          } else if (initial) {
            const payload = JSON.stringify(initial);
            try { ws.send(payload); } catch {}
          }
        } catch {}
      }
    } catch {}

    try{
      if (typeof ws.on === 'function'){
        ws.on('pong', ()=>{
          try{ client.isAlive = true; } catch{}
        });
      }
    } catch{}

    function cleanup(reason = 'disconnect'){
      const wasPresent = clients.delete(client);
      if (wasPresent && onDisconnect) {
        try {
          onDisconnect(client, {
            reason,
            remainingMatchingClients: countMatchingClients(client),
          });
        } catch {}
      }
      if (!clients.size && pingInterval){
        try{ clearInterval(pingInterval); } catch {}
        pingInterval = null;
      }
    }

    ws.on('close', () => cleanup('close'));
    ws.on('error', () => cleanup('error'));
    ws.on('message', (data) => {
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const parsed = safeJsonParse(text, null);
        if (parsed){
          const type = parsed && parsed.type != null ? String(parsed.type) : '';
          if (type === 'subscribe' || type === 'client.subscribe'){
            applyClientMeta(client, parsed);
          }
        }
        if (parsed && onMessage){
          try { onMessage(parsed, client); } catch {}
        }
      } catch {}
    });

    ensurePingLoop();
  }

  function extractTargetMeta(obj){
    const out = {
      agentId: '',
      sessionKey: '',
      sessionId: '',
      groupId: '',
    };
    try {
      if (!obj || typeof obj !== 'object') return out;
      const inner = obj.event && typeof obj.event === 'object' ? obj.event : null;
      const data = obj.data && typeof obj.data === 'object' ? obj.data : null;
      out.agentId = String(obj.agentId ?? inner?.agentId ?? data?.agentId ?? '').trim();
      out.sessionKey = String(obj.sessionKey ?? inner?.sessionKey ?? data?.sessionKey ?? '').trim();
      out.sessionId = String(obj.sessionId ?? inner?.sessionId ?? data?.sessionId ?? '').trim();
      out.groupId = String(obj.groupId ?? inner?.groupId ?? data?.groupId ?? '').trim();
    } catch {}
    return out;
  }

  function shouldDeliver(client, obj){
    if (!client || !obj || typeof obj !== 'object') return true;
    const target = extractTargetMeta(obj);
    const eventAgentId = target.agentId;
    const eventSessionKey = target.sessionKey;
    const eventSessionId = target.sessionId;
    const eventGroupId = target.groupId;
    const clientAgentId = String(client.agentId || '').trim();
    const clientSessionKey = String(client.sessionKey || '').trim();
    const clientSessionId = String(client.sessionId || '').trim();
    const clientGroupId = String(client.groupId || '').trim();
    const clientThreadKind = String(client.threadKind || 'session').trim();

    if (client.receiveAll === true) {
      return true;
    }

    if (!eventAgentId && !eventSessionKey && !eventSessionId && !eventGroupId) {
      return true;
    }

    if (eventAgentId && clientAgentId !== eventAgentId) {
      return false;
    }

    if (eventGroupId) {
      if (clientThreadKind !== 'group') return false;
      return !!clientGroupId && clientGroupId === eventGroupId;
    }

    if (eventSessionKey) {
      if (!clientSessionKey || clientSessionKey !== eventSessionKey) return false;
      return true;
    }

    if (eventSessionId) {
      if (!clientSessionId || clientSessionId !== eventSessionId) return false;
    }

    return true;
  }

  function broadcast(obj){
    if (!clients.size) return 0;
    let payload = null;
    try {
      payload = JSON.stringify(obj);
    } catch {
      return 0;
    }
    if (redact){
      try { payload = redact(payload); } catch {}
    }
    const type = String(obj && obj.type || '');
    let sent = 0;
    for (const client of clients){
      const ws = client && client.ws;
      if (!ws) continue;
      if (!shouldDeliver(client, obj)) continue;
      try {
        if (ws.readyState === ws.OPEN){
          // Backpressure: a slow client otherwise accumulates every streamed
          // event in the kernel/ws buffer until the process OOMs.
          const buffered = Number(ws.bufferedAmount || 0);
          if (buffered >= WS_BUFFER_HARD_LIMIT){
            client.droppedEvents = (Number(client.droppedEvents) || 0) + 1;
            wsDebugLog('backpressure_drop', { type, buffered, hard: true, clientId: client.clientId || '' });
            continue;
          }
          if (buffered >= WS_BUFFER_SOFT_LIMIT && DROPPABLE_EVENT_TYPES.has(type)){
            // Progressive events are superseded by the next snapshot or the
            // item_completed/turn_end that follows; lifecycle events still flow.
            client.droppedEvents = (Number(client.droppedEvents) || 0) + 1;
            wsDebugLog('backpressure_drop', { type, buffered, hard: false, clientId: client.clientId || '' });
            continue;
          }
          ws.send(payload);
          sent += 1;
        }
      } catch {}
    }
    if (sent === 0) {
      try {
        const target = extractTargetMeta(obj);
        const hasTarget = !!(target.agentId || target.sessionKey || target.sessionId || target.groupId);
        const type = String(obj && obj.type || '');
        if (hasTarget && (type === 'assistant_text' || type === 'turn_start' || type === 'turn_end' || type === 'event.appended')) {
          wsDebugLog('broadcast_unmatched', {
            type,
            target,
            clients: Array.from(clients).map((client) => ({
              agentId: String(client && client.agentId || ''),
              sessionKey: String(client && client.sessionKey || ''),
              sessionId: String(client && client.sessionId || ''),
              groupId: String(client && client.groupId || ''),
              threadKind: String(client && client.threadKind || ''),
              receiveAll: client && client.receiveAll === true,
            })),
          });
        }
      } catch {}
    }
    return sent;
  }

  function stop(){
    try{
      for (const client of Array.from(clients)){
        const ws = client && client.ws;
        try{ if (ws && typeof ws.terminate === 'function') ws.terminate(); } catch{}
      }
      clients.clear();
      if (pingInterval){
        try{ clearInterval(pingInterval); } catch{}
        pingInterval = null;
      }
    } catch{}
  }

  return { addClient, broadcast, stop, countMatchingClients };
}

export default { createWsHub };
