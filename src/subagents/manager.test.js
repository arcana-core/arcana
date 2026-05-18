import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runWithContext } from "../event-bus.js";
import { spawnSubagent } from "./manager.js";

test("spawnSubagent returns blocked when codex is disabled for the current agent", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "arcana-subagent-workspace-"));
  const agentHomeRoot = join(workspaceRoot, ".arcana", "agents", "test-agent");

  try {
    mkdirSync(agentHomeRoot, { recursive: true });
    writeFileSync(
      join(agentHomeRoot, "config.json"),
      JSON.stringify({
        tools: {
          disabled: ["codex"],
        },
      }, null, 2),
      "utf-8",
    );

    const result = await runWithContext(
      { workspaceRoot, agentId: "test-agent", agentHomeRoot },
      () => spawnSubagent({ task: "implement a fix" }),
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.error, "tool_disabled");
    assert.equal(result.tool, "codex");
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
