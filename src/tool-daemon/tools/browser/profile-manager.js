import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { chromium } from "playwright";
import { normalizeProxySpec } from "./proxy.js";
import { browserProfileDir, ensureDir, browserBaseDir, browserProfilesDir } from "../../paths.js";

// Chromium-only ProfileManager using Playwright over CDP
// Constraints: no template literals; avoid unescaped "$" characters.

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

function isPidAlive(pid){
  try { if (!pid || pid <= 0) return false; process.kill(pid, 0); return true; } catch { return false; }
}

function safeKeyString(key){ var s=String(key||"default"); var out=""; for(var i=0;i<s.length;i++){ var c=s.charAt(i); if ((c>="A"&&c<="Z")||(c>="a"&&c<="z")||(c>="0"&&c<="9")||c==="_"||c===":"||c==="."||c==="-"){ out += c; } else { out += "_"; } } return out; }

async function pathExists(p){ try { await fsp.access(p, fs.constants.F_OK); return true; } catch { return false; } }

export class ProfileManager {
  constructor({ workspaceRoot, maxProfiles=8 }={}){
    this.workspaceRoot = String(workspaceRoot || process.cwd());
    this.maxProfiles = Number(maxProfiles || 8);
    this.entries = new Map();
    this._idleTimer = null;
    try { ensureDir(browserBaseDir(this.workspaceRoot)); } catch {}
    this._scheduleIdle();
  }

  _scheduleIdle(){
    try { if (this._idleTimer) clearTimeout(this._idleTimer); } catch {}
    const self = this;
    this._idleTimer = setTimeout(function(){
      self._cleanupIdle().catch(function(){}) .finally(function(){ self._scheduleIdle(); });
    }, 30000);
  }

  async _cleanupIdle(){
    const now = Date.now();
    const idleMs = 2 * 60 * 1000;
    const keys = Array.from(this.entries.keys());
    for (let i = 0; i < keys.length; i++){
      const k = keys[i];
      const e = this.entries.get(k);
      if (!e) continue;
      const last = Number(e.lastActiveAt || 0);
      if (last && now - last > idleMs){
        try { await this._stopEntry(e); } catch {}
        try { this.entries.delete(k); } catch {}
      }
    }
    // Enforce maxProfiles: trim least-recently-used
    if (this.entries.size > this.maxProfiles){
      const arr = Array.from(this.entries.entries()).sort(function(a,b){ return (a[1].lastActiveAt||0) - (b[1].lastActiveAt||0); });
      for (let i = 0; i < arr.length - this.maxProfiles; i++){
        const k = arr[i][0];
        const e = arr[i][1];
        try { await this._stopEntry(e); } catch {}
        try { this.entries.delete(k); } catch {}
      }
    }
  }

  list(){
    const out = [];
    const it = this.entries.entries();
    for (const pair of it){
      const k = pair[0];
      const e = pair[1];
      var url = null;
      try {
        var pageOpen = true;
        if (e && e.page && e.page.isClosed && typeof e.page.isClosed === "function"){ pageOpen = !e.page.isClosed(); }
        if (e && e.page && e.page.url && typeof e.page.url === "function" && pageOpen){ url = e.page.url(); }
        else if (e && e.lastUrl){ url = e.lastUrl; }
      } catch { url = e && e.lastUrl ? e.lastUrl : null; }
      out.push({ profileKey: k, pid: e && e.pid ? e.pid : null, cdpPort: e && e.cdpPort ? e.cdpPort : null, userDataDir: e && e.userDataDir ? e.userDataDir : null, url: url, lastActiveAt: e && e.lastActiveAt ? e.lastActiveAt : null });
    }
    return out;
  }

  async status(key){
    const k = String(key || "default");
    const e = this.entries.get(k);
    if (!e){
      const pdir = browserProfileDir(this.workspaceRoot, k);
      return { profileKey: k, pid: null, cdpPort: null, userDataDir: pdir, url: null, lastActiveAt: null };
    }
    var url = null;
    try {
      var pageOpen = true;
      if (e.page && e.page.isClosed && typeof e.page.isClosed === "function"){ pageOpen = !e.page.isClosed(); }
      if (e.page && e.page.url && typeof e.page.url === "function" && pageOpen){ url = e.page.url(); }
      else if (e.lastUrl){ url = e.lastUrl; }
    } catch { url = e.lastUrl || null; }
    return { profileKey: k, pid: e.pid || null, cdpPort: e.cdpPort || null, userDataDir: e.userDataDir, url: url, lastActiveAt: e.lastActiveAt || null };
  }

  async stopProfile(key){
    const k = String(key || "default");
    const e = this.entries.get(k);
    if (!e) return { ok:true, stopped:false };
    await this._stopEntry(e);
    try { this.entries.delete(k); } catch {}
    return { ok:true, stopped:true };
  }

