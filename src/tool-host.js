#!/usr/bin/env node
// Simple JSONL stdio tool-host. Runs high-risk tools in an isolated
// Node child process that we can kill/restart from the main app.
//
// Protocol (one JSON object per line):
//  -> { id, method, params }
//  <- { id, ok: true, result } | { id, ok: false, error: { message } }
//
// Tools implemented:
//  - bash        { command: string, timeout?: number }
//  - web_render  { action: start|status|navigate|snapshot, ... }
//  - web_extract { maxChars?: number, autoScroll?: boolean }
//  - web_search  { query: string, engine?: duckduckgo|bing|baidu }
//
// Playwright state is kept in-process via src/pw-runtime.js across calls.

import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';

// Lazy import to avoid loading Playwright unless actually used
let pw; // populated on first web_* call
async function ensurePW() {
  if (!pw) {
    pw = await import('./pw-runtime.js');
  }
  return pw;
}

// Tail truncation similar to pi-coding-agent defaults: 2000 lines or 50KB
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

function truncateTail(content) {
  const maxLines = DEFAULT_MAX_LINES;
  const maxBytes = DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = content.split('\n');
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes, lastLinePartial: false };
  }
  const out = [];
  let bytes = 0;
  let truncatedBy = 'lines';
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (out.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      if (out.length === 0) { // partial last line edge case
        const buf = Buffer.from(line, 'utf-8');
        let start = Math.max(0, buf.length - maxBytes);
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // utf-8 boundary
        const slice = buf.slice(start);
        out.unshift(slice.toString('utf-8'));
        bytes = slice.length;
        lastLinePartial = true;
      }
      break;
    }
    out.unshift(line);
    bytes += lineBytes;
  }
  return { content: out.join('\n'), truncated: true, truncatedBy, totalLines, totalBytes, outputLines: out.length, outputBytes: bytes, lastLinePartial };
}

// Keep track of currently running task for /status
let busy = null; // { id, method, startedAt }
// Defense-in-depth: serialize execution to one tool at a time inside the host
// even if a buggy client sends overlapping requests. A simple promise chain
// ensures the queue continues after failures.
let queue = Promise.resolve();

function reply(id, ok, payload){
  const obj = { id, ok, ...(ok ? { result: payload } : { error: { message: String(payload?.message||payload||'error') } }) };
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {}
}

