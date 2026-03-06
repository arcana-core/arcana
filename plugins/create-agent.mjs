import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import os from "node:os";

function expandHomeDir(input) {
  if (!input) return input;
  const s = String(input);
  if (s === "~") {
    try {
      return os.homedir();
    } catch {
      return s;
    }
  }
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    try {
      const home = os.homedir();
      if (home) return join(home, s.slice(2));
    } catch {
      // fall through
    }
  }
  return s;
}

function resolveAgentsDir(preferred) {
  const fromArg = String(preferred || "").trim();
  if (fromArg) return resolve(expandHomeDir(fromArg));

  const envAgents = String(process.env.ARCANA_AGENTS_DIR || "").trim();
  if (envAgents) return resolve(expandHomeDir(envAgents));

  const envHome = String(process.env.ARCANA_HOME || "").trim();
  if (envHome) {
    const base = expandHomeDir(envHome);
    return resolve(join(base, "agents"));
  }

  try {
    const home = os.homedir && os.homedir();
    if (home) return join(home, ".arcana", "agents");
  } catch {}

  return join(process.cwd(), ".arcana", "agents");
}

function ensureDir(dir) {
  const existed = existsSync(dir);
  if (!existed) {
    mkdirSync(dir, { recursive: true });
  }
  return { path: dir, existed, created: !existed };
}

function buildAgentMeta(agentId, workspaceRoot) {
  return {
    agentId: String(agentId || ""),
    workspaceRoot: String(workspaceRoot || ""),
    createdAt: new Date().toISOString(),
  };
}

