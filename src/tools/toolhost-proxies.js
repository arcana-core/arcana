import { Type } from "@sinclair/typebox";

// Internal defaults for client-side call timeouts that will kill+restart the
// tool-host on slow/hung operations (prevents overlapping Playwright state or
// a stuck worker wedging future calls). Can be customized via env vars.
const WEB_TIMEOUT_ENV = process.env.ARCANA_TOOLHOST_WEB_TIMEOUT_MS;
const WEB_TIMEOUT_MS = (WEB_TIMEOUT_ENV === '0') ? 0 : Number(WEB_TIMEOUT_ENV || 120000);
const WEB_SHORT_TIMEOUT_MS = Math.min(WEB_TIMEOUT_MS, 10000); // for start/status
const BASH_TIMEOUT_ENV = process.env.ARCANA_TOOLHOST_BASH_TIMEOUT_MS;
const BASH_TIMEOUT_MS = (BASH_TIMEOUT_ENV === '0') ? 0 : Number(BASH_TIMEOUT_ENV || 300000);


function _callTimeoutOpts(baseMs, overrideSec){
  if (baseMs === 0) return {};
  const t = Number(overrideSec || 0);
  const ms = t > 0 ? Math.max(baseMs, (t * 1000) + 5000) : baseMs;
  return (ms && ms > 0) ? { timeoutMs: ms } : {};
}
// Factory helpers to create proxy tools that delegate to ToolHostClient

export function createProxyBashTool(client){
  const Params = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
  });
  return {
    name: "bash",
    label: "bash",
    description: "Execute a bash command via isolated tool-host process.",
    parameters: Params,
    async execute(_id, { command, timeout }, signal /* AbortSignal */, _onUpdate, _ctx){
      // Helper to produce a structured error result for the agent.
      const toError = (err) => {
        const msg = err?.message || String(err || "");
        const kind = (msg === 'timeout') ? 'timeout' : (msg === 'cancelled') ? 'cancelled' : 'error';
        const hint = "Increase ARCANA_TOOLHOST_BASH_TIMEOUT_MS or pass bash.timeout (seconds).";
        const text = "bash failed: " + kind + (msg && msg !== kind ? (" ("+msg+")") : "") + ". " + hint;
        return { content:[{ type:'text', text }], details:{ ok:false, error: kind, message: msg, tool: 'bash', hint } };
      };
      // If already aborted, cancel and return a structured cancellation result.
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} return toError(new Error('cancelled')); }
      const onAbort = async () => { try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        // Client-level timeout is independent of bash's own (seconds) and will kill the host if it hangs.
        let timeoutMs = BASH_TIMEOUT_MS;
        if (timeoutMs !== 0){
          const t = Number(timeout || 0);
          if (t > 0){
            timeoutMs = Math.max(timeoutMs, (t * 1000) + 5000);
          }
        }
        const callOpts = (timeoutMs && timeoutMs > 0) ? { timeoutMs } : {};
        try {
          const res = await client.call("bash", { command, timeout }, callOpts);
          return res;
        } catch (e) {
          return toError(e);
        }
      } finally {
        try { signal?.removeEventListener("abort", onAbort); } catch {}
      }
    }
  };
}

