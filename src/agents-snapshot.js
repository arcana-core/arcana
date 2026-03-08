import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Load metadata for all configured agents from ~/.arcana/agents.
// Returned shape matches the previous CJS implementation: an array of
// { agentId, agentHomeDir, workspaceRoot } objects.
export async function loadAgentsSnapshot() {
  const homeDir = homedir();
  const agentsRoot = join(homeDir, '.arcana', 'agents');

  let entries;
  try {
    entries = await fsp.readdir(agentsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    return [];
  }

  const results = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const agentId = entry.name;
    const agentHomeDir = join(agentsRoot, agentId);
    const manifestPath = join(agentHomeDir, 'agent.json');

    let manifest = null;
    try {
      const raw = await fsp.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch {
      manifest = null;
    }

    let workspaceRoot = null;
    if (manifest && typeof manifest === 'object') {
      if (typeof manifest.workspaceRoot === 'string') {
        workspaceRoot = manifest.workspaceRoot;
      } else if (manifest.workspace && typeof manifest.workspace.root === 'string') {
        workspaceRoot = manifest.workspace.root;
      }
    }

    results.push({
      agentId,
      agentHomeDir,
      workspaceRoot,
    });
  }

  return results;
}

export default { loadAgentsSnapshot };
