// Feishu service template. Copy this file to services/feishu.mjs to enable.
// Spawns the local Feishu WS bridge and writes logs to ctx.logDir.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createWriteStream, promises as fsp } from 'node:fs';
import { createSecretsContext } from '../src/secrets/index.js';
import { resolveAgentHomeRoot, resolveAgentId } from '../src/agent-guard.js';

export async function start(ctx){
  const cwd = join(ctx.workspaceRoot, 'skills', 'feishu');
  const scriptRel = 'scripts/feishu-bridge.mjs';

  const agentHomeRoot = resolveAgentHomeRoot();
  const agentId = resolveAgentId();
  const secrets = createSecretsContext({ agentHomeRoot });
  const required = await secrets.require(['services/feishu/app_id', 'services/feishu/app_secret']);
  const appId = String(required['services/feishu/app_id'] || '').trim();
  const encryptKey = String(await secrets.getText('services/feishu/encrypt_key') || '').trim();
  const verificationToken = String(await secrets.getText('services/feishu/verification_token') || '').trim();

  const appSecret = String(required['services/feishu/app_secret'] || '').trim();
  if (!appId || !appSecret){
    throw new Error('Feishu service missing services/feishu/app_id or services/feishu/app_secret');
  }

  const feishuDomain = (process.env.FEISHU_DOMAIN || 'feishu');
  const config = {
    appId,
    appSecret,
    agentId: agentId || '',
    domain: feishuDomain,
    encryptKey: encryptKey || '',
    verificationToken: verificationToken || '',
  };

  await fsp.mkdir(ctx.logDir, { recursive: true });
  const outPath = join(ctx.logDir, 'bridge.stdout.log');
  const errPath = join(ctx.logDir, 'bridge.stderr.log');
  const out = createWriteStream(outPath, { flags: 'a' });
  const err = createWriteStream(errPath, { flags: 'a' });

  const child = spawn(process.execPath || 'node', [scriptRel], {
    cwd: cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    detached: false
  });

  try {
    const json = JSON.stringify(config);
    child.stdin.write(json + '\n');
    child.stdin.end();
  } catch {
    try { child.stdin.end(); } catch {}
  }
  child.stdout.on('data', (d)=>{ out.write(d); });
  child.stderr.on('data', (d)=>{ err.write(d); });
  child.on('close', (code, signal)=>{
    try { out.write('\n[bridge-exit] code=' + code + ' signal=' + signal + '\n'); } catch {}
    try { out.end(); err.end(); } catch {}
  });

  // Provide a stop hook so the manager can terminate the child.
  return {
    async stop(){
      try { child.kill('SIGTERM'); } catch {}
    }
  };
}

export default { start };
