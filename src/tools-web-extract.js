import { Type } from "@sinclair/typebox";
import * as pw from "../src/pw-runtime.js";

export function createWebExtractTool(){
  const Params = Type.Object({
    mode: Type.Optional(Type.String({ description: 'article|main|full' })),
    selector: Type.Optional(Type.String()),
    maxChars: Type.Optional(Type.Number()),
    autoScroll: Type.Optional(Type.Boolean())
  });
  return {
    label: "Web Extract",
    name: "web_extract",
    description: "Extract readable text from current page (Playwright).",
    parameters: Params,
    async execute(_id, args, _signal){
      const r = await pw.extract({ maxChars: args.maxChars||20000, autoScroll: Boolean(args.autoScroll) });
      const wrapped = `[external:web_extract]\n` + (r.text || "");
      return { content:[{ type:'text', text: wrapped }], details: { url: r.url, title: r.title, tookMs: r.tookMs } };
    }
  };
}

export default createWebExtractTool;
