// ToolHostClient: manages a long-lived child process (tool-host.js)
// to execute high-risk tools. Provides simple call/cancel/status APIs.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { registerToolHostPid, unregisterToolHostPid } from './tool-host-registry.js';

function here(){ return dirname(fileURLToPath(new URL(import.meta.url))); }
const HOST_PATH = join(here(), 'tool-host.js');

let nextId = 1;

export class ToolHostClient {
  constructor(opts={}){
    this.cwd = opts.cwd || process.cwd();
    this.child = null;
    this.buffer = '';
    this.pending = new Map(); // id -> { resolve, reject, timeoutHandle }
    this.active = null; // { id, method, startedAt, reject }
    // Track why the host was killed: 'cancelled' | 'timeout' | null
    // so exit errors are accurate and actionable.
    this.killReason = null;
    this.queue = Promise.resolve();
  }

  ensure(){
    if (this.child && !this.child.killed) return;
    // Reset shared buffer and spawn a new child host. Capture a local
    // reference so event handlers can ignore late events from a stale child.
    this.buffer = '';
    const child = spawn(process.execPath, [HOST_PATH], {
      cwd: this.cwd,
      stdio: ['pipe','pipe','pipe'],
      env: { ...process.env },
      // Make tool-host the leader of a new process group so we can
      // kill the whole group on cancellation/timeout.
      detached: true,
    });
    // New child becomes the current one; reset kill flag for this generation.
    this.child = child;
    this.killReason = null;
    try { registerToolHostPid(this.cwd, child.pid, process.pid); } catch {}
    child.on('exit', (code, sig)=>{
      // Ignore exit events from an older child after a new one has spawned.
      if (this.child !== child) return;
      // Reject all pending requests tied to the current child.
      const reason = this.killReason;
      const err = new Error(reason || 'tool_host_exited');
      if (reason) { console.warn('[ToolHostClient] host exited: reason=' + reason + ' code=' + ((code !== null && code !== undefined) ? code : '') + ' signal=' + (sig || '')); }
      for (const [,p] of this.pending){
        try { if (p?.timeoutHandle) clearTimeout(p.timeoutHandle); } catch {}
        try { p.reject(err); } catch {}
      }
      this.pending.clear();
      // Reject current active call if any
      if (this.active){
        try { this.active.reject?.(err); } catch {}
        this.active = null;
      }
      try { unregisterToolHostPid(this.cwd, child.pid); } catch {}
      this.child = null; this.buffer = '';
      this.killReason = null;
    });
    child.stdout.on('data', (chunk)=>{
      // Ignore stdout from stale children.
      if (this.child !== child) return;
      this.buffer += chunk.toString('utf-8');
      this._drain();
    });
    child.stderr.on('data', (chunk)=>{
      if (this.child !== child) return;
      /* optional debug: console.error('[tool-host]', chunk.toString('utf-8')); */
    });
  }

  _drain(){
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1){
      const line = this.buffer.slice(0, idx); this.buffer = this.buffer.slice(idx+1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const { id, ok, result, error } = msg || {};
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (pending?.timeoutHandle) { try { clearTimeout(pending.timeoutHandle); } catch {} }
      if (this.active && this.active.id === id) this.active = null;
      if (ok) pending.resolve(result);
      else pending.reject(new Error(error?.message || 'error'));
    }
  }

  call(method, params={}, opts={}){
    // Serialize calls to avoid concurrent tool executions in the host.
    // If a call rejects (e.g. cancelled/timeout), do not leave the internal queue
    // rejected or future calls would immediately reject too. Run on both
    // resolve/reject and keep the internal queue as a non-rejecting promise.
    const run = () => this._call(method, params, opts);
    const result = this.queue.then(run, run);   // continue after success or failure
    this.queue = result.catch(()=>{});          // never leave queue rejected
    return result;
  }

