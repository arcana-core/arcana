import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { toolDaemonStatePath, toolDaemonTokenPath } from "./paths.js";
import { getContext } from "../event-bus.js";
import { ensureToolDaemonAuth } from "./auth.js";

function readJSON(p){ try { const t = readFileSync(p, "utf-8"); if (!t) return {}; const j = JSON.parse(t); return (j && typeof j === "object") ? j : {}; } catch { return {}; } }
function readText(p){ try { const t = readFileSync(p, "utf-8"); return String(t||"").trim(); } catch { return ""; } }

export class ToolDaemonClient{
  constructor({ workspaceRoot } = {}){
    const ctx = getContext?.();
    this.workspaceRoot = String(workspaceRoot || (ctx && ctx.workspaceRoot) || process.cwd());
    this.statePath = toolDaemonStatePath(this.workspaceRoot);
    this.tokenPath = toolDaemonTokenPath(this.workspaceRoot);
    this.baseUrl = null;
    this.activeAbort = null;
  }

  _hashToPort(input){
    const h = createHash("sha256").update(String(input||""), "utf8").digest();
    const n = (h[0] << 8) | h[1];
    const base = 43100; const span = 900;
    return base + (n % span);
  }

  _load(){
    const st = readJSON(this.statePath);
    let tok = readText(this.tokenPath);
    let port = Number(st.port || 0);
    if (!port || !Number.isFinite(port) || port <= 0){ port = this._hashToPort(this.workspaceRoot); }
    this.baseUrl = "http://127.0.0.1:" + String(port);
    if (!tok){ try { const a = ensureToolDaemonAuth ? ensureToolDaemonAuth({ workspaceRoot: this.workspaceRoot }) : null; } catch {} }
    if (!tok){ tok = readText(this.tokenPath); }
    this.token = tok || "";
    if (!this.token){ throw new Error("Tool daemon token missing. Start services or run a web tool once to initialize."); }
  }

  _authHeaders(){
    const headers = { "authorization": "Bearer " + (this.token || "") };
    try {
      const ctx = getContext?.() || null;
      if (ctx && ctx.agentId) headers["x-arcana-agent-id"] = String(ctx.agentId);
      if (ctx && ctx.sessionId) headers["x-arcana-session-id"] = String(ctx.sessionId);
    } catch {}
    return headers;
  }

  async _post(path, body, opts){
    if (!this.baseUrl) this._load();
    const url = this.baseUrl + path;
    const payload = JSON.stringify(body || {});
    if (this.activeAbort) { try { this.activeAbort.abort(); } catch {} }
    const ctrl = new AbortController(); this.activeAbort = ctrl;
    let timeoutHandle = null;
    const timeoutMs = (opts && typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) ? opts.timeoutMs : 0;
    try {
      if (timeoutMs > 0){
        timeoutHandle = setTimeout(function(){ try { ctrl.abort(); } catch {} }, timeoutMs);
      }
      let res;
try {
  res = await fetch(url, { method: "POST", headers: { ...this._authHeaders(), "content-type":"application/json" }, body: payload, signal: ctrl.signal });
} catch (fetchErr) {
  const fetchMsg = String(fetchErr?.message || fetchErr || "");
  const isDown = /ECONNREFUSED|fetch failed|ECONNRESET|EPIPE|socket hang up|network/i.test(fetchMsg);
  if (isDown) {
    const wrapped = new Error(
      "Tool daemon is not reachable at " + this.baseUrl + " — it may have crashed or not been started. " +
      "Restart it with: services action=restart id=tool-daemon  (Original: " + fetchMsg + ")"
    );
    wrapped.code = "TOOL_DAEMON_DOWN";
    throw wrapped;
  }
  throw fetchErr;
}
      const text = await res.text();
      try { return JSON.parse(text); } catch { return { ok:false, error:"invalid_json", raw:text }; }
    } finally {
      try { if (timeoutHandle) clearTimeout(timeoutHandle); } catch {}
      try { if (this.activeAbort === ctrl) this.activeAbort = null; } catch {}
    }
  }

  async _get(path){
    if (!this.baseUrl) this._load();
    const url = this.baseUrl + path;
    const res = await fetch(url, { method: "GET", headers: this._authHeaders() });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ok:false, error:"invalid_json", raw:text }; }
  }

  async call(toolName, args, opts){
    return this._post("/tool/" + toolName, args || {}, opts || {});
  }

  async getStatus(){ return this._get("/status"); }

  async cancelActiveCall(){ try { if (this.activeAbort) { this.activeAbort.abort(); } } catch {} return true; }
}

export default { ToolDaemonClient };