async function handleBash(id, params){
  const command = String(params?.command||'');
  if (!command) return reply(id, false, { message: 'missing_command' });
  const timeoutSecs = params?.timeout ? Number(params.timeout) : undefined;
  // Use the user's login shell configuration where possible; fall back to bash -lc
  const shell = process.env.SHELL || 'bash';
  const isBashLike = /bash|zsh|fish|sh/.test(shell);
  const args = isBashLike ? ['-lc', command] : ['-c', command];

  // We want to keep a rolling buffer and write the full output to a temp file if truncated
  const tempPath = join(tmpdir(), 'arcana-bash-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.log');
  const temp = createWriteStream(tempPath);
  let totalBytes = 0;
  const chunks = [];
  let chunksBytes = 0;
  const maxChunksBytes = DEFAULT_MAX_BYTES * 2; // over-collect so truncation has context

  const child = spawn(shell, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore','pipe','pipe'],
    detached: true,
  });

  let timeoutHandle;
  let timedOut = false;
  if (timeoutSecs && timeoutSecs > 0){
    timeoutHandle = setTimeout(()=>{ timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, timeoutSecs*1000);
  }

  const onData = (buf)=>{
    totalBytes += buf.length;
    try { temp.write(buf); } catch {}
    chunks.push(buf);
    chunksBytes += buf.length;
    while (chunksBytes > maxChunksBytes && chunks.length > 1){ const x = chunks.shift(); chunksBytes -= x.length; }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  child.on('error', (err)=>{ if (timeoutHandle) clearTimeout(timeoutHandle); reply(id, false, { message: err?.message||String(err) }); });
  child.on('close', (code)=>{
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { temp.end(); } catch {}
    const text = Buffer.concat(chunks).toString('utf-8');
    const trunc = truncateTail(text);
    let outText = trunc.content || '(no output)';
    let details = { truncation: trunc, fullOutputPath: tempPath };
    if (trunc.truncated){
      const startLine = trunc.totalLines - trunc.outputLines + 1;
      const endLine = trunc.totalLines;
      if (trunc.lastLinePartial){
        outText += '\n\n[Showing last ' + trunc.outputBytes + ' of line ' + endLine + '. Full output: ' + tempPath + ']';
      } else if (trunc.truncatedBy === 'lines'){
        outText += '\n\n[Showing lines ' + startLine + '-' + endLine + ' of ' + trunc.totalLines + '. Full output: ' + tempPath + ']';
      } else {
        outText += '\n\n[Showing lines ' + startLine + '-' + endLine + ' of ' + trunc.totalLines + ' (50KB limit). Full output: ' + tempPath + ']';
      }
    }
    if (timedOut){
      outText += '\n\nCommand timed out after ' + timeoutSecs + 's';
      reply(id, false, { message: outText });
    } else if (code !== 0 && code !== null){
      outText += '\n\nCommand exited with code ' + code;
      reply(id, false, { message: outText });
    } else {
      reply(id, true, { content: [{ type:'text', text: outText }], details });
    }
  });
}

async function handleWebRender(id, params){
  const action = String(params?.action||'').toLowerCase();
  const PW = await ensurePW();
  if (action === 'start') {
    const opts = {
      headless: (typeof params?.headless === 'boolean') ? params.headless : undefined,
      engine: params?.engine,
      userDataDir: params?.userDataDir,
      forceRestart: Boolean(params?.forceRestart),
    };
    await PW.start(opts);
    const s = (PW.status ? PW.status() : { started: true });
    return reply(id, true, { content:[{ type:'text', text:'started' }], details:s });
  }
  if (action === 'status') {
    const s = (PW.status ? PW.status() : { started: false });
    return reply(id, true, { content:[{ type:'text', text:'status' }], details:s });
  }
  if (action === 'open') {
    let userDataDir = params?.userDataDir || undefined;
    if (!userDataDir){
      const defaultUserDataDir = join(process.cwd(), '.cache', 'web_render_profile');
      if (!existsSync(defaultUserDataDir)) mkdirSync(defaultUserDataDir, { recursive: true });
      userDataDir = defaultUserDataDir;
    }
    await PW.start({
      headless: false,
      engine: params?.engine,
      userDataDir,
      forceRestart: Boolean(params?.forceRestart),
    });
    let r = null;
    if (params?.url){
      r = await PW.navigate(params.url, { waitUntil: params?.waitUntil });
    }
    const s = (PW.status ? PW.status() : undefined);
    const details = r || s || { started: true };
    const text = r && r.url ? ('opened ' + r.url) : 'opened';
    return reply(id, true, { content:[{ type:'text', text }], details });
  }
  if (action === 'close') {
    if (PW.close) {
      await PW.close();
    }
    return reply(id, true, { content:[{ type:'text', text:'closed' }], details:{ ok:true } });
  }
  if (action === 'navigate') { const r = await PW.navigate(params?.url, { waitUntil: params?.waitUntil }); return reply(id, true, { content:[{ type:'text', text: 'navigated ' + r.url }], details:r }); }
  if (action === 'snapshot') { const r = await PW.extract({ maxChars: params?.maxChars||20000 }); const wrapped = '[external:web_render]\n' + r.text; return reply(id, true, { content:[{ type:'text', text: wrapped }], details: { url: r.url, title: r.title, tookMs: r.tookMs } }); }
  return reply(id, false, { message: 'unknown_action' });
}

async function handleWebExtract(id, params){
  const PW = await ensurePW();
  const r = await PW.extract({ maxChars: params?.maxChars||20000, autoScroll: Boolean(params?.autoScroll) });
  const wrapped = '[external:web_extract]\n' + (r.text || '');
  return reply(id, true, { content:[{ type:'text', text: wrapped }], details: { url: r.url, title: r.title, tookMs: r.tookMs } });
}

async function handleWebSearch(id, params){
  const q = String(params?.query||'').trim();
  if (!q) return reply(id, false, { message: 'missing_query' });
  const engine = String(params?.engine||'duckduckgo').toLowerCase();
  const base = engine === 'baidu' ? 'https://www.baidu.com/s?wd=' : engine === 'bing' ? 'https://www.bing.com/search?q=' : 'https://duckduckgo.com/?q=';
  const url = base + encodeURIComponent(q);
  const PW = await ensurePW();
  await PW.navigate(url, { waitUntil: 'networkidle' });
  const r = await PW.extract({ maxChars: 20000, autoScroll: false });
  const header = '[external:web_search]\nurl=' + r.url + ' title=' + (r.title||'') + '\n';
  return reply(id, true, { content:[{ type:'text', text: header + (r.text||'') }], details: { provider:'browser', engine, url: r.url, title: r.title, tookMs: r.tookMs } });
}

async function dispatch(id, method, params){
  busy = { id, method, startedAt: Date.now() };
  try {
    if (method === 'bash') return await handleBash(id, params);
    if (method === 'web_render') return await handleWebRender(id, params);
    if (method === 'web_extract') return await handleWebExtract(id, params);
    if (method === 'web_search') return await handleWebSearch(id, params);
    if (method === 'status') { return reply(id, true, { busy, ok: true }); }
    return reply(id, false, { message: 'unknown_method' });
  } catch (e) {
    return reply(id, false, { message: e?.message||String(e) });
  } finally {
    // Keep busy info only for status while a tool is running
    busy = null;
  }
}

// Graceful shutdown to close Playwright resources
async function shutdown(){ try { if (pw?.close) await pw.close().catch(()=>{}); } catch {} }
process.on('SIGINT', ()=>{ shutdown().finally(()=>process.exit(0)); });
process.on('SIGTERM', ()=>{ shutdown().finally(()=>process.exit(0)); });
process.on('exit', ()=>{ /* best effort */ });

// Start JSONL loop
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line)=>{
  if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const id = msg?.id; const method = String(msg?.method||''); const params = msg?.params||{};
  if (!id || !method) return reply(id||'unknown', false, { message: 'invalid_request' });
  // One-at-a-time execution inside the host so Playwright/browser state
  // cannot be corrupted by concurrent actions.
  const run = () => dispatch(id, method, params);
  queue = queue.then(run, run).catch(()=>{});
});
