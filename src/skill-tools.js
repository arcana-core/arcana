// Load skill-scoped tools from arcana/skills/<skill>/tools/**
// - Scans each skill's tools directory
// - Resolves entry files per tool: index.js or tool.js under tools/<tool>/
// - Imports modules and collects ToolDefinition objects (default export should be a factory returning a tool)

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIsolatedSkillExecutor } from './tool-sandbox/isolated-skill-executor.js';

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

function resolveEntry(skillDir, toolName){
  const base = join(skillDir, 'tools', toolName);
  const cand = [ join(base, 'index.js'), join(base, 'tool.js') ];
  for (const p of cand){ try { if (existsSync(p) && statSync(p).isFile()) return p; } catch {} }
  return '';
}

function listToolNamesForSkill(skillDir){
  try {
    if (!skillDir) return [];
    const toolsDir = join(skillDir, 'tools');
    if (!existsSync(toolsDir) || !statSync(toolsDir).isDirectory()) return [];
    const entries = readdirSync(toolsDir, { withFileTypes: true });
    const out = [];
    for (const ent of entries){
      try {
        if (!ent || typeof ent.name !== 'string') continue;
        const name = ent.name;
        // Only consider subdirectories under tools/ as tool names.
        const isDir = ent.isDirectory ? ent.isDirectory() : statSync(join(toolsDir, name)).isDirectory();
        if (!isDir) continue;
        if (!name || name === '.' || name === '..') continue;
        out.push(name);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}


function findToolSafety(skill, toolName){
  try {
    const list = Array.isArray(skill && skill.tools) ? skill.tools : [];
    const name = String(toolName || '').trim();
    if (!name) return {};
    const match = list.find((t)=> t && String(t.name||'').trim() == name);
    if (!match) return {};
    return {
      allowNetwork: match.allowNetwork,
      allowWrite: match.allowWrite,
      allowedHosts: match.allowedHosts,
      allowedWritePaths: match.allowedWritePaths,
      allowedReadPaths: match.allowedReadPaths,
    };
  } catch {
    return {};
  }
}
export async function loadSkillTools(skills, opts = {}){
  const toolsOut = [];
  const mapSkillToTools = new Map(); // skillName -> toolNames[]
  const errors = [];
  for (const s of skills || []){
    try {
      const skillFile = expandHomePath(s.filePath || s.file_path || '');
      const skillDir = dirname(skillFile || '');
      const toolNames = [];
      const names = listToolNamesForSkill(skillDir);
      for (const rawName of names){
        const name = String(rawName || '').trim(); if (!name) continue;
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
          if (!def || !def.name || typeof def.execute !== 'function') { errors.push({ skill: s.name, tool: name, error: 'invalid_definition' }); continue; }          const safety = findToolSafety(s, def.name);
          const isolatedExec = createIsolatedSkillExecutor({
            toolEntry: entry,
            toolName: def.name,
            skillSafety: safety,
            agentHomeRoot: opts.agentHomeRoot,
          });

          toolsOut.push({ ...def, execute: isolatedExec, __arcanaExecution: 'isolated' });
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
