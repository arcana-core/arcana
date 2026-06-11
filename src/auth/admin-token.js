// Admin token for the operator console and /admin/* endpoints.
//
// Deliberately SEPARATE from the regular API token: the API token is handed
// to service clients for chat/stream access, while the admin token controls
// service lifecycle, logs, and platform overview. Unlike the API token there
// is NO loopback bypass — admin calls always authenticate.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { arcanaHomePath, ensureArcanaHomeDir } from "../arcana-home.js";

const ADMIN_TOKEN_ENV = "ARCANA_ADMIN_TOKEN";
const ADMIN_TOKEN_FILE = "admin_token";
export const ADMIN_TOKEN_HEADER = "x-arcana-admin-token";
export const ADMIN_TOKEN_QUERY = "adminToken";

let cachedToken = "";

function normalizeToken(raw){
  try {
    const s = String(raw || "").trim();
    if (!s) return "";
    return s.replace(/\s+/g, "");
  } catch {
    return "";
  }
}

export function getAdminTokenFilePath(){
  try { ensureArcanaHomeDir(); } catch {}
  return arcanaHomePath(ADMIN_TOKEN_FILE);
}

export function loadOrCreateAdminToken(){
  if (cachedToken) return cachedToken;

  const env = normalizeToken(process.env[ADMIN_TOKEN_ENV]);
  if (env){
    cachedToken = env;
    return cachedToken;
  }

  try {
    const path = getAdminTokenFilePath();
    if (existsSync(path)){
      const val = normalizeToken(readFileSync(path, "utf-8"));
      if (val){
        cachedToken = val;
        return cachedToken;
      }
    }
  } catch {}

  let gen = "";
  try {
    gen = randomBytes(32).toString("base64url");
  } catch {
    gen = String(Date.now() ^ Math.floor(Math.random() * 1e9));
  }
  cachedToken = normalizeToken(gen);
  try {
    writeFileSync(getAdminTokenFilePath(), cachedToken + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {}
  return cachedToken;
}

function extractBearerToken(header){
  try {
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

export function isAuthorizedAdminRequest(req, token){
  try {
    const expected = normalizeToken(token || cachedToken || loadOrCreateAdminToken());
    if (!expected) return false;

    const headers = (req && req.headers) ? req.headers : {};

    const fromAuth = extractBearerToken(headers["authorization"] || headers["Authorization"]);
    if (fromAuth && fromAuth === expected) return true;

    let custom = headers[ADMIN_TOKEN_HEADER] || headers[ADMIN_TOKEN_HEADER.toUpperCase()];
    if (Array.isArray(custom)) custom = custom[0];
    const fromHeader = normalizeToken(custom);
    if (fromHeader && fromHeader === expected) return true;

    const rawUrl = req && req.url ? req.url : "";
    if (rawUrl){
      try {
        const u = new URL(rawUrl, "http://localhost");
        const fromQuery = normalizeToken(u.searchParams.get(ADMIN_TOKEN_QUERY));
        if (fromQuery && fromQuery === expected) return true;
      } catch {}
    }

    return false;
  } catch {
    return false;
  }
}

export default { loadOrCreateAdminToken, isAuthorizedAdminRequest, getAdminTokenFilePath, ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY };
