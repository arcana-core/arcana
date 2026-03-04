// Core service manager: auto-starts services in <workspaceRoot>/services.
//
// Goals
// - Make background operations auditable: every long-running process should live in ./services
// - Default behavior: start all services in ./services on Arcana startup
// - Allow runtime management (reload/start/stop/restart) without restarting Arcana
//
// Service module contract
// - A service module is an ESM file exporting either:
//   - `export async function start(ctx) { ... }`, or
//   - `export default async function(ctx) { ... }`
// - start() may return a handle object with optional `stop()`.
//
// ctx = { workspaceRoot, servicePath, serviceId, logDir }
// Logs
// - Manager logs are appended to: <workspaceRoot>/.arcana/services/<serviceId>/manager.log

import { join, basename, extname } from "node:path";
import { promises as fsp } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveWorkspaceRoot } from "../workspace-guard.js";

const state = {
  started: false,
  workspaceRoot: undefined,
  services: new Map(), // serviceId -> { id, path, logDir, status, startedAt, error, handle, stop }
  hooksInstalled: false,
};

function now() { return new Date().toISOString(); }

async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }

async function appendLog(logFile, message) {
  try {
    await fsp.appendFile(logFile, "[" + now() + "] " + message + "\n", "utf-8");
  } catch {
    // ignore
  }
}

function serviceIdFromFilename(file) {
  const b = basename(file);
  const e = extname(b);
  return b.slice(0, b.length - e.length);
}

async function scanServiceFiles(workspaceRoot) {
  const servicesDir = join(workspaceRoot, "services");
  try {
    const entries = await fsp.readdir(servicesDir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const name = e.name;
      if (name.endsWith(".js") || name.endsWith(".mjs")) files.push(join(servicesDir, name));
    }
    return files.sort();
  } catch {
    // directory missing is fine
    return [];
  }
}

async function startOne(filePath, workspaceRoot) {
  const id = serviceIdFromFilename(filePath);
  const logDir = join(workspaceRoot, ".arcana", "services", id);
  await ensureDir(logDir);
  const managerLog = join(logDir, "manager.log");

  const entry = {
    id,
    path: filePath,
    logDir,
    status: "starting",
    startedAt: Date.now(),
    error: null,
    handle: null,
    stop: null,
  };
  state.services.set(id, entry);

  await appendLog(managerLog, "starting service id=" + id + " file=" + filePath);
  try {
    const href = pathToFileURL(filePath).href + "?v=" + String(entry.startedAt);
    const mod = await import(href);
    const starter =
      (mod && typeof mod.start === "function") ? mod.start :
        (mod && typeof mod.default === "function") ? mod.default :
          null;

    if (!starter) {
      entry.status = "skipped";
      await appendLog(managerLog, "no start() or default export function. skipping.");
      return;
    }

    const ctx = { workspaceRoot, servicePath: filePath, serviceId: id, logDir };
    const handle = await starter(ctx);
    entry.handle = handle || null;
    entry.stop = (handle && typeof handle.stop === "function") ? handle.stop.bind(handle) : null;
    entry.status = "running";
    await appendLog(managerLog, "started service id=" + id + (entry.stop ? " (with stop())" : ""));
  } catch (err) {
    entry.status = "error";
    entry.error = String(err && err.stack ? err.stack : err);
    await appendLog(managerLog, "error starting service id=" + id + ": " + entry.error);
  }
}

async function stopOne(id, reason) {
  const s = state.services.get(id);
  if (!s) return { ok: false, error: "unknown_service" };
  const logFile = join(s.logDir, "manager.log");

  if (typeof s.stop !== "function") {
    await appendLog(logFile, "stop requested but service has no stop() id=" + id + " reason=" + (reason || ""));
    return { ok: false, error: "no_stop" };
  }

  await appendLog(logFile, "stopping service id=" + id + " reason=" + (reason || ""));
  try {
    const res = s.stop();
    if (res && typeof res.then === "function") await res;
    s.status = "stopped";
    await appendLog(logFile, "stopped service id=" + id);
    return { ok: true };
  } catch (e) {
    await appendLog(logFile, "error while stopping id=" + id + ": " + String(e && e.stack ? e.stack : e));
    return { ok: false, error: "stop_failed" };
  }
}

