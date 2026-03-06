import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import CodexRunner from "../subagents/codex-runner.js";
import { resolveWorkspaceRoot, normalizeAllowedPaths } from "../workspace-guard.js";

// Codex tool (external agent). Codex performs edits; Arcana never applies patches itself.
export function createCodexSubagentTool() {
  const Params = Type.Object({
    task: Type.String({ description: "Main instruction for Codex." }),
    plan: Type.Optional(
      Type.String({ description: "Optional upstream plan to include in context." })
    ),
    allowedPaths: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Relative path prefixes permitted to modify; defaults to workspace root.",
      })
    ),
    // Keep dryRun for compatibility, though we do not call external apply here.
    dryRun: Type.Optional(
      Type.Boolean({ description: "If true, do not apply; only converse/prepare changes." })
    ),
    sessionLabel: Type.Optional(
      Type.String({ description: "Optional label to bind/continue the Codex session." })
    ),
  });

  const CODEX_DETECT_TTL_MS = 60000;
  let hasLocalCodexCached = null;
  let hasLocalCodexCachedAt = 0;

  function hasLocalCodex() {
    const now = Date.now();
    if (hasLocalCodexCached !== null && (now - hasLocalCodexCachedAt) < CODEX_DETECT_TTL_MS) {
      return hasLocalCodexCached;
    }
    let ok = false;
    try {
      const r = spawnSync("codex", ["--help"], { stdio: "ignore" });
      ok = !!(r && r.status === 0);
    } catch {
      ok = false;
    }
    hasLocalCodexCached = ok;
    hasLocalCodexCachedAt = now;
    return ok;
  }

  function buildPrompt(args) {
    const lines = [
      "You are Codex CLI. You can directly create/modify files within the allowed paths.",
      "Objective:",
      String(args.task || "").trim(),
    ];
    if (args.plan) lines.push("\nUpstream plan:\n" + args.plan);
    const ap = Array.isArray(args.allowedPaths)
      ? args.allowedPaths.filter(Boolean)
      : [];
    if (ap.length) lines.push("\nAllowed write paths: " + ap.join(", "));
    return lines.join("\n");
  }

  return {
    label: "Codex",
    name: "codex",
    description:
      "Use local Codex CLI to plan, edit, and apply changes directly with session continuity.",
    parameters: Params,
    async execute(_id, args) {
      const startedAt = Date.now();
      const root = resolveWorkspaceRoot();
      const allowed = normalizeAllowedPaths(
        Array.isArray(args.allowedPaths) && args.allowedPaths.length
          ? args.allowedPaths
          : [root]
      );

      if (!hasLocalCodex()) {
        const text = "codex_cli_missing (no cloud fallback).";
        const content = [{ type: "text", text }];
        return { content, details: { error: "codex_cli_missing" } };
      }

      const sessionKey = String(args.sessionLabel || "").trim() || String(args.task || "");
      const runner = new CodexRunner({
        cwd: root,
        cacheDir: join(root, "arcana", ".cache", "codex"),
      });
      const prompt = buildPrompt(args);
      const { id: existing } = runner.getSessionForTask(sessionKey);
      const run = existing
        ? await runner.resumeSession(existing, { prompt, allowedPaths: allowed, toolCallId: _id, toolName: "codex" })
        : await runner.runNewSession({ prompt, allowedPaths: allowed, toolCallId: _id, toolName: "codex" });
      const sessionId = run.id || existing || null;
      if (sessionId) runner.saveSessionForTask(sessionKey, sessionId);

      // Do not call external apply here. Codex is responsible for edits it decides to make.

            const tookMs = Date.now() - startedAt;
      const code = typeof run.code === "number" ? run.code : null;

      // Return Codex's raw output tail so the agent can continue the conversation.
      const stdoutTail = String(run.stdout || "").slice(-8000);
      const stderrTail = String(run.stderr || "").slice(-8000);

      const header = [
        "Codex finished",
        "session: " + (sessionId || "n/a"),
        "exit_code: " + (code === null ? "unknown" : String(code)),
        "took_s: " + Math.round(tookMs / 1000),
      ].join("\n");

      const text = [
        header,
        "",
        "=== codex stdout (tail) ===",
        stdoutTail || "(empty)",
        "",
        "=== codex stderr (tail) ===",
        stderrTail || "(empty)",
      ].join("\n");

      const usage = (function(){
        try{
          const parse = (text)=>{
            const lines = String(text||'').split(/\r?\n/);
            let u=null;
            for (const ln of lines){
              const t=ln.trim(); if(!t) continue;
              try {
                const obj = JSON.parse(t);
                const src = (obj && typeof obj === 'object' && obj.usage && typeof obj.usage === 'object') ? obj.usage : obj;
                if (src && typeof src === 'object'){
                  const input = Number(src.inputTokens ?? src.input_tokens ?? src.prompt_tokens ?? src.promptTokens ?? src.input ?? src.prompt ?? 0) || 0;
                  const output = Number(src.outputTokens ?? src.output_tokens ?? src.completion_tokens ?? src.completionTokens ?? src.output ?? 0) || 0;
                  const cacheRead = Number(src.cacheRead ?? src.cache_read_tokens ?? src.cache_read ?? 0) || 0;
                  const cacheWrite = Number(src.cacheWrite ?? src.cache_write_tokens ?? src.cache_write ?? 0) || 0;
                  const total = Number(src.totalTokens ?? src.total_tokens ?? src.total ?? 0) || (input+output) || 0;
                  if (input || output || total || cacheRead || cacheWrite){
                    u = { input: input||undefined, output: output||undefined, cacheRead: cacheRead||undefined, cacheWrite: cacheWrite||undefined, totalTokens: total||undefined };
                  }
                }
              } catch {}
            }
            return u;
          };
          return parse(run.stdout) || parse(run.stderr) || null;
        } catch { return null }
      })();
      const details = { ok: code === 0, sessionId, tookMs, code };
      const content = [{ type: "text", text }];
      if (usage) details.usage = usage;
      return { content, details };
    },
  };
}

export default createCodexSubagentTool;
