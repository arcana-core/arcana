import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, basename, sep } from "node:path";
import { ensureArcanaHomeDir, arcanaHomePath } from "./arcana-home.js";
import { getContext, emit as emitEvent } from "./event-bus.js";

const DEFAULT_AGENT_ID = 'default';

// Agent Guard
// - Central resolver for agentId and agent home root (~/.arcana/agents/<agentId>/).
// - Separate from workspace guard: this is for agent-local state such as
//   MEMORY.md, memory/*.md, skills, persona files, and services.ini.
// - Agent resolution order:
//   1) Async-local context ctx.agentId (per-session)
//   2) env ARCANA_AGENT_ID
//   3) literal "default" (default agent)

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
      return abs;
    }
  }
}

function withTrailingSep(p) { return p.endsWith(sep) ? p : (p + sep); }

function normalizeAgentId(raw) {
  try {
    const s = String(raw || "").trim();
    if (!s) return DEFAULT_AGENT_ID;
    // Keep the id fairly conservative to avoid path traversal.
    const safe = s.replace(/[^A-Za-z0-9_-]/g, "_");
    return safe || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

export function resolveAgentId() {
  // 1) async-local context
  try {
    const ctx = getContext?.();
    if (ctx && ctx.agentId) {
      return normalizeAgentId(ctx.agentId);
    }
  } catch {}

  // 2) env ARCANA_AGENT_ID
  try {
    const env = String(process.env.ARCANA_AGENT_ID || "").trim();
    if (env) return normalizeAgentId(env);
  } catch {}

  // 3) default
  return DEFAULT_AGENT_ID;
}

export function resolveAgentHomeRoot() {
  const agentId = resolveAgentId();
  // Ensure global Arcana home exists (~/.arcana), then resolve per-agent home
  // under ~/.arcana/agents/<agentId>/.
  let base = "";
  try { base = ensureArcanaHomeDir(); } catch { base = arcanaHomePath(); }
  const dir = join(base, "agents", agentId);
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch {}
  try { return canon(dir); } catch { return dir; }
}

function isUnder(root, target) {
  const r = withTrailingSep(canon(root));
  const t = canon(target);
  return t === r.slice(0, -1) || t.startsWith(r);
}

export function ensureAgentReadAllowed(p) {
  const root = resolveAgentHomeRoot();
  const raw = String(p || "");
  const target = isAbsolute(raw) ? raw : resolve(root, raw);
  const ok = isUnder(root, target);
  if (!ok) {
    try { emitEvent({ type: "agent_guard", action: "read_blocked", agentId: resolveAgentId(), root, path: raw }); } catch {}
    const err = new Error("Read forbidden: path is outside agent home root");
    err.code = "AGENT_READ_FORBIDDEN";
    throw err;
  }
  return canon(target);
}

export function ensureAgentWriteAllowed(p) {
  const root = resolveAgentHomeRoot();
  const raw = String(p || "");
  const target = isAbsolute(raw) ? raw : resolve(root, raw);
  const ok = isUnder(root, target);
  if (!ok) {
    try { emitEvent({ type: "agent_guard", action: "write_blocked", agentId: resolveAgentId(), root, path: raw }); } catch {}
    const err = new Error("Write forbidden: path is outside agent home root");
    err.code = "AGENT_WRITE_FORBIDDEN";
    throw err;
  }
  return canon(target);
}

export default {
  resolveAgentId,
  resolveAgentHomeRoot,
  ensureAgentReadAllowed,
  ensureAgentWriteAllowed,
};

