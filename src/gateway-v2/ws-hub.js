import { safeJsonParse } from './util.js';

export function createWsHub(){
  const clients = new Set();

  function addClient(ws){
    if (!ws) return;
    const client = { ws };
    clients.add(client);

    function cleanup(){
      clients.delete(client);
    }

    ws.on('close', cleanup);
    ws.on('error', cleanup);
    ws.on('message', (data) => {
      // Minimal implementation: accept JSON control messages but ignore them for now.
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        safeJsonParse(text, null);
      } catch {}
    });
  }

  function broadcast(obj){
    if (!clients.size) return;
    let payload = null;
    try {
      payload = JSON.stringify(obj);
    } catch {
      return;
    }
    for (const client of clients){
      const ws = client && client.ws;
      if (!ws) continue;
      try {
        if (ws.readyState === ws.OPEN){
          ws.send(payload);
        }
      } catch {}
    }
  }

  return { addClient, broadcast };
}

export default { createWsHub };

