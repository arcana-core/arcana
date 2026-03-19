import http from "node:http";
import { URL } from "node:url";
import { join } from "node:path";
import { createWriteStream, promises as fsp } from "node:fs";

import { ensureToolDaemonAuth } from "../tool-daemon/auth.js";
import { hashToPort } from "./ports.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function json(res, code, obj){
  try {
    const body = JSON.stringify(obj || {});
    res.statusCode = code;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(body);
  } catch {
    try { res.statusCode = 500; res.end("{}"); } catch {}
  }
}

function notFound(res){ res.statusCode = 404; try { res.end("not_found"); } catch {} }

async function readBodyJson(req){
  return await new Promise(function(resolve){
    let body = "";
    try {
      req.on("data", function(c){ body += c.toString("utf-8"); });
      req.on("end", function(){
        let obj = {};
        try { obj = JSON.parse(body || "{}"); } catch { obj = {}; }
        resolve(obj);
      });
    } catch {
      resolve({});
    }
  });
}

function normalizeProfileKey(k){
  const s = String(k || "").trim();
  if (!s) return "user";
  return s.replace(/[^A-Za-z0-9_:\.-]/g, "_");
}

function stableJson(x){
  try { return JSON.stringify(x || {}, Object.keys(x || {}).sort()); } catch { return "{}"; }
}

function buildChromeDevtoolsMcpArgs({ mode, autoConnect, browserUrl, wsEndpoint, wsHeaders, channel, userDataDir, headless, isolated, logFile } = {}){
  const args = ["-y", "chrome-devtools-mcp@latest"]; // npx args

  const effectiveAuto = Boolean(autoConnect) || String(mode || "").toLowerCase() === "autoconnect";
  const bUrl = (browserUrl && String(browserUrl).trim()) ? String(browserUrl).trim() : "";
  const ws = (wsEndpoint && String(wsEndpoint).trim()) ? String(wsEndpoint).trim() : "";

  if (effectiveAuto) {
    args.push("--autoConnect");
  } else if (bUrl) {
    args.push("--browserUrl", bUrl);
  } else if (ws) {
    args.push("--wsEndpoint", ws);
    if (wsHeaders && String(wsHeaders).trim()) {
      args.push("--wsHeaders", String(wsHeaders));
    }
  }

  if (headless) args.push("--headless");
  if (isolated) args.push("--isolated");

  if (channel && String(channel).trim()) {
    args.push("--channel", String(channel).trim());
  }
  if (userDataDir && String(userDataDir).trim()) {
    args.push("--userDataDir", String(userDataDir).trim());
  }

  // Prefer explicit opt-out.
  args.push("--no-usage-statistics");

  if (logFile && String(logFile).trim()) {
    args.push("--logFile", String(logFile).trim());
  }

  return args;
}

