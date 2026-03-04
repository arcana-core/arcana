import { createAgentSession, DefaultResourceLoader, createReadTool, createGrepTool, createFindTool, createLsTool } from '@mariozechner/pi-coding-agent';
import { getModel } from '@mariozechner/pi-ai';
import { loadArcanaPlugins } from './plugin-loader.js';
import { startServicesOnce } from './services/manager.js';
// Scheme C: tool-host isolation. Use proxy tools that delegate to a
// persistent child process which can be killed to cancel hangs.
import { ToolHostClient } from './tool-host-client.js';
import { createProxyBashTool, createProxyWebRenderTool, createProxyWebExtractTool, createProxyWebSearchTool } from './tools/toolhost-proxies.js';
import createCodexSubagentTool from './tools/codex-subagent.js';
import createNotebookTool from './tools/notebook.js';
import createMemoryTools from './tools/memory.js';
import createSubagentsTool from './tools/subagents.js';
import { createTimerTool } from './tools/timer.js';
import { loadArcanaConfig, applyProviderEnv, resolveModelFromConfig, resolveModelFromEnv, inferProviderFromEnv } from './config.js';
import { join, dirname, extname } from 'node:path';
import { resolveArcanaHome } from './arcana-home.js';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { buildArcanaSkillsPrompt, loadArcanaSkills } from './skills.js';
import { loadSkillTools } from './skill-tools.js';
import { ensureArcanaSkillsWatcher } from './skills-watch.js';
import { emit } from './event-bus.js';
import { ensureReadAllowed } from './workspace-guard.js';
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

export async function createArcanaSession(opts={}){
  const cwd = opts.cwd || process.cwd();
  const cfg = loadArcanaConfig();
  applyProviderEnv(cfg);

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
  const toolHost = new ToolHostClient({ cwd });
  const webRender = createProxyWebRenderTool(toolHost);
  const webExtract = createProxyWebExtractTool(toolHost);
  const webSearchProxy = createProxyWebSearchTool(toolHost);
  const bashProxy = createProxyBashTool(toolHost);
  // Start core workspace services once per process. This runs before plugins.
  try { await startServicesOnce(); } catch {}

  const { tools: pluginTools, pluginFiles, errors: pluginErrors } = await loadArcanaPlugins(cwd);
  const filteredPlugins = (pluginTools||[]).filter((t)=> t && !['web_render','web_extract','web_search','bash'].includes(t.name));
  const subagents = createSubagentsTool();
  const codex = createCodexSubagentTool();
  const notebook = createNotebookTool();
  const memoryTools = createMemoryTools();
  const timerTool = createTimerTool();
  const pkgRoot = arcanaPkgRoot();
  const repoRoot = dirname(pkgRoot);
  // Skill-scoped tools (preload definitions; activation controlled by skill gate)
  const arcanaSkills = loadArcanaSkills({ cwd, cfg, pkgRoot, repoRoot });
  let skillTools = []; let skillToolMap = new Map();
  try {
    const res = await loadSkillTools(arcanaSkills);
    skillTools = res.tools || [];
    skillToolMap = res.skillToolNamesBySkill || new Map();
  } catch {}

  const customTools = [
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
  ];

  

  // Compute skills prompt early so the resource loader can append it
  let skillsPrompt = buildArcanaSkillsPrompt({ cwd, cfg, pkgRoot, repoRoot });
  const loader = new DefaultResourceLoader({
    cwd,
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
  // Start a lightweight watcher that refreshes the skills prompt when SKILL.md files change
  try {
    ensureArcanaSkillsWatcher({
      cwd, cfg, pkgRoot, repoRoot,
      onChange: () => {
        try {
          skillsPrompt = buildArcanaSkillsPrompt({ cwd, cfg, pkgRoot, repoRoot });
          const p = loader.reload();
          if (p && typeof p.then === 'function') p.catch(() => {});
          emit({ type: 'skills_refresh', reason: 'watch' });
        } catch {}
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
  const readTool = createReadTool(cwd, {
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

  const grepTool = createGrepTool(cwd, {
    operations: {
      isDirectory: async (p) => {
        const st = await fsp.stat(ensureReadAllowed(p));
        return st.isDirectory();
      },
      readFile: async (p) => fsp.readFile(ensureReadAllowed(p), 'utf-8'),
    }
  });

  const lsTool = createLsTool(cwd, {
    operations: {
      exists: async (p) => { try { await fsp.access(ensureReadAllowed(p)); return true; } catch { return false; } },
      stat: async (p) => fsp.stat(ensureReadAllowed(p)),
      readdir: async (p) => fsp.readdir(ensureReadAllowed(p)),
    }
  });

  const findTool = createFindTool(cwd, {
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

  const created = await createAgentSession({
    cwd,
    tools: baseTools,
    customTools,
    model,
    resourceLoader: loader,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });

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
