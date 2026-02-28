import { existsSync, realpathSync } from "node:fs";
import { resolve, sep, isAbsolute, dirname, join, basename } from "node:path";
import { loadArcanaConfig } from "./config.js";
import { emit as emitEvent, getContext } from "./event-bus.js";

// Workspace Guard
// Central place to resolve the workspace root and to enforce read/write boundaries.
// - Root resolution order:
//   1) env ARCANA_WORKSPACE
//   2) arcana.config.json { workspace_root | workspaceRoot | workspace_dir }
//   3) process.cwd()
// - All paths are canonicalized with realpathSync when possible to defeat path traversal & symlinks.

// No global cache: workspace is session-scoped via async-local context. Keep a
// no-op reset function for backward compatibility.
export function resetWorkspaceRootCache(){}

// Canonicalize a path while defending against traversal and symlinks.
// If the exact path does not exist (e.g., a file to be created), we
// canonicalize the deepest existing parent and join the remainder.
function canon(p) {
  const abs = isAbsolute(p) ? p : resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Walk up until we find an existing ancestor, then resolve remainder
    let cur = abs;
    const tail = [];
    while (cur && !existsSync(cur)) {
      tail.push(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    try {
      const rootReal = realpathSync(cur);
      return tail.reverse().reduce((acc, part) => join(acc, part), rootReal);
    } catch {
      // If even the ancestor cannot be resolved, fall back to absolute
      return abs;
    }
  }
}

function withTrailingSep(p) { return p.endsWith(sep) ? p : (p + sep); }

export function resolveWorkspaceRoot() {
  // 1) async-local context (per-session)
  try { const ctx = getContext?.(); if (ctx && ctx.workspaceRoot) return canon(ctx.workspaceRoot); } catch {}
  // 2) env ARCANA_WORKSPACE
  const env = String(process.env.ARCANA_WORKSPACE || "").trim();
  if (env) return canon(env);
  // 3) config workspace_root | workspaceRoot | workspace_dir | workspaceDir
  try {
    const cfg = loadArcanaConfig();
    const cand = cfg?.workspace_root || cfg?.workspaceRoot || cfg?.workspace_dir || cfg?.workspaceDir;
    if (cand) return canon(cand);
  } catch {}
  // 4) process.cwd()
  return canon(process.cwd());
}

export function isUnder(root, target) {
  const r = withTrailingSep(canon(root));
  const t = canon(target);
  return t === r.slice(0, -1) || t.startsWith(r);
}

export function ensureReadAllowed(p) {
  const root = resolveWorkspaceRoot();
  // Accept relative paths by resolving them against the workspace root (not cwd)
  const raw = String(p || "");
  const target = isAbsolute(raw) ? raw : resolve(root, raw);
  const ok = isUnder(root, target);
  if (!ok) {
    try { emitEvent({ type: "workspace_guard", action: "read_blocked", root, path: raw }); } catch {}
    const err = new Error("Read forbidden: path is outside workspace root");
    err.code = "WORKSPACE_READ_FORBIDDEN";
    throw err;
  }
  return canon(target);
}

export function ensureWriteAllowed(p) {
  const root = resolveWorkspaceRoot();
  // Same semantics as ensureReadAllowed: resolve relative to workspace root before checking
  const raw = String(p || "");
  const target = isAbsolute(raw) ? raw : resolve(root, raw);
  const ok = isUnder(root, target);
  if (!ok) {
    try { emitEvent({ type: "workspace_guard", action: "write_blocked", root, path: raw }); } catch {}
    const err = new Error("Write forbidden: path is outside workspace root");
    err.code = "WORKSPACE_WRITE_FORBIDDEN";
    throw err;
  }
  return canon(target);
}

export function normalizeAllowedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [resolveWorkspaceRoot()];
  return paths.map((p) => canon(resolve(resolveWorkspaceRoot(), p)));
}

export function ensureWithinAllowedPaths(p, allowed) {
  const root = resolveWorkspaceRoot();
  const candidates = normalizeAllowedPaths(allowed);
  const target = canon(resolve(root, p));
  for (const a of candidates) {
    const base = withTrailingSep(a);
    if (target.startsWith(base)) return true;
  }
  try { emitEvent({ type: "workspace_guard", action: "write_blocked_allowed_list", root, path: String(p), allowed: candidates }); } catch {}
  return false;
}

export default {
  resolveWorkspaceRoot,
  isUnder,
  ensureReadAllowed,
  ensureWriteAllowed,
  ensureWithinAllowedPaths,
  normalizeAllowedPaths,
  resetWorkspaceRootCache,
};
