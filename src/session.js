import { createAgentSession, DefaultResourceLoader, createReadTool, createGrepTool, createFindTool, createLsTool } from '@mariozechner/pi-coding-agent';
import { getModel } from '@mariozechner/pi-ai';
import { loadArcanaPlugins } from './plugin-loader.js';
import { startServicesOnce } from './services/manager.js';
// Tool Daemon: singleton per workspace. HTTP server with cancel via fetch Abort.
import { ToolDaemonClient } from './tool-daemon/client.js';
import { createProxyBashTool, createProxyWebRenderTool, createProxyWebExtractTool, createProxyWebSearchTool } from './tools/tooldaemon-proxies.js';
import createCodexSubagentTool from './tools/codex-subagent.js';
import createNotebookTool from './tools/notebook.js';
import createMemoryTools from './tools/memory.js';
import { createAgentMemoryFsTools } from './tools/agent-memory-fs.js';
import createSubagentsTool from './tools/subagents.js';
import { createCronTool } from './tools/cron.js';
import { createHeartbeatTool } from './tools/heartbeat.js';
import { loadArcanaConfig, loadAgentConfig, applyProviderEnv, resolveModelFromConfig, resolveModelFromEnv, inferProviderFromEnv } from './config.js';
import { join, dirname, extname } from 'node:path';
import { resolveArcanaHome } from './arcana-home.js';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { buildArcanaSkillsPrompt, loadArcanaSkills } from './skills.js';
import { loadSkillTools } from './skill-tools.js';
import { ensureArcanaSkillsWatcher } from './skills-watch.js';
import { emit, getContext } from './event-bus.js';
import { ensureReadAllowed } from './workspace-guard.js';
import { resolveAgentHomeRoot } from './agent-guard.js';
import { buildAgentBootstrapContext } from './agent-bootstrap-context.js';
import { globSync } from 'glob';
import { createSecretsContext } from './secrets/index.js';

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

function normalizeAnthropicBase(base){
  let s = String(base || '').trim();
  if (!s) return '';
  // Strip trailing slashes
  s = s.replace(/\/+$/g, '');
  // If the URL ends with '/v1', remove that segment so the
  // Anthropic SDK can safely append '/v1/messages' without
  // producing '/v1/v1/messages'.
  if (s.toLowerCase().endsWith('/v1')) s = s.slice(0, -3);
  return s;
}

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

// --- Secrets context (internal encrypted vault + env) ---

