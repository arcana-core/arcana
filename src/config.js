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
  const base = cfg.base_url?.trim();

  if (provider === "openai") {
    if (base) {
      process.env.OPENAI_BASE_URL = base;      // common convention
      process.env.OPENAI_API_BASE = base;      // alt convention
    } else {
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_BASE;
    }
  } else if (provider === "openrouter") {
    if (base) process.env.OPENROUTER_BASE_URL = base;
    else delete process.env.OPENROUTER_BASE_URL;
  } else if (provider === "xai") {
    // no non-secret env wiring required
  } else if (provider === "anthropic") {
    if (base) process.env.ANTHROPIC_BASE_URL = base;
    else delete process.env.ANTHROPIC_BASE_URL;
  } else if (provider === "google") {
    // Google AI Studio — Arcana supplies apiKey via secrets/authStorage; only GOOGLE_API_BASE is set here
    if (base) process.env.GOOGLE_API_BASE = base; // optional; most setups use default
    else delete process.env.GOOGLE_API_BASE;
  } else {
    // Fallback: expose as ARCANA_GENERIC_* for potential custom provider wiring later
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
  // Avoid inferring provider from secret env vars like *_API_KEY.
  // Only use non-secret hints such as base URLs.
  if (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE) return "openai";
  if (process.env.ANTHROPIC_BASE_URL) return "anthropic";
  if (process.env.GOOGLE_API_BASE) return "google";
  if (process.env.OPENROUTER_BASE_URL) return "openrouter";
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
