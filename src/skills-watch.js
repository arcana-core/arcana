// Lightweight polling watcher for SKILL.md files under skills roots
// - No external deps; scans only root/SKILL.md and root/*/SKILL.md (non-hidden, not node_modules)
// - Uses resolveArcanaSkillsDirs from ./skills.js
// - Debounced onChange callback with changed paths
// - Module-level singleton: multiple ensure* calls won't spawn multiple timers

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveArcanaSkillsDirs } from './skills.js';

// Singleton state (module-level)
let gWatcher = null;

function computeSnapshot(roots) {
  const entries = [];
  const cap = 300;
  for (const root of roots) {
    try {
      // root/SKILL.md
      const rootSkill = join(root, 'SKILL.md');
      if (existsSync(rootSkill)) {
        try {
          const st = statSync(rootSkill);
          entries.push([rootSkill, st.mtimeMs || 0, st.size || 0]);
        } catch { /* ignore */ }
      }
      // root/*/SKILL.md (only immediate children, skip hidden and node_modules)
      let children = [];
      try { children = readdirSync(root, { withFileTypes: true }); } catch { children = []; }
      let seen = 0;
      for (const d of children) {
        const name = String(d.name || '');
        if (!name || name === 'node_modules' || name.startsWith('.')) { continue; }

        // Treat symlinked directories as candidates too. Follow the link to check if it's a directory.
        let isDir = false;
        try {
          if (d?.isDirectory?.()) {
            isDir = true;
          } else if (d?.isSymbolicLink?.()) {
            const st = statSync(join(root, name));
            isDir = !!st?.isDirectory?.();
          }
        } catch { /* ignore stat errors; not a directory candidate */ }

        if (!isDir) { continue; }

        const childSkill = join(root, name, 'SKILL.md');
        if (existsSync(childSkill)) {
          try {
            const st = statSync(childSkill);
            entries.push([childSkill, st.mtimeMs || 0, st.size || 0]);
          } catch { /* ignore */ }
        }
        seen++;
        if (seen >= cap) break;
      }
    } catch { /* ignore root errors */ }
  }
  // Build signature and map
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sig = JSON.stringify(entries);
  const map = new Map(entries.map(([p, m, s]) => [p, { mtimeMs: m, size: s }]));
  return { signature: sig, map };
}

export function ensureArcanaSkillsWatcher({ cwd, cfg, pkgRoot, repoRoot, intervalMs = 1000, debounceMs = 300, onChange } = {}) {
  // Compute roots and key for idempotence across calls
  const roots = resolveArcanaSkillsDirs({ cwd, cfg, pkgRoot, repoRoot }) || [];
  const key = `${roots.join('|')}|${intervalMs}|${debounceMs}`;

  // If a watcher already exists, reuse it if the config matches; otherwise stop and recreate
  if (gWatcher) {
    if (gWatcher.key === key) {
      if (onChange) gWatcher.onChange = onChange; // update callback if provided
      return gWatcher.stop;
    }
    // Different config (roots/interval/debounce) → tear down and create a new one
    try { gWatcher.stop?.(); } catch { /* ignore */ }
  }
  let { signature, map } = computeSnapshot(roots);
  let changeTimer = null;
  const pendingPaths = new Set();

  function fireChangeDebounced() {
    const cb = gWatcher?.onChange;
    if (!cb) return;
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      const paths = Array.from(pendingPaths);
      pendingPaths.clear();
      changeTimer = null;
      try {
        cb({ reason: 'watch', ...(paths.length ? { changedPaths: paths } : {}) });
      } catch { /* ignore user callback errors */ }
    }, debounceMs);
  }

  const iv = setInterval(() => {
    try {
      const snap = computeSnapshot(roots);
      if (snap.signature !== signature) {
        // Compute changed paths for diagnostics
        try {
          const changed = [];
          const allKeys = new Set([...map.keys(), ...snap.map.keys()]);
          for (const k of allKeys) {
            const a = map.get(k);
            const b = snap.map.get(k);
            if (!a || !b) { changed.push(k); continue; }
            if (a.mtimeMs !== b.mtimeMs || a.size !== b.size) changed.push(k);
          }
          for (const p of changed) pendingPaths.add(p);
        } catch { /* ignore */ }
        signature = snap.signature;
        map = snap.map;
        fireChangeDebounced();
      }
    } catch { /* swallow to avoid unhandled rejections */ }
  }, Math.max(200, Number(intervalMs) || 1000));

  function stop() {
    try { clearInterval(iv); } catch {}
    try { if (changeTimer) clearTimeout(changeTimer); } catch {}
    gWatcher = null;
  }

  gWatcher = { stop, onChange, intervalMs, debounceMs, key, roots };
  return stop;
}

export default { ensureArcanaSkillsWatcher };
