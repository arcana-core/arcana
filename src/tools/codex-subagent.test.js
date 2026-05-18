import test from "node:test";
import assert from "node:assert/strict";

import { createCodexSubagentTool } from "./codex-subagent.js";

test("codex subagent tool refuses execution when codex is disabled for the agent", async () => {
  const tool = createCodexSubagentTool({
    getToolDisabledState() {
      return {
        disabled: true,
        error: "tool_disabled",
        reason: "disabled_by_agent_config",
        toolName: "codex",
        text: 'Tool "codex" is disabled in this agent\'s tool settings.',
      };
    },
  });

  const result = await tool.execute("tool-call-id", { task: "touch README.md" });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, "tool_disabled");
  assert.equal(result.details.tool, "codex");
  assert.match(result.content[0].text, /disabled/i);
});
