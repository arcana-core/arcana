import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import * as pw from "../pw-runtime.js";

export function createWebRenderTool(){
  const Params = Type.Object({
    action: Type.String({ description: 'start|status|navigate|snapshot|open|close' }),
    url: Type.Optional(Type.String()),
    waitUntil: Type.Optional(Type.String()),
    maxChars: Type.Optional(Type.Number()),
    headless: Type.Optional(Type.Boolean()),
    engine: Type.Optional(Type.String()),
    userDataDir: Type.Optional(Type.String()),
    forceRestart: Type.Optional(Type.Boolean())
  });
  return {
    label: "Web Render",
    name: "web_render",
    description: "Navigate page and take AI snapshot (Playwright).",
    parameters: Params,
    async execute(_id, args, _signal){
      const action = String(args.action||'').toLowerCase();
      if (action === 'start') {
        const opts = {
          headless: (typeof args.headless === 'boolean') ? args.headless : undefined,
          engine: args.engine,
          userDataDir: args.userDataDir,
          forceRestart: Boolean(args.forceRestart),
        };
        await pw.start(opts);
        const s = (pw.status ? pw.status() : { started: true });
        return { content:[{ type:'text', text:'started' }], details:s };
      }
      if (action === 'status') {
        const s = (pw.status ? pw.status() : { started: false });
        return { content:[{ type:'text', text:'status' }], details:s };
      }
      if (action === 'open') {
        let userDataDir = args.userDataDir || undefined;
        if (!userDataDir){
          const defaultUserDataDir = join(process.cwd(), ".cache", "web_render_profile");
          if (!existsSync(defaultUserDataDir)) mkdirSync(defaultUserDataDir, { recursive: true });
          userDataDir = defaultUserDataDir;
        }
        await pw.start({
          headless: false,
          engine: args.engine,
          userDataDir,
          forceRestart: Boolean(args.forceRestart),
        });
        let r = null;
        if (args.url){
          r = await pw.navigate(args.url, { waitUntil: args.waitUntil });
        }
        const s = (pw.status ? pw.status() : undefined);
        const details = r || s || { started: true };
        const text = r && r.url ? `opened ${r.url}` : 'opened';
        return { content:[{ type:'text', text }], details };
      }
      if (action === 'close') {
        if (pw.close){
          await pw.close();
        }
        return { content:[{ type:'text', text:'closed' }], details:{ ok:true } };
      }
      if (action === 'navigate') { const r = await pw.navigate(args.url, { waitUntil: args.waitUntil }); return { content:[{ type:'text', text: `navigated ${r.url}` }], details: r }; }
      if (action === 'snapshot') { const r = await pw.extract({ maxChars: args.maxChars||20000 }); const wrapped = `[external:web_render]\n` + r.text; return { content:[{ type:'text', text: wrapped }], details: { url: r.url, title: r.title, tookMs: r.tookMs } }; }
      return { content:[{ type:'text', text: 'unknown action' }], details: { ok:false } };
    }
  };
}

export default createWebRenderTool;
