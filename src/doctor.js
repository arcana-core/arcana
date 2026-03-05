import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { getModel } from '@mariozechner/pi-ai';
import { loadArcanaConfig, applyProviderEnv, resolveModelFromConfig, resolveModelFromEnv, inferProviderFromEnv } from './config.js';
import { resolveWorkspaceRoot } from './workspace-guard.js';
import { loadArcanaPlugins } from './plugin-loader.js';
import { loadArcanaSkills } from './skills.js';

function redactPath(p){
  try{
    const home = os.homedir();
    if (!p) return '';
    const s = String(p);
    if (!s.startsWith('/')) return s; // keep relative
    if (s.startsWith(home)) return '<HOME>/…/' + basename(s);
    return '…/' + basename(s);
  } catch { return String(p||''); }
}

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

function status(ok, warn=false){ return ok ? 'ok' : (warn ? 'warn' : 'fail'); }

export async function runDoctor({ cwd } = {}){
  const checks = [];
  const now = new Date().toISOString();

  // workspace
  const root = resolveWorkspaceRoot();
  const wsOk = !!root && existsSync(root);
  checks.push({
    id: 'workspace',
    title: 'Workspace',
    status: status(wsOk),
    code: wsOk ? 'WORKSPACE_OK' : 'WORKSPACE_NOT_FOUND',
    details: { root: redactPath(root) },
    next: wsOk ? [] : ['Set ARCANA_WORKSPACE or create arcana.config.json with "workspace_root".']
  });

  // config
  const cfg = loadArcanaConfig();
  const cfgOk = !!cfg;
  const prov = String(cfg?.provider || inferProviderFromEnv() || '').trim();
  const providerKnown = !prov || ['openai','anthropic','google','openrouter','xai'].includes(prov.toLowerCase());
  const cfgDetails = cfgOk ? { path: redactPath(cfg.path), provider: cfg.provider||'', model: cfg.model||'', base_url: cfg.base_url||'' } : {};
  checks.push({
    id: 'config',
    title: 'Config',
    status: status(cfgOk && providerKnown, cfgOk && !providerKnown),
    code: cfgOk ? (providerKnown ? 'CONFIG_FOUND' : 'CONFIG_PROVIDER_UNKNOWN') : 'CONFIG_NOT_FOUND',
    details: cfgDetails,
    next: cfgOk ? (providerKnown ? [] : ['Set a supported provider: openai|anthropic|google|openrouter|xai']) : ['Create arcana.config.json or set env ARCANA_MODEL/ARCANA_PROVIDER']
  });

  // env & model resolution
  try { applyProviderEnv(cfg||{}); } catch {}
  const modelSel = resolveModelFromConfig(cfg||{}) || resolveModelFromEnv();
  let model = null; let modelCode = 'MODEL_UNAVAILABLE'; let modelNext = [];
  const provider = (cfg?.provider || inferProviderFromEnv() || '').toLowerCase();
  if (modelSel) {
    try { model = getModel(modelSel.provider, modelSel.id); } catch {}
    if (!model) modelNext.push('Check model id or provider in config/env.');
  } else if (provider) {
    model = pickFallbackModel(provider);
    if (!model) modelNext.push('Set ARCANA_MODEL or config.model to a valid id for the selected provider.');
  } else {
    modelNext.push('Set ARCANA_PROVIDER and ARCANA_MODEL, or configure in arcana.config.json.');
  }
  const envFlags = {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
    XAI_API_KEY: !!process.env.XAI_API_KEY
  };
  const needKey = ['openai','anthropic','google','openrouter','xai'].includes(provider) && !Object.values(envFlags).some(Boolean) && !cfg?.key;
  const envOk = !needKey;
  checks.push({
    id: 'env',
    title: 'Environment',
    status: status(envOk, !envOk),
    code: envOk ? 'ENV_API_KEY_PRESENT_OR_NOT_REQUIRED' : 'ENV_API_KEY_MISSING',
    details: { provider, keys_present: envFlags, model_from: modelSel ? 'config/env' : (provider ? 'fallback' : 'unspecified') },
    next: envOk ? [] : ['Set an API key for your chosen provider, e.g. OPENAI_API_KEY.']
  });

  const modelOk = !!model;
  const modelLabel = model ? (model.provider + ':' + model.id + (model.baseUrl ? (' @ ' + model.baseUrl) : '')) : '';
  checks.push({
    id: 'model',
    title: 'Model',
    status: status(modelOk),
    code: modelOk ? 'MODEL_RESOLVED' : 'MODEL_UNAVAILABLE',
    details: modelOk ? { model: modelLabel } : {},
    next: modelOk ? [] : modelNext
  });

  // plugins
  const { errors: pluginErrors, pluginFiles } = await loadArcanaPlugins(cwd||process.cwd());
  const plugOk = !(pluginErrors && pluginErrors.length);
  checks.push({
    id: 'plugins',
    title: 'Plugins',
    status: status(plugOk, !plugOk),
    code: plugOk ? 'PLUGINS_OK' : 'PLUGINS_LOAD_ERRORS',
    details: { files: (pluginFiles||[]).length, errors: (pluginErrors||[]).map(e=>({ file: e.file ? basename(e.file) : '', message: e.message })) },
    next: plugOk ? [] : ['Fix plugin load errors or remove bad plugin files under arcana/plugins.']
  });

  // skills
  let skills = [];
  try { skills = loadArcanaSkills({ workspaceRoot: cwd||process.cwd() }) || []; } catch {}
  const skillsOk = skills.length >= 0; // presence is optional
  checks.push({
    id: 'skills',
    title: 'Skills',
    status: status(skillsOk, skills.length === 0),
    code: skills.length ? 'SKILLS_FOUND' : 'SKILLS_NONE',
    details: { count: skills.length },
    next: skills.length ? [] : ['Add skills under ~/.arcana/agents/<agentId>/skills (default), or under ./skills for shared skills, or set ARCANA_SKILLS_DIRS to extend capabilities.']
  });

  // playwright
  let pwOk = false; let pwLaunchOk = false; let pwError; let pwModule = null;
  try {
    pwModule = await import('./pw-runtime.js');
    pwOk = !!pwModule;
    try { await pwModule.start(); pwLaunchOk = true; } catch (e) { pwError = e?.message||String(e); }
  } catch (e) { pwError = e?.message||String(e); }
  finally {
    // Ensure we always close the runtime to avoid hanging processes
    try {
      if (pwModule && typeof pwModule.close === 'function') await pwModule.close();
      else if (pwModule && typeof pwModule.stop === 'function') await pwModule.stop();
    } catch {}
  }
  const code = !pwOk ? 'PLAYWRIGHT_NOT_INSTALLED' : (pwLaunchOk ? 'PLAYWRIGHT_OK' : 'PLAYWRIGHT_LAUNCH_FAILED');
  checks.push({
    id: 'playwright',
    title: 'Playwright',
    status: status(pwOk && pwLaunchOk, pwOk && !pwLaunchOk),
    code,
    details: pwError ? { error: pwError } : {},
    next: !pwOk ? ['Run: npm i -S playwright && npx playwright install'] : (pwLaunchOk ? [] : ['Run: npx playwright install', 'If still failing, set ARCANA_PW_ENGINE=chromium|firefox|webkit'])
  });

  const summary = {
    ok: checks.filter(c=>c.status==='ok').length,
    warn: checks.filter(c=>c.status==='warn').length,
    fail: checks.filter(c=>c.status==='fail').length,
  };

  return { time: now, summary, checks };
}

export function printDoctor(result){
  const { summary, checks } = result;
  for (const c of checks){
    const tag = c.status === 'ok' ? '[OK]  ' : c.status === 'warn' ? '[WARN]' : '[FAIL]';
    const name = (c.title||c.id||'check');
    const cod = c.code ? (' ' + c.code) : '';
    console.log(tag, name + ':', (c.details && c.details.model) ? c.details.model : (c.details && c.details.root) ? c.details.root : (c.details && typeof c.details.files==='number') ? (c.details.files + ' files') : cod);
    if (c.status !== 'ok' && c.next && c.next.length){
      for (const s of c.next) console.log('   -', s);
    }
  }
  console.log('---');
  console.log('Summary: ok', summary.ok, 'warn', summary.warn, 'fail', summary.fail);
}

export default { runDoctor, printDoctor };

