import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDisabledToolNamesForConfig, getToolDisabledState } from "./tool-permissions.js";

test("getDisabledToolNamesForConfig trims and deduplicates disabled tool names", () => {
  const disabled = getDisabledToolNamesForConfig({
    tools: {
      disabled: [" codex ", "bash", "codex", "", null],
    },
  });

  assert.deepEqual(Array.from(disabled).sort(), ["bash", "codex"]);
});

test("getToolDisabledState returns disabled when the agent config disables the tool", () => {
  const agentHomeRoot = mkdtempSync(join(tmpdir(), "arcana-tool-permissions-"));

  try {
    writeFileSync(
      join(agentHomeRoot, "config.json"),
      JSON.stringify({
        tools: {
          disabled: ["codex"],
        },
      }, null, 2),
      "utf-8",
    );

    const state = getToolDisabledState("codex", { agentHomeRoot });

    assert.equal(state.disabled, true);
    assert.equal(state.error, "tool_disabled");
    assert.match(state.text, /disabled/i);
  } finally {
    rmSync(agentHomeRoot, { recursive: true, force: true });
  }
});

test("getToolDisabledState returns enabled when no agent config disables the tool", () => {
  const state = getToolDisabledState("codex", { cfg: { tools: { disabled: ["bash"] } } });

  assert.equal(state.disabled, false);
  assert.equal(state.toolName, "codex");
});
