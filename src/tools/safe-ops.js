// SafeOps — constrained I/O helpers for Arcana tools (in-process, non-CLI)
// Defaults:
//  - allowNetwork: true (http/https only)
//  - allowWrite: true (but always confined to workspace root via ensureWriteAllowed)
//  - Optional per-skill tightening via allowedHosts (host[:port]) and allowedWritePaths (relative to workspace)

import { resolve as pathResolve } from 'node:path';
import { promises as fsp } from 'node:fs';
import { ensureReadAllowed, ensureWriteAllowed, ensureWithinAllowedPaths, resolveWorkspaceRoot } from '../workspace-guard.js';

const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.ARCANA_SAFEOPS_HTTP_TIMEOUT_MS || 10000);
const DEFAULT_HTTP_MAX_BYTES = Number(process.env.ARCANA_SAFEOPS_HTTP_MAX_BYTES || 10 * 1024 * 1024); // 10MB

function isHttpUrl(u){
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

function parseHostPort(u){
  try {
    const x = new URL(u);
    const port = x.port ? (':' + x.port) : (x.protocol === 'https:' ? ':443' : ':80');
    return (x.hostname + port).toLowerCase();
  } catch { return '';
  }
}

function normalizeHostPort(h){
  const s = String(h || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes(':')) return s;
  return s + ':443';
}

export function createSafeOps(options = {}){
  const allowNetwork = options.allowNetwork !== false; // default true
  const allowWrite = options.allowWrite !== false;     // default true
  const allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts.map(normalizeHostPort) : null;
  const allowedWritePaths = Array.isArray(options.allowedWritePaths) ? options.allowedWritePaths.slice() : null;

  const fs = {
    // Always resolve/guard reads against workspace root
    async readFile(p, enc){ const abs = ensureReadAllowed(p); /* no default encoding: match Node fs.readFile so omitted encoding returns a Buffer (avoids corrupting binary uploads) */ return enc == null ? fsp.readFile(abs) : fsp.readFile(abs, enc); },
    async writeFile(p, data, enc){ if (!allowWrite) throw new Error('write_forbidden'); const abs = ensureWriteAllowed(p); if (allowedWritePaths && !ensureWithinAllowedPaths(abs, allowedWritePaths)) throw new Error('write_forbidden_path'); return enc ? fsp.writeFile(abs, data, enc) : fsp.writeFile(abs, data); },
    async mkdirp(p){ if (!allowWrite) throw new Error('write_forbidden'); const abs = ensureWriteAllowed(p); if (allowedWritePaths && !ensureWithinAllowedPaths(abs, allowedWritePaths)) throw new Error('write_forbidden_path'); return fsp.mkdir(abs, { recursive:true }); },
    async stat(p){ const abs = ensureReadAllowed(p); return fsp.stat(abs); },
    async exists(p){ try { const abs = ensureReadAllowed(p); await fsp.access(abs); return true; } catch { return false; } },
    workspaceRoot(){ return resolveWorkspaceRoot(); }
  };

  const http = {
    async fetch(u, init = {}){
      if (!allowNetwork) throw new Error('network_forbidden');
      if (!isHttpUrl(u)) throw new Error('unsupported_protocol');
      const hostPort = parseHostPort(u);
      if (allowedHosts && allowedHosts.length && !allowedHosts.includes(hostPort)) throw new Error('host_not_allowed');
      // Enforce timeout by racing AbortSignal
      const controller = new AbortController();
      const timeoutMs = typeof init.timeout === 'number' ? init.timeout : DEFAULT_HTTP_TIMEOUT_MS;
      const userSignal = init.signal;
      const onUserAbort = ()=>{ try { controller.abort(); } catch{} };
      if (userSignal) userSignal.addEventListener('abort', onUserAbort, { once:true });
      const timer = setTimeout(()=>controller.abort(), timeoutMs);
      const res = await fetch(u, { ...init, signal: controller.signal, redirect: init.redirect || 'follow' });
      clearTimeout(timer);
      if (userSignal) try { userSignal.removeEventListener('abort', onUserAbort); } catch{}
      return res;
    },
    async readBody(res){
      // Read with size cap; stream reader
      const reader = res.body?.getReader ? res.body.getReader() : null;
      if (!reader) return res.arrayBuffer();
      let received = 0; const chunks = [];
      while (true){
        const { done, value } = await reader.read();
        if (done) break; if (value){ received += value.byteLength; if (received > DEFAULT_HTTP_MAX_BYTES) throw new Error('response_too_large'); chunks.push(value); }
      }
      const buf = new Uint8Array(received); let off=0; for (const c of chunks){ buf.set(c, off); off += c.byteLength; }
      return buf.buffer;
    }
  };

  return { fs, http };
}

export default { createSafeOps };
