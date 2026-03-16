// Load skill-scoped tools from arcana/skills/<skill>/tools/** based on SKILL.md frontmatter
// - Reads the tools list from frontmatter (arcana.tools)
// - Resolves entry files per tool: index.js or tool.js under tools/<tool>/
// - Imports modules and collects ToolDefinition objects (default export should be a factory returning a tool)

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFrontmatter } from '@mariozechner/pi-coding-agent';

function expandHomePath(p){
  try{
    if (!p) return p;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const s = String(p);
    if (s === '~') return home;
    if (s.startsWith('~/')) return join(home, s.slice(2));
    if (s.startsWith('~')) return join(home, s.slice(1));
    return p;
  } catch { return p }
}

function readToolsFromSkillFile(skillFile){
  try{
    const raw = readFileSync(skillFile, 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);
    const arc = frontmatter && frontmatter.arcana;
    const arr = Array.isArray(arc && arc.tools) ? arc.tools : [];
    const out = [];
    for (const t of arr){ if (t && t.name) out.push({ name: String(t.name), label: t.label, description: t.description }); }
    return out;
  } catch { return [] }
}

function resolveEntry(skillDir, toolName){
  const base = join(skillDir, 'tools', toolName);
  const cand = [ join(base, 'index.js'), join(base, 'tool.js') ];
  for (const p of cand){ try { if (existsSync(p) && statSync(p).isFile()) return p; } catch {} }
  return '';
}

export async function loadSkillTools(skills){
  const toolsOut = [];
  const mapSkillToTools = new Map(); // skillName -> toolNames[]
  const errors = [];
  for (const s of skills || []){
    try {
      const skillFile = expandHomePath(s.filePath || s.file_path || '');
      const skillDir = dirname(skillFile || '');
      const fromFm = Array.isArray(s.tools) && s.tools.length ? s.tools : readToolsFromSkillFile(skillFile);
      const toolNames = [];
      for (const t of fromFm){
        const name = String(t.name||'').trim(); if (!name) continue;
        const entry = resolveEntry(skillDir, name);
        if (!entry) { errors.push({ skill: s.name, tool: name, error: 'entry_not_found' }); continue; }
        try {
          let href = pathToFileURL(entry).href;
          try {
            const st = statSync(entry);
            const m = st.mtimeMs || 0;
            const sep = href.includes('?') ? '&' : '?';
            href = href + sep + 'mtime=' + String(m);
          } catch {}
          try {
            if (skillFile) {
              const skSt = statSync(skillFile);
              const sm = skSt.mtimeMs || 0;
              const sep2 = href.includes('?') ? '&' : '?';
              href = href + sep2 + 'skillMtime=' + String(sm);
            }
          } catch {}
          const mod = await import(href);
          const fn = (mod && mod.default && typeof mod.default === 'function') ? mod.default : null;
          if (!fn) { errors.push({ skill: s.name, tool: name, error: 'no_default_factory' }); continue; }
          const def = await Promise.resolve(fn());
          if (!def || !def.name || typeof def.execute !== 'function') { errors.push({ skill: s.name, tool: name, error: 'invalid_definition' }); continue; }
          toolsOut.push(def);
          toolNames.push(def.name);
        } catch (e) {
          errors.push({ skill: s.name, tool: name, error: (e && e.message) ? e.message : String(e) });
        }
      }
      mapSkillToTools.set(s.name, toolNames);
    } catch (e) {
      errors.push({ skill: s && s.name, error: (e && e.message) ? e.message : String(e) });
    }
  }
  return { tools: toolsOut, skillToolNamesBySkill: mapSkillToTools, errors };
}

export default { loadSkillTools };
