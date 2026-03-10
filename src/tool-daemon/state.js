import { readFileSync, writeFileSync } from "node:fs";
import { toolDaemonStatePath, ensureParentDir } from "./paths.js";

export async function readState({ workspaceRoot }){
  const p = toolDaemonStatePath(workspaceRoot);
  try {
    const t = readFileSync(p, "utf-8");
    if (!t) return {};
    const j = JSON.parse(t);
    return (j && typeof j === "object") ? j : {};
  } catch { return {}; }
}

export async function writeState({ workspaceRoot, state }){
  const p = toolDaemonStatePath(workspaceRoot);
  try { ensureParentDir(p); } catch {}
  try {
    const payload = JSON.stringify(state || {}, null, 2);
    writeFileSync(p, payload, "utf-8");
  } catch {}
}

export default { readState, writeState };

