import { Type } from "@sinclair/typebox";

// Internal defaults for client-side call timeouts that will kill+restart the
// tool-host on slow/hung operations (prevents overlapping Playwright state or
// a stuck worker wedging future calls). Can be customized via env vars.
const WEB_TIMEOUT_MS = Number(process.env.ARCANA_TOOLHOST_WEB_TIMEOUT_MS || 60000);
const WEB_SHORT_TIMEOUT_MS = Math.min(WEB_TIMEOUT_MS, 10000); // for start/status
const BASH_TIMEOUT_MS = Number(process.env.ARCANA_TOOLHOST_BASH_TIMEOUT_MS || 30000);

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
      // Support hard-cancel: if the tool is aborted, kill the tool-host child.
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} throw new Error("cancelled"); }
      const onAbort = async () => { try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        // Client-level timeout is independent of bash's own (seconds) and will kill the host if it hangs.
        const res = await client.call("bash", { command, timeout }, { timeoutMs: BASH_TIMEOUT_MS });
        return res;
      } finally {
        try { signal?.removeEventListener("abort", onAbort); } catch {}
      }
    }
  };
}

export function createProxyWebRenderTool(client){
  const Params = Type.Object({
    action: Type.String({ description: "start|status|navigate|snapshot" }),
    url: Type.Optional(Type.String()),
    waitUntil: Type.Optional(Type.String()),
    maxChars: Type.Optional(Type.Number()),
  });
  return {
    name: "web_render",
    label: "Web Render (host)",
    description: "Navigate and snapshot pages in a persistent Playwright session (tool-host).",
    parameters: Params,
    async execute(_id, args, signal /* AbortSignal */, _onUpdate, _ctx){
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} throw new Error("cancelled"); }
      const onAbort = async () => { try { await client.cancelActiveCall(); } catch {} };
      const action = String(args?.action||"").toLowerCase();
      const timeoutMs = (action === "start" || action === "status") ? WEB_SHORT_TIMEOUT_MS : WEB_TIMEOUT_MS;
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        return await client.call("web_render", args||{}, { timeoutMs });
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
    autoScroll: Type.Optional(Type.Boolean()),
  });
  return {
    name: "web_extract",
    label: "Web Extract (host)",
    description: "Extract readable text from current page (tool-host).",
    parameters: Params,
    async execute(_id, args, signal /* AbortSignal */, _onUpdate, _ctx){
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} throw new Error("cancelled"); }
      const onAbort = async () => { try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        return await client.call("web_extract", args||{}, { timeoutMs: WEB_TIMEOUT_MS });
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
  });
  return {
    name: "web_search",
    label: "Web Search (host)",
    description: "Open a search engine in Playwright and return readable SERP text (tool-host).",
    parameters: Params,
    async execute(_id, args, signal /* AbortSignal */, _onUpdate, _ctx){
      if (signal?.aborted) { try { await client.cancelActiveCall(); } catch {} throw new Error("cancelled"); }
      const onAbort = async () => { try { await client.cancelActiveCall(); } catch {} };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        return await client.call("web_search", args||{}, { timeoutMs: WEB_TIMEOUT_MS });
      } finally {
        try { signal?.removeEventListener("abort", onAbort); } catch {}
      }
    }
  };
}

export default { createProxyBashTool, createProxyWebRenderTool, createProxyWebExtractTool, createProxyWebSearchTool };
