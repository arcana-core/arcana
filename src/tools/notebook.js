import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceRoot } from "../workspace-guard.js";

export function createNotebookTool() {
  const Params = Type.Object({
    action: Type.String({ description: "write | append | read | list | search | delete" }),
    title: Type.Optional(Type.String({ description: "Note title (used to create filename when writing)." })),
    id: Type.Optional(Type.String({ description: "Existing note id or filename (without path)." })),
    content: Type.Optional(Type.String({ description: "Content to write or append." })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "Max items to list/search." })),
    query: Type.Optional(Type.String({ description: "Search substring (case-insensitive)." })),
    format: Type.Optional(Type.String({ description: "File extension: md or txt (default md)." })),
  });

  function dir() {
    const root = resolveWorkspaceRoot();
    const d = join(root, "arcana", ".notebook");
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }

  function nowStamp() {
    const dt = new Date();
    const pad = (n)=> String(n).padStart(2, "0");
    return (
      dt.getFullYear().toString() +
      pad(dt.getMonth() + 1) +
      pad(dt.getDate()) + "-" +
      pad(dt.getHours()) + pad(dt.getMinutes()) + pad(dt.getSeconds())
    );
  }

  function slug(s) {
    return String(s || "").toLowerCase().trim()
      .replace(/[^a-z0-9\-_\s]+/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "note";
  }

  function extFrom(format) {
    const f = String(format||"md").toLowerCase();
    return (f === "txt" ? ".txt" : ".md");
  }

  function fileFromId(id) {
    const base = String(id||"").trim();
    if (!base) return null;
    return join(dir(), base);
  }

  function createFilePath(title, format) {
    const name = `${nowStamp()}--${slug(title)}` + extFrom(format);
    return join(dir(), name);
  }

  function listNotes(limit) {
    const d = dir();
    const files = readdirSync(d).filter(f => f.endsWith(".md") || f.endsWith(".txt"));
    const items = files.map((f)=>{
      let st; try { st = statSync(join(d,f)); } catch { st = { mtimeMs: 0, size: 0 }; }
      return { id: f, path: join(d,f), mtimeMs: st.mtimeMs || 0, size: st.size||0 };
    }).sort((a,b)=> b.mtimeMs - a.mtimeMs);
    const n = typeof limit === "number" ? Math.max(1, Math.min(200, limit)) : 50;
    return items.slice(0, n);
  }

  return {
    label: "Notebook",
    name: "notebook",
    description: "Lightweight local notebook for the agent to write/read notes and docs under arcana/.notebook.",
    parameters: Params,
    async execute(_id, args) {
      const action = String(args.action||"").toLowerCase();
      const d = dir();

      if (action === "write") {
        const title = String(args.title||"").trim();
        const content = String(args.content||"");
        if (!title || !content) {
          return { content:[{ type:"text", text:"title and content are required." }], details:{ ok:false, error:"missing_params" } };
        }
        const fp = createFilePath(title, args.format);
        writeFileSync(fp, content, { encoding: "utf-8" });
        return { content:[{ type:"text", text:`notebook: wrote ${fp}` }], details:{ ok:true, path: fp } };
      }

      if (action === "append") {
        const id = args.id || args.title; // allow addressing by filename or title
        const base = fileFromId(id);
        const content = String(args.content||"");
        if (!base || !content || !existsSync(base)) {
          return { content:[{ type:"text", text:"append requires existing id (filename) and content." }], details:{ ok:false, error:"missing_or_not_found" } };
        }
        appendFileSync(base, (content.startsWith("\n")?"":"\n") + content, { encoding: "utf-8" });
        return { content:[{ type:"text", text:`notebook: appended ${base}` }], details:{ ok:true, path: base } };
      }

      if (action === "read") {
        const id = args.id || args.title;
        const base = fileFromId(id);
        if (!base || !existsSync(base)) {
          return { content:[{ type:"text", text:"read requires existing id (filename)." }], details:{ ok:false, error:"not_found" } };
        }
        const text = readFileSync(base, "utf-8");
        return { content:[{ type:"text", text }], details:{ ok:true, path: base, bytes: Buffer.byteLength(text, "utf-8") } };
      }

      if (action === "list") {
        const items = listNotes(args.limit);
        const lines = items.map((it)=> `${it.id}\t${new Date(it.mtimeMs).toISOString()}\t${it.size}B`).join("\n");
        const header = `notebook: ${items.length} item(s) in ${d}`;
        return { content:[{ type:"text", text: header + (lines?"\n"+lines:"") }], details:{ ok:true, dir: d, items } };
      }

      if (action === "search") {
        const q = String(args.query||"").toLowerCase().trim();
        if (!q) return { content:[{ type:"text", text:"query required." }], details:{ ok:false, error:"missing_query" } };
        const items = listNotes(args.limit||200);
        const hits = [];
        for (const it of items) {
          try {
            const txt = readFileSync(it.path, "utf-8").toLowerCase();
            if (txt.includes(q)) hits.push(it);
          } catch {}
          if (hits.length >= (args.limit||50)) break;
        }
        const lines = hits.map((it)=> `${it.id}\t${new Date(it.mtimeMs).toISOString()}\t${it.size}B`).join("\n");
        return { content:[{ type:"text", text: lines || "no matches" }], details:{ ok:true, dir:d, query:q, hits } };
      }

      if (action === "delete") {
        const id = args.id || args.title;
        const base = fileFromId(id);
        if (!base || !existsSync(base)) {
          return { content:[{ type:"text", text:"delete requires existing id (filename)." }], details:{ ok:false, error:"not_found" } };
        }
        unlinkSync(base);
        return { content:[{ type:"text", text:`notebook: deleted ${base}` }], details:{ ok:true, path: base } };
      }

      return { content:[{ type:"text", text:"unknown action" }], details:{ ok:false, error:"unknown_action" } };
    }
  };
}

export default createNotebookTool;
