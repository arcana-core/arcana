import http from "node:http";
import { URL } from "node:url";
import { ensureToolDaemonAuth } from "./auth.js";
import { writeState } from "./state.js";
import { runBash } from "./tools/bash.js";
import { BrowserManager } from "./tools/browser/manager.js";

function json(res, code, obj){
  try {
    const body = JSON.stringify(obj || {});
    res.statusCode = code; res.setHeader("content-type","application/json; charset=utf-8"); res.end(body);
  } catch {
    try { res.statusCode = 500; res.end("{}"); } catch {}
  }
}

function notFound(res){ res.statusCode = 404; try { res.end("not_found"); } catch {} }

export async function startToolDaemon({ workspaceRoot, port }){
  const { token } = await ensureToolDaemonAuth({ workspaceRoot });
  const bm = new BrowserManager({ workspaceRoot, maxProfiles: 6 });

  const server = http.createServer(function(req, res){
    (async function(){
      try {
        // CORS for local dev convenience
        try { res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "authorization, content-type, x-arcana-agent-id, x-arcana-session-id"); } catch {}
        if (req.method === "OPTIONS"){ res.statusCode = 204; try { res.end(); } catch {} return; }

        let urlPathname = "/";
        try {
          const parsed = new URL(req.url || "/", "http://localhost");
          urlPathname = parsed && typeof parsed.pathname === "string" && parsed.pathname ? parsed.pathname : "/";
        } catch {
          try {
            const raw = String(req.url || "/");
            const q = raw.indexOf("?");
            urlPathname = (q >= 0 ? raw.slice(0, q) : raw) || "/";
          } catch {
            urlPathname = "/";
          }
        }
        const u = { pathname: urlPathname };

        // Auth check: Authorization: Bearer <token>
        const auth = String(req.headers["authorization"] || "");
        const ok = auth.startsWith("Bearer ") && auth.slice(7).trim() === token;
        if (!ok){ return json(res, 401, { ok:false, error: "unauthorized" }); }

        if (req.method === "GET" && u.pathname === "/status"){
          try {
            const addr = server.address();
            const serverPort = addr && typeof addr === "object" ? addr.port : port;
            const profiles = bm.listProfiles ? bm.listProfiles() : [];
            return json(res, 200, { ok:true, status:"ok", pid: process.pid, port: serverPort, profiles });
          } catch {
            return json(res, 200, { ok:true, status:"ok", pid: process.pid, port, profiles: [] });
          }
        }

        if (req.method === "GET" && u.pathname === "/profiles"){
          const profiles = bm.listProfiles ? bm.listProfiles() : [];
          return json(res, 200, { ok:true, profiles });
        }

        if (req.method === "POST" && (u.pathname === "/profiles/stop" || u.pathname === "/profiles/reset")){
          let responded = false; let timer = null; let bodyText = ""; let explicitKey = null;
          const finish = function(code, obj){ if (responded) return; responded = true; try { if (timer) clearTimeout(timer); } catch {} return json(res, code, obj); };
          const doCleanup = async function(){ try { await bm.stopProfile({ headers: req.headers, profileKey: explicitKey }); } catch {} };
          try { req.on("close", function(){ try { doCleanup(); } catch {} }); } catch {}
          try { timer = setTimeout(async function(){ try { await bm.stopProfile({ headers: req.headers, profileKey: explicitKey }); } catch {} finish(200, { ok:false, error:"timeout" }); }, 120000); } catch {}
          req.on("data", function(c){ bodyText += c.toString("utf-8"); });
          req.on("end", async function(){
            let args = {}; try { args = JSON.parse(bodyText||"{}"); } catch {}
            explicitKey = args && args.profileKey ? String(args.profileKey) : null;
            try {
              if (u.pathname === "/profiles/stop"){
                const r = await bm.stopProfile({ headers: req.headers, profileKey: explicitKey });
                return finish(200, { ok:true, details:r });
              } else {
                const r = await bm.resetProfile({ headers: req.headers, profileKey: explicitKey });
                return finish(200, { ok:true, details:r });
              }
            } catch (e) {
              return finish(200, { ok:false, error: String(e && e.message ? e.message : e) });
            }
          });
          return;
        }

        if (req.method === "POST" && u.pathname.startsWith("/tool/")){
          let bodyText = ""; let responded = false; let timer = null; let explicitKey = null;
          const finish = function(code, obj){ if (responded) return; responded = true; try { if (timer) clearTimeout(timer); } catch {} return json(res, code, obj); };
          const doCleanup = async function(){ try { await bm.stopProfile({ headers: req.headers, profileKey: explicitKey }); } catch {} };
          try { req.on("close", function(){ try { doCleanup(); } catch {} }); } catch {}
          try { timer = setTimeout(async function(){ try { await bm.stopProfile({ headers: req.headers, profileKey: explicitKey }); } catch {} finish(200, { ok:false, error:"timeout" }); }, 120000); } catch {}
          req.on("data", function(c){ bodyText += c.toString("utf-8"); });
          req.on("end", async function(){
            let args = {}; try { args = JSON.parse(bodyText||"{}"); } catch {}
            const seg = u.pathname.split("/");
            const name = seg[2] || "";
            try {
              if (name === "bash"){
                const resu = await runBash({ command: String(args.command||""), timeoutSec: Number(args.timeout||0) });
                if (resu.ok){ return finish(200, { content:[{ type:"text", text: resu.text }], details:{ ok:true, path: resu.path } }); }
                const kind = resu.timeout ? "timeout" : "error";
                return finish(200, { content:[{ type:"text", text: resu.text || resu.error || "bash failed" }], details:{ ok:false, error: kind } });
              }
              if (name === "web_render"){
                const action = String(args.action||"").toLowerCase();
                if (action === "start"){
                  const r = await bm.start({ headers: req.headers, headless: (typeof args.headless === "boolean") ? args.headless : true, engine: args.engine, forceRestart: Boolean(args.forceRestart) });
                  return finish(200, { content:[{ type:"text", text:"started" }], details:r });
                }
                if (action === "status"){
                  const s = await bm.status({ headers: req.headers });
                  return finish(200, { content:[{ type:"text", text:"status" }], details:s });
                }
                if (action === "open"){
                  const r = await bm.open({ headers: req.headers, url: args.url, headless:false, engine: args.engine, forceRestart: Boolean(args.forceRestart), waitUntil: args.waitUntil, timeoutMs: args.timeoutMs });
                  const text = r && r.url ? ("opened " + r.url) : "opened";
                  return finish(200, { content:[{ type:"text", text }], details:r });
                }
                if (action === "close"){
                  const r = await bm.close({ headers: req.headers });
                  return finish(200, { content:[{ type:"text", text:"closed" }], details:r });
                }
                if (action === "reset" || action === "reset_profile"){
                  const r = await bm.resetProfile({ headers: req.headers, profileKey: args && args.profileKey ? String(args.profileKey) : null });
                  return finish(200, { content:[{ type:"text", text:"reset" }], details:r });
                }
                if (action === "navigate"){
                  const r = await bm.navigate({ headers: req.headers, url: args.url, waitUntil: args.waitUntil, timeoutMs: args.timeoutMs });
                  return finish(200, { content:[{ type:"text", text: "navigated " + (r && r.url ? r.url : "") }], details:r });
                }
                if (action === "snapshot"){
                  const r = await bm.extract({ headers: req.headers, maxChars: Number(args.maxChars||20000), autoScroll: Boolean(args.autoScroll) });
                  return finish(200, { content:[{ type:"text", text: "[external:web_render]\n" + (r.text||"") }], details:{ url: r.url, title: r.title, tookMs: r.tookMs } });
                }
                if (action === "click"){
                  const r = await bm.click({ headers: req.headers, selector: args.selector, text: args.text, nth: args.nth, timeoutMs: args.timeoutMs });
                  let label = ""; if (r.selector) label = "selector " + r.selector; else if (r.text) label = "text " + r.text;
                  const text = label ? ("clicked " + label) : "clicked";
                  return finish(200, { content:[{ type:"text", text }], details:r });
                }
                return finish(400, { ok:false, error:"unknown_action" });
              }
              if (name === "web_extract"){
                const r = await bm.extract({ headers: req.headers, maxChars: Number(args.maxChars||20000), autoScroll: Boolean(args.autoScroll) });
                const wrapped = "[external:web_extract]\n" + String(r.text||"");
                return finish(200, { content:[{ type:"text", text: wrapped }], details:{ url: r.url, title: r.title, tookMs: r.tookMs } });
              }
              if (name === "web_search"){
                const engine = String(args.engine||"duckduckgo").toLowerCase();
                const base = engine === "baidu" ? "https://www.baidu.com/s?wd=" : (engine === "bing" ? "https://www.bing.com/search?q=" : "https://duckduckgo.com/?q=");
                const url = base + encodeURIComponent(String(args.query||""));
                const wait = (args && typeof args.waitUntil === "string" && args.waitUntil) ? args.waitUntil : "networkidle";
                let timeoutMs = undefined;
                if (args && typeof args.timeoutMs === "number" && args.timeoutMs > 0) timeoutMs = args.timeoutMs;
                else if (args && typeof args.timeout === "number" && args.timeout > 0) timeoutMs = Math.floor(args.timeout * 1000);
                await bm.navigate({ headers: req.headers, url: url, waitUntil: wait, timeoutMs: timeoutMs });
                const r = await bm.snapshot({ headers: req.headers, maxChars: 20000 });
                const header = "[external:web_search]\nurl=" + r.url + " title=" + (r.title||"") + "\n";
                return finish(200, { content:[{ type:"text", text: header + (r.text||"") }], details:{ provider:"browser", engine, url: r.url, title: r.title, tookMs: r.tookMs } });
              }
              return finish(404, { ok:false, error:"unknown_tool" });
            } catch (e) {
              return finish(200, { content:[{ type:"text", text: "tool error: " + String(e && e.message ? e.message : e) }], details:{ ok:false, error:"error" } });
            }
          });
          return;
        }
        notFound(res);
      } catch (e) {
        try {
          const alreadyFinished = res.writableEnded || res.headersSent;
          if (!alreadyFinished){ json(res, 500, { ok:false, error:"internal_error" }); }
        } catch {}
      }
    })();
  });

  await new Promise(function(resolve, reject){ server.listen({ port, host: "127.0.0.1" }, function(err){ if (err) reject(err); else resolve(); }); server.on("error", reject); });

  try { await writeState({ workspaceRoot, state: { port, pid: process.pid, startedAt: Date.now() } }); } catch {}

  return { port: server.address().port, stop: function(){ try { server.close(); } catch {} } };
}

export default { startToolDaemon };