export async function startChromeMcpDaemon({ workspaceRoot, port } = {}){
  const root = String(workspaceRoot || process.cwd());
  const { token } = await ensureToolDaemonAuth({ workspaceRoot: root });
  const effectivePort = (Number.isFinite(Number(port)) && Number(port) > 0) ? Number(port) : hashToPort(root);

  const profiles = new Map();

  async function stopProfile(profileKey, reason){
    const k = normalizeProfileKey(profileKey);
    const p = profiles.get(k);
    if (!p) return { ok: true, stopped: false };

    p.status = "stopping";
    p.lastError = null;
    p.stoppedAt = Date.now();
    p.stopReason = String(reason || "");

    try { if (p.transport) await p.transport.close(); } catch {}

    profiles.delete(k);
    return { ok: true, stopped: true };
  }

  async function ensureProfile(profileKey, cfg){
    const k = normalizeProfileKey(profileKey);
    const now = Date.now();
    const config = cfg && typeof cfg === "object" ? cfg : {};

    const logFile = join(root, ".arcana", "services", "chrome_mcp_daemon", "chrome-devtools-mcp." + k + ".log");
    try { await fsp.mkdir(join(root, ".arcana", "services", "chrome_mcp_daemon"), { recursive: true }); } catch {}
    const desiredSpec = {
      mode: config.mode,
      autoConnect: Boolean(config.autoConnect),
      browserUrl: config.browserUrl,
      wsEndpoint: config.wsEndpoint,
      wsHeaders: config.wsHeaders,
      channel: config.channel,
      userDataDir: config.userDataDir,
      headless: Boolean(config.headless),
      isolated: (typeof config.isolated === "boolean") ? config.isolated : false,
      logFile: logFile
    };

    const existing = profiles.get(k);
    if (existing && existing.specKey === stableJson(desiredSpec) && existing.status === "running"){
      existing.lastUsedAt = now;
      return { ok: true, profileKey: k, started: false, pid: existing.pid || null };
    }

    if (existing){
      await stopProfile(k, "restart");
    }

    const transport = new StdioClientTransport({
      command: "npx",
      args: buildChromeDevtoolsMcpArgs(desiredSpec),
      cwd: root,
      stderr: "pipe"
    });

    const stderr = transport.stderr;
    let logStream = null;
    try {
      logStream = createWriteStream(logFile, { flags: "a" });
      if (stderr) {
        stderr.on("data", function(d){
          try { logStream.write(d); } catch {}
        });
      }
    } catch {}

    const client = new Client({ name: "arcana-chrome-mcp-daemon", version: "0.1.0" });

    const entry = {
      profileKey: k,
      createdAt: now,
      startedAt: now,
      lastUsedAt: now,
      status: "starting",
      specKey: stableJson(desiredSpec),
      spec: desiredSpec,
      transport,
      client,
      pid: null,
      lastError: null,
      stopReason: null,
      stoppedAt: null,
      logFile
    };
    profiles.set(k, entry);

    try {
      await client.connect(transport);
      entry.pid = transport.pid;
      entry.status = "running";
      if (stderr && logStream){
        try { logStream.write("[arcana] connected pid=" + String(entry.pid || "") + "\n"); } catch {}
      }
      return { ok: true, profileKey: k, started: true, pid: entry.pid || null };
    } catch (e) {
      entry.status = "error";
      entry.lastError = String(e && e.stack ? e.stack : e);
      try { if (logStream) logStream.write("[arcana] connect error: " + entry.lastError + "\n"); } catch {}
      try { await stopProfile(k, "connect_error"); } catch {}
      return { ok: false, error: "connect_error", details: entry.lastError };
    }
  }

  async function callTool(profileKey, toolName, toolArgs, cfg){
    const k = normalizeProfileKey(profileKey);
    const ensured = await ensureProfile(k, cfg);
    if (!ensured || !ensured.ok){
      return { ok: false, error: ensured && ensured.error ? ensured.error : "ensure_failed", details: ensured && ensured.details ? ensured.details : null };
    }
    const p = profiles.get(k);
    if (!p || p.status !== "running"){
      return { ok: false, error: "profile_not_running" };
    }

    p.lastUsedAt = Date.now();
    try {
      const result = await p.client.callTool({ name: String(toolName || ""), arguments: (toolArgs && typeof toolArgs === "object") ? toolArgs : {} });
      return { ok: true, profileKey: k, pid: p.pid || null, result };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      p.lastError = msg;
      return { ok: false, error: "tool_call_failed", details: msg };
    }
  }

  const server = http.createServer(function(req, res){
    (async function(){
      try {
        try {
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("access-control-allow-headers", "authorization, content-type");
        } catch {}
        if (req.method === "OPTIONS"){ res.statusCode = 204; try { res.end(); } catch {} return; }

        let urlPathname = "/";
        try {
          const parsed = new URL(req.url || "/", "http://localhost");
          urlPathname = parsed && parsed.pathname ? parsed.pathname : "/";
        } catch {
          urlPathname = String(req.url || "/").split("?")[0] || "/";
        }
        const u = { pathname: urlPathname };

        const auth = String(req.headers["authorization"] || "");
        const okAuth = auth.startsWith("Bearer ") && auth.slice(7).trim() === token;
        if (!okAuth){ return json(res, 401, { ok:false, error: "unauthorized" }); }

        if (req.method === "GET" && u.pathname === "/status"){
          const arr = [];
          for (const [k, p] of profiles.entries()){
            arr.push({
              profileKey: k,
              status: p.status,
              pid: p.pid || null,
              createdAt: p.createdAt,
              startedAt: p.startedAt,
              lastUsedAt: p.lastUsedAt,
              lastError: p.lastError || null,
              logFile: p.logFile
            });
          }
          return json(res, 200, { ok:true, status:"ok", pid: process.pid, port: effectivePort, profiles: arr });
        }

        if (req.method === "POST" && u.pathname === "/profiles/ensure"){
          const body = await readBodyJson(req);
          const profileKey = body && body.profileKey ? String(body.profileKey) : "user";
          const cfg = body && body.config && typeof body.config === "object" ? body.config : body;
          const r = await ensureProfile(profileKey, cfg);
          return json(res, 200, r);
        }

        if (req.method === "POST" && u.pathname === "/profiles/stop"){
          const body = await readBodyJson(req);
          const profileKey = body && body.profileKey ? String(body.profileKey) : "user";
          const r = await stopProfile(profileKey, "api");
          return json(res, 200, r);
        }

        if (req.method === "POST" && u.pathname === "/tool/call"){
          const body = await readBodyJson(req);
          const profileKey = body && body.profileKey ? String(body.profileKey) : "user";
          const tool = body && body.tool ? String(body.tool) : "";
          const args = body && body.arguments && typeof body.arguments === "object" ? body.arguments : {};
          const cfg = body && body.config && typeof body.config === "object" ? body.config : {};
          if (!tool) return json(res, 400, { ok:false, error:"tool_required" });
          const r = await callTool(profileKey, tool, args, cfg);
          return json(res, 200, r);
        }

        notFound(res);
      } catch {
        try { json(res, 500, { ok:false, error:"internal_error" }); } catch {}
      }
    })();
  });

  await new Promise(function(resolve, reject){
    server.listen({ port: effectivePort, host: "127.0.0.1" }, function(err){ if (err) reject(err); else resolve(); });
    server.on("error", reject);
  });

  function shutdown(){
    const stops = [];
    for (const [k] of profiles.entries()){
      stops.push(stopProfile(k, "shutdown"));
    }
    Promise.allSettled(stops).finally(function(){
      try { server.close(); } catch {}
    });
  }

  try {
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch {}

  return { port: effectivePort, stop: shutdown };
}

export default { startChromeMcpDaemon };
