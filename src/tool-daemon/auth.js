import { openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { toolDaemonTokenPath, ensureParentDir } from "./paths.js";

function generateToken(){
  // 32 bytes random -> hex string
  try { return randomBytes(32).toString("hex"); } catch { return String(Date.now()) + "-" + Math.random().toString(36).slice(2); }
}

export async function ensureToolDaemonAuth({ workspaceRoot }){
  const p = toolDaemonTokenPath(workspaceRoot);
  try {
    const t = readFileSync(p, "utf-8");
    if (t && t.trim()) return { token: t.trim() };
  } catch {}
  // Create-once file using exclusive flag. If already exists, read it.
  try {
    ensureParentDir(p);
    const fd = openSync(p, "wx", 0o600);
    const tok = generateToken();
    try { writeFileSync(fd, tok, { encoding: "utf-8" }); } finally { try { closeSync(fd); } catch {} }
    return { token: tok };
  } catch {
    try {
      const t = readFileSync(p, "utf-8");
      if (t && t.trim()) return { token: t.trim() };
    } catch {}
    const tok = generateToken();
    return { token: tok };
  }
}

export default { ensureToolDaemonAuth };

