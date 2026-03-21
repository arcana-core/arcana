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
import * as globPkg from 'glob';
import { createSecretsContext } from './secrets/index.js';

const globSync = (...args) => (globPkg.globSync ?? globPkg.sync)(...args);

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
		'openai-compatible': ['gpt-4o-mini','chatgpt-4o-latest'],
		anthropic: ['claude-3-5-sonnet-20241022'],
		openrouter: ['meta-llama/llama-3.1-8b-instruct:free'],
		xai: ['grok-beta']
	};
	// Map "openai-compatible" to the underlying pi-ai provider id.
	const providerForModels = p === 'openai-compatible' ? 'openai' : p;
	const arr = candidatesByProvider[p] || candidatesByProvider[providerForModels] || [];
	for (const id of arr) { try { const m = getModel(providerForModels, id); if (m) return m; } catch {} }
	return null;
}

function normalizeOpenAIBase(base){
  let s = String(base || '').trim();
  if (!s) return '';
  // Normalize trailing slashes to avoid duplicating path segments.
  s = s.replace(/\/+$/g, '');
  const lower = s.toLowerCase();
  const endpoints = ['/chat/completions', '/completions', '/responses'];
  for (const ep of endpoints){
    const epLen = ep.length;
    const withV1 = '/v1' + ep;
    if (lower.endsWith(withV1)){
      // Keep trailing '/v1' and strip only the endpoint suffix.
      return s.slice(0, s.length - epLen);
    }
    if (lower.endsWith(ep)){
      return s.slice(0, s.length - epLen);
    }
  }
  return s;
}

