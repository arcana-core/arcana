export function configureLongRunningHttpServer(server){
  if (!server || typeof server !== 'object') return server;
  try { server.requestTimeout = 0; } catch {}
  try { server.timeout = 0; } catch {}
  return server;
}