function writeJsonFile(path, data, { overwrite }) {
  const existed = existsSync(path);
  if (existed && !overwrite) {
    return { path, existed: true, created: false, overwritten: false, skipped: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(path, json, "utf-8");
  return {
    path,
    existed,
    created: !existed,
    overwritten: existed && !!overwrite,
    skipped: false,
  };
}

function writeTextFile(path, content, { overwrite }) {
  const existed = existsSync(path);
  if (existed && !overwrite) {
    return { path, existed: true, created: false, overwritten: false, skipped: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return {
    path,
    existed,
    created: !existed,
    overwritten: existed && !!overwrite,
    skipped: false,
  };
}

function getBootstrapFiles(agentId, overrides = {}) {
  const safeId = String(agentId || "");
  const { soul, user, tools } = overrides;

  return [
    {
      name: "AGENTS.md",
      required: true,
      content:
        "# Agent Home\n\n" +
        "This directory belongs to agent \"" +
        safeId +
        "\".\n" +
        "Use this file for agent-level rules, routing notes, and shared context.\n",
    },
    {
      name: "MEMORY.md",
      required: true,
      content:
        "# MEMORY\n\n" +
        "Use this file to capture long-term notes, decisions, and links for agent \"" +
        safeId +
        "\".\n",
    },
    {
      name: "SOUL.md",
      required: false,
      content:
        typeof soul === "string"
          ? soul
          : "# SOUL.md - Who You Are\n\n" +
            "Describe the persona, tone, and boundaries for this agent.\n",
    },
    {
      name: "USER.md",
      required: false,
      content:
        typeof user === "string"
          ? user
          : "# USER.md - Who I Am\n\n" +
            "Describe the primary user or team this agent serves, plus preferences and constraints.\n",
    },
    {
      name: "TOOLS.md",
      required: false,
      content:
        typeof tools === "string"
          ? tools
          : "# TOOLS.md - Tools and Capabilities\n\n" +
            "List important tools, APIs, and workflows this agent should know about.\n",
    },
  ];
}

function createCreateAgentTool() {
  const parameters = {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description:
          "Short identifier for this agent; becomes the folder name under the Arcana home directory. Must match /^[A-Za-z0-9_-]{1,64}$/.",
      },
      agentsDir: {
        type: "string",
        nullable: true,
        description:
          "Override the agents root directory (defaults to ARCANA_AGENTS_DIR, or ARCANA_HOME/agents, or ~/.arcana/agents).",
      },
      workspaceRoot: {
        type: "string",
        nullable: false,
        description:
          "REQUIRED: absolute or ~-relative path for this agent's workspaceRoot.",
      },
      overwrite: {
        type: "boolean",
        nullable: true,
        description: "When true, overwrite existing agent.json and bootstrap files.",
      },
      seedWorkspace: {
        type: "boolean",
        nullable: true,
        description:
          "When true (default), write AGENTS.md/MEMORY.md and optional SOUL/USER/TOOLS.md into the agent home.",
      },
      soul: {
        type: "string",
        nullable: true,
        description:
          "Optional content for SOUL.md. If provided, this file is written even when seedWorkspace is false.",
      },
      user: {
        type: "string",
        nullable: true,
        description:
          "Optional content for USER.md. If provided, this file is written even when seedWorkspace is false.",
      },
      tools: {
        type: "string",
        nullable: true,
        description:
          "Optional content for TOOLS.md. If provided, this file is written even when seedWorkspace is false.",
      },
    },
    required: ["agentId", "workspaceRoot"],
  };

  return {
    name: "create_agent",
    label: "Create Agent",
    description:
      "Create a per-agent home under ~/.arcana/agents/<agentId>/ with agent.json (including workspaceRoot) and bootstrap files.",
    parameters,
    async execute(_callId, args) {
      const errors = [];

      const rawAgentId = String(args?.agentId || "").trim();
      const agentIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

      if (!rawAgentId) {
        errors.push("agentId is required.");
      } else if (!agentIdPattern.test(rawAgentId)) {
        errors.push(
          "agentId must match /^[A-Za-z0-9_-]{1,64}$/ (letters, numbers, underscore, hyphen; max length 64).",
        );
      }

      let workspaceRootArg = "";
      if (typeof args?.workspaceRoot === "string") {
        workspaceRootArg = args.workspaceRoot.trim();
      }
      if (!workspaceRootArg) {
        errors.push("workspaceRoot is required (absolute or ~-relative path).");
      }

      if (errors.length) {
        return {
          content: [{ type: "text", text: errors.join("\n") }],
          details: { ok: false, errors },
        };
      }

      const overwrite = Boolean(args?.overwrite);
      const seedWorkspace =
        typeof args?.seedWorkspace === "boolean" ? args.seedWorkspace : true;

      const soulArg = typeof args?.soul === "string" ? args.soul : undefined;
      const userArg = typeof args?.user === "string" ? args.user : undefined;
      const toolsArg = typeof args?.tools === "string" ? args.tools : undefined;

      const soulRequested = typeof args?.soul === "string";
      const userRequested = typeof args?.user === "string";
      const toolsRequested = typeof args?.tools === "string";

      const arcanaHome = resolveAgentsDir(args?.agentsDir);
      const agentDir = resolve(arcanaHome, rawAgentId);

      const agentsDirInfo = ensureDir(arcanaHome);
      const agentDirInfo = ensureDir(agentDir);

      const workspaceBase = workspaceRootArg;
      const workspaceDir = resolve(expandHomeDir(workspaceBase));
      const workspaceDirInfo = ensureDir(workspaceDir);
      const artifactsDirInfo = ensureDir(join(workspaceDir, "artifacts"));

      const agentSubdirInfos = [];
      agentSubdirInfos.push(
        ensureDir(join(agentDir, "memory")),
        ensureDir(join(agentDir, "skills")),
        ensureDir(join(agentDir, ".agents", "skills")),
      );

      const bootstrapNeeded =
        seedWorkspace || soulRequested || userRequested || toolsRequested;

      const agentMetaPath = join(agentDir, "agent.json");
      const agentMeta = buildAgentMeta(rawAgentId, workspaceDir);
      const agentResult = writeJsonFile(agentMetaPath, agentMeta, { overwrite });

      const bootstrapResults = [];
      if (bootstrapNeeded) {
        const bootstrapDefs = getBootstrapFiles(rawAgentId, {
          soul: soulArg,
          user: userArg,
          tools: toolsArg,
        });

        let filesToWrite;
        if (seedWorkspace) {
          filesToWrite = bootstrapDefs;
        } else {
          filesToWrite = bootstrapDefs.filter((def) => {
            if (def.name === "SOUL.md") return soulRequested;
            if (def.name === "USER.md") return userRequested;
            if (def.name === "TOOLS.md") return toolsRequested;
            return false;
          });
        }

        for (const def of filesToWrite) {
          const filePath = join(agentDir, def.name);
          const res = writeTextFile(filePath, def.content, { overwrite });
          bootstrapResults.push({ name: def.name, required: def.required, ...res });
        }
      }

      let servicesIniResult = null;
      if (seedWorkspace) {
        const servicesIniPath = join(agentDir, "services.ini");
        const servicesIniLines = [
          "; Arcana services configuration",
          "; Each section [serviceId] defines an auto-starting service.",
          ";",
          "; Example Feishu WebSocket bridge service:",
          ";",
          "; [feishu]",
          "; command = node $ARCANA_PKG_ROOT/skills/feishu/scripts/feishu-bridge.mjs",
          "; env.FEISHU_APP_ID = your-app-id",
          "; env.FEISHU_APP_SECRET = your-app-secret",
          "; env.FEISHU_DOMAIN = feishu",
          "",
        ];
        const servicesIniContent = servicesIniLines.join("\n");
        servicesIniResult = writeTextFile(servicesIniPath, servicesIniContent, {
          overwrite,
        });
      }

      const lines = [];
      lines.push(`Agents root: ${arcanaHome}`);
      lines.push(`Agent: ${rawAgentId}`);
      lines.push(`Agent home directory: ${agentDir}`);
      lines.push(`Workspace root: ${workspaceDir}`);

      const createdDirs = [];
      if (agentsDirInfo.created) createdDirs.push(agentsDirInfo.path);
      if (agentDirInfo.created) createdDirs.push(agentDirInfo.path);
      if (workspaceDirInfo.created) createdDirs.push(workspaceDirInfo.path);
      if (artifactsDirInfo.created) createdDirs.push(artifactsDirInfo.path);

      if (createdDirs.length) {
        lines.push(`Directories created: ${createdDirs.join(", ")}`);
      }

      if (agentSubdirInfos.length) {
        const subdirSummary = agentSubdirInfos
          .map((d) => `${d.path}${d.created ? " (created)" : " (exists)"}`)
          .join(", ");
        lines.push(`Agent home subdirectories: ${subdirSummary}`);
      }

      if (agentResult.skipped) {
        lines.push("agent.json: exists (skipped; set overwrite=true to replace)");
      } else if (agentResult.overwritten) {
        lines.push("agent.json: overwritten");
      } else if (agentResult.created) {
        lines.push("agent.json: created");
      }

      if (servicesIniResult) {
        if (servicesIniResult.skipped && !overwrite) {
          lines.push(
            "services.ini: exists (skipped; set overwrite=true to replace)",
          );
        } else if (servicesIniResult.overwritten) {
          lines.push("services.ini: overwritten");
        } else if (servicesIniResult.created) {
          lines.push("services.ini: created");
        }
      }

      const createdBootstrap = bootstrapResults.filter((r) => r.created && !r.skipped);
      const skippedBootstrap = bootstrapResults.filter((r) => r.skipped);

      if (createdBootstrap.length) {
        lines.push(
          "Bootstrap files created: " +
            createdBootstrap.map((r) => r.name).join(", "),
        );
      }
      if (skippedBootstrap.length && !overwrite) {
        lines.push(
          "Bootstrap files skipped (already exist): " +
            skippedBootstrap.map((r) => r.name).join(", "),
        );
      }

      const details = {
        ok: true,
        agentsDir: arcanaHome,
        agentId: rawAgentId,
        agentDir,
        agentHomeDir: agentDir,
        workspaceRoot: workspaceDir,
        workspaceDir: workspaceDir,
        seedWorkspace,
        agent: agentResult,
        bootstrap: bootstrapResults,
        servicesIni: servicesIniResult,
        directories: {
          agentsDir: agentsDirInfo,
          agentDir: agentDirInfo,
          agentHomeSubdirs: agentSubdirInfos,
          workspaceRoot: workspaceDirInfo,
          workspaceArtifacts: artifactsDirInfo,
        },
      };

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details,
      };
    },
  };
}

export default async function registerCreateAgentTool(pi) {
  if (!pi || typeof pi.registerTool !== "function") return;
  pi.registerTool(createCreateAgentTool());
}
