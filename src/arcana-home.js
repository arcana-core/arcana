import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Arcana Home
// Centralized resolver for the per-user/global Arcana directory.
// Semantics:
// - If env ARCANA_HOME is set, use it.
// - Otherwise default to ~/.arcana
// - Helper ensureArcanaHomeDir() creates the directory (mkdir -p).
// - No reliance on workspace guard here — this is outside the session workspace.

export function resolveArcanaHome(){
  const explicit = String(process.env.ARCANA_HOME || "").trim();
  if (explicit) return explicit;
  return join(homedir(), ".arcana");
}

export function ensureArcanaHomeDir(){
  const dir = resolveArcanaHome();
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

export function arcanaHomePath(...parts){
  const base = resolveArcanaHome();
  return join(base, ...parts);
}

export default { resolveArcanaHome, ensureArcanaHomeDir, arcanaHomePath };
