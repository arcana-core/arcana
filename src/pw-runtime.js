import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { resolveWorkspaceRoot } from "./workspace-guard.js";

let _pw;
let _browser;
let _context;
let _page;
let _lastStartOpts;

const artifactsDir = join(resolveWorkspaceRoot(), "arcana", "artifacts");
if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true });

export async function ensure(){
  if (!_pw) {
    try { _pw = await import("playwright"); }
    catch { throw new Error("Playwright not installed. Run: npm i -S playwright && npx playwright install"); }
  }
  return _pw;
}

function pickEngine(pw, explicit){
  const pref = (explicit || process.env.ARCANA_PW_ENGINE||"").toLowerCase();
  if (pref && pw[pref]) return pref;
  return "chromium"; // default
}

export async function start(opts={}){
  const forceRestart = Boolean(opts && opts.forceRestart);
  if (_browser && !forceRestart) return;
  if (_browser && forceRestart) {
    await close();
  }
  const pw = await ensure();
  const engine = pickEngine(pw, opts.engine);
  const envHeadless = String(process.env.ARCANA_PW_HEADLESS||"true").toLowerCase() !== "false";
  const headless = (typeof opts.headless === "boolean") ? opts.headless : envHeadless;
  let userDataDir = opts.userDataDir || undefined;
  const tryLaunch = async () => {
    const engines = engine === "chromium" ? ["chromium","webkit","firefox"] : [engine,"chromium","webkit","firefox"];
    let lastErr;
    let usedEngine = null;
    for (const e of engines){
      try {
        if (userDataDir){
          if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
          _context = await pw[e].launchPersistentContext(userDataDir, { headless });
          _browser = _context.browser();
        } else {
          _browser = await pw[e].launch({ headless });
          _context = await _browser.newContext();
        }
        usedEngine = e;
        return usedEngine;
      } catch (err) {
        lastErr = err;
        _browser = null;
        _context = null;
      }
    }
    throw lastErr || new Error("All Playwright engines failed to launch");
  };
  const usedEngine = await tryLaunch();
  const pages = (_context && _context.pages) ? _context.pages() : [];
  _page = (pages && pages.length > 0) ? pages[0] : await _context.newPage();
  _lastStartOpts = { headless, engine: usedEngine || engine, userDataDir };
}

export async function navigate(url, opts={}){
  await start();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs allowed");
  await _page.goto(url, { waitUntil: opts.waitUntil||"networkidle", timeout: opts.timeoutMs||30000 });
  return { url: _page.url() };
}

export async function extract(opts={}){
  await start();
  const startTs = Date.now();
  if (opts.autoScroll){
    for (let i=0;i<(opts.scrollSteps||8);i++){ await _page.evaluate((y)=>window.scrollBy(0,y), 1400); await _page.waitForTimeout(200); }
  }
  const result = await _page.evaluate((maxChars)=>{
    function cleanup(el){ const q=el.querySelectorAll("script,style,nav,footer,header,iframe,svg"); q.forEach(n=>n.remove()); }
    function text(el){ const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null); const out=[]; let len=0; const cap=maxChars; while(w.nextNode()){ const t=(w.currentNode.nodeValue||"").replace(/\s+/g," ").trim(); if(!t) continue; out.push(t); len+=t.length+1; if(len>cap) break; } return out.join("\n"); }
    const root=document.querySelector("article")||document.querySelector("main")||document.body; cleanup(root);
    const title=document.title||undefined; const body=text(root);
    return { title, body };
  }, opts.maxChars||20000);
  return { url: _page.url(), title: result.title, text: result.body, tookMs: Date.now()-startTs };
}

export async function click(opts={}){
  await start();
  if (!_page) throw new Error("Playwright page not started");
  const selector = (opts && typeof opts.selector === "string" && opts.selector.trim()) ? opts.selector.trim() : undefined;
  const text = (opts && typeof opts.text === "string" && opts.text.trim()) ? opts.text.trim() : undefined;
  if (!selector && !text) throw new Error("click requires selector or text");
  const nth = (typeof opts.nth === "number" && opts.nth >= 0) ? Math.floor(opts.nth) : 0;
  const timeoutMs = (typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) ? opts.timeoutMs : 30000;
  let target;
  if (selector){
    target = _page.locator(selector).nth(nth);
  } else {
    target = _page.getByText(text, { exact:false }).nth(nth);
  }
  await target.click({ timeout: timeoutMs });
  return {
    ok: true,
    selector,
    text,
    nth,
    timeoutMs,
    url: (_page && _page.url) ? _page.url() : undefined,
  };
}


// Evaluate arbitrary function in page context (internal helper for plugins)
export async function evaluate(fn, arg){
  await start();
  return _page.evaluate(fn, arg);
}

export function status(){
  const started = Boolean(_browser);
  const url = (_page && _page.url) ? _page.url() : undefined;
  return {
    started,
    headless: _lastStartOpts ? _lastStartOpts.headless : undefined,
    engine: _lastStartOpts ? _lastStartOpts.engine : undefined,
    userDataDir: _lastStartOpts ? _lastStartOpts.userDataDir : undefined,
    url,
  };
}
// Gracefully close Playwright resources and clear module globals
export async function close(){
  // Close in reverse order of creation. Ignore errors to ensure shutdown.
  try { if (_page) await _page.close().catch(()=>{}); } finally { _page = null; }
  try { if (_context) await _context.close().catch(()=>{}); } finally { _context = null; }
  try { if (_browser) await _browser.close().catch(()=>{}); } finally { _browser = null; }
  // Drop the Playwright import as well so a fresh  will re-import
  _pw = null;
}

// Back-compat alias if callers prefer 
export const stop = close;

export default { ensure, start, navigate, extract, evaluate, status, close, stop, click };
