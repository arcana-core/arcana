import { createAgentSession, DefaultResourceLoader, createReadTool, createGrepTool, createFindTool, createLsTool } from '@mariozechner/pi-coding-agent';
import { getModel } from '@mariozechner/pi-ai';
import { loadArcanaPlugins } from './plugin-loader.js';
import { startServicesOnce } from './services/manager.js';
// Scheme C: tool-host isolation. Use proxy tools that delegate to a
// persistent child process which can be killed to cancel hangs.
import { ToolHostClient } from './tool-host-client.js';
import { sweepOrphanedToolHostsOnce } from './tool-host-registry.js';
import { createProxyBashTool, createProxyWebRenderTool, createProxyWebExtractTool, createProxyWebSearchTool } from './tools/toolhost-proxies.js';
import createCodexSubagentTool from './tools/codex-subagent.js';
import createNotebookTool from './tools/notebook.js';
import createMemoryTools from './tools/memory.js';
import createSubagentsTool from './tools/subagents.js';
import { createTimerTool } from './tools/timer.js';
import { loadArcanaConfig, loadAgentConfig, applyProviderEnv, resolveModelFromConfig, resolveModelFromEnv, inferProviderFromEnv } from './config.js';
import { join, dirname, extname } from 'node:path';
import { scryptSync, createDecipheriv } from 'node:crypto';
import { resolveArcanaHome, arcanaHomePath } from './arcana-home.js';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { buildArcanaSkillsPrompt, loadArcanaSkills } from './skills.js';
import { loadSkillTools } from './skill-tools.js';
import { ensureArcanaSkillsWatcher } from './skills-watch.js';
import { emit } from './event-bus.js';
import { ensureReadAllowed } from './workspace-guard.js';
import { resolveAgentHomeRoot } from './agent-guard.js';
import { globSync } from 'glob';

function arcanaPkgRoot(){
  const here = fileURLToPath(new URL('.', import.meta.url)); // arcana/src/
  return join(here, '..'); // arcana/
}

function readIfExists(p){ try{ if (existsSync(p)) return readFileSync(p, 'utf-8'); } catch{} return ''; }

function pickFallbackModel(provider){
  const p = (provider||'').toLowerCase();
  const candidatesByProvider = {
    google: ['gemini-2.0-flash','gemini-2.0-flash-lite','gemini-1.5-flash','gemini-1.5-pro','gemini-2.5-flash-lite-preview-06-17','gemini-2.5-pro-preview-06-17'],
    openai: ['gpt-4o-mini','chatgpt-4o-latest'],
    anthropic: ['claude-3-5-sonnet-20241022'],
    openrouter: ['meta-llama/llama-3.1-8b-instruct:free'],
    xai: ['grok-beta']
  };
  const arr = candidatesByProvider[p] || [];
  for (const id of arr) { try { const m = getModel(p, id); if (m) return m; } catch {} }
  return null;
}

function normalizeOpenAIBase(base){ return String(base||'').trim(); }

function mergeAgentConfig(globalCfg, agentCfg){
  const base = (globalCfg && typeof globalCfg === 'object') ? { ...globalCfg } : {};
  const agent = (agentCfg && typeof agentCfg === 'object') ? agentCfg : null;
  if (agent){
    for (const [k, vRaw] of Object.entries(agent)){
      if (k === 'path') continue;
      const v = vRaw;
      if (v == null) continue;
      if (typeof v === 'string'){
        if (v.trim() === '') continue;
      }
      base[k] = v;
    }
    if (agent.path) base.path = agent.path;
  }
  return base;
}

// --- Env vault overlay (global + per-agent) ---

function isValidEnvName(n){
  try {
    const s = String(n || '');
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  } catch { return false; }
}

function filterValidEnv(obj){
  const out = {};
  try {
    for (const [k, v] of Object.entries(obj || {})){
      if (!isValidEnvName(k)) continue;
      out[k] = v == null ? '' : String(v);
    }
  } catch {}
  return out;
}

