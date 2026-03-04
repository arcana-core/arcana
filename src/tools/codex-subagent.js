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

  function hasLocalCodex() {
    try {
      const r = spawnSync("codex", ["--help"], { stdio: "ignore" });
      return r && r.status === 0;
    } catch {
      return false;
    }
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
        ? await runner.resumeSession(existing, { prompt, allowedPaths: allowed })
        : await runner.runNewSession({ prompt, allowedPaths: allowed });
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

      const details = { ok: code === 0, sessionId, tookMs, code };
      const content = [{ type: "text", text }];
      return { content, details };
    },
  };
}

export default createCodexSubagentTool;
