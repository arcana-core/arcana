import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

function resolveHeartbeatConfigPath(agentId) {
  const homeDir = os.homedir();
  const baseDir = join(homeDir, '.arcana', 'agents', String(agentId));
  const filePath = join(baseDir, 'heartbeat.json');
  return { baseDir, filePath };
}

export async function loadHeartbeatConfigForAgent(agentId) {
  if (!agentId) {
    return null;
  }

  const { filePath } = resolveHeartbeatConfigPath(agentId);

  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return null;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

export async function saveHeartbeatConfigForAgent(agentId, config) {
  if (!agentId) {
    return null;
  }

  const toSave = config && typeof config === 'object' ? { ...config } : {};
  const { baseDir, filePath } = resolveHeartbeatConfigPath(agentId);

  try {
    await fsp.mkdir(baseDir, { recursive: true });
  } catch {
    // best-effort; mkdir failures will surface on write
  }

  const tmpPath = `${filePath}.tmp`;
  const data = JSON.stringify(toSave, null, 2);

  await fsp.writeFile(tmpPath, data, 'utf8');
  await fsp.rename(tmpPath, filePath);

  return toSave;
}

export async function patchHeartbeatConfigForAgent(agentId, patch) {
  if (!agentId) {
    return null;
  }

  const current = await loadHeartbeatConfigForAgent(agentId);
  const base = current && typeof current === 'object' ? current : {};
  const patchObj = patch && typeof patch === 'object' ? patch : {};
  const updated = { ...base, ...patchObj };

  return saveHeartbeatConfigForAgent(agentId, updated);
}

export default { loadHeartbeatConfigForAgent, saveHeartbeatConfigForAgent, patchHeartbeatConfigForAgent };
