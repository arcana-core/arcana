import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceRoot, normalizeAllowedPaths } from "../src/workspace-guard.js";
import { emit as emitEvent } from "../src/event-bus.js";

function hasClaudeCli() {
  try {
    const r = spawnSync("claude", ["--help"], { stdio: "ignore" });
    return r && r.status === 0;
  } catch {
    return false;
  }
}

function buildPrompt(args, extraDirs) {
  const lines = [
    "You are Claude Code (claude CLI) working inside the local Arcana workspace.",
    "Objective:",
    String(args.task || "").trim(),
  ];
  if (args.plan) lines.push("\nUpstream plan:\n" + String(args.plan));
  const ap = Array.isArray(extraDirs) ? extraDirs.filter(Boolean) : [];
  if (ap.length) lines.push("\nAdditional directories (--add-dir): " + ap.join(", "));
  if (args.dryRun) {
    lines.push(
      "\nNOTE: dryRun=true; prefer describing edits and showing patches instead of applying destructive changes directly.",
    );
  }
  return lines.join("\n");
}

function sessionMapPath(root) {
  const dir = join(root, "arcana", ".cache", "claude-code");
  const file = join(dir, "sessions.json");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return file;
}

function readSessionId(root, key) {
  const mapFile = sessionMapPath(root);
  try {
    if (!existsSync(mapFile)) return null;
    const raw = readFileSync(mapFile, "utf-8");
    const map = JSON.parse(raw);
    const entry = map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    if (!entry) return null;
    if (typeof entry === "string") return entry || null;
    if (entry && typeof entry === "object") {
      return entry.sessionId || entry.session_id || entry.id || null;
    }
  } catch {
    // ignore invalid map
  }
  return null;
}

function writeSessionId(root, key, sessionId) {
  if (!sessionId) return;
  const mapFile = sessionMapPath(root);
  let map = {};
  try {
    if (existsSync(mapFile)) {
      const raw = readFileSync(mapFile, "utf-8");
      map = JSON.parse(raw) || {};
    }
  } catch {
    map = {};
  }
  map[key] = { sessionId: String(sessionId), updatedAt: Date.now() };
  try {
    writeFileSync(mapFile, JSON.stringify(map, null, 2));
  } catch {
    // ignore write errors
  }
}

function parseSingleJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return null;
    try {
      return JSON.parse(last);
    } catch {
      return null;
    }
  }
}

function extractSessionIdFromJson(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.session_id === "string" && obj.session_id) return obj.session_id;
  if (typeof obj.sessionId === "string" && obj.sessionId) return obj.sessionId;
  if (obj.session && typeof obj.session === "object") {
    const s = obj.session;
    if (typeof s.id === "string" && s.id) return s.id;
    if (typeof s.session_id === "string" && s.session_id) return s.session_id;
  }
  return null;
}

function extractUsageFromJson(obj) {
  if (!obj || typeof obj !== "object") return null;
  const src = obj.usage && typeof obj.usage === "object" ? obj.usage : obj;
  if (!src || typeof src !== "object") return null;
  const input =
    Number(
      src.inputTokens ??
        src.input_tokens ??
        src.prompt_tokens ??
        src.promptTokens ??
        src.input ??
        src.prompt ??
        0,
    ) || 0;
  const output =
    Number(
      src.outputTokens ??
        src.output_tokens ??
        src.completion_tokens ??
        src.completionTokens ??
        src.output ??
        0,
    ) || 0;
  const cacheRead =
    Number(
      src.cacheRead ??
        src.cache_read_tokens ??
        src.cache_read_input_tokens ??
        src.cache_read ??
        0,
    ) || 0;
  const cacheWrite =
    Number(
      src.cacheWrite ??
        src.cache_write_tokens ??
        src.cache_creation_input_tokens ??
        src.cache_write ??
        0,
    ) || 0;
  const total =
    Number(src.totalTokens ?? src.total_tokens ?? src.total ?? 0) || input + output || 0;
  if (!input && !output && !total && !cacheRead && !cacheWrite) return null;
  return {
    input: input || undefined,
    output: output || undefined,
    cacheRead: cacheRead || undefined,
    cacheWrite: cacheWrite || undefined,
    totalTokens: total || undefined,
  };
}

function parseUsageFromText(stdout, stderr) {
  try {
    const parseLines = (text) => {
      const lines = String(text || "").split(/\r?\n/);
      let usage = null;
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          const u = extractUsageFromJson(obj);
          if (u) usage = u;
        } catch {
          // ignore non-JSON lines
        }
      }
      return usage;
    };
    return parseLines(stdout) || parseLines(stderr) || null;
  } catch {
    return null;
  }
}

