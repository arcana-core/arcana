import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { resolveArcanaHome } from "./arcana-home.js";
import { pathToFileURL, fileURLToPath } from "node:url";

const exts = new Set([".js", ".mjs"]);

function listFiles(dir){
  try {
    const names = readdirSync(dir);
    const files = [];
    for (const n of names){
      const p = join(dir, n);
      try {
        const st = statSync(p);
        if (st.isFile() && exts.has(extname(n))) files.push(p);
      } catch {}
    }
    return files;
  } catch { return []; }
}

export async function loadArcanaPlugins(cwd){
  // Determine arcana package root regardless of current working directory
  const here = fileURLToPath(new URL(".", import.meta.url)); // arcana/src/
  const pkgRoot = join(here, "..");                              // arcana/

  const roots = [
    join(pkgRoot, "plugins"),              // arcana/plugins (preferred location)
    join(cwd, "arcana", "plugins"),       // <repo>/arcana/plugins when running from repo root
    join(cwd, "plugins"),                  // <repo>/plugins (project-level overrides)
    join(pkgRoot, ".pi", "extensions"),   // arcana/.pi/extensions (optional)
    join(cwd, ".pi", "extensions"),       // project .pi/extensions for local dev
    join(resolveArcanaHome(), ".pi", "extensions"), // global extensions in ARCANA_HOME
  ];
  const seen = new Set();
  const uniqueRoots = roots.filter(r => { if (seen.has(r)) return false; seen.add(r); return true; });

  const pluginFiles = uniqueRoots.flatMap(listFiles);
  const loadedTools = [];
  const errors = [];
  for (const file of pluginFiles){
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.default === "function"){
        const local = [];
        const ctx = { registerTool: (tool)=>{ if (tool && tool.name && tool.execute) local.push(tool); }, cwd };
        await mod.default(ctx);
        loadedTools.push(...local);
        continue;
      }
      if (Array.isArray(mod.tools)){
        for (const t of mod.tools) if (t && t.name && t.execute) loadedTools.push(t);
        continue;
      }
      if (mod.tool && mod.tool.name && mod.tool.execute){ loadedTools.push(mod.tool); continue; }
    } catch (e) {
      errors.push({ file, message: (e && e.message) ? e.message : String(e) });
    }
  }
  return { tools: loadedTools, errors, pluginFiles };
}
