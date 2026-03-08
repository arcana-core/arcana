export function createInbox({ wsHub, eventStore, auditStore, trace } = {}){
  const appendEvent = eventStore && typeof eventStore.appendEvent === 'function'
    ? eventStore.appendEvent
    : null;
  const appendAudit = auditStore && typeof auditStore.appendAudit === 'function'
    ? auditStore.appendAudit
    : null;

  async function ingestEvent(raw){
    if (!appendEvent) throw new Error('event_store_missing');
    if (!raw || typeof raw !== 'object') throw new Error('invalid_event');

    const agentId = raw.agentId || 'default';
    const sessionKey = raw.sessionKey || 'session';
    const type = raw.type || 'event';
    const source = raw.source || 'gateway';
    const tsMs = raw.tsMs ?? raw.ts;
    const data = raw.data ?? null;

    const stored = await appendEvent({
      agentId,
      sessionKey,
      type,
      source,
      tsMs,
      data,
    });

    if (appendAudit){
      try {
        await appendAudit({ kind: 'event.ingested', event: stored });
      } catch {}
    }

    if (trace && typeof trace.emitSpan === 'function'){
      try {
        await trace.emitSpan({
          name: 'event.ingested',
          attributes: {
            agentId,
            sessionKey,
            type,
            source,
          },
        });
      } catch {}
    }

    if (wsHub && typeof wsHub.broadcast === 'function'){
      try {
        wsHub.broadcast({ type: 'event.appended', event: stored });
      } catch {}
    }

    return stored;
  }

  async function ingestEvents({ agentId, sessionKey, events } = {}){
    const list = Array.isArray(events) ? events : [];
    const stored = [];

    for (const raw of list){
      const ev = await ingestEvent({
        ...(raw || {}),
        agentId: (raw && raw.agentId) || agentId,
        sessionKey: (raw && raw.sessionKey) || sessionKey,
      });
      stored.push(ev);
    }

    return stored;
  }

  return { ingestEvent, ingestEvents };
}

export default { createInbox };