export function createProxyWebRenderTool(client){
  const Params = Type.Object({
    action: Type.String({ description: "start|status|navigate|snapshot|open|close" }),
    url: Type.Optional(Type.String()),
    waitUntil: Type.Optional(Type.String()),
    maxChars: Type.Optional(Type.Number()),
    headless: Type.Optional(Type.Boolean()),
    engine: Type.Optional(Type.String()),
    userDataDir: Type.Optional(Type.String()),
    forceRestart: Type.Optional(Type.Boolean()),
    timeout: Type.Optional(Type.Number()),
  });
  return {
    name: "web_render",
    label: "Web Render (host)",
    description: "Navigate and snapshot pages in a persistent Playwright session (tool-host).",
    parameters: Params,
    async execute(_id, args, signal /* AbortSignal */, _onUpdate, _ctx){
      const toError = (err) => {
        const msg = err?.message || String(err || "");
        const kind = (msg === 'timeout') ? 'timeout' : (msg === 'cancelled') ? 'cancelled' : 'error';
        const hint = "Increase ARCANA_TOOLHOST_WEB_TIMEOUT_MS or pass args.timeout (seconds).";
        const text = "web_render failed: " + kind + (msg && msg !== kind ? (" ("+msg+")") : "") + ". " + hint;
        return { content:[{ type:'text', text }], details:{ ok:false, error: kind, message: msg, tool: 'web_render', hint } };
      };
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} return toError(new Error('cancelled')); }
      const onAbort = async () => { try { await client.cancelActiveCall(); } catch {} };
      const action = String(args?.action||"").toLowerCase();
      const isShort = (action === "start" || action === "status" || action === "open" || action === "close");
      const callOpts = _callTimeoutOpts(isShort ? WEB_SHORT_TIMEOUT_MS : WEB_TIMEOUT_MS, isShort ? 0 : (args && args.timeout));
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          return await client.call("web_render", args||{}, callOpts);
        } catch (e) {
          return toError(e);
        }
      } finally {
        try { signal?.removeEventListener("abort", onAbort); } catch {}
      }
    }
  };
}

export function createProxyWebExtractTool(client){
  const Params = Type.Object({
    mode: Type.Optional(Type.String({ description: "article|main|full" })),
    selector: Type.Optional(Type.String()),
    maxChars: Type.Optional(Type.Number()),
    timeout: Type.Optional(Type.Number()),
    autoScroll: Type.Optional(Type.Boolean()),
  });
  return {
    name: "web_extract",
    label: "Web Extract (host)",
    description: "Extract readable text from current page (tool-host).",
    parameters: Params,
    async execute(_id, args, signal /* AbortSignal */, _onUpdate, _ctx){
      const toError = (err) => {
        const msg = err?.message || String(err || "");
        const kind = (msg === 'timeout') ? 'timeout' : (msg === 'cancelled') ? 'cancelled' : 'error';
        const hint = "Increase ARCANA_TOOLHOST_WEB_TIMEOUT_MS or pass args.timeout (seconds).";
        const text = "web_extract failed: " + kind + (msg && msg !== kind ? (" ("+msg+")") : "") + ". " + hint;
        return { content:[{ type:'text', text }], details:{ ok:false, error: kind, message: msg, tool: 'web_extract', hint } };
      };
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} return toError(new Error('cancelled')); }
      const onAbort = async () => { try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        const callOpts = _callTimeoutOpts(WEB_TIMEOUT_MS, args && args.timeout);
        try {
          return await client.call("web_extract", args||{}, callOpts);
        } catch (e) {
          return toError(e);
        }
      } finally {
        try { signal?.removeEventListener("abort", onAbort); } catch {}
      }
    }
  };
}

export function createProxyWebSearchTool(client){
  const Params = Type.Object({
    query: Type.String(),
    engine: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number()),
  });
  return {
    name: "web_search",
    label: "Web Search (host)",
    description: "Open a search engine in Playwright and return readable SERP text (tool-host).",
    parameters: Params,
    async execute(_id, args, signal /* AbortSignal */, _onUpdate, _ctx){
      const toError = (err) => {
        const msg = err?.message || String(err || "");
        const kind = (msg === 'timeout') ? 'timeout' : (msg === 'cancelled') ? 'cancelled' : 'error';
        const hint = "Increase ARCANA_TOOLHOST_WEB_TIMEOUT_MS or pass args.timeout (seconds).";
        const text = "web_search failed: " + kind + (msg && msg !== kind ? (" ("+msg+")") : "") + ". " + hint;
        return { content:[{ type:'text', text }], details:{ ok:false, error: kind, message: msg, tool: 'web_search', hint } };
      };
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} return toError(new Error('cancelled')); }
      const onAbort = async () => { try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        const callOpts = _callTimeoutOpts(WEB_TIMEOUT_MS, args && args.timeout);
        try {
          return await client.call("web_search", args||{}, callOpts);
        } catch (e) {
          return toError(e);
        }
      } finally {
        try { signal?.removeEventListener("abort", onAbort); } catch {}
      }
    }
  };
}

export default { createProxyBashTool, createProxyWebRenderTool, createProxyWebExtractTool, createProxyWebSearchTool };
