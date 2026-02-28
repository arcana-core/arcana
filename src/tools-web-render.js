import { Type } from "@sinclair/typebox";
import * as pw from "../src/pw-runtime.js";

export function createWebRenderTool(){
  const Params = Type.Object({
    action: Type.String({ description: 'start|status|navigate|snapshot' }),
    url: Type.Optional(Type.String()),
    waitUntil: Type.Optional(Type.String()),
    maxChars: Type.Optional(Type.Number())
  });
  return {
    label: "Web Render",
    name: "web_render",
    description: "Navigate page and take AI snapshot (Playwright).",
    parameters: Params,
    async execute(_id, args, _signal){
      const action = String(args.action||'').toLowerCase();
      if (action === 'start') { await pw.start(); return { content:[{ type:'text', text:'started' }], details:{ ok:true } }; }
      if (action === 'status') { return { content:[{ type:'text', text:'ok' }], details:{ ok: true } }; }
      if (action === 'navigate') { const r = await pw.navigate(args.url, { waitUntil: args.waitUntil }); return { content:[{ type:'text', text: `navigated ${r.url}` }], details: r }; }
      if (action === 'snapshot') { const r = await pw.extract({ maxChars: args.maxChars||20000 }); const wrapped = `[external:web_render]\n` + r.text; return { content:[{ type:'text', text: wrapped }], details: { url: r.url, title: r.title, tookMs: r.tookMs } }; }
      return { content:[{ type:'text', text: 'unknown action' }], details: { ok:false } };
    }
  };
}

export default createWebRenderTool;
