import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { arcanaHomePath } from '../arcana-home.js';
import { resolveWorkspaceRoot, ensureReadAllowed } from '../workspace-guard.js';

// Read the agent heartbeat file HEARTBEAT.md.
//
// Primary source (modern behavior):
//   <ARCANA_HOME>/agents/<agentId>/HEARTBEAT.md
//   - Resolved via arcanaHomePath('agents', agentId, 'HEARTBEAT.md').
//   - This lives outside the workspace and does not go through
//     the workspace guard.
//
// Fallback (back-compat behavior):
//   <workspaceRoot>/HEARTBEAT.md
//   - workspaceRoot parameter or resolved via resolveWorkspaceRoot().
//   - Guarded by ensureReadAllowed() as it lives inside the workspace.
//
// Returns the file contents as a string, or null if the file does not
// exist in either location or cannot be read.
export async function readAgentHeartbeatFile(agentId, workspaceRoot) { // agentId kept for back-compat
  // 1) Prefer agent-home heartbeat file.
  try {
    const agentIdStr = agentId == null ? '' : String(agentId);
    const agentHeartbeatPath = arcanaHomePath('agents', agentIdStr, 'HEARTBEAT.md');
    const raw = await fsp.readFile(agentHeartbeatPath, 'utf8');
    return String(raw);
  } catch {
    // If the agent-home heartbeat file is missing or unreadable,
    // fall back to the workspace heartbeat file for back-compat.
  }

  // 2) Fallback: workspace HEARTBEAT.md inside the session workspace.
  const root = workspaceRoot || resolveWorkspaceRoot();
  if (!root) {
    return null;
  }

  const filePath = join(root, 'HEARTBEAT.md');

  try {
    const raw = await fsp.readFile(ensureReadAllowed(filePath), 'utf8');
    return String(raw);
  } catch {
    return null;
  }
}

// Determine whether a heartbeat file is effectively empty.
// A file is considered empty if it is null/undefined, only whitespace,
// or if all non-blank lines are ignorable metadata such as headings,
// horizontal rules, or comment directives.
export function isHeartbeatFileEffectivelyEmpty(text) {
  if (text == null) {
    return true;
  }

  const value = String(text);
  if (value.trim().length === 0) {
    return true;
  }

  const lines = value.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    // Ignore completely blank lines.
    if (trimmed.length === 0) {
      continue;
    }

    // Ignore Markdown headings (lines starting with one or more '#').
    if (/^#+\s*/.test(trimmed)) {
      continue;
    }

    // Ignore Markdown horizontal rules: '---', '***', or '___'.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      continue;
    }

    // Ignore single-line HTML comments.
    if (/^<!--.*-->$/.test(trimmed)) {
      continue;
    }

    // Ignore Markdown comment directives: [//]: # (comment)
    if (/^\[\/\/\]:\s*#\s*\(.*\)\s*$/.test(trimmed)) {
      continue;
    }

    // Any remaining non-empty line counts as content.
    return false;
  }

  // Only ignorable lines were found.
  return true;
}

export default { readAgentHeartbeatFile, isHeartbeatFileEffectivelyEmpty };
