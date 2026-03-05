// Arcana skills prompt integration
// - Resolve skill directories from config, env, agent home, and workspace
// - Load skills via pi-coding-agent helpers
// - Dedupe by skill name (higher-priority dirs override lower)
// - Compact file paths by replacing the home directory prefix with ~/ 
// - Export buildArcanaSkillsPrompt({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot }) -> string
//   (empty string when there are no visible skills)

import { formatSkillsForPrompt, loadSkillsFromDir, parseFrontmatter } from '@mariozechner/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

function expandHome(p) {
  const home = homedir();
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  if (p.startsWith('~')) return join(home, p.slice(1));
  return p;
}

function resolvePathLike(p, base) {
  const expanded = expandHome(String(p).trim());
  return isAbsolute(expanded) ? expanded : resolve(base || process.cwd(), expanded);
}

function compactPath(p) {
  try {
    const home = homedir();
    if (!p) return p;
    const normHome = String(home).split('\\').join('/');
    const norm = String(p).split('\\').join('/');
    if (norm === normHome) return '~/';
    if (norm.startsWith(normHome + '/')) return '~/' + norm.slice(normHome.length + 1);
    if (norm.startsWith(normHome)) return '~' + norm.slice(normHome.length);
    return p;
  } catch {
    return p;
  }
}

function expandHomePath(p){
  try{
    if (!p) return p;
    const home = homedir();
    const s = String(p);
    if (s === '~') return home;
    if (s.startsWith('~/')) return join(home, s.slice(2));
    if (s.startsWith('~')) return join(home, s.slice(1));
    return p;
  } catch { return p; }
}

function readSkillToolsFromFrontmatter(skillFile){
  try{
    const raw = readFileSync(skillFile, 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);
    const arc = frontmatter && frontmatter.arcana;
    const arr = Array.isArray(arc && arc.tools) ? arc.tools : [];
    const out = [];
    for (const t of arr){
      if (!t || !t.name) continue;
      out.push({
        name: String(t.name),
        label: t.label ? String(t.label) : undefined,
        description: t.description ? String(t.description) : undefined,
        allowedHosts: Array.isArray(t.allowedHosts) ? t.allowedHosts.map(String) : undefined,
        allowedWritePaths: Array.isArray(t.allowedWritePaths) ? t.allowedWritePaths.map(String) : undefined,
      });
    }
    return out;
  } catch { return []; }
}

function unwrapLoadedSkills(loaded){
  try{
    if (!loaded) return [];
    if (Array.isArray(loaded)) return loaded;
    if (Array.isArray(loaded.skills)) return loaded.skills;
    if (loaded.value && Array.isArray(loaded.value.skills)) return loaded.value.skills;
  } catch {}
  return [];
}

// Resolve skills directories in low-to-high priority order:
// package skills < workspace skills < agent-home skills < config/env overrides.
export function resolveArcanaSkillsDirs({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot, cwd } = {}) {
  const wsRoot = workspaceRoot || cwd || process.cwd();
  const dirsPkg = [];
  const dirsWorkspace = [];
  const dirsAgent = [];
  const dirsCfgEnv = [];

  // Package skills (lowest priority)
  if (pkgRoot) {
    const pkgSkills = resolve(pkgRoot, 'skills');
    if (existsSync(pkgSkills)) dirsPkg.push(pkgSkills);
  }

  // Workspace-local skills
  if (wsRoot) {
    dirsWorkspace.push(
      resolve(wsRoot, 'skills'),
      resolve(wsRoot, '.agents', 'skills'),
    );
  }

  // Agent-home skills
  if (agentHomeRoot) {
    dirsAgent.push(
      resolve(agentHomeRoot, 'skills'),
      resolve(agentHomeRoot, '.agents', 'skills'),
    );
  }

  // Config/env skills (highest priority)
  const baseForConfig = wsRoot || process.cwd();
  const cfgDirsRaw = [
    ...(cfg?.skills?.dirs ? toArray(cfg.skills.dirs) : []),
    ...(cfg?.skills_dirs ? toArray(cfg.skills_dirs) : []),
  ];

  for (const p of cfgDirsRaw) {
    if (!p) continue;
    dirsCfgEnv.push(resolvePathLike(p, baseForConfig));
  }

  const envListRaw = String(process.env.ARCANA_SKILLS_DIRS || '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const p of envListRaw) {
    dirsCfgEnv.push(resolvePathLike(p, baseForConfig));
  }

  const seen = new Set();
  const merged = [];
  for (const group of [dirsPkg, dirsWorkspace, dirsAgent, dirsCfgEnv]) {
    for (const p of group) {
      const abs = resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      merged.push(abs);
    }
  }
  return merged;
}

export function loadArcanaSkills({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot, cwd } = {}) {
  const dirs = resolveArcanaSkillsDirs({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot, cwd });
  const byName = new Map(); // de-dupe by skill name, higher-priority dirs override lower
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const loaded = loadSkillsFromDir({ dir, source: 'path' });
      const skills = unwrapLoadedSkills(loaded);
      for (const s of skills || []) {
        const name = String(s?.name || '').trim();
        if (!name) continue;
        const filePathReal = expandHomePath(s.filePath);
        const filePathCompact = compactPath(s.filePath);
        const tools = readSkillToolsFromFrontmatter(filePathReal);
        const merged = { ...s, name, filePath: filePathCompact, tools };
        byName.set(name, merged);
      }
    } catch {
      continue;
    }
  }
  return Array.from(byName.values());
}

export function buildArcanaSkillsPrompt({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot, cwd } = {}) {
  try {
    const skills = loadArcanaSkills({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot, cwd });
    const prompt = formatSkillsForPrompt(skills);
    return prompt && prompt.trim().length > 0 ? prompt : '';
  } catch {
    return '';
  }
}

export default { buildArcanaSkillsPrompt, resolveArcanaSkillsDirs, loadArcanaSkills };
