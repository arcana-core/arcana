import { Type } from "@sinclair/typebox";

function _callTimeoutOpts(baseMs, overrideSec){
  if (baseMs === 0) return {};
  const t = Number(overrideSec || 0);
  const ms = t > 0 ? Math.max(baseMs, (t * 1000) + 5000) : baseMs;
  return (ms && ms > 0) ? { timeoutMs: ms } : {};
}

const WEB_TIMEOUT_ENV = process.env.ARCANA_TOOLHOST_WEB_TIMEOUT_MS;
const WEB_TIMEOUT_MS = (WEB_TIMEOUT_ENV === "0") ? 0 : Number(WEB_TIMEOUT_ENV || 120000);
const WEB_SHORT_TIMEOUT_MS = Math.min(WEB_TIMEOUT_MS, 10000);
const BASH_TIMEOUT_ENV = process.env.ARCANA_TOOLHOST_BASH_TIMEOUT_MS;
const BASH_TIMEOUT_MS = (BASH_TIMEOUT_ENV === "0") ? 0 : Number(BASH_TIMEOUT_ENV || 300000);

export function createProxyBashTool(client){
  const Params = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
  });
  return {
    name: "bash",
    label: "bash",
    description: "Execute a bash command via tool daemon.",
    parameters: Params,
    async execute(_id, { command, timeout }, signal){
      const toError = function(err){ const msg = err && err.message ? err.message : String(err||""); const isDaemonDown = (err && err.code === "TOOL_DAEMON_DOWN") || /Tool daemon is not reachable|ECONNREFUSED/i.test(msg); if (isDaemonDown) { const text = "bash failed: tool-daemon is not running or crashed. Restart with: services action=restart id=tool-daemon\n(" + msg + ")"; return { content:[{ type:"text", text }], details:{ ok:false, error: "tool_daemon_down", message: msg, tool: "bash", hint: "Restart tool-daemon: services action=restart id=tool-daemon" } }; } const kind = (msg === "timeout") ? "timeout" : (msg === "cancelled") ? "cancelled" : "error"; const hint = "Increase ARCANA_TOOLHOST_BASH_TIMEOUT_MS or pass bash.timeout (seconds)."; const text = "bash failed: " + kind + (msg && msg !== kind ? (" ("+msg+")") : "") + ". " + hint; return { content:[{ type:"text", text }], details:{ ok:false, error: kind, message: msg, tool: "bash", hint } }; };
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} return toError(new Error("cancelled")); }
      const onAbort = async function(){ try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        let timeoutMs = BASH_TIMEOUT_MS; if (timeoutMs !== 0){ const t = Number(timeout || 0); if (t > 0) timeoutMs = Math.max(timeoutMs, (t*1000)+5000); }
        const callOpts = (timeoutMs && timeoutMs > 0) ? { timeoutMs } : {};
        const res = await client.call("bash", { command, timeout }, callOpts);
        return res;
      } catch (e) {
        return toError(e);
      } finally { try { signal?.removeEventListener("abort", onAbort); } catch {} }
    }
  };
}

export function createProxyWebRenderTool(client){
  const Params = Type.Object({
    action: Type.String({ description: "start|status|navigate|snapshot|open|close|click" }),
    url: Type.Optional(Type.String()),
    proxy: Type.Optional(Type.String({ description: "Proxy mode: 'system' (default), 'none' to bypass, or a proxy URL like socks5://127.0.0.1:1086" })),
    waitUntil: Type.Optional(Type.String()),
    maxChars: Type.Optional(Type.Number()),
    headless: Type.Optional(Type.Boolean()),
    engine: Type.Optional(Type.String()),
    userDataDir: Type.Optional(Type.String()),
    forceRestart: Type.Optional(Type.Boolean()),
    selector: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    nth: Type.Optional(Type.Number()),
    timeoutMs: Type.Optional(Type.Number()),
    timeout: Type.Optional(Type.Number()),
  });
  return {
    name: "web_render",
    label: "Web Render (daemon)",
    description: "Navigate and snapshot pages in a persistent Playwright session (tool daemon).",
    parameters: Params,
    async execute(_id, args, signal){
      const toError = function(err){ const msg = err && err.message ? err.message : String(err||""); const isDaemonDown = (err && err.code === "TOOL_DAEMON_DOWN") || /Tool daemon is not reachable|ECONNREFUSED/i.test(msg); if (isDaemonDown) { const text = "web_render failed: tool-daemon is not running or crashed. Restart with: services action=restart id=tool-daemon\n(" + msg + ")"; return { content:[{ type:"text", text }], details:{ ok:false, error: "tool_daemon_down", message: msg, tool: "web_render", hint: "Restart tool-daemon: services action=restart id=tool-daemon" } }; } const kind = (msg === "timeout") ? "timeout" : (msg === "cancelled") ? "cancelled" : "error"; const hint = "Increase ARCANA_TOOLHOST_WEB_TIMEOUT_MS or pass args.timeout (seconds)."; const text = "web_render failed: " + kind + (msg && msg !== kind ? (" ("+msg+")") : "") + ". " + hint; return { content:[{ type:"text", text }], details:{ ok:false, error: kind, message: msg, tool: "web_render", hint } }; };
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} return toError(new Error("cancelled")); }
      const onAbort = async function(){ try { await client.cancelActiveCall(); } catch {} };
      const action = String(args?.action||"").toLowerCase();
      const isShort = (action === "start" || action === "status" || action === "open" || action === "close");
      const callOpts = _callTimeoutOpts(isShort ? WEB_SHORT_TIMEOUT_MS : WEB_TIMEOUT_MS, isShort ? 0 : (args && args.timeout));
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        const res = await client.call("web_render", args||{}, callOpts);
        return res;
      } catch (e) { return toError(e); } finally { try { signal?.removeEventListener("abort", onAbort); } catch {} }
    }
  };
}