async function stopAll(reason) {
  const tasks = [];
  for (const [id] of state.services) {
    tasks.push(stopOne(id, reason));
  }
  try { await Promise.allSettled(tasks); } catch { /* ignore */ }
}

function installHooksOnce() {
  if (state.hooksInstalled) return;
  state.hooksInstalled = true;

  const onSig = function (sig) {
    try { process.removeListener("SIGINT", onSigWrappedSIGINT); } catch { }
    try { process.removeListener("SIGTERM", onSigWrappedSIGTERM); } catch { }
    stopAll(sig).finally(function () {
      // Let default behavior continue
      try { if (sig === "SIGINT") process.kill(process.pid, "SIGINT"); } catch { }
      try { if (sig === "SIGTERM") process.kill(process.pid, "SIGTERM"); } catch { }
    });
  };
  const onExit = function () { stopAll("exit"); };
  const onSigWrappedSIGINT = function () { onSig("SIGINT"); };
  const onSigWrappedSIGTERM = function () { onSig("SIGTERM"); };

  try { process.once("SIGINT", onSigWrappedSIGINT); } catch { }
  try { process.once("SIGTERM", onSigWrappedSIGTERM); } catch { }
  try { process.once("exit", onExit); } catch { }
}

export async function startServicesOnce({ workspaceRoot } = {}) {
  if (state.started) return getServicesStatus();

  const root = workspaceRoot || resolveWorkspaceRoot();
  state.workspaceRoot = root;
  state.started = true; // mark started early to avoid re-entrancy
  installHooksOnce();

  const files = await scanServiceFiles(root);
  for (const file of files) {
    await startOne(file, root);
  }

  return getServicesStatus();
}

export async function reloadServices({ workspaceRoot } = {}) {
  const root = workspaceRoot || state.workspaceRoot || resolveWorkspaceRoot();
  state.workspaceRoot = root;

  if (!state.started) {
    // First-time load
    return startServicesOnce({ workspaceRoot: root });
  }

  installHooksOnce();

  const files = await scanServiceFiles(root);
  for (const file of files) {
    const id = serviceIdFromFilename(file);
    const existing = state.services.get(id);
    if (!existing) {
      await startOne(file, root);
      continue;
    }
    // If a service errored during initial start, allow reload to retry after the user fixes dependencies/env.
    if (existing.status === "error") {
      await startOne(file, root);
      continue;
    }
  }

  return getServicesStatus();
}

export async function startService({ id, workspaceRoot } = {}) {
  const root = workspaceRoot || state.workspaceRoot || resolveWorkspaceRoot();
  state.workspaceRoot = root;
  installHooksOnce();

  if (!id) throw new Error("service id required");
  if (state.services.has(id)) return getServicesStatus();

  const candidates = [join(root, "services", id + ".mjs"), join(root, "services", id + ".js")];
  let found = null;
  for (const p of candidates) {
    try {
      const st = await fsp.stat(p);
      if (st && st.isFile()) { found = p; break; }
    } catch { }
  }
  if (!found) throw new Error("service not found: " + id);

  state.started = true; // treat as started once user explicitly starts
  await startOne(found, root);
  return getServicesStatus();
}

export async function stopService({ id, reason } = {}) {
  if (!id) throw new Error("service id required");
  await stopOne(id, reason || "tool");
  return getServicesStatus();
}

export async function restartService({ id } = {}) {
  if (!id) throw new Error("service id required");
  const s = state.services.get(id);
  if (!s) throw new Error("unknown service: " + id);

  const root = state.workspaceRoot || resolveWorkspaceRoot();
  await stopOne(id, "restart");
  // If the service module path was replaced on disk with a new one of the same id,
  // we still use the stored path. Users can delete + reload to pick up a rename.
  await startOne(s.path, root);
  return getServicesStatus();
}

export function getServicesStatus() {
  const services = [];
  for (const [, s] of state.services) {
    services.push({
      id: s.id,
      path: s.path,
      logDir: s.logDir,
      status: s.status,
      startedAt: s.startedAt,
      error: s.error,
    });
  }
  return {
    started: state.started,
    workspaceRoot: state.workspaceRoot,
    count: services.length,
    services,
  };
}

export default {
  startServicesOnce,
  reloadServices,
  startService,
  stopService,
  restartService,
  getServicesStatus,
};
