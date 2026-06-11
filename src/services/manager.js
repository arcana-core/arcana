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
import { promises as fsp, readFileSync, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolveWorkspaceRoot } from "../workspace-guard.js";
import { createServiceProcess } from "./service-supervisor.js";

const SERVICE_CHILD_PATH = fileURLToPath(new URL("./service-child.js", import.meta.url));

const state = {
  started: false,
  workspaceRoot: undefined,
  services: new Map(), // serviceId -> { id, path, logDir, mode, status?, proc?, startedAt, error, handle, stop }
  config: {}, // per-service isolation/resource config from services.config.json
  hooksInstalled: false,
};

function refreshServiceConfig(workspaceRoot) {
  const roots = [workspaceRoot];
  const bundledRoot = getBundledRoot();
  if (bundledRoot) roots.push(bundledRoot);
  state.config = loadServiceConfig(roots);
  return state.config;
}

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

export function normalizeServiceId(id) {
  const raw = String(id || "").trim();
  if (raw === "tool-daemon") return "tool_daemon";
  return raw;
}

// Global default isolation mode. Defaults to 'in-process' so existing services
// (some rely on the gateway's in-process event bus / shared state) are
// unaffected. Operators harden a deployment by setting
// ARCANA_SERVICE_ISOLATION=process, then opt specific services back to
// in-process via services.config.json when they need shared state.
function globalIsolationDefault() {
  try {
    const raw = String(process.env.ARCANA_SERVICE_ISOLATION || "").trim().toLowerCase();
    if (raw === "process" || raw === "child" || raw === "isolated") return "process";
    return "in-process";
  } catch {
    return "in-process";
  }
}

// Optional per-service config, merged from <workspaceRoot>/services/services.config.json
// and (if enabled) <bundledRoot>/services/services.config.json.
// Shape: { "<serviceId>": { isolation, memoryLimitMB, restart, maxRestarts,
//          heartbeatTimeoutMs, ... } }
export function loadServiceConfig(roots) {
  const out = {};
  const dirs = Array.isArray(roots) ? roots : [roots];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = join(dir, "services", "services.config.json");
    try {
      if (!existsSync(p)) continue;
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object") {
        const map = (parsed.services && typeof parsed.services === "object") ? parsed.services : parsed;
        for (const [k, v] of Object.entries(map)) {
          if (v && typeof v === "object") out[normalizeServiceId(k)] = v;
        }
      }
    } catch {
      // malformed config is non-fatal; fall back to defaults
    }
  }
  return out;
}

export function resolveServiceOptions(id, config) {
  const cfg = (config && typeof config === "object" && config[normalizeServiceId(id)]) || {};
  const isolationRaw = String(cfg.isolation || "").trim().toLowerCase();
  let isolation;
  if (isolationRaw === "process" || isolationRaw === "child" || isolationRaw === "isolated") isolation = "process";
  else if (isolationRaw === "in-process" || isolationRaw === "inprocess" || isolationRaw === "shared") isolation = "in-process";
  else isolation = globalIsolationDefault();
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
  return {
    isolation,
    memoryLimitMB: num(cfg.memoryLimitMB, 0),
    restart: cfg.restart === false ? false : true,
    maxRestarts: num(cfg.maxRestarts, 5),
    heartbeatTimeoutMs: num(cfg.heartbeatTimeoutMs, 10000),
    memoryLimitMBRaw: cfg.memoryLimitMB,
  };
}

function isBundledServicesEnabled() {
  try {
    const raw = String(process.env.ARCANA_ENABLE_BUNDLED_SERVICES || "").trim().toLowerCase();
    if (!raw) return false;
    if (raw === "0" || raw === "false" || raw === "no") return false;
    return true;
  } catch {
    return false;
  }
}

function getBundledRoot() {
  if (!isBundledServicesEnabled()) return null;
  const root = process.env.ARCANA_BUNDLED_ROOT;
  if (!root) return null;
  return root;
}