  async resetProfile(key){
    const k = String(key || "default");
    try { await this.stopProfile(k); } catch {}
    const src = browserProfileDir(this.workspaceRoot, k);
    const safe = safeKeyString(k);
    const trashRoot = path.join(browserBaseDir(this.workspaceRoot), "trash");
    const dst = path.join(trashRoot, safe + "-" + String(Date.now()));
    try { ensureDir(trashRoot); } catch {}
    try {
      if (await pathExists(src)){
        await fsp.rename(src, dst);
        return { ok:true, moved:true, from: src, to: dst };
      }
    } catch {}
    return { ok:true, moved:false };
  }

  async getOrStartProfile(key, { headless=true, engine, forceRestart=false, webgl=false, proxy }={}){
    const k = String(key || "default");
    const e = this.entries.get(k);
    if (e){
      this._touchActivity(e);
      const valid = await this._validateEntry(e);
      if (!forceRestart && valid) return e;
      try { await this._stopEntry(e); } catch {}
      try { this.entries.delete(k); } catch {}
    }

    // Enforce LRU maxProfiles before starting a new one
    if (this.entries.size >= this.maxProfiles){
      const arr = Array.from(this.entries.entries()).sort(function(a,b){ return (a[1].lastActiveAt||0) - (b[1].lastActiveAt||0); });
      const toDrop = arr[0] && arr[0][1] ? arr[0][1] : null;
      const toDropKey = arr[0] && arr[0][0] ? arr[0][0] : null;
      if (toDrop){ try { await this._stopEntry(toDrop); } catch {} }
      if (toDropKey){ try { this.entries.delete(toDropKey); } catch {} }
    }

    const entry = await this._startChromiumProfile(k, { headless: Boolean(headless), webgl: Boolean(webgl), proxy: proxy });
    this.entries.set(k, entry);
    this._touchActivity(entry);
    return entry;
  }

  async _startChromiumProfile(key, { headless, webgl=false, proxy }={}){
    const userDataDir = browserProfileDir(this.workspaceRoot, key);
    try { ensureDir(browserProfilesDir(this.workspaceRoot)); } catch {}
    try { ensureDir(userDataDir); } catch {}

    const execPath = await this._detectExecutablePath();
    const args = [];
    args.push("--remote-debugging-port=0");
    args.push("--user-data-dir=" + String(userDataDir));
    args.push("--no-first-run");
    args.push("--no-default-browser-check");
    const p = normalizeProxySpec(proxy);
    if (p && p.mode === "none"){
      args.push("--no-proxy-server");
    } else if (p && p.mode === "custom" && p.server){
      args.push("--proxy-server=" + String(p.server));
    }
    const disableGpuEnv = String(process.env["ARCANA_BROWSER_DISABLE_GPU"] || "").trim().toLowerCase();
    const useGpuStabilityFlags = !(disableGpuEnv === "0" || disableGpuEnv === "false");
    const enableWebgl = Boolean(webgl);
    if (headless){ args.push("--headless=new"); }
    if (headless && enableWebgl){
      if (process.platform === "darwin"){ args.push("--use-angle=metal"); }
      args.push("--enable-webgl");
      args.push("--ignore-gpu-blocklist");
      args.push("--enable-gpu-rasterization");
      args.push("--disable-features=Vulkan");
      args.push("--enable-unsafe-swiftshader");
    } else if (headless && useGpuStabilityFlags){
      args.push("--disable-gpu");
      args.push("--disable-gpu-sandbox");
      args.push("--disable-gpu-compositing");
      args.push("--use-gl=swiftshader");
    }

    const logPath = path.join(String(userDataDir), "chrome.log");
    let logFd = null;
    try { logFd = fs.openSync(logPath, "a"); } catch {}
    const stdio = logFd !== null ? ["ignore", logFd, logFd] : "ignore";

    const proc = spawn(execPath, args, { stdio: stdio, detached: true });
    try { if (typeof logFd === "number") fs.closeSync(logFd); } catch {}
    const pid = proc && proc.pid ? proc.pid : null;

    const entry = { key: key, engine: "chromium", userDataDir: userDataDir, proc: proc, pid: pid, stale: false, lastActiveAt: Date.now(), browser: null, page: null, cdpPort: null, lastUrl: null, logPath: logPath, webgl: Boolean(webgl) };
    try { proc.on("exit", function(){ try { entry.stale = true; } catch {} }); } catch {}

    const port = await this._waitForDevToolsPort(userDataDir, 15000);
    if (!port){
      try { await this._stopEntry(entry); } catch {}
      var msg = "failed_to_start_chromium";
      if (entry && entry.logPath){ msg += " (see " + String(entry.logPath) + ")"; }
      throw new Error(msg);
    }

    entry.cdpPort = port;
    const endpoint = "http://127.0.0.1:" + String(port);
    const browser = await chromium.connectOverCDP(endpoint);
    entry.browser = browser;
    try { browser.on("disconnected", function(){ try { entry.stale = true; } catch {} }); } catch {}
    // Ensure at least one page exists
    let context = null;
    try { context = browser.contexts()[0] || null; } catch { context = null; }
    if (!context){
      try { context = await browser.newContext(); } catch {}
    }
    if (!context) throw new Error("no_browser_context");
    const page = await context.newPage();
    entry.page = page;
    try { page.setDefaultTimeout(30000); } catch {}
    try {
      page.on("framenavigated", function(){ try { entry.lastUrl = page.url(); } catch {} });
      page.on("close", function(){ try { entry.lastUrl = entry.lastUrl || null; } catch {} });
    } catch {}
    return entry;
  }