function normalizeAnthropicBase(base){
  let s = String(base || '').trim();
  if (!s) return '';
  // Strip trailing slashes first so suffix checks are reliable.
  s = s.replace(/\/+$/g, '');
  const lower = s.toLowerCase();
  if (lower.endsWith('/v1/messages')){
    // Users often paste the full messages endpoint; drop it so the
    // Anthropic SDK does not append '/v1/messages' twice.
    s = s.slice(0, s.length - '/v1/messages'.length);
  } else if (lower.endsWith('/messages')){
    s = s.slice(0, s.length - '/messages'.length);
  } else if (lower.endsWith('/v1')){
    s = s.slice(0, s.length - '/v1'.length);
  }
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

  function filterDisabledSkillsForConfig(allSkills, cfg){
    try {
      const skills = Array.isArray(allSkills) ? allSkills : [];
      const disabledArr = cfg && cfg.skills && Array.isArray(cfg.skills.disabled) ? cfg.skills.disabled : [];
      if (!disabledArr || !disabledArr.length) return skills;
      const disabled = new Set();
      for (const raw of disabledArr){
        if (typeof raw !== 'string') continue;
        const name = raw.trim();
        if (!name) continue;
        disabled.add(name);
      }
      if (!disabled.size) return skills;
      return skills.filter((s)=>{
        try {
          const n = String(s && s.name || '').trim();
          if (!n) return false;
          return !disabled.has(n);
        } catch {
          return true;
        }
      });
    } catch {
      return Array.isArray(allSkills) ? allSkills : [];
    }
  }

  const providerName = (cfg && cfg.provider) ? String(cfg.provider).trim() : '';
  // Legacy provider key; prefer secrets bindings
  const providerKey = (cfg && cfg.key) ? String(cfg.key).trim() : '';

  // Inline provider/model definitions: cfg.models.providers
  const inlineProvidersCfg = cfg && cfg.models && cfg.models.providers && typeof cfg.models.providers === 'object'
    ? cfg.models.providers
    : null;

  function normalizeInlineProviderId(p){
    return String(p || '').trim().toLowerCase();
  }

  function buildInlineProvidersIndex(raw){
    if (!raw || typeof raw !== 'object') return null;
    const index = new Map();
    for (const [key, value] of Object.entries(raw)){
      const norm = normalizeInlineProviderId(key);
      if (!norm) continue;
      if (!index.has(norm)){
        const cfgObj = value && typeof value === 'object' ? value : {};
        index.set(norm, { key, cfg: cfgObj });
      }
    }
    return index;
  }

  const inlineProvidersIndex = buildInlineProvidersIndex(inlineProvidersCfg);

  function getInlineProviderEntry(name){
    if (!inlineProvidersIndex) return null;
    const norm = normalizeInlineProviderId(name);
    if (!norm) return null;
    const entry = inlineProvidersIndex.get(norm);
    return entry || null;
  }

  function buildProviderModelsMap(providerCfg){
    if (!providerCfg || typeof providerCfg !== 'object') return null;
    const src = providerCfg.models;
    if (!src) return null;
    if (Array.isArray(src)){
      const map = {};
      for (const item of src){
        if (!item || typeof item !== 'object') continue;
        const id = item.id != null ? String(item.id).trim() : '';
        if (!id) continue;
        map[id] = item;
      }
      return map;
    }
    if (typeof src === 'object') return src;
    return null;
  }

  function mergeProviderAndModelTemplate(providerCfg, modelCfg){
    const base = providerCfg && typeof providerCfg === 'object' ? providerCfg : {};
    const model = modelCfg && typeof modelCfg === 'object' ? modelCfg : {};
    const merged = { ...base, ...model };

    const providerHeaders = (base && typeof base.headers === 'object') ? base.headers : null;
    const modelHeaders = (model && typeof model.headers === 'object') ? model.headers : null;
    if (providerHeaders || modelHeaders){
      merged.headers = { ...(providerHeaders || {}), ...(modelHeaders || {}) };
    }

    // Do not leak nested models/defaultModel fields into individual model templates.
    delete merged.models;
    delete merged.defaultModel;
    return merged;
  }

  function hasInlineBaseUrl(providerCfg, modelCfg){
    const hasFrom = (obj)=>{
      if (!obj || typeof obj !== 'object') return false;
      if (Object.prototype.hasOwnProperty.call(obj, 'baseUrl')){
        const v = obj.baseUrl;
        if (v != null && String(v).trim()) return true;
      }
      if (Object.prototype.hasOwnProperty.call(obj, 'baseURL')){
        const v = obj.baseURL;
        if (v != null && String(v).trim()) return true;
      }
      if (Object.prototype.hasOwnProperty.call(obj, 'base_url')){
        const v = obj.base_url;
        if (v != null && String(v).trim()) return true;
      }
      return false;
    };
    return hasFrom(modelCfg) || hasFrom(providerCfg);
  }

  let inlineBaseUrlExplicit = false;

  function buildModelFromInline(provider, id, template){
    const prov = String(provider || '').trim();
    const modelId = String(id || '').trim();
    if (!prov || !modelId) return null;

    const provNorm = prov.toLowerCase();
    const providerForLookup = provNorm === 'openai-compatible' ? 'openai' : provNorm;

    let baseTemplate = null;
    try {
      baseTemplate = getModel(providerForLookup, modelId);
    } catch {}

    const src = template && typeof template === 'object' ? template : {};

    const api = String(src.api || (baseTemplate && baseTemplate.api) || 'openai-completions');

    let baseUrl = src.baseUrl || src.baseURL || src.base_url || (baseTemplate && (baseTemplate.baseUrl || baseTemplate.baseURL || baseTemplate.base_url)) || '';
    if (api === 'anthropic-messages') baseUrl = normalizeAnthropicBase(baseUrl);
    else if (api === 'openai-completions' || api === 'openai-responses' || api === 'openai-codex-responses' || api === 'azure-openai-responses') baseUrl = normalizeOpenAIBase(baseUrl);
    else {
      let s = String(baseUrl || '').trim();
      if (s) s = s.replace(/\/+$/g, '');
      baseUrl = s;
    }

    const baseHeaders = (baseTemplate && baseTemplate.headers && typeof baseTemplate.headers === 'object') ? baseTemplate.headers : {};
    const overrideHeaders = (src.headers && typeof src.headers === 'object') ? src.headers : {};

    const result = {
      id: modelId,
      name: String(src.name || (baseTemplate && baseTemplate.name) || modelId),
      provider: provNorm,
      api,
      baseUrl,
      reasoning: src.reasoning != null ? !!src.reasoning : !!(baseTemplate && baseTemplate.reasoning),
      input: Array.isArray(src.input) && src.input.length ? src.input : (baseTemplate && Array.isArray(baseTemplate.input) && baseTemplate.input.length ? baseTemplate.input : ['text']),
      cost: src.cost && typeof src.cost === 'object' ? src.cost : (baseTemplate && baseTemplate.cost) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: typeof src.contextWindow === 'number' ? src.contextWindow : (baseTemplate && typeof baseTemplate.contextWindow === 'number' ? baseTemplate.contextWindow : 200000),
      maxTokens: typeof src.maxTokens === 'number' ? src.maxTokens : (baseTemplate && typeof baseTemplate.maxTokens === 'number' ? baseTemplate.maxTokens : 8192),
      headers: { ...baseHeaders, ...overrideHeaders },
    };

    // Preserve any additional fields from the inline template (e.g., compat)
    for (const [k, v] of Object.entries(src)){
      if (Object.prototype.hasOwnProperty.call(result, k)) continue;
      result[k] = v;
    }

    return result;
  }

  function resolveModel(){
    inlineBaseUrlExplicit = false;
    const sel = resolveModelFromConfig(cfg) || resolveModelFromEnv();
    let model = null;
    let selProvider = '';
    let selId = '';
    if (sel){
      selProvider = String(sel.provider || '').trim();
      selId = String(sel.id || '').trim();
      const inlineEntry = selProvider ? getInlineProviderEntry(selProvider) : null;
      if (inlineEntry){
        const providerCfg = inlineEntry.cfg || {};
        const providerKey = inlineEntry.key;
        const modelsMap = buildProviderModelsMap(providerCfg);
        if (modelsMap && Object.prototype.hasOwnProperty.call(modelsMap, selId)){
          const modelCfg = modelsMap[selId] || {};
          const template = mergeProviderAndModelTemplate(providerCfg, modelCfg);
          inlineBaseUrlExplicit = hasInlineBaseUrl(providerCfg, modelCfg);
          model = buildModelFromInline(providerKey, selId, template);
        } else {
          // Inline provider exists but model id is not explicitly listed: allow fallback construction
          inlineBaseUrlExplicit = hasInlineBaseUrl(providerCfg, null);
          model = buildModelFromInline(providerKey, selId, providerCfg || {});
        }
      }
      if (!model){
        try {
          const norm = normalizeInlineProviderId(selProvider);
          const providerForLookup = norm === 'openai-compatible' ? 'openai' : (norm || selProvider);
          model = getModel(providerForLookup, selId);
        } catch {}
      }
    }
    if (!model){
      const rawProvider = cfg?.provider || inferProviderFromEnv() || '';
      const providerNorm = normalizeInlineProviderId(rawProvider);
      if (inlineProvidersIndex && providerNorm){
        const inlineEntry = inlineProvidersIndex.get(providerNorm);
        if (inlineEntry){
          const providerCfg = inlineEntry.cfg || {};
          const providerKey = inlineEntry.key;
          // If a default model id is specified on the provider entry, prefer it;
          // otherwise try to build from the provider entry itself using the selected id (if any).
          let defaultId = '';
          try {
            if (providerCfg && typeof providerCfg === 'object' && providerCfg.defaultModel){
              defaultId = String(providerCfg.defaultModel || '').trim();
            }
          } catch {}
          const id = defaultId || selId || '';
          if (id){
            const modelsMap = buildProviderModelsMap(providerCfg);
            if (modelsMap && Object.prototype.hasOwnProperty.call(modelsMap, id)){
              const modelCfg = modelsMap[id] || {};
              const template = mergeProviderAndModelTemplate(providerCfg, modelCfg);
              inlineBaseUrlExplicit = hasInlineBaseUrl(providerCfg, modelCfg);
              model = buildModelFromInline(providerKey, id, template);
            } else {
              inlineBaseUrlExplicit = hasInlineBaseUrl(providerCfg, null);
              model = buildModelFromInline(providerKey, id, providerCfg || {});
            }
          }
        }
      }
      if (!model && providerNorm) model = pickFallbackModel(providerNorm);
    }

    // Legacy cfg.base_url / env overrides for OpenAI/Anthropic.
    const baseOverrideRaw = cfg?.base_url || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || '';
    const baseOverrideOpenAI = normalizeOpenAIBase(baseOverrideRaw || '');
    if (baseOverrideOpenAI && model && !inlineBaseUrlExplicit){
      const providerNorm = String(model.provider || '').trim().toLowerCase();
      if (providerNorm === 'openai' || providerNorm === 'openai-compatible'){
        model = { ...model, baseUrl: baseOverrideOpenAI };
      }
    }

    const anthropicBaseRaw = cfg?.base_url || process.env.ANTHROPIC_BASE_URL || '';
    const anthropicBaseOverride = normalizeAnthropicBase(anthropicBaseRaw || '');
    if (anthropicBaseOverride && model && !inlineBaseUrlExplicit){
      const providerNorm = String(model.provider || '').trim().toLowerCase();
      if (providerNorm === 'anthropic'){
        model = { ...model, baseUrl: anthropicBaseOverride };
      }
    }

    return model;
  }

  let model = resolveModel();

  // Inject Codex CLI identification headers for OpenAI provider.
  // The OpenAI API requires `originator: codex_cli_rs` header for certain models/endpoints,
  // otherwise it returns 400 "This API endpoint is only accessible via the official Codex CLI".
  if (model){
    const modelProviderNorm = String(model.provider || '').trim().toLowerCase();
    if (modelProviderNorm === 'openai' && providerName.toLowerCase() === 'openai') {
      model = {
        ...model,
        headers: {
          ...model.headers,
          'originator': 'codex_cli_rs',
          'User-Agent': 'codex/0.1.0',
        }
      };
    }
  }

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

  // Skill-scoped tools (preload definitions; activation controlled by per-agent toggles)
  let arcanaSkills = loadArcanaSkills({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot });
  arcanaSkills = filterDisabledSkillsForConfig(arcanaSkills, cfg);
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
  // Start a lightweight watcher that refreshes the skills prompt when skills change
  try {
    ensureArcanaSkillsWatcher({
      workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot,
      onChange: () => {
        (async () => {
          try {
            skillsPrompt = buildArcanaSkillsPrompt({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot });
            arcanaSkills = loadArcanaSkills({ workspaceRoot, agentHomeRoot, cfg, pkgRoot, repoRoot });
            arcanaSkills = filterDisabledSkillsForConfig(arcanaSkills, cfg);
            try {
              const res = await loadSkillTools(arcanaSkills);
              skillTools = res.tools || [];
              skillToolMap = res.skillToolNamesBySkill || new Map();
            } catch {}

            const nextCustomTools = buildCustomTools();
            const wrappedCustomTools = nextCustomTools.map((t) => wrapToolWithSecrets(t));

            if (createdSession && typeof createdSession.reload === 'function') {
              try {
                let prevActive = [];
                try {
                  if (typeof createdSession.getActiveToolNames === 'function') {
                    const current = createdSession.getActiveToolNames() || [];
                    if (Array.isArray(current)) prevActive = current;
                  }
                } catch {}

                createdSession._customTools = wrappedCustomTools;
                await createdSession.reload();

                try {
                    if (typeof createdSession.setActiveToolsByName === 'function') {
                      const seen = new Set();
                      const nextActive = [];
                      const bashName = (bashProxy && bashProxy.name) || 'bash';

                      for (const name of prevActive || []) {
                        if (typeof name !== 'string') continue;
                        const trimmed = name.trim();
                        if (!trimmed) continue;
                        if (execPolicy !== 'open' && trimmed === bashName) continue;
                        if (seen.has(trimmed)) continue;
                        seen.add(trimmed);
                        nextActive.push(trimmed);
                      }

                      if (execPolicy === 'open' && !seen.has(bashName)) {
                        seen.add(bashName);
                        nextActive.push(bashName);
                      }

                      createdSession.setActiveToolsByName(nextActive);
                    }
                } catch {}
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
  const baseReadTool = createReadTool(workspaceRoot, {
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

  const readTool = baseReadTool;

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

  // Optionally capture the last LLM request context and provider payload
  // for gateway-v2 failure logs. This wraps the underlying pi-agent-core
  // Agent.streamFn only when ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST or
  // ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL is enabled.
  try {
    const env = (typeof process !== 'undefined' && process && process.env) ? process.env : null;
    const logReqEnv = env && (env.ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST || env.ARCANA_GATEWAY_V2_CHAT_LOG_REQUEST_FULL);
    if (logReqEnv && createdSession && createdSession.agent && createdSession.agent.streamFn){
      const agent = createdSession.agent;
      const originalStreamFn = agent.streamFn;
      if (originalStreamFn && !agent.__arcanaStreamFnWrappedForRequestLogging){
        agent.__arcanaStreamFnWrappedForRequestLogging = true;
        agent.streamFn = function(modelArg, llmContextArg, optionsArg){
          try {
            try { createdSession.__arcana_last_llm_context = llmContextArg || null; } catch {}
            const opts = (optionsArg && typeof optionsArg === 'object') ? { ...optionsArg } : {};
            const prevOnPayload = typeof opts.onPayload === 'function' ? opts.onPayload : null;
            opts.onPayload = function(payload){
              try { createdSession.__arcana_last_provider_payload = payload || null; } catch {}
              if (prevOnPayload){
                try { prevOnPayload(payload); } catch {}
              }
            };
            return originalStreamFn.call(agent, modelArg, llmContextArg, opts);
          } catch {
            return originalStreamFn.call(agent, modelArg, llmContextArg, optionsArg);
          }
        };
      }
    }
  } catch {}

  // Attach the tool-daemon client to the session so server-side abort can cancel active tool calls.
  try {
    if (createdSession && !createdSession._arcanaToolHostClient) createdSession._arcanaToolHostClient = toolDaemon;
  } catch {}

	// Apply per-agent provider API key (runtime override) so pi-ai does not rely on process.env.
	try {
		const modelProvider = model && model.provider ? String(model.provider).trim() : '';
		const cfgProvider = providerName ? String(providerName).trim() : '';
		const cfgProviderLower = cfgProvider.toLowerCase();
		const prov = cfgProvider || modelProvider || '';
		let key = providerKey;
		// Prefer secrets bound for the configured provider name, falling back to the
		// resolved model provider when no explicit provider is configured.
		if (!key) {
			try {
				if (cfgProvider) {
					key = await secrets.getProviderApiKey(cfgProvider);
				} else if (prov) {
					key = await secrets.getProviderApiKey(prov);
				}
			} catch {
				key = providerKey;
			}
		}
		const authStorage = created && created.session && created.session.modelRegistry && created.session.modelRegistry.authStorage;
		if (key && authStorage && typeof authStorage.setRuntimeApiKey === 'function') {
			// When cfg.provider is "openai-compatible" but the resolved model is
			// backed by the "openai" provider in pi-ai, fetch the key using the
			// configured provider name but apply it to the real provider id so
			// authentication succeeds.
			if (cfgProviderLower === 'openai-compatible' && modelProvider === 'openai') {
				authStorage.setRuntimeApiKey('openai', key);
				// Also register under the configured alias for completeness.
				authStorage.setRuntimeApiKey('openai-compatible', key);
			} else if (prov) {
				authStorage.setRuntimeApiKey(prov, key);
			}
		}
	} catch {}

  // Apply initial execution policy to active tool names so chat2 sessions
  // honor the requested policy without an extra server-side toggle.
  try {
    const baseNames = baseTools
      .map((t) => t && t.name)
      .filter((n) => typeof n === 'string' && n.length > 0);

    const customNames = customTools
      .map((t) => t && t.name)
      .filter((n) => typeof n === 'string' && n.length > 0);

    const desired = new Set();

    // Always enable base tools (read/grep/find/ls)
    for (const n of baseNames) desired.add(n);

    // Enable all custom tools (including skill tools) by default
    for (const n of customNames) {
      if (!n) continue;
      desired.add(n);
    }

    // Apply bash enablement based on execution policy
    const bashName = (bashProxy && bashProxy.name) || 'bash';
    if (execPolicy === 'open') desired.add(bashName);
    else desired.delete(bashName);

    created.session?.setActiveToolsByName?.(Array.from(desired));
  } catch {}

  const visibleSkillNames = arcanaSkills.map(s=>s.name).filter(Boolean);
  const toolNames = created.session?.getActiveToolNames ? created.session.getActiveToolNames() : baseTools.map(t=>t?.name).filter(Boolean);

  return { session: created.session, model, toolNames, pluginFiles, pluginErrors, skillNames: visibleSkillNames, skillsCount: visibleSkillNames.length, toolHost: toolDaemon, skillToolMap };
}

export default { createArcanaSession };
