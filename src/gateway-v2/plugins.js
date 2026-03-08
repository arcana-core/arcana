import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveArcanaHome } from '../arcana-home.js';

const exts = new Set(['.js', '.mjs']);

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
  } catch {
    return [];
  }
}

function uniqueRoots(roots){
  const seen = new Set();
  const out = [];
  for (const r of roots){
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function normalizeRunner(candidate){
  if (!candidate || typeof candidate !== 'object') return null;
  const idRaw = candidate.id != null ? String(candidate.id) : '';
  const id = idRaw.trim();
  if (!id) return null;

  const runFn = typeof candidate.run === 'function'
    ? candidate.run
    : (typeof candidate.runTurn === 'function' ? candidate.runTurn : null);
  if (!runFn) return null;

  return { ...candidate, id, run: runFn };
}

function normalizeChannel(candidate){
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate;
}

function normalizeSink(candidate){
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate;
}

function normalizeTool(candidate){
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate;
}

export async function loadGatewayV2Plugins(cwd){
  const here = fileURLToPath(new URL('.', import.meta.url));
  const pkgRoot = join(here, '..');

  const roots = uniqueRoots([
    join(pkgRoot, 'plugins'),
    join(cwd || process.cwd(), 'arcana', 'plugins'),
    join(cwd || process.cwd(), 'plugins'),
    join(pkgRoot, '.pi', 'extensions'),
    join(cwd || process.cwd(), '.pi', 'extensions'),
    join(resolveArcanaHome(), '.pi', 'extensions'),
  ]);

  const pluginFiles = roots.flatMap(listFiles);

  const runners = [];
  const channels = [];
  const sinks = [];
  const tools = [];
  const errors = [];

  for (const file of pluginFiles){
    const localRunners = [];
    const localChannels = [];
    const localSinks = [];
    const localTools = [];

    try {
      const mod = await import(pathToFileURL(file).href);

      if (typeof mod.default === 'function'){
        const ctx = {
          cwd: cwd || process.cwd(),
          registerRunner: (runner) => {
            const r = normalizeRunner(runner);
            if (r) localRunners.push(r);
          },
          registerChannel: (channel) => {
            const c = normalizeChannel(channel);
            if (c) localChannels.push(c);
          },
          registerSink: (sink) => {
            const s = normalizeSink(sink);
            if (s) localSinks.push(s);
          },
          registerTool: (tool) => {
            const t = normalizeTool(tool);
            if (t) localTools.push(t);
          },
        };
        await mod.default(ctx);
      }

      if (Array.isArray(mod.runners)){
        for (const r of mod.runners){
          const nr = normalizeRunner(r);
          if (nr) localRunners.push(nr);
        }
      }

      if (Array.isArray(mod.channels)){
        for (const c of mod.channels){
          const nc = normalizeChannel(c);
          if (nc) localChannels.push(nc);
        }
      }

      if (Array.isArray(mod.sinks)){
        for (const s of mod.sinks){
          const ns = normalizeSink(s);
          if (ns) localSinks.push(ns);
        }
      }

      if (Array.isArray(mod.tools)){
        for (const t of mod.tools){
          const nt = normalizeTool(t);
          if (nt) localTools.push(nt);
        }
      }
    } catch (e) {
      errors.push({
        file,
        message: e && e.message ? e.message : String(e),
      });
    }

    if (localRunners.length) runners.push(...localRunners);
    if (localChannels.length) channels.push(...localChannels);
    if (localSinks.length) sinks.push(...localSinks);
    if (localTools.length) tools.push(...localTools);
  }

  return { runners, channels, sinks, tools, errors, pluginFiles };
}

export default { loadGatewayV2Plugins };

