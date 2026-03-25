// Tool Daemon service entry.
// Spawns a detached child process that runs the HTTP tool daemon out-of-process.

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createWriteStream, promises as fsp } from "node:fs";
import { ensureToolDaemonAuth } from "../src/tool-daemon/auth.js";
import { readState } from "../src/tool-daemon/state.js";

function hashToPort(input){
  // Deterministic unprivileged port: sha256(input) mapped to [43100,43999].
  const h = createHash("sha256").update(String(input||""), "utf8").digest();
  const n = (h[0] << 8) | h[1];
  const base = 43100; const span = 900;
  return base + (n % span);
}

async function httpGet(url, headers){
  try {
    const res = await fetch(url, { method: "GET", headers: headers||{} });
    let text = "";
    try { text = await res.text(); } catch { text = ""; }
    const out = { ok: res.ok, status: res.status };
    if (text && text.length){
      out.text = text;
      try { out.json = JSON.parse(text); } catch {}
    }
    return out;
  } catch {
    return { ok:false, status: 0 };
  }
}

async function terminatePidTree(pid){
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return;
  const pgid = -Math.abs(n);
  try { process.kill(pgid, "SIGTERM"); } catch {}
  try { await new Promise((r)=>setTimeout(r, 400)); } catch {}
  try { process.kill(pgid, "SIGKILL"); } catch {}
  try { process.kill(n, "SIGTERM"); } catch {}
  try { await new Promise((r)=>setTimeout(r, 400)); } catch {}
  try { process.kill(n, "SIGKILL"); } catch {}
}

function buildChildEnv(extra){
  const baseEnv = { ...process.env, ...(extra || {}) };
  try {
    if (process.versions && Object.prototype.hasOwnProperty.call(process.versions, "electron")){
      if (!baseEnv.ELECTRON_RUN_AS_NODE){
        baseEnv.ELECTRON_RUN_AS_NODE = "1";
      }
    }
  } catch {}
  return baseEnv;
}

function pathToEntry(){
  // services/tool_daemon.mjs -> arcana/services. Entry at arcana/src/tool-daemon/entry.js
  const here = fileURLToPath(new URL(".", import.meta.url));
  const root = join(here, "..");
  return join(root, "src", "tool-daemon", "entry.js");
}

function writeSupervisorLog(stream, message){
  if (!message) return;
  const line = "[tool-daemon-supervisor] " + String(message) + "\n";
  if (stream){
    try { stream.write(line); } catch {}
  } else {
    try { process.stderr.write(line); } catch {}
  }
}

function runSyntaxPreflight(entryPath, logStream, logPath, env){
  const res = spawnSync(process.execPath, ["--check", entryPath], { encoding: "utf8", env: env || buildChildEnv() });
  const status = typeof res.status === "number" ? res.status : 0;
  const stderr = res && typeof res.stderr === "string" ? res.stderr : "";
  if (status !== 0){
    writeSupervisorLog(logStream, "node --check failed for " + entryPath);
    if (stderr && stderr.length){
      try { if (logStream) logStream.write(stderr + "\n"); } catch {}
    }
    const errMsg = "Tool daemon syntax check failed. See log: " + logPath +
      " (node --check stderr: " + (stderr || "no stderr") + ")";
    const err = new Error(errMsg);
    err.code = "TOOL_DAEMON_SYNTAX_ERROR";
    throw err;
  }
}