export function createProxyWebExtractTool(client){
  const Params = Type.Object({
    mode: Type.Optional(Type.String({ description: "article|main|full" })),
    selector: Type.Optional(Type.String()),
    proxy: Type.Optional(Type.String({ description: "Proxy mode: 'system' (default), 'none' to bypass, or a proxy URL like socks5://127.0.0.1:1086" })),
    maxChars: Type.Optional(Type.Number()),
    timeout: Type.Optional(Type.Number()),
    autoScroll: Type.Optional(Type.Boolean()),
  });
  return {
    name: "web_extract",
    label: "Web Extract (daemon)",
    description: "Extract readable text from current page (tool daemon).",
    parameters: Params,
    async execute(_id, args, signal){
      const toError = function(err){ const msg = err && err.message ? err.message : String(err||""); const isDaemonDown = (err && err.code === "TOOL_DAEMON_DOWN") || /Tool daemon is not reachable|ECONNREFUSED/i.test(msg); if (isDaemonDown) { const text = "web_extract failed: tool-daemon is not running or crashed. Restart with: services action=restart id=tool-daemon\n(" + msg + ")"; return { content:[{ type:"text", text }], details:{ ok:false, error: "tool_daemon_down", message: msg, tool: "web_extract", hint: "Restart tool-daemon: services action=restart id=tool-daemon" } }; } const kind = (msg === "timeout") ? "timeout" : (msg === "cancelled") ? "cancelled" : "error"; const hint = "Increase ARCANA_TOOLHOST_WEB_TIMEOUT_MS or pass args.timeout (seconds)."; const text = "web_extract failed: " + kind + (msg && msg !== kind ? (" ("+msg+")") : "") + ". " + hint; return { content:[{ type:"text", text }], details:{ ok:false, error: kind, message: msg, tool: "web_extract", hint } }; };
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} return toError(new Error("cancelled")); }
      const onAbort = async function(){ try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        const callOpts = _callTimeoutOpts(WEB_TIMEOUT_MS, args && args.timeout);
        const res = await client.call("web_extract", args||{}, callOpts);
        return res;
      } catch (e) { return toError(e); } finally { try { signal?.removeEventListener("abort", onAbort); } catch {} }
    }
  };
}

export function createProxyWebSearchTool(client){
  const Params = Type.Object({
    query: Type.String(),
    proxy: Type.Optional(Type.String({ description: "Proxy mode: 'system' (default), 'none' to bypass, or a proxy URL like socks5://127.0.0.1:1086" })),
    engine: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number()),
    waitUntil: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  });
  return {
    name: "web_search",
    label: "Web Search (daemon)",
    description: "Open a search engine in Playwright and return readable SERP text (tool daemon).",
    parameters: Params,
    async execute(_id, args, signal){
      const toError = function(err){ const msg = err && err.message ? err.message : String(err||""); const isDaemonDown = (err && err.code === "TOOL_DAEMON_DOWN") || /Tool daemon is not reachable|ECONNREFUSED/i.test(msg); if (isDaemonDown) { const text = "web_search failed: tool-daemon is not running or crashed. Restart with: services action=restart id=tool-daemon\n(" + msg + ")"; return { content:[{ type:"text", text }], details:{ ok:false, error: "tool_daemon_down", message: msg, tool: "web_search", hint: "Restart tool-daemon: services action=restart id=tool-daemon" } }; } const kind = (msg === "timeout") ? "timeout" : (msg === "cancelled") ? "cancelled" : "error"; const hint = "Increase ARCANA_TOOLHOST_WEB_TIMEOUT_MS or pass args.timeout (seconds)."; const text = "web_search failed: " + kind + (msg && msg !== kind ? (" ("+msg+")") : "") + ". " + hint; return { content:[{ type:"text", text }], details:{ ok:false, error: kind, message: msg, tool: "web_search", hint } }; };
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} return toError(new Error("cancelled")); }
      const onAbort = async function(){ try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        const callOpts = _callTimeoutOpts(WEB_TIMEOUT_MS, args && args.timeout);
        const res = await client.call("web_search", args||{}, callOpts);
        return res;
      } catch (e) { return toError(e); } finally { try { signal?.removeEventListener("abort", onAbort); } catch {} }
    }
  };
}

export default { createProxyBashTool, createProxyWebRenderTool, createProxyWebExtractTool, createProxyWebSearchTool };
