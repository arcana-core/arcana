// Feishu service template. Copy this file to services/feishu.mjs to enable.
// Spawns the local Feishu WS bridge and writes logs to ctx.logDir.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createWriteStream, promises as fsp } from 'node:fs';
import { arcanaHomePath } from '../src/arcana-home.js';
import { createSecretsContext, secrets } from '../src/secrets/index.js';
import { resolveAgentHomeRoot, resolveAgentId } from '../src/agent-guard.js';

const REQUIRED_SECRET_NAMES = ['services/feishu/app_id', 'services/feishu/app_secret'];

function sanitizeAgentId(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/[^A-Za-z0-9_-]/g, '_').trim();
}

async function discoverAgentChannels() {
  const agentsDir = arcanaHomePath('agents');
  let entries = [];
  try {
    entries = await fsp.readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return [];
  }

  const channels = [];
  for (const entry of entries) {
    if (!entry || !entry.isDirectory?.()) continue;
    const agentId = sanitizeAgentId(entry.name);
    if (!agentId) continue;

    const agentHomeRoot = arcanaHomePath('agents', agentId);
    let names;
    try {
      names = await secrets.listNames(agentHomeRoot);
    } catch {
      continue;
    }

    const hasScopedSecrets = REQUIRED_SECRET_NAMES.every((name) => {
      const binding = names?.bindings?.[name];
      return !!(binding && binding.hasAgent);
    });
    if (!hasScopedSecrets) continue;

    channels.push({ agentId, agentHomeRoot });
  }

  return channels;
}

async function loadChannelConfig(agentId, agentHomeRoot) {
  const ctx = createSecretsContext({ agentHomeRoot });
  const required = await ctx.require(REQUIRED_SECRET_NAMES);
  const appId = String(required['services/feishu/app_id'] || '').trim();
  const appSecret = String(required['services/feishu/app_secret'] || '').trim();
  const encryptKey = String(await ctx.getText('services/feishu/encrypt_key') || '').trim();
  const verificationToken = String(await ctx.getText('services/feishu/verification_token') || '').trim();

  if (!appId || !appSecret) {
    throw new Error(`Feishu channel "${agentId}" missing services/feishu/app_id or services/feishu/app_secret`);
  }

  return {
    agentId: agentId || '',
    appId,
    appSecret,
    encryptKey: encryptKey || '',
    verificationToken: verificationToken || '',
  };
}

function stopChild(child) {
  try { child.kill('SIGTERM'); } catch {}
}

function closeStream(stream) {
  try { stream.end(); } catch {}
}

function parseBool(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

async function spawnBridge(ctx, cwd, scriptRel, feishuDomain, channel, arcanaServerUrl, requireMention) {
  const outPath = join(ctx.logDir, `bridge.${channel.agentId}.stdout.log`);
  const errPath = join(ctx.logDir, `bridge.${channel.agentId}.stderr.log`);
  const out = createWriteStream(outPath, { flags: 'a' });
  const err = createWriteStream(errPath, { flags: 'a' });

  const child = spawn(process.execPath || 'node', [scriptRel], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ARCANA_SERVER_URL: arcanaServerUrl },
    detached: false,
  });

  let ready = false;
  try {
    const json = JSON.stringify({
      appId: channel.appId,
      appSecret: channel.appSecret,
      agentId: channel.agentId || '',
      domain: feishuDomain,
      encryptKey: channel.encryptKey || '',
      verificationToken: channel.verificationToken || '',
      requireMention,
    });
    child.stdin.write(json + '\n');
    child.stdin.end();
    ready = true;
  } finally {
    if (!ready) {
      try { child.stdin.end(); } catch {}
    }
  }

  child.stdout.on('data', (d) => { out.write(d); });
  child.stderr.on('data', (d) => { err.write(d); });
  child.on('close', (code, signal) => {
    try { out.write('\n[bridge-exit] code=' + code + ' signal=' + signal + '\n'); } catch {}
    closeStream(out);
    closeStream(err);
  });
  child.on('error', (error) => {
    try { err.write('[bridge-error] ' + (error?.stack || error?.message || String(error)) + '\n'); } catch {}
  });

  return { child, out, err };
}

export async function start(ctx){
  const cwd = join(ctx.workspaceRoot, 'skills', 'feishu');
  const scriptRel = 'scripts/feishu-bridge.mjs';
  const arcanaServerUrl = (process.env.ARCANA_SERVER_URL || 'http://127.0.0.1:8787').trim();
  const requireMention = parseBool(process.env.FEISHU_GROUP_REQUIRE_MENTION, false);

  await fsp.mkdir(ctx.logDir, { recursive: true });

  const feishuDomain = (process.env.FEISHU_DOMAIN || 'feishu');
  const discoveredChannels = await discoverAgentChannels();
  const channelConfigs = [];
  const loadErrors = [];

  if (discoveredChannels.length > 0) {
    for (const channel of discoveredChannels) {
      try {
        channelConfigs.push(await loadChannelConfig(channel.agentId, channel.agentHomeRoot));
      } catch (error) {
        loadErrors.push(`${channel.agentId}: ${error?.message || String(error)}`);
      }
    }
    if (channelConfigs.length === 0) {
      throw new Error(
        'Feishu service could not start any auto-discovered agent channels. ' +
        'Each discovered agent must have agent-scoped services/feishu/app_id and services/feishu/app_secret. ' +
        `Failures: ${loadErrors.join('; ')}`
      );
    }
  } else {
    const agentHomeRoot = resolveAgentHomeRoot();
    const agentId = resolveAgentId();
    try {
      channelConfigs.push(await loadChannelConfig(agentId, agentHomeRoot));
    } catch (error) {
      const message = error?.message || String(error);
      throw new Error(
        'Feishu service could not start: no auto-discovered agent channels were found and the legacy fallback channel is missing secrets. ' +
        `Agent "${agentId}" error: ${message}`
      );
    }
  }

  const bridges = [];
  try {
    for (const channel of channelConfigs) {
      bridges.push(await spawnBridge(ctx, cwd, scriptRel, feishuDomain, channel, arcanaServerUrl, requireMention));
    }
  } catch (error) {
    for (const bridge of bridges) {
      stopChild(bridge.child);
      closeStream(bridge.out);
      closeStream(bridge.err);
    }
    throw error;
  }

  return {
    async stop(){
      for (const bridge of bridges) {
        stopChild(bridge.child);
      }
    }
  };
}

export default { start };
