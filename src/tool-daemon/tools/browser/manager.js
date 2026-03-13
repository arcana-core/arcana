import fs from "node:fs";
import path from "node:path";
import { ProfileManager } from "./profile-manager.js";
import { normalizeProxySpec } from "./proxy.js";

export class BrowserManager {
  constructor({ workspaceRoot, maxProfiles=8 } = {}){
    this.workspaceRoot = String(workspaceRoot||process.cwd());
    this.profiles = new ProfileManager({ workspaceRoot: this.workspaceRoot, maxProfiles });
  }

  _profileKeyFromHeaders(headers, { proxy } = {}){
    // Compose a stable key from agent headers, optionally per-session.
    const a = String(headers["x-arcana-agent-id"] || headers["X-Arcana-Agent-Id"] || "default");
    const s = String(headers["x-arcana-session-id"] || headers["X-Arcana-Session-Id"] || "");
    const isoHeader = String(headers["x-arcana-browser-isolate"] || headers["X-Arcana-Browser-Isolate"] || "").trim();
    const isolate = (process.env.ARCANA_BROWSER_ISOLATE_BY_SESSION === "1") || isoHeader === "1"; // Opt into session-scoped profile.
    const base = (isolate && s) ? (a + "__" + s) : a;
    const spec = normalizeProxySpec(proxy);
    const withProxy = (spec && spec.mode && spec.mode !== "system")
      ? (base + "__px_" + String(spec.key || ""))
      : base;
    return withProxy.replace(/[^A-Za-z0-9_:\.-]/g, "_");
  }

  async start({ headers, headless=true, engine, forceRestart=false, webgl, proxy }={}){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    const entry = await this.profiles.getOrStartProfile(key, { headless, engine, forceRestart, webgl: Boolean(webgl), proxy });
    return { ok:true, profileKey: key, engine: entry.engine, userDataDir: entry.userDataDir };
  }

  async status({ headers, proxy }={}){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    return this.profiles.status(key);
  }

  async open({ headers, url, headless=false, engine, forceRestart=false, waitUntil, timeoutMs, webgl, proxy }){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    const entry = await this.profiles.getOrStartProfile(key, { headless, engine, forceRestart, webgl: Boolean(webgl), proxy });
    if (url){
      let u = String(url||""); if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
      await entry.page.goto(u, { waitUntil: waitUntil||"networkidle", timeout: t });
      entry.lastUrl = entry.page.url?.();
    }
    return { ok:true, url: entry.page.url?.(), engine: entry.engine };
  }

  async close({ headers, proxy }={}){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    await this.profiles.stopProfile(key);
    return { ok:true };
  }

  listProfiles(){ return this.profiles.list ? this.profiles.list() : []; }

  async stopProfile({ headers, profileKey, proxy }={}){
    const key = String(profileKey || this._profileKeyFromHeaders(headers||{}, { proxy }));
    return this.profiles.stopProfile(key);
  }

  async resetProfile({ headers, profileKey, proxy }={}){
    const key = String(profileKey || this._profileKeyFromHeaders(headers||{}, { proxy }));
    if (this.profiles.resetProfile){ return this.profiles.resetProfile(key); }
    return { ok:false, error: "reset_not_supported" };
  }

  async navigate({ headers, url, waitUntil, timeoutMs, webgl, proxy }){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    const entry = await this.profiles.getOrStartProfile(key, { webgl: Boolean(webgl), proxy });
    let u = String(url||""); if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
    await entry.page.goto(u, { waitUntil: waitUntil||"networkidle", timeout: t });
    entry.lastUrl = entry.page.url?.();
    return { ok:true, url: entry.page.url?.() };
  }

  async screenshot({ headers, path: relPath, fullPage, proxy }={}){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    const entry = await this.profiles.getOrStartProfile(key, { proxy });
    const effectiveRelPath = (relPath && String(relPath).trim()) ? String(relPath).trim() : "artifacts/web_render/latest.png";
    const absPath = path.isAbsolute(effectiveRelPath) ? effectiveRelPath : path.join(this.workspaceRoot, effectiveRelPath);
    const dir = path.dirname(absPath);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch {}
    try {
      const opts = { path: absPath };
      if (typeof fullPage === "boolean") opts.fullPage = fullPage;
      await entry.page.screenshot(opts);
      return { ok:true, path: effectiveRelPath, fullPage: Boolean(opts.fullPage) };
    } catch (e) {
      return { ok:false, error: String(e && e.message ? e.message : e), path: effectiveRelPath };
    }
  }

