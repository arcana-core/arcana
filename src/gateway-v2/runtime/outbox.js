export function createOutbox({ wsHub, inbox, trace, policy } = {}){
  const sinks = new Map();

  function registerSink(sink){
    if (!sink || typeof sink !== 'object') return;
    const id = sink.id != null ? String(sink.id).trim() : '';
    if (!id) return;
    if (sinks.has(id)) return;
    sinks.set(id, sink);
  }

  async function deliverOutput({ agentId, sessionKey, output, runnerId, reason } = {}){
    if (!output || typeof output !== 'object') return { delivered: false, reason: 'invalid_output' };

    const kind = output.kind || 'unknown';
    const aId = agentId || output.agentId || 'default';
    const sKey = sessionKey || output.sessionKey || 'session';

    let decision = { allow: true, reason: 'allow_default' };
    if (policy && typeof policy.evaluateDelivery === 'function'){
      try {
        const d = await policy.evaluateDelivery({ agentId: aId, sessionKey: sKey, output, runnerId, reason });
        if (d && typeof d.allow === 'boolean') decision = d;
      } catch {}
    }

    if (!decision.allow){
      return { delivered: false, reason: decision.reason || 'denied' };
    }

    if (kind === 'assistant_message'){
      const text = output.text != null ? String(output.text) : '';
      if (!text) return { delivered: false, reason: 'empty_text' };
      const eventData = {
        text,
        sessionId: output.sessionId != null ? String(output.sessionId) : null,
        replyToEventId: output.replyToEventId != null ? String(output.replyToEventId) : null,
      };
      const event = await inbox.ingestEvent({
        agentId: aId,
        sessionKey: sKey,
        type: 'assistant_message',
        source: runnerId || 'assistant',
        data: eventData,
      });
      return { delivered: true, event };
    }

    const sinkId = output.sinkId || output.sink || null;
    if (sinkId && sinks.has(sinkId)){
      const sink = sinks.get(sinkId);
      if (sink && typeof sink.deliver === 'function'){
        try {
          const res = await sink.deliver({ agentId: aId, sessionKey: sKey, output, runnerId, reason, wsHub, trace, inbox });
          return res || { delivered: true };
        } catch (e) {
          return { delivered: false, error: e && e.message ? e.message : String(e) };
        }
      }
    }

    return { delivered: false, reason: 'unhandled_kind' };
  }

  async function deliverOutputs({ agentId, sessionKey, outputs, runnerId, reason } = {}){
    const results = [];
    const arr = Array.isArray(outputs) ? outputs : [];
    for (const output of arr){
      const res = await deliverOutput({ agentId, sessionKey, output, runnerId, reason });
      results.push({ output, result: res });
    }
    return results;
  }

  return { deliverOutput, deliverOutputs, registerSink, sinks };
}

export default { createOutbox };