function deriveVaultKey(passphrase, kdfParams){
  const base = kdfParams || {};
  const N = typeof base.N === 'number' ? base.N : 16384;
  const r = typeof base.r === 'number' ? base.r : 8;
  const p = typeof base.p === 'number' ? base.p : 1;
  const saltB64 = base.saltB64 || '';
  const salt = Buffer.from(String(saltB64), 'base64');
  const key = scryptSync(String(passphrase || ''), salt, 32, { N, r, p });
  return { key };
}

function decryptVaultValues(fileObj, passphrase){
  if (!fileObj) return {};
  if (!fileObj.encrypted){
    const raw = (fileObj.values && typeof fileObj.values === 'object') ? fileObj.values : {};
    return filterValidEnv(raw);
  }
  const { key } = deriveVaultKey(passphrase, fileObj.kdf || {});
  const cipherMeta = fileObj.cipher || {};
  const ivB64 = cipherMeta.ivB64 || fileObj.ivB64 || fileObj.iv;
  const tagB64 = cipherMeta.tagB64 || fileObj.tagB64 || fileObj.tag;
  const ciphertextB64 = fileObj.ciphertextB64 || fileObj.ciphertext;
  const iv = Buffer.from(String(ivB64 || ''), 'base64');
  const tag = Buffer.from(String(tagB64 || ''), 'base64');
  const enc = Buffer.from(String(ciphertextB64 || ''), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  const obj = JSON.parse(out.toString('utf8') || '{}');
  return filterValidEnv(obj && typeof obj === 'object' ? obj : {});
}

function readGlobalVaultMeta(){
  const path = arcanaHomePath('vault.json');
  const meta = {
    path,
    hasFile: false,
    encrypted: false,
    names: [],
  };
  try {
    if (!path || !existsSync(path)) return meta;
    const text = readFileSync(path, 'utf8');
    if (!text) {
      return { ...meta, hasFile: true };
    }
    const data = JSON.parse(text);
    const encrypted = !!(data && data.encrypted);
    let names = [];
    if (Array.isArray(data.names)) names = data.names;
    else if (data && data.values && typeof data.values === 'object') names = Object.keys(data.values);
    names = names.filter((n) => isValidEnvName(n));
    return {
      path,
      hasFile: true,
      encrypted,
      names,
    };
  } catch {
    return meta;
  }
}

function agentVaultPath(agentHomeRoot){
  const base = String(agentHomeRoot || '').trim();
  if (!base) return '';
  return join(base, 'vault.json');
}

function readAgentVaultState(agentHomeRoot){
  const path = agentVaultPath(agentHomeRoot);
  const empty = {
    path: path || '',
    hasFile: false,
    encrypted: false,
    locked: false,
    names: [],
    inheritGlobal: true,
    values: {},
  };
  try {
    if (!path || !existsSync(path)) return empty;
    const text = readFileSync(path, 'utf8');
    if (!text) {
      return { ...empty, hasFile: true };
    }
    const data = JSON.parse(text);
    const encrypted = !!(data && data.encrypted);
    let names = [];
    if (Array.isArray(data.names)) names = data.names;
    else if (!encrypted && data && data.values && typeof data.values === 'object') names = Object.keys(data.values);
    names = names.filter((n) => isValidEnvName(n));
    const inheritGlobal = (typeof data.inheritGlobal === 'boolean') ? data.inheritGlobal : true;
    let values = {};
    let locked = false;
    if (!encrypted){
      const raw = (data && data.values && typeof data.values === 'object') ? data.values : {};
      values = filterValidEnv(raw);
    } else {
      const envPass = String(process.env.ARCANA_VAULT_PASSPHRASE || '').trim();
      if (!envPass) {
        locked = true;
      } else {
        try { values = decryptVaultValues(data, envPass); }
        catch { locked = true; values = {}; }
      }
    }
    return {
      path,
      hasFile: true,
      encrypted,
      locked,
      names,
      inheritGlobal,
      values,
    };
  } catch {
    return empty;
  }
}

class AsyncMutex{
  constructor(){
    this._locked = false;
    this._waiters = [];
  }
  async acquire(){
    if (!this._locked){
      this._locked = true;
      return;
    }
    await new Promise((resolve) => { this._waiters.push(resolve); });
  }
  release(){
    if (this._waiters.length){
      const next = this._waiters.shift();
      try { next(); } catch {}
    } else {
      this._locked = false;
    }
  }
  async runExclusive(fn){
    await this.acquire();
    try { return await fn(); }
    finally { this.release(); }
  }
}

const envOverlayMutex = new AsyncMutex();
const sweptToolHostWorkspaces = new Set();

async function runWithEnvOverlay(agentHomeRoot, fn){
  const globalMeta = readGlobalVaultMeta();
  const agentMeta = readAgentVaultState(agentHomeRoot);
  const globalNames = new Set(globalMeta.names || []);
  const agentValues = agentMeta.values || {};
  const inheritGlobal = agentMeta.inheritGlobal !== false;

  const hasGlobalNames = globalNames.size > 0;
  const hasAgentValues = Object.keys(agentValues).length > 0;
  const shouldHideGlobal = hasGlobalNames && inheritGlobal === false;

  if (!shouldHideGlobal && !hasAgentValues){
    return fn();
  }

  return envOverlayMutex.runExclusive(async () => {
    const previous = new Map();
    try {
      if (shouldHideGlobal){
        for (const name of globalNames){
          if (!previous.has(name)){
            if (Object.prototype.hasOwnProperty.call(process.env, name)) previous.set(name, process.env[name]);
            else previous.set(name, undefined);
          }
          delete process.env[name];
        }
      }
      for (const [k, v] of Object.entries(agentValues)){
        if (!previous.has(k)){
          if (Object.prototype.hasOwnProperty.call(process.env, k)) previous.set(k, process.env[k]);
          else previous.set(k, undefined);
        }
        process.env[k] = v == null ? '' : String(v);
      }
      return await fn();
    } finally {
      for (const [k, v] of previous.entries()){
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
}

function wrapToolWithEnvOverlay(tool, agentHomeRoot){
  if (!tool || typeof tool.execute !== 'function') return tool;
  const exec = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(...args){
      return runWithEnvOverlay(agentHomeRoot, () => exec(...args));
    }
  };
}

export async function runWithAgentEnvOverlay(agentHomeRoot, fn){
  return runWithEnvOverlay(agentHomeRoot, fn);
}

export async function createArcanaSession(opts={}){
  const workspaceRoot = opts.workspaceRoot || opts.cwd || process.cwd();
  const sweepKey = String(workspaceRoot || '').trim();
  if (sweepKey && !sweptToolHostWorkspaces.has(sweepKey)){
    sweptToolHostWorkspaces.add(sweepKey);
    try { sweepOrphanedToolHostsOnce(workspaceRoot); } catch {}
  }
  let agentHomeRoot = opts.agentHomeRoot;
  if (!agentHomeRoot){
    try {
      agentHomeRoot = resolveAgentHomeRoot();
    } catch {
      agentHomeRoot = workspaceRoot;
    }
  }
  const globalCfg = loadArcanaConfig();
  applyProviderEnv(globalCfg);

  const agentCfg = loadAgentConfig(agentHomeRoot);
  const cfg = mergeAgentConfig(globalCfg, agentCfg);

  const providerName = (cfg && cfg.provider) ? String(cfg.provider).trim() : '';
  const providerKey = (cfg && cfg.key) ? String(cfg.key).trim() : '';

  let model;
  const sel = resolveModelFromConfig(cfg) || resolveModelFromEnv();
  if (sel) { try { model = getModel(sel.provider, sel.id); } catch {} }
  if (!model) {
    const provider = (cfg?.provider || inferProviderFromEnv() || '').toLowerCase();
    if (provider) model = pickFallbackModel(provider);
  }
  const baseOverride = normalizeOpenAIBase(cfg?.base_url || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || '');
  if (baseOverride && model && model.provider === 'openai') model = { ...model, baseUrl: baseOverride };

  // Create tool-host client and proxy tools. We always register a proxy 'bash'
  // tool, but activation is controlled by execPolicy via setActiveToolsByName.
  const toolHost = new ToolHostClient({ cwd: workspaceRoot });
  const webRender = createProxyWebRenderTool(toolHost);
  const webExtract = createProxyWebExtractTool(toolHost);
  const webSearchProxy = createProxyWebSearchTool(toolHost);
  const bashProxy = createProxyBashTool(toolHost);
  // Start core workspace services once per process. This runs before plugins.
  try { await startServicesOnce(); } catch {}

  const { tools: pluginTools, pluginFiles, errors: pluginErrors } = await loadArcanaPlugins(workspaceRoot);
  const filteredPlugins = (pluginTools||[]).filter((t)=> t && !['web_render','web_extract','web_search','bash'].includes(t.name));
  const subagents = createSubagentsTool();
  const codex = createCodexSubagentTool();
  const notebook = createNotebookTool();
  const memoryTools = createMemoryTools();
  const timerTool = createTimerTool();
  const pkgRoot = arcanaPkgRoot();
  if (!process.env.ARCANA_PKG_ROOT){
    try { process.env.ARCANA_PKG_ROOT = pkgRoot; } catch {}
  }
  const repoRoot = dirname(pkgRoot);
  // Skill-scoped tools (preload definitions; activation controlled by skill gate)
  let arcanaSkills = loadArcanaSkills({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot });
  let skillTools = []; let skillToolMap = new Map();
  try {
    const res = await loadSkillTools(arcanaSkills);
    skillTools = res.tools || [];
    skillToolMap = res.skillToolNamesBySkill || new Map();
  } catch {}
  const buildCustomTools = () => ([
    notebook,
    ...memoryTools,
    codex,
    subagents,
    timerTool,
    ...filteredPlugins,
    ...skillTools,
    webRender,
    webExtract,
    webSearchProxy,
    bashProxy,
  ]);

  const customTools = buildCustomTools();

  // Compute skills prompt early so the resource loader can append it
  let skillsPrompt = buildArcanaSkillsPrompt({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot });
  const loader = new DefaultResourceLoader({
    cwd: workspaceRoot,
    appendSystemPromptOverride: (base)=>{
      const extras = [
        join(repoRoot, '.pi', 'APPEND_SYSTEM.md'),
        join(pkgRoot, '.pi', 'APPEND_SYSTEM.md'),
        join(resolveArcanaHome(), 'APPEND_SYSTEM.md'),
      ].map(readIfExists).filter(Boolean);
      // Append skills prompt after APPEND_SYSTEM.md blocks
      if (skillsPrompt && skillsPrompt.trim()) extras.push(skillsPrompt);
      const merged = [...(base||[])];
      for (const s of extras){ if (s && !merged.includes(s)) merged.push(s); }
      return merged;
    }
  });
  await loader.reload();
  let createdSession = null;
  // Start a lightweight watcher that refreshes the skills prompt when SKILL.md files change
  try {
    ensureArcanaSkillsWatcher({
      workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot,
      onChange: () => {
        (async () => {
          try {
            skillsPrompt = buildArcanaSkillsPrompt({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot });
            arcanaSkills = loadArcanaSkills({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot });
            try {
              const res = await loadSkillTools(arcanaSkills);
              skillTools = res.tools || [];
              skillToolMap = res.skillToolNamesBySkill || new Map();
            } catch {}

            const nextCustomTools = buildCustomTools();
            const wrappedCustomTools = nextCustomTools.map((t) => wrapToolWithEnvOverlay(t, agentHomeRoot));

            if (createdSession && typeof createdSession.reload === 'function') {
              try {
                createdSession._customTools = wrappedCustomTools;
                await createdSession.reload();
              } catch {}
            } else {
              const p = loader.reload();
              if (p && typeof p.then === 'function') p.catch(() => {});
            }
          } catch {}
          try {
            emit({ type: 'skills_refresh', reason: 'watch' });
          } catch {}
        })().catch(() => {});
      }
    });
  } catch {}

  // thinking level: env > config > off
  const rawThinking = String(process.env.ARCANA_THINKING || cfg?.thinking || '').trim().toLowerCase();
  const allowed = new Set(['off','minimal','low','medium','high','xhigh']);
  const thinkingLevel = allowed.has(rawThinking) ? rawThinking : undefined;

  // Determine execution policy -> base built-in tools
  // Backwards compatibility: allow env var when opts.execPolicy is not provided
  const rawPolicy = String(opts.execPolicy || process.env.ARCANA_EXEC_POLICY || '').trim().toLowerCase();
  const execPolicy = rawPolicy === 'open' ? 'open' : 'restricted';

  // Workspace-guarded built-in tools. All operations call ensureReadAllowed(path).
  const readTool = createReadTool(workspaceRoot, {
    operations: {
      access: async (p) => { await fsp.access(ensureReadAllowed(p)); },
      readFile: async (p) => fsp.readFile(ensureReadAllowed(p)),
      // Lightweight image type detection based on file extension.
      detectImageMimeType: async (p) => {
        const e = extname(String(p)).toLowerCase();
        if (e === '.png') return 'image/png';
        if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
        if (e === '.gif') return 'image/gif';
        if (e === '.webp') return 'image/webp';
        return null;
      }
    }
  });

  const grepTool = createGrepTool(workspaceRoot, {
    operations: {
      isDirectory: async (p) => {
        const st = await fsp.stat(ensureReadAllowed(p));
        return st.isDirectory();
      },
      readFile: async (p) => fsp.readFile(ensureReadAllowed(p), 'utf-8'),
    }
  });

  const lsTool = createLsTool(workspaceRoot, {
    operations: {
      exists: async (p) => { try { await fsp.access(ensureReadAllowed(p)); return true; } catch { return false; } },
      stat: async (p) => fsp.stat(ensureReadAllowed(p)),
      readdir: async (p) => fsp.readdir(ensureReadAllowed(p)),
    }
  });

  const findTool = createFindTool(workspaceRoot, {
    operations: {
      exists: async (p) => { try { await fsp.access(ensureReadAllowed(p)); return true; } catch { return false; } },
      // Use globSync with ignore rules and enforce workspace guard.
      glob: async (pattern, searchCwd, options) => {
        const base = ensureReadAllowed(searchCwd || '.');
        const ig = (options?.ignore && Array.isArray(options.ignore)) ? options.ignore : ['**/node_modules/**','**/.git/**'];
        const limit = typeof options?.limit === 'number' ? options.limit : 1000;
        const matches = globSync(pattern, { cwd: base, dot: true, absolute: true, ignore: ig }) || [];
        return matches.slice(0, Math.max(1, limit));
      }
    }
  });

  // Register only read/grep/find/ls as base tools. We purposely exclude built-in
  // bash/edit/write. 'bash' is available via our proxy in customTools and can be
  // enabled by policy at runtime.
  const baseTools = [readTool, grepTool, findTool, lsTool];
  const wrappedBaseTools = baseTools.map((t) => wrapToolWithEnvOverlay(t, agentHomeRoot));
  const wrappedCustomTools = customTools.map((t) => wrapToolWithEnvOverlay(t, agentHomeRoot));

  const created = await createAgentSession({
    cwd: workspaceRoot,
    tools: wrappedBaseTools,
    customTools: wrappedCustomTools,
    model,
    resourceLoader: loader,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });

  createdSession = created && created.session ? created.session : null;

  // Apply per-agent provider API key (runtime override) so pi-ai does not rely on process.env.
  try {
    const prov = providerName || (model && model.provider) || '';
    if (prov && providerKey && created && created.session && created.session.modelRegistry && created.session.modelRegistry.authStorage && typeof created.session.modelRegistry.authStorage.setRuntimeApiKey === 'function') {
      created.session.modelRegistry.authStorage.setRuntimeApiKey(prov, providerKey);
    }
  } catch {}

  // Apply initial execution policy to active tool names so chat2 sessions
  // honor the requested policy without an extra server-side toggle.
  try {
    const desired = new Set(created.session?.getActiveToolNames?.() || []);
    ['read','grep','find','ls'].forEach((t) => desired.add(t));
    if (execPolicy === 'open') desired.add('bash');
    else desired.delete('bash');
    desired.delete('edit');
    desired.delete('write');
    created.session?.setActiveToolsByName?.(Array.from(desired));
  } catch {}

  const visibleSkillNames = arcanaSkills.map(s=>s.name).filter(Boolean);
  const toolNames = created.session?.getActiveToolNames ? created.session.getActiveToolNames() : baseTools.map(t=>t?.name).filter(Boolean);

  return { session: created.session, model, toolNames, pluginFiles, pluginErrors, skillNames: visibleSkillNames, skillsCount: visibleSkillNames.length, toolHost, skillToolMap };
}

export default { createArcanaSession };
