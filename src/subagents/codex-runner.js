import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { emit as emitEvent } from "../event-bus.js";

// Codex CLI subagent runner with per-task session continuity and streaming events.
export class CodexRunner {
  constructor(options = {}){
    this.cwd = options.cwd || process.cwd();
    this.cacheDir = options.cacheDir || join(this.cwd, "arcana", ".cache", "codex");
    this.homeDir = (Object.prototype.hasOwnProperty.call(options, 'homeDir') ? options.homeDir : null); // used as CODEX_HOME
    this.mapFile = join(this.cacheDir, "sessions.json");
    this.ensureDirs();
  }

  ensureDirs(){ try { mkdirSync(this.cacheDir, { recursive: true }); } catch {} }

  get env(){ const env = { ...process.env }; if (this.homeDir) env.CODEX_HOME = this.homeDir; return env; }

  taskKey(task){ const h = createHash("sha1"); h.update(String(task||"")); return h.digest("hex").slice(0,16); }

  readMap(){ try { if (existsSync(this.mapFile)) return JSON.parse(readFileSync(this.mapFile,"utf-8")); } catch {} return {}; }
  writeMap(map){ try { writeFileSync(this.mapFile, JSON.stringify(map,null,2)); } catch {} }

  getSessionForTask(task){ const key = this.taskKey(task); const map = this.readMap(); return { key, id: map[key]?.id || null }; }
  saveSessionForTask(task, sessionId){ const key=this.taskKey(task); const map=this.readMap(); map[key]={ id:sessionId, savedAt:Date.now() }; this.writeMap(map); }

