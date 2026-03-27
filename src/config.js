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

  if (provider === "openai" || provider === "openai-compatible") {
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
 * Resolve a model from config.
 *
 * Supported shapes (OpenClaw-aligned):
 *   - String provider+id:   "google:gemini-2.0-flash" or "google/gemini-2.0-flash"
 *   - String id only:       "gemini-2.0-flash" with cfg.provider set separately
 *   - Object:               { provider, id } or { provider, model }
 */
export function resolveModelFromConfig(cfg){
  if (!cfg || cfg.model == null) return null;

  const rawModel = cfg.model;

  // Object form: { provider, id } or { provider, model }
  if (rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel)){
    const obj = rawModel;
    const provider = obj.provider != null ? obj.provider : cfg.provider;
    const id = obj.id != null ? obj.id : (obj.model != null ? obj.model : undefined);
    if (provider && id){
      return {
        provider: String(provider).trim(),
        id: String(id).trim(),
      };
    }
    if (!provider && id && cfg?.provider){
      return {
        provider: String(cfg.provider).trim(),
        id: String(id).trim(),
      };
    }
    return null;
  }

  // String form
  if (typeof rawModel === 'string'){
    const raw = rawModel.trim();
    if (!raw) return null;

    // "provider:id" (first ':' wins so ids may contain ':')
    const colonIdx = raw.indexOf(':');
    if (colonIdx > 0 && colonIdx < raw.length - 1){
      const provider = raw.slice(0, colonIdx).trim();
      const id = raw.slice(colonIdx + 1).trim();
      if (provider && id) return { provider, id };
    }

    // "provider/id" (first '/' wins so ids may contain '/')
    const slashIdx = raw.indexOf('/');
    if (slashIdx > 0 && slashIdx < raw.length - 1){
      const provider = raw.slice(0, slashIdx).trim();
      const id = raw.slice(slashIdx + 1).trim();
      if (provider && id) return { provider, id };
    }

    // If only model id is given and provider provided separately
    if (cfg?.provider){
      return { provider: String(cfg.provider).trim(), id: raw };
    }
  }

  return null;
}

/** Try to infer provider from environment variables. */
export function inferProviderFromEnv(){
  const p = (process.env.ARCANA_PROVIDER||"").trim().toLowerCase();
  if (p) return p;
  // Prefer explicit base URLs when present.
  if (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE) return "openai";
  if (process.env.ANTHROPIC_BASE_URL) return "anthropic";
  if (process.env.GOOGLE_API_BASE) return "google";
  if (process.env.OPENROUTER_BASE_URL) return "openrouter";
  // Infer from presence of standard API key env vars (presence check only; do not read values)
  try { if (Object.prototype.hasOwnProperty.call(process.env, 'OPENAI_API_KEY')) return 'openai'; } catch {}
  try { if (Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY')) return 'anthropic'; } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(process.env, 'GOOGLE_API_KEY') || Object.prototype.hasOwnProperty.call(process.env, 'GEMINI_API_KEY')) return 'google';
  } catch {}
  try { if (Object.prototype.hasOwnProperty.call(process.env, 'OPENROUTER_API_KEY')) return 'openrouter'; } catch {}
  try { if (Object.prototype.hasOwnProperty.call(process.env, 'XAI_API_KEY')) return 'xai'; } catch {}
  return "";
}

/** Resolve model from env ARCANA_MODEL, optionally paired with ARCANA_PROVIDER. */
export function resolveModelFromEnv(){
  const raw = (process.env.ARCANA_MODEL||"").trim();
  if (!raw) return null;
  const p = inferProviderFromEnv();

  // "provider:id"
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0 && colonIdx < raw.length - 1){
    const provider = raw.slice(0, colonIdx).trim();
    const id = raw.slice(colonIdx + 1).trim();
    if (provider && id) return { provider, id };
  }

  // "provider/id"
  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0 && slashIdx < raw.length - 1){
    const provider = raw.slice(0, slashIdx).trim();
    const id = raw.slice(slashIdx + 1).trim();
    if (provider && id) return { provider, id };
  }

  if (p) return { provider: p, id: raw };
  return null;
}
