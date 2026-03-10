export default async function(pi){
  pi.registerTool({
    label: 'Web Search (Browser)',
    name: 'web_search',
    description: 'Open a search engine in Playwright and return readable SERP text.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        engine: { type: 'string', enum: ['auto','duckduckgo','bing','baidu'], default: 'auto' },
        waitUntil: { type: 'string', enum: ['networkidle','domcontentloaded'], default: 'networkidle' },
        timeoutMs: { type: 'number', minimum: 1 }
      },
      required: ['query']
    },
    async execute(_id, args){
      let q = String(args.query||'').trim();
      if (!q) return { content:[{type:'text',text:'Query is required.'}], details:{ ok:false } };

      // engine detection from explicit arg or query prefix
      const pick = (q, eng) => {
        const e = String(eng||'auto').toLowerCase();
        if (e && e !== 'auto') return { engine:e, clean:q };
        const m = q.match(/^\s*(百度|baidu|必应|bing|duckduckgo|ddg|google|谷歌)\s*[:：]\s*(.*)$/i);
        if (m){
          const key = m[1].toLowerCase();
          const clean = m[2].trim();
          if (key === '百度' || key === 'baidu') return { engine:'baidu', clean };
          if (key === '必应' || key === 'bing') return { engine:'bing', clean };
          return { engine:'duckduckgo', clean };
        }
        // simple heuristic: Chinese text → baidu, otherwise ddg
        if (/[\u4e00-\u9fa5]/.test(q)) return { engine:'baidu', clean:q };
        return { engine:'duckduckgo', clean:q };
      };

      const { engine:eng, clean } = pick(q, args.engine);
      q = clean;

      let u;
      if (eng === 'baidu') u = 'https://www.baidu.com/s?wd=' + encodeURIComponent(q);
      else if (eng === 'bing') u = 'https://www.bing.com/search?q=' + encodeURIComponent(q);
      else u = 'https://duckduckgo.com/?q=' + encodeURIComponent(q);

      const pw = await import('../src/pw-runtime.js');
      const waitUntil = (args && typeof args.waitUntil === 'string' && args.waitUntil) ? args.waitUntil : 'networkidle';
      const timeoutMs = (args && typeof args.timeoutMs === 'number' && args.timeoutMs > 0) ? args.timeoutMs : undefined;
      await pw.navigate(u, { waitUntil, timeoutMs });
      // Try to extract Top-N structured results
      let top = [];
      try {
        top = await pw.evaluate((engine)=>{
          function pick(engine){
            if (engine === 'baidu'){
              const nodes = Array.from(document.querySelectorAll('#content_left h3 a, #content_left .result h3 a')).slice(0,5);
              return nodes.map(a=>({ title:(a.textContent||'').trim(), url:a.href }));
            } else if (engine === 'bing'){
              const nodes = Array.from(document.querySelectorAll('li.b_algo h2 a')).slice(0,5);
              return nodes.map(a=>({ title:(a.textContent||'').trim(), url:a.href }));
            } else {
              const nodes = Array.from(document.querySelectorAll('[data-testid=result-title-a], a.result__a')).slice(0,5);
              return nodes.map(a=>({ title:(a.textContent||'').trim(), url:a.href }));
            }
          }
          return pick(engine);
        }, engine);
      } catch {}

      const r = await pw.extract({ maxChars: 20000, autoScroll: false });
      const header = '[external:web_search]\nurl=' + r.url + ' title=' + (r.title||'') + '\n';
      const list = top && top.length ? ('\nTop results:\n' + top.map((t,i)=> ((i+1) + '. ' + (t.title||'') + ' — ' + t.url)).join('\n') + '\n\n') : '';
      return {
        content: [{ type:'text', text: header + list + (r.text||'') }],
        details: { provider:'browser', engine: eng, url: r.url, title: r.title, results: top, tookMs: r.tookMs }
      };
    }
  });
}
