import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { arcanaHomePath, ensureArcanaHomeDir } from "../arcana-home.js";

const API_TOKEN_ENV = "ARCANA_API_TOKEN";
// Canonical token file name under ~/.arcana
const API_TOKEN_FILE_CANONICAL = "api_token";
// Legacy name for backward compatibility (read-only)
const API_TOKEN_FILE_LEGACY = "api-token";
export const API_TOKEN_HEADER = "x-arcana-token";
export const API_TOKEN_QUERY = "token";

let cachedToken = "";

function normalizeToken(raw){
  try {
    const s = String(raw || "").trim();
    if (!s) return "";
    // Collapse whitespace and ensure single-line token
    return s.replace(/\s+/g, "");
  } catch {
    return "";
  }
}

function generateToken(){
  try {
    // 32 random bytes -> base64url, no padding
    return randomBytes(32).toString("base64url");
  } catch {
    const fallback = String(Date.now() ^ Math.floor(Math.random() * 1e9));
    return fallback.replace(/\D+/g, "");
  }
}

function loadTokenFromFile(){
  try {
    ensureArcanaHomeDir();
  } catch {}
  try {
    // Prefer canonical file; fall back to legacy name if present
    const canonicalPath = arcanaHomePath(API_TOKEN_FILE_CANONICAL);
    if (existsSync(canonicalPath)){
      const raw = readFileSync(canonicalPath, "utf-8");
      const val = normalizeToken(raw);
      if (val) return val;
    }

    const legacyPath = arcanaHomePath(API_TOKEN_FILE_LEGACY);
    if (existsSync(legacyPath)){
      const raw = readFileSync(legacyPath, "utf-8");
      const val = normalizeToken(raw);
      if (val) return val;
    }

    return "";
  } catch {
    return "";
  }
}

function saveTokenToFile(token){
  try {
    ensureArcanaHomeDir();
  } catch {}
  try {
    const path = arcanaHomePath(API_TOKEN_FILE_CANONICAL);
    const value = normalizeToken(token);
    if (!value) return;
    writeFileSync(path, value + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {}
}

export function getApiTokenFilePath(){
  try {
    ensureArcanaHomeDir();
  } catch {}
  try {
    return arcanaHomePath(API_TOKEN_FILE_CANONICAL);
  } catch {
    return arcanaHomePath(API_TOKEN_FILE_CANONICAL);
  }
}

export function loadOrCreateApiToken(){
  if (cachedToken) return cachedToken;

  // 1) Explicit env var wins
  const envRaw = process.env[API_TOKEN_ENV];
  const env = normalizeToken(envRaw);
  if (env) {
    cachedToken = env;
    return cachedToken;
  }

  // 2) Existing file under Arcana home
  const fromFile = loadTokenFromFile();
  if (fromFile) {
    cachedToken = fromFile;
    return cachedToken;
  }

  // 3) Generate and persist a new token
  const gen = normalizeToken(generateToken());
  cachedToken = gen;
  saveTokenToFile(gen);
  return cachedToken;
}

function extractBearerToken(header){
  try {
    if (!header) return "";
    const raw = String(header || "").trim();
    if (!raw) return "";
    const parts = raw.split(/\s+/g);
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer"){
      return normalizeToken(parts[1]);
    }
    return normalizeToken(raw);
  } catch {
    return "";
  }
}

export function isAuthorizedRequest(req, token){
  try {
    const expected = normalizeToken(token || cachedToken || loadOrCreateApiToken());
    if (!expected) return false; // Missing/empty token -> not authorized

    const headers = (req && req.headers) ? req.headers : {};

    // 1) Authorization header (Bearer or raw)
    const authHeader = headers["authorization"] || headers["Authorization"];
    const fromAuth = extractBearerToken(authHeader);
    if (fromAuth && fromAuth === expected) return true;

    // 2) Custom x-arcana-token header
    let custom = headers[API_TOKEN_HEADER] || headers[API_TOKEN_HEADER.toUpperCase()];
    if (Array.isArray(custom)) custom = custom[0];
    const fromHeader = normalizeToken(custom);
    if (fromHeader && fromHeader === expected) return true;

    // 3) Query param ?token= or ?api_token=
    const rawUrl = req && req.url ? req.url : "";
    if (rawUrl) {
      try {
        const u = new URL(rawUrl, "http://localhost");
        const qp = u.searchParams.get(API_TOKEN_QUERY) || u.searchParams.get("api_token");
        const fromQuery = normalizeToken(qp);
        if (fromQuery && fromQuery === expected) return true;
      } catch {}
    }

    return false;
  } catch {
    return false;
  }
}

export function tokenHint(token){
  const t = normalizeToken(token || cachedToken || "");
  if (!t) return "(none)";
  const len = t.length;
  if (len <= 8) {
    // Still avoid printing the raw token directly
    const masked = "*".repeat(Math.max(0, len - 2)) + t.slice(-2);
    return "[len=" + String(len) + ", masked=" + masked + "]";
  }
  const prefix = t.slice(0, 4);
  const suffix = t.slice(-4);
  return "[len=" + String(len) + ", prefix=" + prefix + ", suffix=" + suffix + "]";
}

export default { loadOrCreateApiToken, isAuthorizedRequest, tokenHint, API_TOKEN_HEADER, API_TOKEN_QUERY };