  // Spawn child, stream stdout/stderr via eventBus, collect result
  spawnCollect(cmd, args, opts={}, meta={}){
    return new Promise((resolveP)=>{
      const child = spawn(cmd, args, { cwd: this.cwd, env: this.env, stdio: ["ignore","pipe","pipe"] });
      const captureMax = (function(){
        try {
          const raw = process.env.ARCANA_CODEX_CAPTURE_MAX;
          if (!raw) return 200000;
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) return 200000;
          return Math.floor(n);
        } catch { return 200000; }
      })();
      let stdout = ""; let stderr = "";
      const id = meta.id || (Date.now() + "-" + Math.random().toString(36).slice(2,8));
      const toolCallId = meta.toolCallId || null;
      const toolName = meta.toolName || "codex";
      const useToolEvents = !!toolCallId;
      const throttleMs = 50;
      const maxStreamChunk = 16000;
      let stdoutBuf = "";
      let stderrBuf = "";
      let stdoutTimer = null;
      let stderrTimer = null;

      const flushStdoutNow = () => {
        if (!useToolEvents) return;
        if (stdoutTimer){ try { clearTimeout(stdoutTimer); } catch {} stdoutTimer = null; }
        if (!stdoutBuf) return;
        let chunk = stdoutBuf;
        stdoutBuf = "";
        if (chunk.length > maxStreamChunk) chunk = chunk.slice(-maxStreamChunk);
        emitEvent({
          type: "tool_execution_update",
          toolCallId,
          toolName,
          partialResult: { stream: "stdout", chunk },
        });
      };

      const flushStderrNow = () => {
        if (!useToolEvents) return;
        if (stderrTimer){ try { clearTimeout(stderrTimer); } catch {} stderrTimer = null; }
        if (!stderrBuf) return;
        let chunk = stderrBuf;
        stderrBuf = "";
        if (chunk.length > maxStreamChunk) chunk = chunk.slice(-maxStreamChunk);
        emitEvent({
          type: "tool_execution_update",
          toolCallId,
          toolName,
          partialResult: { stream: "stderr", chunk },
        });
      };

      const scheduleStdoutFlush = () => {
        if (!useToolEvents) return;
        if (stdoutTimer) return;
        stdoutTimer = setTimeout(() => { stdoutTimer = null; flushStdoutNow(); }, throttleMs);
        try { stdoutTimer.unref && stdoutTimer.unref(); } catch {}
      };

      const scheduleStderrFlush = () => {
        if (!useToolEvents) return;
        if (stderrTimer) return;
        stderrTimer = setTimeout(() => { stderrTimer = null; flushStderrNow(); }, throttleMs);
        try { stderrTimer.unref && stderrTimer.unref(); } catch {}
      };

      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (useToolEvents){
          flushStdoutNow();
          flushStderrNow();
        } else {
          if (code !== 0) {
            try {
              emitEvent({ type: "subagent_error", id, code, stderr: String(stderr||"").slice(-2000) });
            } catch (e) {}
          }
          emitEvent({ type: "subagent_end", id, code, ok: code===0 });
        }
        resolveP({ code, stdout, stderr, id });
      };

      if (!useToolEvents){
        emitEvent({ type: "subagent_start", id, agent: "codex", args });
      }

      child.stdout.on("data", (d)=>{
        const s = String(d);
        stdout += s;
        if (stdout.length > captureMax) stdout = stdout.slice(-captureMax);
        if (useToolEvents){
          stdoutBuf += s;
          scheduleStdoutFlush();
        } else {
          emitEvent({ type: "subagent_stream", id, stream: "stdout", chunk: s });
        }
      });

      child.stderr.on("data", (d)=>{
        const s = String(d);
        stderr += s;
        if (stderr.length > captureMax) stderr = stderr.slice(-captureMax);
        if (useToolEvents){
          stderrBuf += s;
          scheduleStderrFlush();
        } else {
          emitEvent({ type: "subagent_stream", id, stream: "stderr", chunk: s });
        }
      });

      child.on("error", (err)=>{
        try {
          const msg = String((err && err.message) || err || "");
          if (msg) {
            stderr += (stderr ? "\n" : "") + msg;
            if (stderr.length > captureMax) stderr = stderr.slice(-captureMax);
          }
        } catch {}
        finish(null);
      });

      child.on("close", (code)=>{ finish(code); });
    });
  }

  buildExecArgs({ prompt, allowedPaths, fullAuto=true }){
    const args = ["exec", "--json", "--skip-git-repo-check", "--cd", this.cwd];
    if (fullAuto) args.push("--full-auto");
    for (const p of (allowedPaths||[])){ const abs=resolve(this.cwd,p); args.push("--add-dir", abs); }
    if (prompt && prompt!=="-") args.push(prompt);
    // Decoupled from ARCANA_EXEC_POLICY; use dedicated ARCANA_CODEX_POLICY
    const policy = String(process.env.ARCANA_CODEX_POLICY||'').toLowerCase();
    if (policy === "open") args.push("--dangerously-bypass-approvals-and-sandbox");
    return args;
  }

  async runNewSession({ prompt, allowedPaths, toolCallId, toolName }){
    const args = this.buildExecArgs({ prompt, allowedPaths, fullAuto: true });
    const meta = { id: `codex-run-${Date.now()}` };
    if (toolCallId) meta.toolCallId = toolCallId;
    if (toolName) meta.toolName = toolName;
    const res = await this.spawnCollect("codex", args, {}, meta);
    const id = this.extractSessionId(res.stdout) || this.extractSessionId(res.stderr);
    return { id, ...res };
  }

  async resumeSession(sessionId, { prompt, allowedPaths, toolCallId, toolName }){
    const base = ["exec", "resume", sessionId, "--json", "--skip-git-repo-check", "--cd", this.cwd];
    const policy2 = String(process.env.ARCANA_CODEX_POLICY||'').toLowerCase();
    if (policy2 === 'open') base.push('--dangerously-bypass-approvals-and-sandbox');
    for (const p of (allowedPaths||[])){ const abs=resolve(this.cwd,p); base.push("--add-dir", abs); }
    if (prompt && prompt!=="-") base.push(prompt);
    const meta = { id: `codex-resume-${Date.now()}` };
    if (toolCallId) meta.toolCallId = toolCallId;
    if (toolName) meta.toolName = toolName;
    const res = await this.spawnCollect("codex", base, {}, meta);
    const id = sessionId || this.extractSessionId(res.stdout) || this.extractSessionId(res.stderr);
    return { id, ...res };
  }

  async applyLatest({ toolCallId, toolName } = {}){
    emitEvent({ type: "subagent_apply_start", agent: "codex" });
    const meta = { id: `codex-apply-${Date.now()}` };
    if (toolCallId) meta.toolCallId = toolCallId;
    if (toolName) meta.toolName = toolName;
    const out = await this.spawnCollect("codex", ["apply"], {}, meta);
    emitEvent({ type: "subagent_apply_end", agent: "codex", code: out.code });
    return out;
  }

  // session id extraction
  extractSessionId(text){
    const lines = String(text||"").split(/\r?\n/);
    for (const line of lines){
      const t=line.trim(); if(!t) continue;
      try { const obj=JSON.parse(t); const id=obj?.session?.id||obj?.sessionId||obj?.id; if (id && String(id).length>=6) return String(id); } catch {}
      const m=t.match(/session[_ -]?id\s*[:=]\s*([A-Za-z0-9_-]{6,})/i); if (m) return m[1];
    }
    return null;
  }
}

export default CodexRunner;
