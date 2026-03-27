// wrap-arcana-tool — inject SafeOps (defaults open net + workspace-only writes)
// and merge per-Skill overrides from SKILL.md frontmatter (arcana.tools).
//
// Note: This wrapper is imported by tools inside arcana/skills/*/tools/**, so
// keep it dependency-light and resilient to missing/partial frontmatter.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { initTheme } from '@mariozechner/pi-coding-agent';
import { createSafeOps } from './safe-ops.js';
import { getContext } from '../event-bus.js';
import { parseFrontmatter } from '../util/frontmatter.js';

// pi-coding-agent has a global theme Proxy that some renderers touch even in headless
// mode. When Arcana is embedded (not started via pi CLI), the theme may be
// uninitialized and throw: "Theme not initialized. Call initTheme() first."
let __piThemeInitialized = false;
function ensurePiThemeInitialized(){
  if (__piThemeInitialized) return;
  __piThemeInitialized = true;
  try { initTheme(undefined, false); } catch {}
}

ensurePiThemeInitialized();

function readSkillToolOverrides(skillDir, toolName){
  try{
    const p = join(skillDir, 'SKILL.md');
    const raw = readFileSync(p, 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);
    const arc = frontmatter?.arcana;
    const arr = Array.isArray(arc?.tools) ? arc.tools : [];
    const match = arr.find(t => (t && (t.name === toolName)));
    if (!match) return {};
    const allowedHosts = Array.isArray(match.allowedHosts) ? match.allowedHosts : undefined;
    const allowedWritePaths = Array.isArray(match.allowedWritePaths) ? match.allowedWritePaths : undefined;
    const allowNetwork = (match.allowNetwork === false) ? false : (match.allowNetwork === true ? true : undefined);
    const allowWrite = (match.allowWrite === false) ? false : (match.allowWrite === true ? true : undefined);
    const label = match.label; const description = match.description;
    return { allowedHosts, allowedWritePaths, allowNetwork, allowWrite, label, description };
  } catch { return {}; }
}

/**
 * Wrap a tool factory to inject SafeOps and merge Skill frontmatter overrides.
 * @param {() => { name:string, label:string, description:string, parameters:any, execute:function }} factory
 * @param {{ skillDir?: string, defaultSafety?: { allowNetwork?: boolean, allowWrite?: boolean, allowedHosts?: string[], allowedWritePaths?: string[] } }} opts
 */
export function wrapArcanaTool(factory, opts={}){
  const base = factory();
  if (!base || !base.name || typeof base.execute !== 'function') return base;

  const skillDir = opts.skillDir || dirname(dirname(fileURLToPath(import.meta.url))); // best-effort
  const ov = readSkillToolOverrides(skillDir, base.name);
  const mergedSafety = {
    allowNetwork: (ov.allowNetwork !== undefined) ? ov.allowNetwork : (opts.defaultSafety?.allowNetwork !== undefined ? opts.defaultSafety.allowNetwork : true),
    allowWrite: (ov.allowWrite !== undefined) ? ov.allowWrite : (opts.defaultSafety?.allowWrite !== undefined ? opts.defaultSafety.allowWrite : true),
    allowedHosts: ov.allowedHosts || opts.defaultSafety?.allowedHosts || undefined,
    allowedWritePaths: ov.allowedWritePaths || opts.defaultSafety?.allowedWritePaths || undefined,
  };

  const out = {
    ...base,
    label: ov.label || base.label,
    description: ov.description || base.description,
    async execute(callId, args, signal, onUpdate, ctx){
      // Merge AsyncLocalStorage context with provided ctx; explicit ctx wins.
      const alsCtx = (typeof getContext === 'function' ? (getContext() || null) : null);
      const mergedCtx = { ...(alsCtx || {}), ...(ctx || {}) };
      // Always create SafeOps from the merged safety config. This ensures
      // per-tool constraints (allowedHosts, allowedWritePaths, etc.) from
      // SKILL.md frontmatter are enforced consistently.
      const safeOps = createSafeOps(mergedSafety);
      const ctxWithOps = { ...mergedCtx, safeOps };
      return base.execute(callId, args, signal, onUpdate, ctxWithOps);
    }
  };
  return out;
}

export default { wrapArcanaTool };
