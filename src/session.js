import { createAgentSession, DefaultResourceLoader, createReadTool, createGrepTool, createFindTool, createLsTool } from '@mariozechner/pi-coding-agent';
import { getModel } from '@mariozechner/pi-ai';
import { loadArcanaPlugins } from './plugin-loader.js';
// Scheme C: tool-host isolation. Use proxy tools that delegate to a
// persistent child process which can be killed to cancel hangs.
import { ToolHostClient } from './tool-host-client.js';
import { createProxyBashTool, createProxyWebRenderTool, createProxyWebExtractTool, createProxyWebSearchTool } from './tools-toolhost-proxies.js';
import createCodexSubagentTool from './tools-codex-subagent.js';
import createNotebookTool from './tools-notebook.js';
import createSubagentsTool from './tools-subagents.js';
import { createTimerTool } from './tools-timer.js';
import { loadArcanaConfig, applyProviderEnv, resolveModelFromConfig, resolveModelFromEnv, inferProviderFromEnv } from './config.js';
import { join, dirname, extname } from 'node:path';
import { resolveArcanaHome } from './arcana-home.js';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { buildArcanaSkillsPrompt, loadArcanaSkills } from './skills.js';
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

  // Create tool-host client and proxy tools
  const toolHost = new ToolHostClient({ cwd });
  const webRender = createProxyWebRenderTool(toolHost);
  const webExtract = createProxyWebExtractTool(toolHost);
  const { tools: pluginTools, pluginFiles, errors: pluginErrors } = await loadArcanaPlugins(cwd);
  const filteredPlugins = (pluginTools||[]).filter((t)=> t && !['web_render','web_extract','web_search','bash'].includes(t.name));
  const subagents = createSubagentsTool();
  const codex = createCodexSubagentTool();
  const notebook = createNotebookTool();
  // Replace web_* tools with proxies; web_search proxy below.
  const webSearchProxy = createProxyWebSearchTool(toolHost);
  const timerTool = createTimerTool();
  const customTools = [notebook, codex, subagents, timerTool, ...filteredPlugins, webRender, webExtract, webSearchProxy];

  const pkgRoot = arcanaPkgRoot();
  const repoRoot = dirname(pkgRoot);

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
  // Build guarded read/grep/find/ls tools that enforce workspace boundaries.
  // All operations call ensureReadAllowed(path) before touching the filesystem.
  const readTool = createReadTool(cwd, {
    operations: {
      access: async (p) => { await fsp.access(ensureReadAllowed(p)); },
      readFile: async (p) => fsp.readFile(ensureReadAllowed(p)),
      // Lightweight image type detection based on file extension.
      detectImageMimeType: async (p) => {
        const e = extname(String(p)).toLowerCase();
        if (e === '.png') return 'image/png';
        if (e === ' .jpg' || e === ' .jpeg') return 'image/jpeg';
        if (e === ' .gif') return 'image/gif';
        if (e === ' .webp') return 'image/webp';
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
}

export default { createArcanaSession };
