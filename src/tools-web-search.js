import { Type } from "@sinclair/typebox";
import * as pw from "../src/pw-runtime.js";

// Web Search tool (ESM). Uses the Playwright runtime to open a search
// engine results page and extracts readable text. Parameters use TypeBox
// to match the shape of other Arcana tools.
export function createWebSearchTool() {
  const Params = Type.Object({
    query: Type.String(),
    engine: Type.Optional(
      Type.String({ description: "duckduckgo|bing|baidu" })
    ),
  });

  function makeSearchUrl(q, engine) {
    const query = encodeURIComponent(String(q || "").trim());
    const eng = String(engine || "duckduckgo").toLowerCase();
    if (eng === "bing") return `https://www.bing.com/search?q=${query}`;
    if (eng === "baidu") return `https://www.baidu.com/s?wd=${query}`;
    // default to DuckDuckGo
    return `https://duckduckgo.com/?q=${query}`;
  }

  return {
    label: "Web Search (Browser)",
    name: "web_search",
    description:
      "Open a search engine in Playwright and return readable SERP text.",
    parameters: Params,
    async execute(_id, args, _signal) {
      const q = String(args.query || "").trim();
      if (!q) {
        return {
          content: [{ type: "text", text: "Query is required." }],
          details: { ok: false },
        };
      }

      const engine = String(args.engine || "duckduckgo").toLowerCase();
      const url = makeSearchUrl(q, engine);

      const t0 = Date.now();
      await pw.navigate(url, { waitUntil: "networkidle" });
      const r = await pw.extract({ maxChars: 20000, autoScroll: false });
      const tookMs = Date.now() - t0;

      const header =
        `[external:web_search]\n` +
        (r.title ? `title: ${r.title}\n` : "") +
        `url: ${r.url}\n\n`;

      return {
        content: [{ type: "text", text: header + String(r.text || "") }],
        details: {
          provider: "browser",
          engine,
          url: r.url,
          title: r.title,
          tookMs,
        },
      };
    },
  };
}

export default createWebSearchTool;
