import { createHash } from "node:crypto";
import { ensureToolDaemonAuth } from "../../auth.js";

function hashToPort(input){
  const h = createHash("sha256").update(String(input||""), "utf8").digest();
  const n = (h[2] << 8) | h[3];
  const base = 44100; const span = 900;
  return base + (n % span);
}

async function httpJson(method, url, token, body){
  const headers = { authorization: "Bearer " + token };
  if (body !== undefined){ headers["content-type"] = "application/json"; }
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { ok: res.ok, status: res.status, text, json };
}

function extractFirstJsonCodeblock(text){
  const s = String(text || "");
  const m = s.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!m) return null;
  const inner = String(m[1] || "").trim();
  try { return JSON.parse(inner); } catch { return null; }
}

function extractFirstTextContent(mcpResult){
  try {
    const c = mcpResult && mcpResult.content ? mcpResult.content : null;
    if (!Array.isArray(c) || c.length === 0) return "";
    const t = c[0] && c[0].type === "text" ? c[0].text : "";
    return String(t || "");
  } catch { return ""; }
}

export class ChromeMcpHttpClient {
  constructor({ workspaceRoot } = {}){
    this.workspaceRoot = String(workspaceRoot || process.cwd());
    this._token = null;
    this._base = null;
  }

  async _init(){
    if (this._token && this._base) return;
    const { token } = await ensureToolDaemonAuth({ workspaceRoot: this.workspaceRoot });
    this._token = token;
    const port = hashToPort(this.workspaceRoot);
    this._base = "http://127.0.0.1:" + String(port);
  }

  async status(){
    await this._init();
    const r = await httpJson("GET", this._base + "/status", this._token);
    if (r && r.ok && r.json) return r.json;
    return { ok: false, error: "status_failed", details: r && r.text ? r.text : null };
  }

  async ensureProfile(profileKey, config){
    await this._init();
    const r = await httpJson("POST", this._base + "/profiles/ensure", this._token, { profileKey: String(profileKey||"user"), config: config || {} });
    if (r && r.ok && r.json) return r.json;
    return { ok: false, error: "ensure_failed", details: r && r.text ? r.text : null };
  }

  async stopProfile(profileKey){
    await this._init();
    const r = await httpJson("POST", this._base + "/profiles/stop", this._token, { profileKey: String(profileKey||"user") });
    if (r && r.ok && r.json) return r.json;
    return { ok: false, error: "stop_failed", details: r && r.text ? r.text : null };
  }

  async call(profileKey, tool, args, config){
    await this._init();
    const body = { profileKey: String(profileKey||"user"), tool: String(tool||""), arguments: (args && typeof args === "object") ? args : {}, config: config || {} };
    const r = await httpJson("POST", this._base + "/tool/call", this._token, body);
    if (r && r.ok && r.json) return r.json;
    return { ok: false, error: "call_failed", details: r && r.text ? r.text : null };
  }
}

export function parseMcpEvaluateJsonResult(mcpCallResult){
  try {
    const result = mcpCallResult && mcpCallResult.result ? mcpCallResult.result : mcpCallResult;
    const text = extractFirstTextContent(result);
    return extractFirstJsonCodeblock(text);
  } catch { return null; }
}

export function getMcpTextContent(mcpCallResult){
  try {
    const result = mcpCallResult && mcpCallResult.result ? mcpCallResult.result : mcpCallResult;
    return extractFirstTextContent(result);
  } catch { return ""; }
}

export default { ChromeMcpHttpClient, parseMcpEvaluateJsonResult, getMcpTextContent };
