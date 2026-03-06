import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveArcanaHome } from "./arcana-home.js";
import { homedir } from "node:os";

export function loadArcanaConfig() {
  const explicit = process.env.ARCANA_CONFIG?.trim();
  const candidates = [
    explicit,
    join(resolveArcanaHome(), "config.json"),
    join(process.cwd(), "arcana.config.json"),
    join(process.cwd(), "arcana", "arcana.config.json"),
    join(homedir(), ".arcana", "config.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) {
        const raw = readFileSync(p, "utf-8");
        const cfg = JSON.parse(raw);
        return { path: p, ...cfg };
      }
    } catch {
      // ignore parse errors; fall through
    }
  }
  return null;
}

export function loadAgentConfig(agentHomeRoot) {
  try {
    const base = String(agentHomeRoot || '').trim();
    if (!base) return null;
    const p = join(base, 'config.json');
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf-8');
    const cfg = JSON.parse(raw);
    return { path: p, ...cfg };
  } catch {
    return null;
  }
}

export function applyProviderEnv(cfg) {
  if (!cfg) return;
  const provider = (cfg.provider || "openai").toLowerCase();
  const key = cfg.key?.trim();
  const base = cfg.base_url?.trim();

  if (provider === "openai") {
    if (key && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = key;
    if (base) {
      process.env.OPENAI_BASE_URL = base;      // common convention
      process.env.OPENAI_API_BASE = base;      // alt convention
    }
  } else if (provider === "openrouter") {
    if (key && !process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = key;
    if (base) process.env.OPENROUTER_BASE_URL = base;
  } else if (provider === "xai") {
    if (key && !process.env.XAI_API_KEY) process.env.XAI_API_KEY = key;
  } else if (provider === "anthropic") {
    if (key && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = key;
  } else if (provider === "google") {
    // Google AI Studio (Generative Language API)
    if (key && !process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = key;
    if (base) process.env.GOOGLE_API_BASE = base; // optional; most setups use default
  } else {
    // Fallback: expose as ARCANA_GENERIC_* for potential custom provider wiring later
    if (key) process.env.ARCANA_GENERIC_API_KEY = key;
    if (base) process.env.ARCANA_GENERIC_BASE_URL = base;
  }
}

/**
 * Resolve a model from config like:
 *   { "model": "google:gemini-2.0-flash" }
 * Returns { provider, id } or null.
 */
export function resolveModelFromConfig(cfg){
  const raw = cfg?.model?.trim();
  if (!raw) return null;
  const m = raw.split(":");
  if (m.length === 2) return { provider: m[0].trim(), id: m[1].trim() };
  // If only model id is given and provider provided separately
  if (cfg?.provider) return { provider: String(cfg.provider).trim(), id: raw };
  return null;
}

/** Try to infer provider from environment variables. */
export function inferProviderFromEnv(){
  const p = (process.env.ARCANA_PROVIDER||"").trim().toLowerCase();
  if (p) return p;
  if (process.env.GOOGLE_API_KEY) return "google";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.XAI_API_KEY) return "xai";
  return "";
}

/** Resolve model from env ARCANA_MODEL, optionally paired with ARCANA_PROVIDER. */
export function resolveModelFromEnv(){
  const raw = (process.env.ARCANA_MODEL||"").trim();
  if (!raw) return null;
  const p = inferProviderFromEnv();
  if (raw.includes(":")){
    const [prov,id] = raw.split(":");
    return { provider: prov.trim(), id: id.trim() };
  }
  if (p) return { provider: p, id: raw };
  return null;
}
