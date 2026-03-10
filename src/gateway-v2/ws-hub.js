import { safeJsonParse } from './util.js';

export function createWsHub(){
  const clients = new Set();
  let pingInterval = null;

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
              clients.delete(client);
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

  function addClient(ws){
    if (!ws) return;
    const client = { ws, isAlive: true };
    clients.add(client);

    try{
      if (typeof ws.on === 'function'){
        ws.on('pong', ()=>{
          try{ client.isAlive = true; } catch{}
        });
      }
    } catch{}

    function cleanup(){
      clients.delete(client);
      if (!clients.size && pingInterval){
        try{ clearInterval(pingInterval); } catch {}
        pingInterval = null;
      }
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

    ensurePingLoop();
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

  return { addClient, broadcast, stop };
}

export default { createWsHub };