  async _stopEntry(entry){
    if (!entry) return;
    entry.stale = true;
    try { if (entry.page) await entry.page.close({ runBeforeUnload: false }); } catch {}
    try {
      if (entry.browser){
        await entry.browser.close();
      }
    } catch {}
    try {
      if (entry.proc && entry.pid && isPidAlive(entry.pid)){
        const pid = entry.pid;
        try { process.kill(0 - pid, "SIGTERM"); } catch {}
        try { entry.proc.kill("SIGTERM"); } catch {}
        try { process.kill(pid, "SIGTERM"); } catch {}
        const start = Date.now();
        while (Date.now() - start < 1500){ if (!isPidAlive(pid)) break; await sleep(50); }
        if (isPidAlive(pid)){
          try { process.kill(0 - pid, "SIGKILL"); } catch {}
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    } catch {}
    entry.browser = null; entry.page = null; entry.proc = null; entry.pid = null;
  }

  async _validateEntry(entry){
    if (!entry) return false;
    if (entry.stale) return false;
    if (!entry.proc || !entry.pid || !isPidAlive(entry.pid)) return false;
    if (!entry.browser || !entry.browser.isConnected || !entry.browser.isConnected()) return false;
    try {
      const ctxs = entry.browser.contexts ? entry.browser.contexts() : [];
      const ctx = ctxs && ctxs[0] ? ctxs[0] : null;
      if (!ctx) return false;
      const pages = ctx.pages ? ctx.pages() : [];
      if (!pages || pages.length === 0) return false;
      if (!entry.page) entry.page = pages[0];
      if (entry.page && entry.page.isClosed && entry.page.isClosed()) return false;
    } catch { return false; }
    return true;
  }

  async _detectExecutablePath(){
    try {
      const envPath = String(process.env["ARCANA_BROWSER_EXECUTABLE"] || "").trim();
      if (envPath && fs.existsSync(envPath)) return envPath;
    } catch {}

    try {
      const chromiumPath = chromium.executablePath();
      if (chromiumPath && fs.existsSync(chromiumPath)) return chromiumPath;
    } catch {}

    if (process.platform === "darwin"){
      const candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
      ];
      for (let i = 0; i < candidates.length; i++){
        const p = candidates[i];
        try { if (fs.existsSync(p)) return p; } catch {}
      }
    }
    throw new Error("chromium_executable_not_found");
  }

  async _waitForDevToolsPort(userDataDir, timeoutMs){
    const start = Date.now();
    const deadline = start + Number(timeoutMs || 10000);
    const activePath = path.join(String(userDataDir||""), "DevToolsActivePort");
    while (Date.now() < deadline){
      try {
        if (fs.existsSync(activePath)){
          const txt = await fsp.readFile(activePath, { encoding: "utf-8" });
          const line = String(txt || "").split("\n")[0] || "";
          const port = parseInt(String(line).trim(), 10);
          if (port && port > 0){
            const ok = await this._waitForCdpHttp(port, 2000);
            if (ok) return port;
          }
        }
      } catch {}
      await sleep(100);
    }
    return null;
  }

  async _waitForCdpHttp(port, timeoutMs){
    const start = Date.now();
    const deadline = start + Number(timeoutMs || 2000);
    const url = "http://127.0.0.1:" + String(port) + "/json/version";
    while (Date.now() < deadline){
      try {
        const ok = await new Promise(function(resolve){
          try {
            const req = http.get(url, function(resp){
              try { resolve(Boolean(resp && resp.statusCode && resp.statusCode >= 200 && resp.statusCode < 500)); } catch { resolve(false); }
            });
            req.on("error", function(){ resolve(false); });
            try { req.setTimeout(500, function(){ try { req.destroy(); } catch {}; resolve(false); }); } catch {}
          } catch { resolve(false); }
        });
        if (ok) return true;
      } catch {}
      await sleep(100);
    }
    return false;
  }

  _touchActivity(entry){ entry.lastActiveAt = Date.now(); }
}

export default { ProfileManager };