  _call(method, params={}, opts={}){
    this.ensure();
    const id = 'req_' + (nextId++);
    const payload = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject)=>{
      const entry = { resolve, reject, timeoutHandle: null };
      this.pending.set(id, entry);
      this.active = { id, method, startedAt: Date.now(), reject };
      try { this.child.stdin.write(payload); } catch (e) { this.pending.delete(id); this.active=null; reject(e); }
      // Optional timeout (ms)
      const timeoutMs = Number(opts.timeoutMs || 0);
      if (timeoutMs > 0){
        // Kill-and-restart on timeout to avoid leaving a stuck worker or
        // overlapping Playwright/browser state. This prevents future calls
        // from wedging behind a hung one.
        entry.timeoutHandle = setTimeout(()=>{
          if (!this.pending.has(id)) return;
          // Remove from pending first to avoid double rejection from exit.
          this.pending.delete(id);
          // Capture start time before clearing active for accurate elapsed.
          const activeStartedAt = (this.active && this.active.id === id) ? this.active.startedAt : undefined;
          // Clear active so status reflects idle; new ensure() will respawn.
          if (this.active && this.active.id === id) this.active = null;
          try { reject(new Error('timeout')); } catch {}
          // Kill the host and let the next call lazily respawn it.
          const elapsed = (activeStartedAt != null) ? (Date.now() - activeStartedAt) : undefined;
          console.warn('[ToolHostClient] kill host (timeout): method=' + method + ' elapsedMs=' + (elapsed != null ? elapsed : 'n/a') + ' timeoutMs=' + timeoutMs);
          this._killHost('timeout');
        }, timeoutMs);
      }
    });
  }

  getStatus(){
    if (this.active){
      return { busy: true, method: this.active.method, elapsedMs: Date.now() - this.active.startedAt };
    }
    return { busy: false };
  }

  async cancelActiveCall(){
    if (!this.child) return false;
    if (!this.active) return false;
    // Kill the current child process group. Immediately detach our reference so
    // subsequent ensure() calls will spawn a fresh host instead of waiting
    // for the dying child to emit 'exit' (child.killed may remain false until exit).
    const elapsed = this.active ? (Date.now() - this.active.startedAt) : undefined;
    const method = (this.active && this.active.method) ? this.active.method : 'unknown';
    console.warn('[ToolHostClient] kill host (cancelled): method=' + method + ' elapsedMs=' + (elapsed != null ? elapsed : 'n/a'));
    this._killHost('cancelled');
    this.child = null;
    this.buffer = '';
    // Proactively reject the active call so callers unblock even if the
    // child's exit event is delayed and thus handlers don't run immediately.
    try {
      const id = this.active?.id;
      if (id && this.pending.has(id)){
        const p = this.pending.get(id);
        this.pending.delete(id);
        try { if (p?.timeoutHandle) clearTimeout(p.timeoutHandle); } catch {}
        try { p.reject(new Error('cancelled')); } catch {}
      }
    } finally {
      this.active = null;
    }
    // New child will be created lazily on next call
    return true;
  }

  // Kill helper: try process group first, then direct child kill.
  _killHost(reason){
    const child = this.child;
    if (!child) return;
    try { unregisterToolHostPid(this.cwd, child.pid); } catch {}
    this.killReason = reason || null;
    // We proactively reject and clear any pending requests here because we
    // drop this.child before the OS delivers the 'exit' event. Our exit
    // handler intentionally ignores children that are no longer current,
    // so it will not reject promises for this killed child. Doing it here
    // guarantees we never leak promises if a buggy client had multiple
    // concurrent calls in-flight.
    const err = new Error(this.killReason || 'killed');
    if (this.pending.size) {
      for (const [, p] of this.pending) {
        try { if (p?.timeoutHandle) clearTimeout(p.timeoutHandle); } catch {}
        try { p.reject(err); } catch {}
      }
      this.pending.clear();
    }
    // Clear the active marker so status reflects idle immediately.
    this.active = null;

    // Drop our reference immediately so ensure() will spawn a fresh host
    // even if the OS has not reported the child exit yet.
    this.child = null;
    this.buffer = '';
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

export default { ToolHostClient };