export async function start(ctx){
  const workspaceRoot = ctx && ctx.workspaceRoot ? String(ctx.workspaceRoot) : process.cwd();
  // Ensure log directory exists early so we can write child output.
  try { await fsp.mkdir(ctx.logDir, { recursive: true }); } catch {}
  const { token } = await ensureToolDaemonAuth({ workspaceRoot });
  const port = hashToPort(workspaceRoot);
  const base = "http://127.0.0.1:" + String(port);
  const logPath = join(ctx.logDir || ".", "daemon.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  const env = { ...process.env, ARCANA_TOOL_DAEMON_WORKSPACE_ROOT: workspaceRoot, ARCANA_TOOL_DAEMON_PORT: String(port) };
  const entry = pathToEntry();
  const childEnv = buildChildEnv(env);

  let child = null;
  let probeTimer = null;
  let restartTimer = null;
  let stopped = false;
  let consecutiveProbeFailures = 0;
  let backoffMs = 1000;
  const maxBackoffMs = 5000;
  const maxProbeFailures = 3;
  let hasEverBeenReady = false;

  function attachChildStreams(proc){
    if (!proc) return;
    try {
      if (proc.stdout) proc.stdout.on("data", function(d){
        try { logStream.write(d); } catch {}
      });
      if (proc.stderr) proc.stderr.on("data", function(d){
        try { logStream.write(d); } catch {}
      });
      proc.on("close", function(code, signal){
        try {
          const msg = "child exit code=" + String(code) + " signal=" + String(signal);
          writeSupervisorLog(logStream, msg);
        } catch {}
        if (!stopped && hasEverBeenReady){
          scheduleRestart("child-exit");
        }
      });
    } catch {}
  }

  async function spawnAndWaitReady(label){
    if (stopped) return;
    writeSupervisorLog(logStream, "starting daemon (" + label + ")");
    runSyntaxPreflight(entry, logStream, logPath, childEnv);

    if (child && child.pid){
      try { await terminatePidTree(child.pid); } catch {}
    }

    try {
      const state = await readState({ workspaceRoot });
      const existingPid = state && state.pid ? Number(state.pid) : 0;
      if (existingPid > 0 && (!child || existingPid !== child.pid)){
        await terminatePidTree(existingPid);
      }
    } catch {}

    const proc = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore","pipe","pipe"], env: childEnv });
    child = proc;
    attachChildStreams(proc);
    try { proc.unref(); } catch {}

    const deadline = Date.now() + 15000;
    let ready = false;
    let lastProbe = null;
    while (!stopped && Date.now() < deadline){
      const p = await httpGet(base + "/status", { authorization: "Bearer " + token });
      if (p) lastProbe = p;
      if (p && p.ok){ ready = true; break; }
      await new Promise(function(r){ setTimeout(r, 150); });
    }

    if (!ready){
      const lastStatus = lastProbe && typeof lastProbe.status === "number" ? String(lastProbe.status) : "unknown";
      writeSupervisorLog(logStream, "readiness failed for " + base + " lastProbeStatus=" + lastStatus);
      if (proc && proc.pid){
        try { await terminatePidTree(proc.pid); } catch {}
      }
      const errMsg = "Tool daemon failed readiness probe within 15s at " + base +
        " (port=" + String(port) + ") lastProbeStatus=" + lastStatus + " - see log: " + logPath;
      throw new Error(errMsg);
    }

    hasEverBeenReady = true;
    consecutiveProbeFailures = 0;
    backoffMs = 1000;
  }

  function startProbes(){
    if (probeTimer || stopped) return;
    const intervalMs = 3000;
    probeTimer = setInterval(function(){
      if (stopped) return;
      httpGet(base + "/status", { authorization: "Bearer " + token }).then(function(p){
        if (stopped) return;
        if (p && p.ok){
          consecutiveProbeFailures = 0;
          return;
        }
        consecutiveProbeFailures += 1;
        if (consecutiveProbeFailures >= maxProbeFailures){
          writeSupervisorLog(logStream, "status probe failed " + String(consecutiveProbeFailures) + " times");
          scheduleRestart("status-probe-failures");
        }
      }).catch(function(){
        if (stopped) return;
        consecutiveProbeFailures += 1;
        if (consecutiveProbeFailures >= maxProbeFailures){
          writeSupervisorLog(logStream, "status probe error");
          scheduleRestart("status-probe-error");
        }
      });
    }, intervalMs);
  }

  function scheduleRestart(reason){
    if (stopped) return;
    if (restartTimer) return;
    if (probeTimer){
      try { clearInterval(probeTimer); } catch {}
      probeTimer = null;
    }
    const delay = backoffMs;
    writeSupervisorLog(logStream, "scheduling restart in " + String(delay) + "ms (reason=" + reason + ")");
    restartTimer = setTimeout(function(){
      restartTimer = null;
      if (stopped) return;
      spawnAndWaitReady("restart-" + reason).then(function(){
        if (stopped) return;
        startProbes();
      }).catch(function(err){
        if (stopped) return;
        const msg = "restart failed: " + (err && err.message ? err.message : String(err));
        writeSupervisorLog(logStream, msg);
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        scheduleRestart("restart-failed");
      });
    }, delay);
  }

  // Probe existing daemon. If it is already healthy, attach supervisor
  // without spawning a new child; otherwise, clean up any recorded PID
  // and spawn a fresh daemon.
  const probe1 = await httpGet(base + "/status", { authorization: "Bearer " + token });
  if (probe1 && probe1.ok){
    hasEverBeenReady = true;
    consecutiveProbeFailures = 0;
  } else {
    if (probe1 && !probe1.ok && typeof probe1.status === "number" && probe1.status > 0){
      try {
        const state = await readState({ workspaceRoot });
        const existingPid = state && state.pid ? Number(state.pid) : 0;
        if (existingPid > 0){ await terminatePidTree(existingPid); }
      } catch {}
    }

    await spawnAndWaitReady("initial");
  }

  startProbes();

  return {
    stop: async function(){
      stopped = true;
      if (probeTimer){
        try { clearInterval(probeTimer); } catch {}
        probeTimer = null;
      }
      if (restartTimer){
        try { clearTimeout(restartTimer); } catch {}
        restartTimer = null;
      }
      if (child && child.pid){
        try { await terminatePidTree(child.pid); } catch {}
      }
      try {
        const state = await readState({ workspaceRoot });
        const existingPid = state && state.pid ? Number(state.pid) : 0;
        if (existingPid > 0 && (!child || existingPid !== child.pid)){
          await terminatePidTree(existingPid);
        }
      } catch {}
      try { writeSupervisorLog(logStream, "stop() called, supervisor shutting down"); } catch {}
      try { logStream.end(); } catch {}
    }
  };
}

export default { start };
