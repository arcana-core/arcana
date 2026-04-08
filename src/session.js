import { createAgentSession, DefaultResourceLoader, createReadTool, createGrepTool, createFindTool, createLsTool, initTheme } from '@mariozechner/pi-coding-agent';
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
import { loadArcanaConfig, loadAgentConfig, applyProviderEnv, resolveModelFromConfig, resolveModelFromEnv, inferProviderFromEnv } from './config.js';
import { join, dirname, extname, basename } from 'node:path';
import { resolveArcanaHome, ensureArcanaHomeDir } from './arcana-home.js';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, promises as fsp } from 'node:fs';
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

// pi-coding-agent exports a global `theme` Proxy used by multiple renderers (including
// some headless/export utilities). In headless Arcana environments (gateway/whiteboard),
// pi's CLI entrypoint is not used, so the theme would otherwise remain uninitialized
// and throw: "Theme not initialized. Call initTheme() first."
let __piThemeInitialized = false;
function ensurePiThemeInitialized(){
  if (__piThemeInitialized) return;
  __piThemeInitialized = true;
  try { initTheme(undefined, false); } catch {}
}

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
		deepseek: ['deepseek-chat','gpt-4o-mini','chatgpt-4o-latest'],
		anthropic: ['claude-3-5-sonnet-20241022'],
		openrouter: ['meta-llama/llama-3.1-8b-instruct:free'],
		xai: ['grok-beta']
	};
	// Map OpenAI-compatible aliases to the underlying pi-ai provider id.
	const providerForModels = p === 'openai-compatible' || p === 'deepseek' ? 'openai' : p;
	const arr = candidatesByProvider[p] || candidatesByProvider[providerForModels] || [];
	for (const id of arr) { try { const m = getModel(providerForModels, id); if (m) return m; } catch {} }
	if (p === 'deepseek'){
		return {
			id: 'deepseek-chat',
			name: 'deepseek-chat',
			provider: 'deepseek',
			api: 'openai-completions',
			baseUrl: 'https://api.deepseek.com',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
			headers: {},
		};
	}
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
  // Agent id is needed for per-agent secret names like:
  // agents/<agentId>/providers/<provider>/api_key
  let agentId = String(opts.agentId || '').trim();
  if (!agentId) {
    try { agentId = basename(String(agentHomeRoot || '').replace(/[\/\\]+$/, '')); } catch {}
  }
  if (!agentId) agentId = 'default';

  const globalCfg = loadArcanaConfig();

  const agentCfg = loadAgentConfig(agentHomeRoot);
  const cfg = mergeAgentConfig(globalCfg, agentCfg);

  // Apply provider env wiring based on the *effective* merged config so
  // per-agent overrides take precedence and we don't leak global provider
  // base URLs into inference for other providers.
  applyProviderEnv(cfg);

  // Ensure pi theme is initialized even in headless environments (gateway, tests).
  ensurePiThemeInitialized();

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
    const providerForLookup = provNorm === 'openai-compatible' || provNorm === 'deepseek' ? 'openai' : provNorm;

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
    if (!baseUrl && provNorm === 'deepseek') baseUrl = 'https://api.deepseek.com';

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
    const hadExplicitSelection = !!sel;
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
          const providerForLookup = norm === 'openai-compatible' || norm === 'deepseek' ? 'openai' : (norm || selProvider);
          model = getModel(providerForLookup, selId);
        } catch {}
      }
    }
    // If user explicitly selected a model but we still couldn't resolve a
    // concrete built-in template, construct a generic model description based
    // on the user's selection and skip provider-family fallback. This preserves
    // the exact model id/addressing so upstream gateways can return precise
    // errors (e.g., unknown model vs. bad URL) instead of masking with a
    // fallback like gpt-4o-mini.
    if (!model && hadExplicitSelection){
      try {
        // Prefer the configured provider when present (e.g., openai-compatible),
        // but keep the original selection as a subfamily prefix in the id so
        // gateways that expect "anthropic/xxx" continue to receive it.
        const provForGeneric = (cfg && cfg.provider ? String(cfg.provider).trim() : '') || selProvider;
        const provLower = String(provForGeneric || '').toLowerCase();
        let idForGeneric = selId;
        if (selProvider && provForGeneric && selProvider.toLowerCase() !== provLower){
          // Preserve the original provider prefix in the id when user wrote
          // something like "anthropic/claude-sonnet-4.6" but the configured
          // provider is an OpenAI‑compatible router.
          idForGeneric = `${selProvider}/${selId}`;
        }
        // Pick a sensible API default for the generic template.
        const template = {};
        if (provLower === 'openai' || provLower === 'openai-compatible' || provLower === 'deepseek' || provLower === 'openrouter' || provLower === 'groq' || provLower === 'cerebras' || provLower === 'zai' || provLower === 'mistral'){
          template.api = 'openai-completions';
        } else if (provLower === 'anthropic') {
          template.api = 'anthropic-messages';
        } else if (provLower === 'google' || provLower === 'google-gemini-cli' || provLower === 'google-vertex'){
          template.api = 'google-generative-ai';
        }
        model = buildModelFromInline(provForGeneric, idForGeneric, template);
      } catch {}
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
      // Only apply family fallback when the user did NOT explicitly select a model.
      if (!model && !hadExplicitSelection && providerNorm) model = pickFallbackModel(providerNorm);
    }

    // Legacy cfg.base_url / env overrides for OpenAI/Anthropic.
    const baseOverrideRaw = cfg?.base_url || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || '';
    const baseOverrideOpenAI = normalizeOpenAIBase(baseOverrideRaw || '');
    if (baseOverrideOpenAI && model && !inlineBaseUrlExplicit){
      const providerNorm = String(model.provider || '').trim().toLowerCase();
      if (providerNorm === 'openai' || providerNorm === 'openai-compatible' || providerNorm === 'deepseek'){
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

  // --- Configurable HTTP request headers (HEADERS.json) ---
  // Load and apply header rules after model resolution and before tools are created.
  try {
    function pickCaseInsensitive(obj, key){
      try {
        if (!obj || typeof obj !== 'object') return null;
        const want = String(key || '').toLowerCase();
        for (const [k, v] of Object.entries(obj)){
          if (String(k).toLowerCase() === want) return (v && typeof v === 'object') ? v : null;
        }
      } catch {}
      return null;
    }

    function mergeHeadersCaseInsensitive(base, patch){
      const map = new Map(); // lowerName -> [preservedCaseName, value]
      try {
        const addFrom = (src, isPatch)=>{
          if (!src || typeof src !== 'object') return;
          for (const [k, v] of Object.entries(src)){
            const lower = String(k).toLowerCase();
            if (isPatch && v == null){
              map.delete(lower);
              continue;
            }
            if (v == null) continue;
            map.set(lower, [k, v]);
          }
        };
        addFrom(base, false);
        addFrom(patch, true);
        const out = {};
        for (const [, [name, val]] of map){ out[name] = val; }
        return out;
      } catch { return { ...(base||{}) }; }
    }

    function readJsonIfExists(p){
      try {
        if (!p || !existsSync(p)) return null;
        const raw = readFileSync(p, 'utf-8');
        if (!raw) return null;
        try { const obj = JSON.parse(raw); return (obj && typeof obj === 'object') ? obj : null; } catch { return null; }
      } catch { return null; }
    }

    function applyHeaderRulesToModel(modelIn){
      try {
        if (!modelIn || typeof modelIn !== 'object') return modelIn;
        const prov = String(modelIn.provider || '').trim().toLowerCase();
        const api = String(modelIn.api || '').trim();
        const id = String(modelIn.id || '').trim();

        // Collect HEADERS.json files in increasing precedence; later wins.
        const pkgRootLocal = arcanaPkgRoot();
        const repoRootLocal = dirname(pkgRootLocal);
        let arcanaHome = '';
        try { arcanaHome = resolveArcanaHome() || ''; } catch { arcanaHome = ''; }

        const files = [
          join(pkgRootLocal, '.pi', 'HEADERS.json'),
          arcanaHome ? join(arcanaHome, 'HEADERS.json') : null,
          join(repoRootLocal, '.pi', 'HEADERS.json'),
          agentHomeRoot ? join(agentHomeRoot, 'HEADERS.json') : null,
        ].filter(Boolean);

        let merged = (modelIn.headers && typeof modelIn.headers === 'object') ? { ...modelIn.headers } : {};

        for (const f of files){
          const root = readJsonIfExists(f);
          if (!root || typeof root !== 'object') continue;

          const hasSchemaKeys = (
            Object.prototype.hasOwnProperty.call(root, 'all') ||
            Object.prototype.hasOwnProperty.call(root, 'providers') ||
            Object.prototype.hasOwnProperty.call(root, 'apis') ||
            Object.prototype.hasOwnProperty.call(root, 'models')
          );

          const allPatch = hasSchemaKeys ? (root.all && typeof root.all === 'object' ? root.all : null) : root;
          const provPatch = (hasSchemaKeys && root.providers && prov) ? pickCaseInsensitive(root.providers, prov) : null;
          const apiPatch = (hasSchemaKeys && root.apis && api) ? pickCaseInsensitive(root.apis, api) : null;
          const modelsObj = hasSchemaKeys && root.models && typeof root.models === 'object' ? root.models : null;

          if (allPatch) merged = mergeHeadersCaseInsensitive(merged, allPatch);
          if (provPatch) merged = mergeHeadersCaseInsensitive(merged, provPatch);
          if (apiPatch) merged = mergeHeadersCaseInsensitive(merged, apiPatch);
          if (modelsObj && id){
            const keysToTry = [];
            if (prov) keysToTry.push(`${prov}:${id}`, `${prov}/${id}`);
            if (prov === 'openai-compatible' || prov === 'deepseek') keysToTry.push(`openai:${id}`, `openai/${id}`);
            for (const k of keysToTry){
              const m = pickCaseInsensitive(modelsObj, k);
              if (m) merged = mergeHeadersCaseInsensitive(merged, m);
            }
          }
        }

        return { ...modelIn, headers: merged };
      } catch { return modelIn; }
    }

    if (model) model = applyHeaderRulesToModel(model);
  } catch {}

  // If no model is selected after config/env and header rules, throw a structured error
  if (!model) {
    try {
      const provider = (cfg && cfg.provider) ? String(cfg.provider).trim() : (inferProviderFromEnv() || '');
      const cfgPath = (cfg && cfg.path) ? String(cfg.path) : ((agentCfg && agentCfg.path) ? String(agentCfg.path) : ((globalCfg && globalCfg.path) ? String(globalCfg.path) : ''));
      const hint = 'No model selected. Set ARCANA_MODEL or define a "model" in arcana.config.json or agents/' + (agentId || 'default') + '/config.json. Also ensure provider and API key env vars are set (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY/GEMINI_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY).';
      const err = new Error(hint);
      err.code = 'ARCANA_NO_MODEL_SELECTED';
      err.status = 400;
      err.details = {
        agentId,
        agentHomeRoot,
        workspaceRoot: workspaceRootNormalized || workspaceRoot,
        configPath: cfgPath,
        provider,
        model: model || null,
      };
      throw err;
    } catch (e) {
      // Re-throw if building the structured error failed for any reason
      throw e;
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
  const pkgRoot = arcanaPkgRoot();
  if (!process.env.ARCANA_PKG_ROOT){
    try { process.env.ARCANA_PKG_ROOT = pkgRoot; } catch {}
  }
  const repoRoot = dirname(pkgRoot);

  // Seed $ARCANA_HOME/APPEND_SYSTEM.md on first session creation.
  try {
    const homeDir = ensureArcanaHomeDir();
    const homeAppendPath = join(homeDir, 'APPEND_SYSTEM.md');
    if (!existsSync(homeAppendPath)){
      const packagedAppendPath = join(pkgRoot, '.pi', 'APPEND_SYSTEM.md');
      if (existsSync(packagedAppendPath)){
        try {
          const contents = readFileSync(packagedAppendPath, 'utf-8');
          if (contents && contents.length) writeFileSync(homeAppendPath, contents, 'utf-8');
        } catch {}
      }
    }
  } catch {}

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
  let agentBootstrap = { contextFiles: [], hasSoul: false };
  if (bootstrapContextMode === 'lightweight'){
    minimalAgentBootstrap = true;
  }
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
    const res = await loadSkillTools(arcanaSkills, { agentHomeRoot });
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
      const allBaseFiles = base && Array.isArray(base.agentsFiles) ? base.agentsFiles : [];
      let baseFiles = allBaseFiles;
      if (minimalAgentBootstrap && workspaceRootNormalized){
        baseFiles = allBaseFiles.filter((f)=>{
          if (!f || !f.path) return false;
          const p = String(f.path).split("\\").join("/");
          if (!p) return false;
          if (p === workspaceRootNormalized) return true;
          return p.startsWith(workspaceRootNormalized + "/");
        });
      }
      const merged = [...baseFiles];
      const seen = new Set();
      for (const f of baseFiles){
        if (f && typeof f.path === "string") seen.add(f.path);
      }
      const extra = agentBootstrap && Array.isArray(agentBootstrap.contextFiles) ? agentBootstrap.contextFiles : [];
      for (const f of extra){
        if (!f || !f.path || seen.has(f.path)) continue;
        merged.push(f);
      }
      return { agentsFiles: merged };
    },
    appendSystemPromptOverride: (base)=>{
      const extras = [];

      // Workspace override: repo-local .pi/APPEND_SYSTEM.md
      try {
        const repoAppend = readIfExists(join(repoRoot, ".pi", "APPEND_SYSTEM.md"));
        if (repoAppend) extras.push(repoAppend);
      } catch {}

      // Base APPEND_SYSTEM: prefer $ARCANA_HOME/APPEND_SYSTEM.md, fall back to packaged default.
      try {
        let baseAppend = "";
        try {
          const homeDir = resolveArcanaHome();
          if (homeDir) baseAppend = readIfExists(join(homeDir, "APPEND_SYSTEM.md"));
        } catch {}
        if (!baseAppend){
          baseAppend = readIfExists(join(pkgRoot, ".pi", "APPEND_SYSTEM.md"));
        }
        if (baseAppend) extras.push(baseAppend);
      } catch {}
      const soulLine = hasSoulHint
        ? "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it."
        : "";
      if (soulLine) extras.push(soulLine);
      // Append skills prompt after APPEND_SYSTEM.md blocks and SOUL hint
      if (skillsPrompt && skillsPrompt.trim()) extras.push(skillsPrompt);
      const mergedSp = [...(base||[])];
      for (const sText of extras){ if (sText && !mergedSp.includes(sText)) mergedSp.push(sText); }
      return mergedSp;
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
              const res = await loadSkillTools(arcanaSkills, { agentHomeRoot });
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
            const visibleSkillNames = (Array.isArray(arcanaSkills) ? arcanaSkills : [])
              .map((s) => s && s.name)
              .filter(Boolean);
            emit({ type: 'skills_refresh', reason: 'watch', skills: visibleSkillNames, agentId });
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
  // Enable pi-agent-core's built-in auto-compaction so that context (including
  // accumulated image base64 data from tool results) is automatically summarized
  // and trimmed when approaching the token limit.  This prevents the request
  // payload from growing unbounded and triggering proxy/gateway body-size errors.
  //
  // Auto-retry remains DISABLED — Arcana handles all retry logic at the gateway
  // layer (with prelude rebuilding, overflow compaction, back-off, etc.).
  try {
    if (createdSession && typeof createdSession.setAutoCompactionEnabled === 'function'){
      createdSession.setAutoCompactionEnabled(true);
    }
  } catch {}
  try {
    if (createdSession && typeof createdSession.setAutoRetryEnabled === 'function'){
      createdSession.setAutoRetryEnabled(false);
    }
  } catch {}

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
		const modelProviderLower = modelProvider.toLowerCase();
		const cfgProvider = providerName ? String(providerName).trim() : '';
		const cfgProviderLower = cfgProvider.toLowerCase();

		function agentSecretName(aid, prov){
			try {
				const a = String(aid || '').trim();
				const p = String(prov || '').trim().toLowerCase();
				if (!a || !p) return '';
				return `agents/${a}/providers/${p}/api_key`;
			} catch { return ''; }
		}

		async function resolveProviderKey(prov){
			const p = String(prov || '').trim();
			if (!p) return '';
			// Prefer per-agent namespaced secret
			try {
				const name = agentSecretName(agentId, p);
				if (name) {
					const v = await secrets.getText(name);
					if (v) return v;
				}
			} catch {}
			// Fallback to standard provider secret: providers/<provider>/api_key
			try {
				const v = await secrets.getProviderApiKey(p);
				if (v) return v;
			} catch {}
			return '';
		}

		// Prefer Secrets bindings over legacy inline config keys.
		let key = '';
		try {
			if (cfgProvider) key = await resolveProviderKey(cfgProvider);
		} catch {}
		try {
			if (!key && modelProvider && modelProviderLower && modelProviderLower !== cfgProviderLower) {
				key = await resolveProviderKey(modelProvider);
			}
		} catch {}

		// Fallback: legacy inline config key (cfg.key).
		if (!key) key = providerKey;

		const authStorage = created && created.session && created.session.modelRegistry && created.session.modelRegistry.authStorage;
		if (key && authStorage && typeof authStorage.setRuntimeApiKey === 'function') {
			// When cfg.provider is an OpenAI-compatible alias but the resolved model
			// is backed by the "openai" provider in pi-ai, apply the key to both ids.
			if ((cfgProviderLower === 'openai-compatible' || cfgProviderLower === 'deepseek') && modelProviderLower === 'openai') {
				authStorage.setRuntimeApiKey('openai', key);
				authStorage.setRuntimeApiKey(cfgProviderLower, key);
			} else if (cfgProviderLower === 'openai' && (modelProviderLower === 'openai-compatible' || modelProviderLower === 'deepseek')) {
				authStorage.setRuntimeApiKey('openai', key);
				authStorage.setRuntimeApiKey(modelProviderLower, key);
			} else {
				// Prefer applying to the resolved model provider. Also register under the
				// configured provider id when they differ (harmless and improves compatibility).
				if (modelProvider) authStorage.setRuntimeApiKey(modelProvider, key);
				if (cfgProvider && cfgProviderLower && cfgProviderLower !== modelProviderLower) {
					authStorage.setRuntimeApiKey(cfgProvider, key);
				} else if (!modelProvider && cfgProvider) {
					authStorage.setRuntimeApiKey(cfgProvider, key);
				}
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
