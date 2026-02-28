// Arcana skills prompt integration (OpenClaw style)
// - Resolve skill directories from config, env, and sensible defaults
// - Load skills via pi-coding-agent helpers
// - Dedupe by name+filePath
// - Compact file paths by replacing the home directory prefix with ~/ 
// - Export buildArcanaSkillsPrompt({ cwd, cfg, pkgRoot, repoRoot }) -> string
//   (empty string when there are no visible skills)

import { formatSkillsForPrompt, loadSkillsFromDir } from '@mariozechner/pi-coding-agent';
import { existsSync } from 'node:fs';
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

function resolvePathLike(p, cwd) {
  const expanded = expandHome(String(p).trim());
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
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

export function resolveArcanaSkillsDirs({ cwd, cfg, pkgRoot, repoRoot } = {}) {
  const dirs = [];
  const cwdUse = cwd || process.cwd();

  // 1) Config: cfg.skills.dirs or cfg.skills_dirs (array or single string)
  const cfgDirs = [
    ...(cfg?.skills?.dirs ? toArray(cfg.skills.dirs) : []),
    ...(cfg?.skills_dirs ? toArray(cfg.skills_dirs) : []),
  ]
    .map((p) => resolvePathLike(p, cwdUse))
    .filter(Boolean);

  // 2) Env: ARCANA_SKILLS_DIRS (path list)
  const envList = (process.env.ARCANA_SKILLS_DIRS || '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolvePathLike(p, cwdUse));

  // 3) Defaults: <cwd>/skills, <cwd>/.agents/skills, <cwd>/openclaw/skills
  const defaults = [
    resolve(cwdUse, 'skills'),
    resolve(cwdUse, '.agents', 'skills'),
    resolve(cwdUse, 'openclaw', 'skills'),
  ];
  // Also consider repoRoot/openclaw/skills if repoRoot is provided (handles running from arcana/pkg)
  if (repoRoot) {
    defaults.push(resolve(repoRoot, 'openclaw', 'skills'));
  }

  // plus <pkgRoot>/skills if present
  if (pkgRoot) {
    const pkgSkills = resolve(pkgRoot, 'skills');
    if (existsSync(pkgSkills)) defaults.push(pkgSkills);
  }

  // Merge in priority order, dedupe by absolute path
  const seen = new Set();
  const merged = [];
  for (const arr of [cfgDirs, envList, defaults]) {
    for (const p of arr) {
      const abs = resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      merged.push(abs);
    }
  }
  return merged;
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

export function loadArcanaSkills({ cwd, cfg, pkgRoot, repoRoot } = {}) {
  const dirs = resolveArcanaSkillsDirs({ cwd, cfg, pkgRoot, repoRoot });
  const seen = new Set(); // de-dupe by name|filePath
  const all = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const loaded = loadSkillsFromDir({ dir, source: 'path' });
      const skills = unwrapLoadedSkills(loaded);
      for (const s of skills || []) {
        const key = String(s?.name||'') + '|' + String(s?.filePath||'');
        if (seen.has(key)) continue;
        seen.add(key);
        all.push({ ...s, filePath: compactPath(s.filePath) });
      }
    } catch {
      continue;
    }
  }
  return all;
}
export function buildArcanaSkillsPrompt({ cwd, cfg, pkgRoot, repoRoot } = {}) {
  try {
    const skills = loadArcanaSkills({ cwd, cfg, pkgRoot, repoRoot });
    const prompt = formatSkillsForPrompt(skills);
    return prompt && prompt.trim().length > 0 ? prompt : '';
  } catch {
    return '';
  }
}

export default { buildArcanaSkillsPrompt, resolveArcanaSkillsDirs, loadArcanaSkills };
