import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

export function toolDaemonBaseDir(workspaceRoot){
  return join(String(workspaceRoot||process.cwd()), ".arcana", "tool-daemon");
}

export function toolDaemonStatePath(workspaceRoot){
  return join(toolDaemonBaseDir(workspaceRoot), "state.json");
}

export function toolDaemonTokenPath(workspaceRoot){
  return join(toolDaemonBaseDir(workspaceRoot), "token.txt");
}

export function browserBaseDir(workspaceRoot){
  return join(String(workspaceRoot||process.cwd()), ".arcana", "browser");
}

export function browserProfilesDir(workspaceRoot){
  return join(browserBaseDir(workspaceRoot), "profiles");
}

export function browserProfileDir(workspaceRoot, profileKey){
  const safe = String(profileKey||"default").replace(/[^A-Za-z0-9_:\.-]/g, "_");
  return join(browserProfilesDir(workspaceRoot), safe);
}

export function ensureDir(p){
  try { mkdirSync(p, { recursive: true }); } catch {}
}

export function ensureParentDir(p){
  try { const d = dirname(p); mkdirSync(d, { recursive: true }); } catch {}
}

export default { toolDaemonBaseDir, toolDaemonStatePath, toolDaemonTokenPath, browserBaseDir, browserProfilesDir, browserProfileDir, ensureDir, ensureParentDir };