function runClaudeOnce(args, cwd, meta = {}) {
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const toolCallId = meta && meta.toolCallId ? meta.toolCallId : null;
    const toolName = (meta && meta.toolName) || "claude_code";
    const useToolEvents = !!toolCallId;
    try {
      child = spawn("claude", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err || "Unknown error");
      resolveRun({ code: null, stdout: "", stderr: msg });
      return;
    }
    child.stdout.on("data", (d) => {
      const s = String(d);
      stdout += s;
      if (useToolEvents) {
        emitEvent({
          type: "tool_execution_update",
          toolCallId,
          toolName,
          partialResult: { stream: "stdout", chunk: s },
        });
      }
    });
    child.stderr.on("data", (d) => {
      const s = String(d);
      stderr += s;
      if (useToolEvents) {
        emitEvent({
          type: "tool_execution_update",
          toolCallId,
          toolName,
          partialResult: { stream: "stderr", chunk: s },
        });
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      const msg = err && err.message ? String(err.message) : String(err || "Unknown error");
      resolveRun({ code: null, stdout, stderr: stderr + (stderr ? "\n" : "") + msg });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolveRun({ code: typeof code === "number" ? code : null, stdout, stderr });
    });
  });
}


export default async function (pi) {
  pi.registerTool({
    label: "Claude Code",
    name: "claude_code",
    description:
      "Use local Anthropic Claude Code CLI (`claude`) to plan, edit, and apply changes directly with session continuity.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Main instruction for Claude Code." },
        plan: {
          type: "string",
          nullable: true,
          description: "Optional upstream plan to include in context.",
        },
        allowedPaths: {
          type: "array",
          items: { type: "string" },
          nullable: true,
          description:
            "Additional workspace-relative directories to pass to Claude via --add-dir (the Arcana workspace root is available by default).",
        },
        dryRun: {
          type: "boolean",
          nullable: true,
          description:
            "If true, prefer planning and showing patches instead of applying destructive edits.",
        },
        sessionLabel: {
          type: "string",
          nullable: true,
          description:
            "Optional label to bind/continue the Claude Code session (used for session cache).",
        },
        model: {
          type: "string",
          nullable: true,
          description:
            "Optional Claude model identifier or alias (e.g. 'sonnet', 'opus').",
        },
        fallbackModel: {
          type: "string",
          nullable: true,
          description:
            "Optional fallback model to use when the primary model is overloaded (only honored in non-interactive mode).",
        },
        permissionMode: {
          type: "string",
          enum: ["default", "plan", "acceptEdits", "bypassPermissions"],
          nullable: true,
          description:
            "Permission mode to use for the session (maps to --permission-mode).",
        },
        continue: {
          type: "boolean",
          nullable: true,
          description:
            "When true, continue the most recent Claude Code conversation (maps to --continue).",
        },
        resumeSessionId: {
          type: "string",
          nullable: true,
          description:
            "Explicit Claude Code session id to resume (maps to --resume <id>).",
        },
        outputFormat: {
          type: "string",
          enum: ["text", "json", "stream-json"],
          nullable: true,
          description:
            "claude --output-format value: 'text' (default), 'json', or 'stream-json'. Defaults to 'json'.",
        },
        dangerouslySkipPermissions: {
          type: "boolean",
          nullable: true,
          description:
            "When true, pass --dangerously-skip-permissions to claude (use only in safe sandboxes).",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          nullable: true,
          description:
            "Optional list of allowed tool names (maps to --allowedTools).",
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          nullable: true,
          description:
            "Optional list of disallowed tool names (maps to --disallowedTools).",
        },
      },
      required: ["task"],
    },
    async execute(_id, args) {
      const startedAt = Date.now();
      const root = resolveWorkspaceRoot();

      const allowedInput = Array.isArray(args.allowedPaths)
        ? args.allowedPaths.filter(Boolean)
        : [];
      const normalizedAllowed = allowedInput.length
        ? normalizeAllowedPaths(allowedInput)
        : [];
      const extraDirs = normalizedAllowed.filter((p) => p && p !== root);

      if (!hasClaudeCli()) {
        const text = "claude_cli_missing (failed to run `claude --help`; ensure Claude Code CLI is installed and accessible on PATH).";
        return {
          content: [{ type: "text", text }],
          details: { error: "claude_cli_missing" },
        };
      }

      const taskText = String(args.task || "").trim();
      if (!taskText) {
        const text = "Task is required for claude_code tool.";
        return { content: [{ type: "text", text }], details: { ok: false } };
      }

      const sessionKey =
        String(args.sessionLabel || "").trim() || taskText;
      const explicitResumeId =
        typeof args.resumeSessionId === "string"
          ? String(args.resumeSessionId).trim()
          : "";
      const continueFlag = Boolean(args.continue);

      let resumeMode = null;
      let resumeId = null;
      if (explicitResumeId) {
        resumeMode = "resume_explicit";
        resumeId = explicitResumeId;
      } else if (continueFlag) {
        resumeMode = "continue";
      } else {
        const cached = readSessionId(root, sessionKey);
        if (cached) {
          resumeMode = "resume_cached";
          resumeId = cached;
        }
      }

      const outputFormatRaw =
        typeof args.outputFormat === "string" && args.outputFormat
          ? String(args.outputFormat)
          : "json";
      const fmt =
        outputFormatRaw === "text" ||
        outputFormatRaw === "json" ||
        outputFormatRaw === "stream-json"
          ? outputFormatRaw
          : "json";

      const prompt = buildPrompt({ ...args, task: taskText }, extraDirs);

      const cliArgs = [];
      cliArgs.push("--print");
      cliArgs.push("--output-format", fmt);
      if (fmt === "stream-json") {
        cliArgs.push("--verbose");
      }

      if (args.dangerouslySkipPermissions) {
        cliArgs.push("--dangerously-skip-permissions");
      }

      const permMode = typeof args.permissionMode === "string" ? args.permissionMode : null;
      if (permMode && permMode !== "default") {
        cliArgs.push("--permission-mode", permMode);
      }

      const model = typeof args.model === "string" ? args.model.trim() : "";
      if (model) {
        cliArgs.push("--model", model);
      }
      const fallbackModel =
        typeof args.fallbackModel === "string" ? args.fallbackModel.trim() : "";
      if (fallbackModel) {
        cliArgs.push("--fallback-model", fallbackModel);
      }

      const allowedTools = Array.isArray(args.allowedTools)
        ? args.allowedTools.filter(Boolean).map((s) => String(s))
        : [];
      if (allowedTools.length) {
        cliArgs.push("--allowedTools", ...allowedTools);
      }
      const disallowedTools = Array.isArray(args.disallowedTools)
        ? args.disallowedTools.filter(Boolean).map((s) => String(s))
        : [];
      if (disallowedTools.length) {
        cliArgs.push("--disallowedTools", ...disallowedTools);
      }

      for (const p of extraDirs) {
        cliArgs.push("--add-dir", p);
      }

      if (resumeMode === "resume_explicit" && resumeId) {
        cliArgs.push("--resume", resumeId);
      } else if (resumeMode === "continue") {
        cliArgs.push("--continue");
      } else if (resumeMode === "resume_cached" && resumeId) {
        cliArgs.push("--resume", resumeId);
      }

      cliArgs.push(prompt);

      const run = await runClaudeOnce(cliArgs, root, { toolCallId: _id, toolName: "claude_code" });

      let sessionId = null;
      let usage = null;
      if (fmt === "json") {
        const parsed = parseSingleJson(run.stdout) || parseSingleJson(run.stderr);
        if (parsed) {
          sessionId = extractSessionIdFromJson(parsed);
          usage = extractUsageFromJson(parsed) || usage;
        }
      }
      if (!usage) {
        usage = parseUsageFromText(run.stdout, run.stderr);
      }

      if (sessionId) {
        writeSessionId(root, sessionKey, sessionId);
      }

      const tookMs = Date.now() - startedAt;
      const code = typeof run.code === "number" ? run.code : null;
      const stdoutTail = String(run.stdout || "").slice(-8000);
      const stderrTail = String(run.stderr || "").slice(-8000);

      const header = [
        "Claude Code finished",
        "session: " + (sessionId || "n/a"),
        "exit_code: " + (code === null ? "unknown" : String(code)),
        "took_s: " + Math.round(tookMs / 1000),
        "output_format: " + fmt,
      ].join("\n");

      const text = [
        header,
        "",
        "=== claude stdout (tail) ===",
        stdoutTail || "(empty)",
        "",
        "=== claude stderr (tail) ===",
        stderrTail || "(empty)",
      ].join("\n");

      const details = {
        ok: code === 0,
        sessionId,
        tookMs,
        code,
        outputFormat: fmt,
        resumeMode,
      };
      if (usage) details.usage = usage;

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  });
}