async function scanServicesDir(servicesDir) {
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

async function scanServiceFiles(workspaceRoot) {
  const servicesDir = join(workspaceRoot, "services");
  return scanServicesDir(servicesDir);
}

async function scanBundledServiceFiles() {
  const bundledRoot = getBundledRoot();
  if (!bundledRoot) return [];
  const servicesDir = join(bundledRoot, "services");
  return scanServicesDir(servicesDir);
}

async function scanAllServiceFiles(workspaceRoot) {
  const workspaceFiles = await scanServiceFiles(workspaceRoot);
  const bundledFiles = await scanBundledServiceFiles();
  if (!bundledFiles.length) return workspaceFiles;

  const seen = new Set();
  for (const file of workspaceFiles) {
    seen.add(serviceIdFromFilename(file));
  }

  const all = workspaceFiles.slice();
  for (const file of bundledFiles) {
    const id = serviceIdFromFilename(file);
    if (!seen.has(id)) all.push(file);
  }

  return all;
}

async function startOneIsolated(filePath, workspaceRoot, opts) {
  const id = serviceIdFromFilename(filePath);
  const logDir = join(workspaceRoot, ".arcana", "services", id);
  await ensureDir(logDir);
  const managerLog = join(logDir, "manager.log");
  const serviceLog = join(logDir, "service.log");

  await appendLog(managerLog, "starting isolated service id=" + id + " file=" + filePath
    + (opts.memoryLimitMB ? (" memoryLimitMB=" + opts.memoryLimitMB) : ""));

  const proc = createServiceProcess({
    id,
    servicePath: filePath,
    ctx: { workspaceRoot, servicePath: filePath, serviceId: id, logDir },
    logFile: serviceLog,
    childPath: SERVICE_CHILD_PATH,
    memoryLimitMB: opts.memoryLimitMB,
    restart: opts.restart,
    maxRestarts: opts.maxRestarts,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
    onLog: (level, msg) => { appendLog(managerLog, "[" + level + "] " + msg).catch(() => {}); },
  });

  const entry = {
    id,
    path: filePath,
    logDir,
    mode: "process",
    proc,
    startedAt: Date.now(),
    handle: null,
    stop: null,
  };
  state.services.set(id, entry);
  proc.start();
}

async function startOne(filePath, workspaceRoot) {
  const id = serviceIdFromFilename(filePath);
  const options = resolveServiceOptions(id, state.config);
  if (options.isolation === "process") {
    return startOneIsolated(filePath, workspaceRoot, options);
  }

  const logDir = join(workspaceRoot, ".arcana", "services", id);
  await ensureDir(logDir);
  const managerLog = join(logDir, "manager.log");

  const entry = {
    id,
    path: filePath,
    logDir,
    mode: "in-process",
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
    const STARTUP_TIMEOUT_MS = 30000;
    const startPromise = starter(ctx);
    const TIMEOUT = Symbol("timeout");
    const result = await Promise.race([
      startPromise.then(function(h){ return { handle: h }; }),
      new Promise(function(resolve){ setTimeout(function(){ resolve(TIMEOUT); }, STARTUP_TIMEOUT_MS); })
    ]);

    if (result === TIMEOUT) {
      entry.status = "timeout";
      await appendLog(managerLog, "service start() timed out after " + String(STARTUP_TIMEOUT_MS / 1000) + "s id=" + id + " (continuing to next service)");
      // If the promise eventually resolves, attach the handle
      startPromise.then(function(handle) {
        entry.handle = handle || null;
        entry.stop = (handle && typeof handle.stop === "function") ? handle.stop.bind(handle) : null;
        entry.status = "running";
        appendLog(managerLog, "service eventually started (after timeout) id=" + id).catch(function(){});
      }).catch(function(err) {
        entry.status = "error";
        entry.error = String(err && err.stack ? err.stack : err);
        appendLog(managerLog, "service start() failed after timeout id=" + id + ": " + entry.error).catch(function(){});
      });
      return;
    }

    var handle = result.handle;
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

  if (s.mode === "process" && s.proc) {
    await appendLog(logFile, "stopping isolated service id=" + id + " reason=" + (reason || ""));
    try {
      await s.proc.stop({ timeoutMs: 6000 });
      await appendLog(logFile, "stopped isolated service id=" + id);
      return { ok: true };
    } catch (e) {
      await appendLog(logFile, "stop error id=" + id + ": " + String(e && e.stack ? e.stack : e));
      return { ok: true, warning: String(e && e.message ? e.message : e) };
    }
  }

  if (typeof s.stop !== "function") {
    await appendLog(logFile, "stop requested but service has no stop() id=" + id + " reason=" + (reason || ""));
    return { ok: false, error: "no_stop" };
  }

  await appendLog(logFile, "stopping service id=" + id + " reason=" + (reason || ""));
  try {
    const res = s.stop();
    if (res && typeof res.then === "function") {
      const STOP_TIMEOUT = 5000;
      const timeout = new Promise(function (_, rej) {
        setTimeout(function () { rej(new Error("stop() timed out after " + STOP_TIMEOUT + "ms")); }, STOP_TIMEOUT);
      });
      await Promise.race([res, timeout]);
    }
    s.status = "stopped";
    await appendLog(logFile, "stopped service id=" + id);
    return { ok: true };
  } catch (e) {
    s.status = "stopped";
    await appendLog(logFile, "stop error (force-marked stopped) id=" + id + ": " + String(e && e.stack ? e.stack : e));
    return { ok: true, warning: String(e && e.message ? e.message : e) };
  }
}

async function stopAll(reason) {
  const tasks = [];
  for (const [id] of state.services) {
    tasks.push(stopOne(id, reason));
  }
  try { await Promise.allSettled(tasks); } catch { /* ignore */ }
  state.started = false;
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
  try {
    const disabled = String(process.env.ARCANA_DISABLE_CORE_SERVICES || "").trim().toLowerCase();
    if (disabled === "1" || disabled === "true" || disabled === "yes" || disabled === "on") {
      state.started = true;
      return getServicesStatus();
    }
  } catch {}

  const root = workspaceRoot || resolveWorkspaceRoot();
  state.workspaceRoot = root;
  state.started = true; // mark started early to avoid re-entrancy
  refreshServiceConfig(root);
  installHooksOnce();

  const files = await scanAllServiceFiles(root);
  for (const file of files) {
    await startOne(file, root);
  }

  return getServicesStatus();
}

// Unified status string across in-process ('status' field) and isolated
// ('proc.status().status') entries.
function entryStatus(s) {
  if (!s) return "";
  if (s.mode === "process" && s.proc) {
    try { return s.proc.status().status; } catch { return ""; }
  }
  return s.status || "";
}

export async function reloadServices({ workspaceRoot } = {}) {
  const root = workspaceRoot || state.workspaceRoot || resolveWorkspaceRoot();
  state.workspaceRoot = root;

  if (!state.started) {
    // First-time load
    return startServicesOnce({ workspaceRoot: root });
  }

  refreshServiceConfig(root);
  installHooksOnce();

  const files = await scanAllServiceFiles(root);
  for (const file of files) {
    const id = serviceIdFromFilename(file);
    const existing = state.services.get(id);
    if (!existing) {
      await startOne(file, root);
      continue;
    }
    // Restart entries that are no longer live (stopped, errored, or an
    // isolated service that exhausted its crash budget).
    const st = entryStatus(existing);
    if (st === "stopped" || st === "error" || st === "crashed") {
      await startOne(file, root);
      continue;
    }
  }

  return getServicesStatus();
}

export async function startService({ id, workspaceRoot } = {}) {
  const root = workspaceRoot || state.workspaceRoot || resolveWorkspaceRoot();
  state.workspaceRoot = root;
  refreshServiceConfig(root);
  installHooksOnce();

  id = normalizeServiceId(id);
  if (!id) throw new Error("service id required");
  // A live entry is left alone; a dead one (stopped/crashed) is cleared so it
  // can be re-created below.
  if (state.services.has(id)) {
    const st = entryStatus(state.services.get(id));
    if (st !== "stopped" && st !== "crashed" && st !== "error") return getServicesStatus();
    state.services.delete(id);
  }

  const candidates = [join(root, "services", id + ".mjs"), join(root, "services", id + ".js")];
  if (isBundledServicesEnabled()) {
    const bundledRoot = getBundledRoot();
    if (bundledRoot) {
      candidates.push(join(bundledRoot, "services", id + ".mjs"));
      candidates.push(join(bundledRoot, "services", id + ".js"));
    }
  }
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
  id = normalizeServiceId(id);
  if (!id) throw new Error("service id required");
  await stopOne(id, reason || "tool");
  return getServicesStatus();
}

export async function restartService({ id } = {}) {
  id = normalizeServiceId(id);
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
    if (s.mode === "process" && s.proc) {
      let ps = {};
      try { ps = s.proc.status(); } catch {}
      services.push({
        id: s.id,
        path: s.path,
        logDir: s.logDir,
        mode: "process",
        status: ps.status || "unknown",
        startedAt: ps.startedAt || s.startedAt,
        error: ps.error || null,
        restarts: ps.restarts || 0,
        pid: ps.pid || null,
        lastHeartbeatAt: ps.lastHeartbeatAt || null,
      });
      continue;
    }
    services.push({
      id: s.id,
      path: s.path,
      logDir: s.logDir,
      mode: s.mode || "in-process",
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
  normalizeServiceId,
  startServicesOnce,
  reloadServices,
  startService,
  stopService,
  restartService,
  getServicesStatus,
};
