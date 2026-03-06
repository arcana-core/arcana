// Workspace-scoped registry for tool-host child processes.
// Stores entries in <workspaceRoot>/.arcana/tool-host/pids.json so that
// new Arcana processes can sweep orphaned tool-hosts left behind after
// crashes, without touching hosts owned by other live parents.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function registryPath(workspaceRoot){
  const base = String(workspaceRoot || process.cwd());
  return join(base, '.arcana', 'tool-host', 'pids.json');
}

function sanitizePid(pid){
  const n = Number(pid);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  return i > 0 ? i : 0;
}

function normalizeEntries(raw){
  const out = [];
  const now = Date.now();
  if (!Array.isArray(raw)) return out;
  for (const e of raw){
    if (!e || typeof e !== 'object') continue;
    const pid = sanitizePid(e.pid);
    const parentPid = sanitizePid(e.parentPid);
    if (!pid) continue;
    const startedAtMs = (typeof e.startedAtMs === 'number' && Number.isFinite(e.startedAtMs)) ? e.startedAtMs : now;
    out.push({ pid, parentPid, startedAtMs });
  }
  return out;
}

function readRegistry(workspaceRoot){
  try {
    const path = registryPath(workspaceRoot);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    if (!text) return [];
    let data;
    try { data = JSON.parse(text); }
    catch { return []; }
    if (Array.isArray(data)) return normalizeEntries(data);
    if (data && Array.isArray(data.entries)) return normalizeEntries(data.entries);
    return [];
  } catch {
    return [];
  }
}

function writeRegistry(workspaceRoot, entries){
  try {
    const path = registryPath(workspaceRoot);
    const dir = dirname(path);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const payload = JSON.stringify(Array.isArray(entries) ? entries : [], null, 2);
    writeFileSync(path, payload, 'utf8');
  } catch {
    // Best-effort only; ignore write errors.
  }
}

function isPidAlive(pid){
  const id = sanitizePid(pid);
  if (!id) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (code === 'ESRCH') return false;
    // Treat other errors (e.g. EPERM) as "maybe alive" to avoid
    // accidentally killing tool-hosts owned by another user/session.
    return true;
  }
}

function killToolHostProcess(pid){
  const id = sanitizePid(pid);
  if (!id) return;
  try {
    // Prefer killing the entire process group where supported.
    process.kill(-id, 'SIGKILL');
  } catch {
    try { process.kill(id, 'SIGKILL'); } catch {}
  }
}

export function sweepOrphanedToolHostsOnce(workspaceRoot){
  const entries = readRegistry(workspaceRoot);
  if (!entries.length) return;
  const survivors = [];
  for (const e of entries){
    if (!e || typeof e !== 'object') continue;
    const parentPid = sanitizePid(e.parentPid);
    if (parentPid && isPidAlive(parentPid)){
      survivors.push(e);
      continue;
    }
    // Parent is definitely not alive; best-effort kill for the host.
    try { killToolHostProcess(e.pid); } catch {}
  }
  writeRegistry(workspaceRoot, survivors);
}

export function registerToolHostPid(workspaceRoot, pid, parentPid){
  try {
    const id = sanitizePid(pid);
    if (!id) return;
    const ppid = sanitizePid(parentPid || process.pid);
    const now = Date.now();
    const entries = readRegistry(workspaceRoot);
    let replaced = false;
    const next = [];
    for (const e of entries){
      if (!e || typeof e !== 'object') continue;
      if (sanitizePid(e.pid) === id){
        next.push({ pid: id, parentPid: ppid, startedAtMs: now });
        replaced = true;
      } else {
        next.push(e);
      }
    }
    if (!replaced){
      next.push({ pid: id, parentPid: ppid, startedAtMs: now });
    }
    writeRegistry(workspaceRoot, next);
  } catch {
    // Best-effort only.
  }
}

export function unregisterToolHostPid(workspaceRoot, pid){
  try {
    const id = sanitizePid(pid);
    if (!id) return;
    const entries = readRegistry(workspaceRoot);
    if (!entries.length) return;
    const next = entries.filter((e) => sanitizePid(e && e.pid) !== id);
    if (next.length === entries.length) return;
    writeRegistry(workspaceRoot, next);
  } catch {
    // Best-effort only.
  }
}

export default { sweepOrphanedToolHostsOnce, registerToolHostPid, unregisterToolHostPid };