export async function createArcanaSession(opts={}){
  const bootstrapContextMode = String(opts.bootstrapContextMode || "").trim().toLowerCase();
  const workspaceRoot = opts.workspaceRoot || opts.cwd || process.cwd();
  const workspaceRootNormalized = String(workspaceRoot || '').split('\\').join('/');
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

  const secrets = createSecretsContext({ agentHomeRoot });

  function normalizeToolContentBlocks(content){
    if (Array.isArray(content)){
      const blocks = [];
      for (const item of content){
        if (item === null || item === undefined) continue;
        const t = typeof item;
        if (t === 'string' || t === 'number' || t === 'boolean'){
          blocks.push({ type: 'text', text: String(item) });
          continue;
        }
        if (item && typeof item === 'object'){
          const block = item;
          if (typeof block.type === 'string'){
            if (block.type === 'text'){
              const text = typeof block.text === 'string' ? block.text : String(block.text || '');
              blocks.push({ ...block, text });
            } else {
              blocks.push(block);
            }
          } else {
            blocks.push({ type: 'text', text: String(block) });
          }
          continue;
        }
        blocks.push({ type: 'text', text: String(item) });
      }
      return blocks;
    }
    if (content === null || content === undefined) return [];
    const t = typeof content;
    if (t === 'string' || t === 'number' || t === 'boolean'){
      return [{ type: 'text', text: String(content) }];
    }
    if (content && typeof content === 'object'){
      const block = content;
      if (Array.isArray(block)) return normalizeToolContentBlocks(block);
      if (typeof block.type === 'string'){
        if (block.type === 'text'){
          const text = typeof block.text === 'string' ? block.text : String(block.text || '');
          return [{ ...block, text }];
        }
        return [block];
      }
      return [{ type: 'text', text: String(block) }];
    }
    return [{ type: 'text', text: String(content) }];
  }

  function normalizeToolResult(result){
    try {
      if (result && typeof result === 'object'){
        if (Array.isArray(result)){
          return { content: normalizeToolContentBlocks(result) };
        }
        // For object results without an explicit 'content' field, synthesize
        // an empty content array so downstream code never sees undefined.
        if (!('content' in result)) return { ...result, content: [] };
        const normalizedContent = normalizeToolContentBlocks(result.content);
        if (normalizedContent === result.content) return result;
        return { ...result, content: normalizedContent };
      }
      if (result === null || result === undefined) return { content: [] };
      return { content: normalizeToolContentBlocks(result) };
    } catch {
      return result;
    }
  }

  function wrapToolWithSecrets(tool){
    if (!tool || typeof tool.execute !== 'function') return tool;
    const exec = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(callId, args, signal, onUpdate, ctx){
        const ctxWithSecrets = { ...(ctx || {}), secrets };
        let wrappedOnUpdate = onUpdate;
        if (typeof onUpdate === 'function'){
          wrappedOnUpdate = function(partial){
            const normalized = normalizeToolResult(partial);
            return onUpdate(normalized);
          };
        }
        const result = await exec(callId, args, signal, wrappedOnUpdate, ctxWithSecrets);
        return normalizeToolResult(result);
      }
    };
  }

  const providerName = (cfg && cfg.provider) ? String(cfg.provider).trim() : '';
  // Legacy provider key; prefer secrets bindings
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

  const anthropicBaseOverride = normalizeAnthropicBase(cfg?.base_url || process.env.ANTHROPIC_BASE_URL || '');
  if (anthropicBaseOverride && model && model.provider === 'anthropic') model = { ...model, baseUrl: anthropicBaseOverride };

  // Create tool-daemon client and proxy tools. We always register a proxy 'bash'
  // tool, but activation is controlled by execPolicy via setActiveToolsByName.
  const toolDaemon = new ToolDaemonClient({ workspaceRoot });
  const webRender = createProxyWebRenderTool(toolDaemon);
  const webExtract = createProxyWebExtractTool(toolDaemon);
  const webSearchProxy = createProxyWebSearchTool(toolDaemon);
  const bashProxy = createProxyBashTool(toolDaemon);
  // Start core workspace services once per process. This runs before plugins.
  try { await startServicesOnce(); } catch {}

  const { tools: pluginTools, pluginFiles, errors: pluginErrors } = await loadArcanaPlugins(workspaceRoot);
  const filteredPlugins = (pluginTools||[]).filter((t)=> t && !['web_render','web_extract','web_search','bash'].includes(t.name));
  const subagents = createSubagentsTool();
  const codex = createCodexSubagentTool();
  const notebook = createNotebookTool();
  const memoryTools = createMemoryTools();
  const agentMemoryFsTools = createAgentMemoryFsTools();
  const cronTool = createCronTool();
  const heartbeatTool = createHeartbeatTool();
  const pkgRoot = arcanaPkgRoot();
  if (!process.env.ARCANA_PKG_ROOT){
    try { process.env.ARCANA_PKG_ROOT = pkgRoot; } catch {}
  }
  const repoRoot = dirname(pkgRoot);

  let minimalAgentBootstrap = false;
  let contextSessionId = '';
  try {
    const ctx = getContext?.();
    if (ctx && ctx.sessionId) contextSessionId = String(ctx.sessionId || '');
  } catch {}
  if (!contextSessionId && opts && typeof opts.sessionId === 'string'){
    contextSessionId = String(opts.sessionId || '');
  }
  if (contextSessionId && contextSessionId.startsWith('agent:arcana:subagent:')){
    minimalAgentBootstrap = true;
  }

  if (bootstrapContextMode === 'heartbeat_light' || bootstrapContextMode === 'lightweight'){
    minimalAgentBootstrap = true;
  }

  let agentBootstrap = { contextFiles: [], hasSoul: false };
  try {
    agentBootstrap = buildAgentBootstrapContext(agentHomeRoot, { minimal: minimalAgentBootstrap }) || agentBootstrap;
  } catch {}

  let hasSoulHint = false;
  try {
    if (!minimalAgentBootstrap && agentHomeRoot && existsSync(join(agentHomeRoot, 'SOUL.md'))){
      hasSoulHint = true;
    }
  } catch {}

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
    ...agentMemoryFsTools,
    codex,
    subagents,
    cronTool,
    heartbeatTool,
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
    agentDir: agentHomeRoot,
    agentsFilesOverride: (base)=>{
      const heartbeatLight = bootstrapContextMode === 'heartbeat_light';

      const allBaseFiles = base && Array.isArray(base.agentsFiles) ? base.agentsFiles : [];
      let baseFiles = allBaseFiles;
      if (minimalAgentBootstrap && workspaceRootNormalized){
        baseFiles = allBaseFiles.filter((f)=>{
          if (!f || !f.path) return false;
          const p = String(f.path).split('\\').join('/');
          if (!p) return false;
          if (p === workspaceRootNormalized) return true;
          return p.startsWith(workspaceRootNormalized + '/');
        });
      }
      const merged = [...baseFiles];
      const seen = new Set();
      for (const f of baseFiles){
        if (f && typeof f.path === 'string') seen.add(f.path);
      }
      let extra = agentBootstrap && Array.isArray(agentBootstrap.contextFiles) ? agentBootstrap.contextFiles : [];
      if (heartbeatLight){
        const heartbeatPath = agentHomeRoot ? join(agentHomeRoot, 'HEARTBEAT.md') : null;
        if (heartbeatPath){
          extra = extra.filter((f)=> f && typeof f.path === 'string' && f.path === heartbeatPath);
        } else {
          extra = [];
        }
      }
      for (const f of extra){
        if (!f || !f.path || seen.has(f.path)) continue;
        merged.push(f);
      }
      return { agentsFiles: merged };
    },
    appendSystemPromptOverride: (base)=>{
      const extras = [
        join(repoRoot, '.pi', 'APPEND_SYSTEM.md'),
        join(pkgRoot, '.pi', 'APPEND_SYSTEM.md'),
        join(resolveArcanaHome(), 'APPEND_SYSTEM.md'),
      ].map(readIfExists).filter(Boolean);
      const soulLine = hasSoulHint
        ? 'If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.'
        : '';
      if (soulLine) extras.push(soulLine);
      // Append skills prompt after APPEND_SYSTEM.md blocks and SOUL hint
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
            const wrappedCustomTools = nextCustomTools.map((t) => wrapToolWithSecrets(t));

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

  const wrappedBaseTools = baseTools.map((t) => wrapToolWithSecrets(t));
  const wrappedCustomTools = customTools.map((t) => wrapToolWithSecrets(t));

  const created = await createAgentSession({
    cwd: workspaceRoot,
    tools: wrappedBaseTools,
    customTools: wrappedCustomTools,
    model,
    resourceLoader: loader,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });

  createdSession = created && created.session ? created.session : null;

  // Attach the tool-daemon client to the session so server-side abort can cancel active tool calls.
  try {
    if (createdSession && !createdSession._arcanaToolHostClient) createdSession._arcanaToolHostClient = toolDaemon;
  } catch {}

  // Apply per-agent provider API key (runtime override) so pi-ai does not rely on process.env.
  try {
    const prov = providerName || (model && model.provider) || '';
    let key = providerKey;
    if (!key && prov) {
      try {
        key = await secrets.getProviderApiKey(prov);
      } catch {
        key = providerKey;
      }
    }
    if (prov && key && created && created.session && created.session.modelRegistry && created.session.modelRegistry.authStorage && typeof created.session.modelRegistry.authStorage.setRuntimeApiKey === 'function') {
      created.session.modelRegistry.authStorage.setRuntimeApiKey(prov, key);
    }
  } catch {}

  // Apply initial execution policy to active tool names so chat2 sessions
  // honor the requested policy without an extra server-side toggle.
  try {
    const desired = new Set(created.session?.getActiveToolNames?.() || []);
    ['read','grep','find','ls'].forEach((t) => desired.add(t));
    if (execPolicy === 'open') desired.add('bash');
    else desired.delete('bash');
    created.session?.setActiveToolsByName?.(Array.from(desired));
  } catch {}

  const visibleSkillNames = arcanaSkills.map(s=>s.name).filter(Boolean);
  const toolNames = created.session?.getActiveToolNames ? created.session.getActiveToolNames() : baseTools.map(t=>t?.name).filter(Boolean);

  return { session: created.session, model, toolNames, pluginFiles, pluginErrors, skillNames: visibleSkillNames, skillsCount: visibleSkillNames.length, toolHost: toolDaemon, skillToolMap };
}

export default { createArcanaSession };