  async snapshot({ headers, maxChars, proxy }){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    const entry = await this.profiles.getOrStartProfile(key, { proxy });
    const startTs = Date.now();
    const result = await entry.page.evaluate(function(maxC){
      function cleanup(el){ if(!el) return; var qs=el.querySelectorAll("script,style,nav,footer,header,iframe,svg"); for (var i=0;i<qs.length;i++){ var n=qs[i]; if (n && n.parentNode) n.parentNode.removeChild(n); } }
      function text(el){ var w=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null); var out=[]; var len=0; var cap=maxC; while(w.nextNode()){ var t=(w.currentNode.nodeValue||"").replace(/\s+/g," ").trim(); if(!t) continue; out.push(t); len+=t.length+1; if(len>cap) break; } return out.join("\n"); }
      var root=document.querySelector("article")||document.querySelector("main")||document.body||document.documentElement;
      var title=document.title||undefined; if(!root) return { title:title, body:"" };
      cleanup(root);
      var body=text(root);
      return { title: title, body: body };
    }, Number(maxChars||20000));
    return { ok:true, url: entry.page.url?.(), title: result.title, text: result.body, tookMs: Date.now()-startTs };
  }

  async extract({ headers, maxChars, autoScroll, proxy }){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    const entry = await this.profiles.getOrStartProfile(key, { proxy });
    const startTs = Date.now();
    if (autoScroll){
      try {
        await entry.page.evaluate(async function(){
          function delay(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
          var lastH = 0; var same = 0; var steps = 0; var maxSteps = 60;
          while (steps < maxSteps){
            window.scrollBy(0, 800);
            await delay(150);
            var h = Math.max(document.body.scrollHeight||0, document.documentElement.scrollHeight||0);
            if (h === lastH){ same += 1; } else { same = 0; lastH = h; }
            steps += 1; if (same >= 5) break;
          }
        });
      } catch {}
    }
    const result = await entry.page.evaluate(function(maxC){
      function cleanup(el){ if(!el) return; var qs=el.querySelectorAll("script,style,nav,footer,header,iframe,svg"); for (var i=0;i<qs.length;i++){ var n=qs[i]; if (n && n.parentNode) n.parentNode.removeChild(n); } }
      function text(el){ var w=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null); var out=[]; var len=0; var cap=maxC; while(w.nextNode()){ var t=(w.currentNode.nodeValue||"").replace(/\s+/g," ").trim(); if(!t) continue; out.push(t); len+=t.length+1; if(len>cap) break; } return out.join("\n"); }
      var root=document.querySelector("article")||document.querySelector("main")||document.body||document.documentElement;
      var title=document.title||undefined; if(!root) return { title:title, body:"" };
      cleanup(root);
      var body=text(root);
      return { title: title, body: body };
    }, Number(maxChars||20000));
    return { ok:true, url: entry.page.url?.(), title: result.title, text: result.body, tookMs: Date.now()-startTs };
  }

  async click({ headers, selector, text, nth, timeoutMs, proxy }){
    const key = this._profileKeyFromHeaders(headers||{}, { proxy });
    const entry = await this.profiles.getOrStartProfile(key, { proxy });
    const sel = (selector && String(selector).trim()) ? String(selector).trim() : undefined;
    const txt = (text && String(text).trim()) ? String(text).trim() : undefined;
    if (!sel && !txt) throw new Error("click requires selector or text");
    const n = (typeof nth === "number" && nth >= 0) ? Math.floor(nth) : 0;
    const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
    let target;
    if (sel) target = entry.page.locator(sel).nth(n);
    else target = entry.page.getByText(txt, { exact:false }).nth(n);
    try {
      try {
        entry.page.waitForNavigation({ timeout: t }).catch(function(){});
      } catch {}
      try {
        entry.page.waitForEvent("popup", { timeout: t }).then(function(p){
          try {
            if (!p) return;
            entry.page = p;
            try {
              if (p.url && typeof p.url === "function"){ entry.lastUrl = p.url(); }
            } catch {}
            try {
              p.on("framenavigated", function(){ try { entry.lastUrl = p.url(); } catch {} });
              p.on("close", function(){ try { entry.lastUrl = entry.lastUrl || null; } catch {} });
            } catch {}
          } catch {}
        }).catch(function(){});
      } catch {}
      await target.click({ timeout: t });
    } catch (e) {
      throw e;
    }
    let url = null;
    try {
      if (entry.page && entry.page.url && typeof entry.page.url === "function"){ url = entry.page.url(); }
      else if (entry.lastUrl){ url = entry.lastUrl; }
    } catch {
      url = entry.lastUrl || null;
    }
    entry.lastUrl = url;
    return { ok:true, selector: sel, text: txt, nth: n, timeoutMs: t, url: url };
  }
}

export default { BrowserManager };
