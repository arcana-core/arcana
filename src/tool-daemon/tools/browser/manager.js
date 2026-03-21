import fs from "node:fs";
import path from "node:path";
import { ProfileManager } from "./profile-manager.js";
import { normalizeProxySpec } from "./proxy.js";
import { ChromeMcpHttpClient, parseMcpEvaluateJsonResult, getMcpTextContent } from "./chrome-mcp-http.js";

export class BrowserManager {
  constructor({ workspaceRoot, maxProfiles=8 } = {}){
    this.workspaceRoot = String(workspaceRoot||process.cwd());
    this.profiles = new ProfileManager({ workspaceRoot: this.workspaceRoot, maxProfiles });
    this.mcp = new ChromeMcpHttpClient({ workspaceRoot: this.workspaceRoot });
  }

  _resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile } = {}){
    const explicit = profileKey || browserProfile || profile;
    if (explicit && String(explicit).trim()){
      return String(explicit).trim().replace(/[^A-Za-z0-9_:\.-]/g, "_");
    }
    return this._profileKeyFromHeaders(headers||{}, { proxy });
  }

  _normalizeDriver(driver, profileKey){
    // Defaults
    const pk = String(profileKey || "");
    const s = String(driver||"").trim().toLowerCase();

    // Built-in "user" profile defaults to MCP attach.
    if (!s && pk === "user") return "mcp";

    if (!s) return "playwright";

    // Aliases
    if (
      s === "mcp" ||
      s === "chrome-mcp" ||
      s === "chrome_devtools_mcp" ||
      s === "chrome-devtools-mcp" ||
      s === "devtools" ||
      s === "chrome-devtools" ||
      s === "existing-session" ||
      s === "existing_session"
    ) return "mcp";

    return "playwright";
  }

  _normalizeMcpConfig(profileKey, mcp){
    const pk = String(profileKey || "");
    const cfg = (mcp && typeof mcp === "object") ? { ...mcp } : {};

    // If the caller explicitly configures a connection target, don't override.
    const hasExplicitTarget = Boolean(
      (cfg.browserUrl && String(cfg.browserUrl).trim()) ||
      (cfg.wsEndpoint && String(cfg.wsEndpoint).trim())
    );

    // Defaults for "user": attach to an existing local Chrome instance.
    if (pk === "user" && !hasExplicitTarget){
      if (typeof cfg.autoConnect !== "boolean") cfg.autoConnect = true;
      if (!cfg.mode) cfg.mode = "autoConnect";
      if (!cfg.channel) cfg.channel = "stable";
    }

    // existing-session should not try to run headless.
    if (typeof cfg.headless !== "boolean") cfg.headless = false;

    return cfg;
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

  _normalizeUrl(url){
    let u = String(url||"").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u;
  }

  async start({ headers, headless=true, engine, forceRestart=false, webgl, proxy, profileKey, browserProfile, profile, driver, mcp }={}){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const ensured = await this.mcp.ensureProfile(key, cfg);
      return { ok: Boolean(ensured && ensured.ok), profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", details: ensured };
    }

    const entry = await this.profiles.getOrStartProfile(key, { headless, engine, forceRestart, webgl: Boolean(webgl), proxy });
    return { ok:true, profileKey: key, engine: entry.engine, userDataDir: entry.userDataDir };
  }

  async status({ headers, proxy, profileKey, browserProfile, profile, driver, mcp }={}){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const st = await this.mcp.status();
      let p = null;
      try {
        const arr = st && Array.isArray(st.profiles) ? st.profiles : [];
        for (let i = 0; i < arr.length; i++){
          const it = arr[i];
          if (it && String(it.profileKey||"") === String(key)) { p = it; break; }
        }
      } catch {}
      return {
        ok: Boolean(st && st.ok),
        profileKey: key,
        engine: "chromium",
        driver: "existing-session",
        transport: "chrome-mcp",
        pid: p && p.pid ? p.pid : null,
        lastError: p && p.lastError ? p.lastError : null,
        logFile: p && p.logFile ? p.logFile : null,
        profile: p,
        raw: st
      };
    }

    return this.profiles.status(key);
  }

  async open({ headers, url, headless=false, engine, forceRestart=false, waitUntil, timeoutMs, webgl, proxy, profileKey, browserProfile, profile, driver, mcp }){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const ensured = await this.mcp.ensureProfile(key, cfg);
      if (!ensured || !ensured.ok){
        return { ok:false, profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", error: "ensure_failed", details: ensured };
      }

      const u = this._normalizeUrl(url);
      const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
      if (u){
        // chrome-devtools-mcp does not expose Playwright waitUntil semantics.
        const nav = await this.mcp.call(key, "navigate_page", { type: "url", url: u, timeout: t }, cfg);
        return { ok: Boolean(nav && nav.ok), url: u, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", details: nav };
      }

      return { ok:true, url: null, engine: "chromium", driver: "existing-session", transport: "chrome-mcp" };
    }

    const entry = await this.profiles.getOrStartProfile(key, { headless, engine, forceRestart, webgl: Boolean(webgl), proxy });
    if (url){
      const u = this._normalizeUrl(url);
      const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
      await entry.page.goto(u, { waitUntil: waitUntil||"networkidle", timeout: t });
      entry.lastUrl = entry.page.url?.();
    }
    return { ok:true, url: entry.page.url?.(), engine: entry.engine };
  }

  async close({ headers, proxy, profileKey, browserProfile, profile, driver, mcp }={}){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const r = await this.mcp.stopProfile(key);
      return { ok: Boolean(r && r.ok), profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", details: r };
    }

    await this.profiles.stopProfile(key);
    return { ok:true };
  }

  listProfiles(){ return this.profiles.list ? this.profiles.list() : []; }

  async stopProfile({ headers, profileKey, browserProfile, profile, proxy, driver, mcp }={}){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);
    if (drv === "mcp") return this.mcp.stopProfile(key);
    return this.profiles.stopProfile(key);
  }

  async resetProfile({ headers, profileKey, browserProfile, profile, proxy, driver, mcp }={}){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const r = await this.mcp.stopProfile(key);
      if (r && r.ok){ return { ok:true, reset:true, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", details: r }; }
      return { ok:false, error: "reset_failed", engine: "chromium", driver: "existing-session", transport: "chrome-mcp", details: r };
    }

    if (this.profiles.resetProfile){ return this.profiles.resetProfile(key); }
    return { ok:false, error: "reset_not_supported" };
  }

  async navigate({ headers, url, waitUntil, timeoutMs, webgl, proxy, profileKey, browserProfile, profile, driver, mcp }){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const ensured = await this.mcp.ensureProfile(key, cfg);
      if (!ensured || !ensured.ok){
        return { ok:false, profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", error: "ensure_failed", details: ensured };
      }
      const u = this._normalizeUrl(url);
      const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
      const nav = await this.mcp.call(key, "navigate_page", { type: "url", url: u, timeout: t }, cfg);
      return { ok: Boolean(nav && nav.ok), url: u || null, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", details: nav };
    }

    const entry = await this.profiles.getOrStartProfile(key, { webgl: Boolean(webgl), proxy });
    const u = this._normalizeUrl(url);
    const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
    await entry.page.goto(u, { waitUntil: waitUntil||"networkidle", timeout: t });
    entry.lastUrl = entry.page.url?.();
    return { ok:true, url: entry.page.url?.() };
  }

  async screenshot({ headers, path: relPath, fullPage, type, quality, proxy, profileKey, browserProfile, profile, driver, mcp }={}){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    let typeExplicit = false;
    let normalizedType = "jpeg";
    if (typeof type === "string" && type) {
      const t = String(type).trim().toLowerCase();
      if (t === "png" || t === "jpeg"){
        normalizedType = t;
        typeExplicit = true;
      }
    }

    let qualityExplicit = false;
    let normalizedQuality = 80;
    if (typeof quality === "number" && Number.isFinite(quality)){
      let q = Math.round(quality);
      if (q < 1) q = 1;
      if (q > 100) q = 100;
      normalizedQuality = q;
      qualityExplicit = true;
    }

    let effectiveRelPath = null;
    if (relPath && String(relPath).trim()){
      effectiveRelPath = String(relPath).trim();
      const ext = path.extname(effectiveRelPath).toLowerCase();
      const isPngExt = ext === ".png";
      const isJpegExt = ext === ".jpg" || ext === ".jpeg";
      if (!typeExplicit){
        if (isPngExt){
          normalizedType = "png";
        } else if (isJpegExt){
          normalizedType = "jpeg";
        }
      } else if (isPngExt && normalizedType === "jpeg"){
        console.error("[web_render] Warning: type=jpeg but screenshot path has .png extension; keeping type jpeg and writing as-is.");
      } else if (isJpegExt && normalizedType === "png"){
        console.error("[web_render] Warning: type=png but screenshot path has .jpg/.jpeg extension; keeping type png and writing as-is.");
      }
    } else {
      if (normalizedType === "png"){
        effectiveRelPath = "artifacts/web_render/latest.png";
      } else {
        effectiveRelPath = "artifacts/web_render/latest.jpg";
        normalizedType = "jpeg";
      }
    }

    if (normalizedType !== "jpeg" && qualityExplicit){
      console.error("[web_render] Warning: quality is only used for jpeg screenshots and will be ignored for type png.");
    }

    const absPath = path.isAbsolute(effectiveRelPath) ? effectiveRelPath : path.join(this.workspaceRoot, effectiveRelPath);
    try { await fs.promises.mkdir(path.dirname(absPath), { recursive: true }); } catch {}

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const args = { filePath: absPath };
      if (typeof fullPage === "boolean") args.fullPage = fullPage;
      const r = await this.mcp.call(key, "take_screenshot", args, cfg);

      return {
        ok: Boolean(r && r.ok),
        path: effectiveRelPath,
        fullPage: (typeof fullPage === "boolean") ? Boolean(fullPage) : undefined,
        engine: "chromium",
        driver: "existing-session",
        transport: "chrome-mcp",
        details: r
      };
    }

    const entry = await this.profiles.getOrStartProfile(key, { proxy });

    try {
      const opts = { path: absPath, type: normalizedType };
      if (normalizedType === "jpeg" && typeof normalizedQuality === "number") opts.quality = normalizedQuality;
      if (typeof fullPage === "boolean") opts.fullPage = fullPage;
      await entry.page.screenshot(opts);
      return { ok:true, path: effectiveRelPath, fullPage: Boolean(opts.fullPage) };
    } catch (e) {
      return { ok:false, error: String(e && e.message ? e.message : e), path: effectiveRelPath };
    }
  }

  async snapshot({ headers, maxChars, proxy, profileKey, browserProfile, profile, driver, mcp }){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const ensured = await this.mcp.ensureProfile(key, cfg);
      if (!ensured || !ensured.ok){
        return { ok:false, profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", error: "ensure_failed", details: ensured };
      }

      const startTs = Date.now();
      const infoRes = await this.mcp.call(key, "evaluate_script", { function: "() => ({ url: location.href, title: document.title || null })" }, cfg);
      const snapRes = await this.mcp.call(key, "take_snapshot", {}, cfg);

      let url = null; let title = null;
      try {
        const info = parseMcpEvaluateJsonResult(infoRes);
        if (info && typeof info === "object"){
          if (info.url) url = String(info.url);
          if (info.title) title = String(info.title);
        }
      } catch {}

      let text = getMcpTextContent(snapRes);
      const cap = (typeof maxChars === "number" && maxChars > 0) ? Math.floor(maxChars) : 20000;
      if (text && text.length > cap) text = text.slice(0, cap);

      return {
        ok:true,
        url,
        title,
        text,
        tookMs: Date.now() - startTs,
        engine: "chromium",
        driver: "existing-session",
        transport: "chrome-mcp",
        raw: { pageInfo: infoRes, snapshot: snapRes }
      };
    }

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

  async extract({ headers, maxChars, autoScroll, proxy, profileKey, browserProfile, profile, driver, mcp }){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const ensured = await this.mcp.ensureProfile(key, cfg);
      if (!ensured || !ensured.ok){
        return { ok:false, profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", error: "ensure_failed", details: ensured };
      }

      const startTs = Date.now();
      const cap = (typeof maxChars === "number" && maxChars > 0) ? Math.floor(maxChars) : 20000;
      const doScroll = Boolean(autoScroll);

      const fn =
        "async () => {" +
        "function delay(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }" +
        (doScroll ?
          "var lastH=0; var same=0; var steps=0; var maxSteps=60; while(steps<maxSteps){ window.scrollBy(0,800); await delay(150); var h=Math.max(document.body.scrollHeight||0, document.documentElement.scrollHeight||0); if(h===lastH){ same+=1; } else { same=0; lastH=h; } steps+=1; if(same>=5) break; }" :
          ""
        ) +
        "function cleanup(el){ if(!el) return; var qs=el.querySelectorAll('script,style,nav,footer,header,iframe,svg'); for(var i=0;i<qs.length;i++){ var n=qs[i]; if(n && n.parentNode) n.parentNode.removeChild(n); } }" +
        "function text(el){ var w=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null); var out=[]; var len=0; var cap=" + String(cap) + "; while(w.nextNode()){ var t=(w.currentNode.nodeValue||'').replace(/\\s+/g,' ').trim(); if(!t) continue; out.push(t); len+=t.length+1; if(len>cap) break; } return out.join('\\n'); }" +
        "var root=document.querySelector('article')||document.querySelector('main')||document.body||document.documentElement;" +
        "var title=document.title||undefined; var url=location.href; if(!root) return { title:title, url:url, body:'' };" +
        "cleanup(root); var body=text(root); return { title:title, url:url, body:body };" +
        "}";

      const evalRes = await this.mcp.call(key, "evaluate_script", { function: fn }, cfg);
      const obj = parseMcpEvaluateJsonResult(evalRes);
      if (obj && typeof obj === "object"){
        return {
          ok:true,
          url: obj.url ? String(obj.url) : null,
          title: obj.title,
          text: obj.body ? String(obj.body) : "",
          tookMs: Date.now() - startTs,
          engine: "chromium",
          driver: "existing-session",
          transport: "chrome-mcp",
          raw: evalRes
        };
      }

      // Fallback: use a11y snapshot.
      const snapRes = await this.mcp.call(key, "take_snapshot", {}, cfg);
      let text = getMcpTextContent(snapRes);
      if (text && text.length > cap) text = text.slice(0, cap);
      return {
        ok:true,
        url: null,
        title: undefined,
        text,
        tookMs: Date.now() - startTs,
        engine: "chromium",
        driver: "existing-session",
        transport: "chrome-mcp",
        raw: { evaluate: evalRes, snapshot: snapRes }
      };
    }

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

  async click({ headers, selector, text, nth, timeoutMs, proxy, profileKey, browserProfile, profile, driver, mcp }){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const ensured = await this.mcp.ensureProfile(key, cfg);
      if (!ensured || !ensured.ok){
        return { ok:false, profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", error: "ensure_failed", details: ensured };
      }

      const sel = (selector && String(selector).trim()) ? String(selector).trim() : "";
      const txt = (text && String(text).trim()) ? String(text).trim() : "";
      const n = (typeof nth === "number" && nth >= 0) ? Math.floor(nth) : 0;
      const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;

      if (!sel && !txt) throw new Error("click requires selector or text");

      const fn =
        "async () => {" +
        "function delay(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }" +
        "function findByText(root, s){" +
        "  var w=document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);" +
        "  var out=[];" +
        "  while(w.nextNode()){" +
        "    var el=w.currentNode;" +
        "    var t=(el && el.innerText) ? String(el.innerText) : '';" +
        "    if(t && t.indexOf(s) >= 0) out.push(el);" +
        "  }" +
        "  return out;" +
        "}" +
        "var selector=" + JSON.stringify(sel) + ";" +
        "var text=" + JSON.stringify(txt) + ";" +
        "var nth=" + String(n) + ";" +
        "var el=null;" +
        "if(selector){ var list=document.querySelectorAll(selector); if(list && list.length>nth) el=list[nth]; }" +
        "else if(text){ var list2=findByText(document.body||document.documentElement, text); if(list2 && list2.length>nth) el=list2[nth]; }" +
        "if(!el) return { ok:false, error:'element_not_found', url: location.href };" +
        "try { if(el.scrollIntoView) el.scrollIntoView({ block:'center', inline:'center' }); } catch {}" +
        "try { el.click(); } catch (e) { return { ok:false, error: String(e && e.message ? e.message : e), url: location.href }; }" +
        "await delay(200);" +
        "return { ok:true, url: location.href };" +
        "}";

      const res = await this.mcp.call(key, "evaluate_script", { function: fn }, cfg);
      const obj = parseMcpEvaluateJsonResult(res);
      return {
        ok: Boolean(obj && obj.ok !== false),
        selector: sel || undefined,
        text: txt || undefined,
        nth: n,
        timeoutMs: t,
        url: obj && obj.url ? String(obj.url) : null,
        engine: "chromium",
        driver: "existing-session",
        transport: "chrome-mcp",
        details: res
      };
    }

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

  async tabs({ headers, proxy, profileKey, browserProfile, profile, driver, mcp }={}){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const ensured = await this.mcp.ensureProfile(key, cfg);
      if (!ensured || !ensured.ok){
        return { ok:false, profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", error: "ensure_failed", details: ensured };
      }

      const res = await this.mcp.call(key, "list_pages", {}, cfg);
      const text = getMcpTextContent(res);
      const tabs = [];
      try {
        const lines = String(text||"").split("\n");
        for (let i = 0; i < lines.length; i++){
          const line = String(lines[i]||"").trim();
          const m = line.match(/^(\d+):\s*(.+?)(\s*\[selected\])?$/i);
          if (!m) continue;
          const pageId = parseInt(m[1], 10);
          const url = String(m[2]||"").trim();
          const selected = Boolean(m[3]);
          if (pageId && pageId > 0){
            tabs.push({ pageId, url, selected });
          }
        }
      } catch {}

      return { ok: Boolean(res && res.ok), profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", tabs, raw: res };
    }

    const entry = await this.profiles.getOrStartProfile(key, { proxy });
    let tabs = [];
    try {
      let context = null;
      try { context = entry.browser && entry.browser.contexts ? entry.browser.contexts()[0] : null; } catch { context = null; }
      let pages = [];
      if (context && context.pages && typeof context.pages === "function"){ pages = context.pages(); }
      for (let i = 0; i < pages.length; i++){
        const p = pages[i];
        let url = null; let title = null;
        try { if (p && p.url && typeof p.url === "function") url = p.url(); } catch {}
        try { if (p && p.title && typeof p.title === "function") title = p.title(); } catch {}
        const isActive = (p === entry.page);
        tabs.push({ index: i, url, title, isActive });
      }
    } catch {}
    return { ok:true, profileKey: key, driver: "playwright", engine: entry.engine, tabs };
  }

  async selectTab({ headers, index, url, proxy, profileKey, browserProfile, profile, driver, mcp }={}){
    const key = this._resolveProfileKey({ headers, proxy, profileKey, browserProfile, profile });
    const drv = this._normalizeDriver(driver, key);

    if (drv === "mcp"){
      const cfg = this._normalizeMcpConfig(key, mcp);
      const ensured = await this.mcp.ensureProfile(key, cfg);
      if (!ensured || !ensured.ok){
        return { ok:false, profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", error: "ensure_failed", details: ensured };
      }

      let pageId = null;
      if (typeof index === "number" && index > 0){
        pageId = Math.floor(index);
      } else if (url){
        const tabsRes = await this.tabs({ headers, proxy, profileKey: key, driver: "mcp", mcp: cfg });
        if (tabsRes && Array.isArray(tabsRes.tabs)){
          for (let i = 0; i < tabsRes.tabs.length; i++){
            const t = tabsRes.tabs[i];
            if (t && t.url === String(url)) { pageId = t.pageId; break; }
          }
        }
      }

      if (!pageId){
        return { ok:false, profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", error: "page_id_required" };
      }

      const res = await this.mcp.call(key, "select_page", { pageId }, cfg);
      return { ok: Boolean(res && res.ok), profileKey: key, engine: "chromium", driver: "existing-session", transport: "chrome-mcp", selectedPageId: pageId, raw: res };
    }

    const entry = await this.profiles.getOrStartProfile(key, { proxy });
    let context = null;
    try { context = entry.browser && entry.browser.contexts ? entry.browser.contexts()[0] : null; } catch { context = null; }
    if (!context || !context.pages || typeof context.pages !== "function"){
      return { ok:false, error: "no_context", profileKey: key };
    }
    const pages = context.pages();
    let target = null; let targetIndex = null;
    if (typeof index === "number" && index >= 0 && index < pages.length){
      targetIndex = Math.floor(index);
      target = pages[targetIndex];
    } else if (url){
      const want = String(url);
      for (let i = 0; i < pages.length; i++){
        const p = pages[i];
        let u = null;
        try { if (p && p.url && typeof p.url === "function") u = p.url(); } catch { u = null; }
        if (u === want){ target = p; targetIndex = i; break; }
      }
    }
    if (!target){ return { ok:false, error: "tab_not_found", profileKey: key }; }
    entry.page = target;
    let currentUrl = null; let currentTitle = null;
    try { if (target.url && typeof target.url === "function") currentUrl = target.url(); } catch {}
    try { if (target.title && typeof target.title === "function") currentTitle = target.title(); } catch {}
    entry.lastUrl = currentUrl || entry.lastUrl || null;
    return { ok:true, profileKey: key, driver: "playwright", engine: entry.engine, selectedIndex: targetIndex, url: currentUrl, title: currentTitle };
  }
}

export default { BrowserManager };
