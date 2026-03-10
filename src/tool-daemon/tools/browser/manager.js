import { ProfileManager } from "./profile-manager.js";

export class BrowserManager {
  constructor({ workspaceRoot, maxProfiles=8 } = {}){
    this.workspaceRoot = String(workspaceRoot||process.cwd());
    this.profiles = new ProfileManager({ workspaceRoot: this.workspaceRoot, maxProfiles });
  }

  _profileKeyFromHeaders(headers){
    // Compose a stable key from agent + session headers when set.
    const a = String(headers["x-arcana-agent-id"] || headers["X-Arcana-Agent-Id"] || "default");
    const s = String(headers["x-arcana-session-id"] || headers["X-Arcana-Session-Id"] || "");
    const key = a + (s ? ("__" + s) : "");
    return key.replace(/[^A-Za-z0-9_:\.-]/g, "_");
  }

  async start({ headers, headless=true, engine, forceRestart=false }={}){
    const key = this._profileKeyFromHeaders(headers||{});
    const entry = await this.profiles.getOrStartProfile(key, { headless, engine, forceRestart });
    return { ok:true, profileKey: key, engine: entry.engine, userDataDir: entry.userDataDir };
  }

  async status({ headers }={}){
    const key = this._profileKeyFromHeaders(headers||{});
    return this.profiles.status(key);
  }

  async open({ headers, url, headless=false, engine, forceRestart=false, waitUntil, timeoutMs }){
    const key = this._profileKeyFromHeaders(headers||{});
    const entry = await this.profiles.getOrStartProfile(key, { headless, engine, forceRestart });
    if (url){
      let u = String(url||""); if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
      await entry.page.goto(u, { waitUntil: waitUntil||"networkidle", timeout: t });
      entry.lastUrl = entry.page.url?.();
    }
    return { ok:true, url: entry.page.url?.(), engine: entry.engine };
  }

  async close({ headers }={}){
    const key = this._profileKeyFromHeaders(headers||{});
    await this.profiles.stopProfile(key);
    return { ok:true };
  }

  listProfiles(){ return this.profiles.list ? this.profiles.list() : []; }

  async stopProfile({ headers, profileKey }={}){
    const key = String(profileKey || this._profileKeyFromHeaders(headers||{}));
    return this.profiles.stopProfile(key);
  }

  async resetProfile({ headers, profileKey }={}){
    const key = String(profileKey || this._profileKeyFromHeaders(headers||{}));
    if (this.profiles.resetProfile){ return this.profiles.resetProfile(key); }
    return { ok:false, error: "reset_not_supported" };
  }

  async navigate({ headers, url, waitUntil, timeoutMs }){
    const key = this._profileKeyFromHeaders(headers||{});
    const entry = await this.profiles.getOrStartProfile(key, {});
    let u = String(url||""); if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
    await entry.page.goto(u, { waitUntil: waitUntil||"networkidle", timeout: t });
    entry.lastUrl = entry.page.url?.();
    return { ok:true, url: entry.page.url?.() };
  }

  async snapshot({ headers, maxChars }){
    const key = this._profileKeyFromHeaders(headers||{});
    const entry = await this.profiles.getOrStartProfile(key, {});
    const startTs = Date.now();
    const result = await entry.page.evaluate(function(maxC){
      function cleanup(el){ var qs=el.querySelectorAll("script,style,nav,footer,header,iframe,svg"); for (var i=0;i<qs.length;i++){ var n=qs[i]; if (n && n.parentNode) n.parentNode.removeChild(n); } }
      function text(el){ var w=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null); var out=[]; var len=0; var cap=maxC; while(w.nextNode()){ var t=(w.currentNode.nodeValue||"").replace(/\s+/g," ").trim(); if(!t) continue; out.push(t); len+=t.length+1; if(len>cap) break; } return out.join("\n"); }
      var root=document.querySelector("article")||document.querySelector("main")||document.body; cleanup(root);
      var title=document.title||undefined; var body=text(root);
      return { title: title, body: body };
    }, Number(maxChars||20000));
    return { ok:true, url: entry.page.url?.(), title: result.title, text: result.body, tookMs: Date.now()-startTs };
  }

  async extract({ headers, maxChars, autoScroll }){
    const key = this._profileKeyFromHeaders(headers||{});
    const entry = await this.profiles.getOrStartProfile(key, {});
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
      function cleanup(el){ var qs=el.querySelectorAll("script,style,nav,footer,header,iframe,svg"); for (var i=0;i<qs.length;i++){ var n=qs[i]; if (n && n.parentNode) n.parentNode.removeChild(n); } }
      function text(el){ var w=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null); var out=[]; var len=0; var cap=maxC; while(w.nextNode()){ var t=(w.currentNode.nodeValue||"").replace(/\s+/g," ").trim(); if(!t) continue; out.push(t); len+=t.length+1; if(len>cap) break; } return out.join("\n"); }
      var root=document.querySelector("article")||document.querySelector("main")||document.body; cleanup(root);
      var title=document.title||undefined; var body=text(root);
      return { title: title, body: body };
    }, Number(maxChars||20000));
    return { ok:true, url: entry.page.url?.(), title: result.title, text: result.body, tookMs: Date.now()-startTs };
  }

  async click({ headers, selector, text, nth, timeoutMs }){
    const key = this._profileKeyFromHeaders(headers||{});
    const entry = await this.profiles.getOrStartProfile(key, {});
    const sel = (selector && String(selector).trim()) ? String(selector).trim() : undefined;
    const txt = (text && String(text).trim()) ? String(text).trim() : undefined;
    if (!sel && !txt) throw new Error("click requires selector or text");
    const n = (typeof nth === "number" && nth >= 0) ? Math.floor(nth) : 0;
    const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
    let target;
    if (sel) target = entry.page.locator(sel).nth(n);
    else target = entry.page.getByText(txt, { exact:false }).nth(n);
    await target.click({ timeout: t });
    return { ok:true, selector: sel, text: txt, nth: n, timeoutMs: t, url: entry.page.url?.() };
  }
}

export default { BrowserManager };
