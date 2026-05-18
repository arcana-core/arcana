import { loadAgentConfig } from "./config.js";
import { getContext } from "./event-bus.js";

export function getDisabledToolNamesForConfig(cfg) {
  const disabled = new Set();
  try {
    const disabledArr = cfg && cfg.tools && Array.isArray(cfg.tools.disabled) ? cfg.tools.disabled : [];
    for (const raw of disabledArr) {
      if (typeof raw !== "string") continue;
      const name = raw.trim();
      if (!name) continue;
      disabled.add(name);
    }
  } catch {}
  return disabled;
}

export function getToolDisabledState(toolName, options = {}) {
  const normalizedToolName = String(toolName || "").trim();
  const ctx = getContext?.() || null;
  const agentHomeRoot = String(options.agentHomeRoot || ctx?.agentHomeRoot || "").trim();
  const cfg = options.cfg && typeof options.cfg === "object"
    ? options.cfg
    : (agentHomeRoot ? loadAgentConfig(agentHomeRoot) : null);
  const disabledTools = getDisabledToolNamesForConfig(cfg);

  if (!normalizedToolName || !disabledTools.has(normalizedToolName)) {
    return {
      disabled: false,
      toolName: normalizedToolName,
      agentHomeRoot,
    };
  }

  return {
    disabled: true,
    toolName: normalizedToolName,
    agentHomeRoot,
    error: "tool_disabled",
    reason: "disabled_by_agent_config",
    text: 'Tool "' + normalizedToolName + '" is disabled in this agent\'s tool settings.',
  };
}

export default {
  getDisabledToolNamesForConfig,
  getToolDisabledState,
};
