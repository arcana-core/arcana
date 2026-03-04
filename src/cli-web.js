import * as pw from './pw-runtime.js';

async function navigate(url){
  if (!url) throw new Error('missing_url');
  const r = await pw.navigate(url, { waitUntil: 'networkidle' });
  console.log('[arcana:web] navigated', r.url);
}

async function extract(){
  const r = await pw.extract({ maxChars: 20000, autoScroll: false });
  console.log('[arcana:web] url:', r.url, 'title:', r.title||'');
  process.stdout.write(String(r.text||'') + '\n');
}

async function search(query, engine){
  if (!query) throw new Error('missing_query');
  // Use the plugin implementation for richer output
  try {
    const reg = [];
    const mod = await import('../plugins/web-search.js');
    await mod.default({ registerTool: (t)=> reg.push(t) });
    const tool = reg.find(t=> t && (t.name === 'web_search' || t.label.includes('Web Search')));
    if (tool) {
      try {
        const out = await tool.execute('cli', { query, engine: engine||'auto' });
        const text = (out && out.content || []).filter(c=>c.type==='text').map(c=>c.text).join('\n');
        process.stdout.write(String(text||'') + '\n');
        return;
      } catch (e) {
        // fall through to simple mode
      }
    }
  } catch {}
  // Fallback: simple search using src tool
  const simple = (await import('./tools/web-search.js')).default;
  const tool = simple();
  const out = await tool.execute('cli', { query, engine: engine||'duckduckgo' });
  const text = (out && out.content || []).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  process.stdout.write(String(text||'') + '\n');
}

async function serve(port){
  const desiredPort = typeof port === 'number' && Number.isFinite(port) ? port : undefined;
  if (desiredPort) process.env.PORT = String(desiredPort);
  const mod = await import('../server/server.mjs');
  const fn = mod && (mod.startArcanaWebServer || mod.default?.startArcanaWebServer);
  if (typeof fn !== 'function'){
    throw new Error('startArcanaWebServer not exported from server/server.mjs');
  }
  const workspaceRoot = String(process.env.ARCANA_WORKSPACE || process.cwd());
  await fn({ port: desiredPort, workspaceRoot });
}

export async function webCLI({ args }){
  const [, sub, ...rest] = args;
  if (sub === 'navigate') return navigate(rest[0]);
  if (sub === 'extract') return extract();
  if (sub === 'search') {
    let engine = 'auto';
    const idx = rest.indexOf('--engine');
    if (idx > -1) engine = rest[idx+1] || 'auto';
    const query = rest.filter((x,i)=> i !== idx && i !== idx+1).join(' ').trim();
    return search(query, engine);
  }
  if (sub === 'serve') {
    let port = undefined;
    const idx = rest.indexOf('--port');
    if (idx > -1) port = Number(rest[idx+1]);
    return serve(port);
  }
  console.log('[arcana] usage: arcana web navigate <url> | extract | search <query> [--engine e] | serve [--port n]');
}

export default { webCLI };
