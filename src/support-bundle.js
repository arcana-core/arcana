import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runDoctor } from './doctor.js';
import { loadArcanaConfig } from './config.js';
import { resolveWorkspaceRoot } from './workspace-guard.js';
import { loadArcanaPlugins } from './plugin-loader.js';

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

function sanitizeConfig(cfg){
  if (!cfg) return null;
  const clone = { ...cfg };
  // Remove secret-like keys
  delete clone.key;
  delete clone.api_key;
  delete clone.apiKey;
  delete clone.password;
  delete clone.token;
  delete clone.tokens;
  delete clone.cookies;
  delete clone.session;
  if (clone.path) clone.path = redactPath(clone.path);
  // Avoid leaking full paths in workspace config too
  if (clone.workspace_root) clone.workspace_root = redactPath(clone.workspace_root);
  if (clone.workspaceRoot) clone.workspaceRoot = redactPath(clone.workspaceRoot);
  if (clone.workspace_dir) clone.workspace_dir = redactPath(clone.workspace_dir);
  if (clone.workspaceDir) clone.workspaceDir = redactPath(clone.workspaceDir);
  return clone;
}

function envSummary(){
  const out = {};
  const keep = ['ARCANA_WORKSPACE','ARCANA_PROVIDER','ARCANA_MODEL','ARCANA_THINKING','ARCANA_EXEC_POLICY','ARCANA_PW_ENGINE','ARCANA_MEMORY_TRIGGERS','OPENAI_BASE_URL','OPENAI_API_BASE','ANTHROPIC_BASE_URL'];
  for (const k of keep){ if (process.env[k]) out[k] = k.includes('WORKSPACE') ? redactPath(process.env[k]) : String(process.env[k]); }
  // API keys are summarized as present/not present only
  out.keys_present = {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
    XAI_API_KEY: !!process.env.XAI_API_KEY,
  };
  return out;
}

function versionSummary(){
  let pkg = null;
  try { pkg = JSON.parse(readFileSync(join(process.cwd(),'arcana','package.json'),'utf-8')); } catch {}
  const deps = pkg && pkg.dependencies ? pkg.dependencies : {};
  return {
    node: process.version,
    platform: process.platform + ' ' + os.release() + ' ' + os.arch(),
    cpu_count: (os.cpus()||[]).length || 0,
    memory_gb: Math.round((os.totalmem()/(1024**3))*10)/10,
    pkg_version: (pkg && pkg.version) ? pkg.version : '',
    dependencies: deps,
  };
}

export async function createSupportBundle({ outDir, cwd }={}){
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const baseDir = (outDir && outDir.trim()) ? outDir.trim() : join(process.cwd(), 'arcana-support-' + stamp);
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });

  // doctor.json
  const doc = await runDoctor({ cwd: cwd||process.cwd() });
  writeFileSync(join(baseDir,'doctor.json'), JSON.stringify(doc, null, 2));

  // sanitized config
  const cfg = sanitizeConfig(loadArcanaConfig());
  if (cfg) writeFileSync(join(baseDir,'config.sanitized.json'), JSON.stringify(cfg, null, 2));

  // env summary
  writeFileSync(join(baseDir,'env.sanitized.json'), JSON.stringify(envSummary(), null, 2));

  // versions
  writeFileSync(join(baseDir,'versions.json'), JSON.stringify(versionSummary(), null, 2));

  // plugin load info
  const { errors, pluginFiles } = await loadArcanaPlugins(cwd||process.cwd());
  const pluginInfo = {
    files: (pluginFiles||[]).map(p=>({ file: basename(p) })),
    errors: (errors||[]).map(e=>({ file: e.file ? basename(e.file) : '', message: e.message }))
  };
  writeFileSync(join(baseDir,'plugins.json'), JSON.stringify(pluginInfo, null, 2));

  // system info minimal
  const sys = {
    workspace_root: redactPath(resolveWorkspaceRoot()),
    homedir: '<HOME>',
  };
  writeFileSync(join(baseDir,'system.json'), JSON.stringify(sys, null, 2));

  // Try to create tar.gz if tar is available
  let tarPath = '';
  try {
    execFileSync('tar',['-czf', baseDir + '.tar.gz', '-C', baseDir, '.'], { stdio: 'ignore' });
    tarPath = baseDir + '.tar.gz';
  } catch {}

  return { dir: baseDir, tarPath: tarPath || null };
}

export default { createSupportBundle };
