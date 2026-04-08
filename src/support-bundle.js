import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join, basename } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runDoctor } from './doctor.js';
import { loadArcanaConfig } from './config.js';
import { resolveWorkspaceRoot } from './workspace-guard.js';
import { loadArcanaPlugins } from './plugin-loader.js';
import { resolveAgentHomeRoot } from './agent-guard.js';
import { providerApiKeyName, secrets } from './secrets/index.js';

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

async function envSummary(){
  const out = {};
  const keep = ['ARCANA_WORKSPACE','ARCANA_PROVIDER','ARCANA_MODEL','ARCANA_THINKING','ARCANA_EXEC_POLICY','ARCANA_PW_ENGINE','ARCANA_MEMORY_TRIGGERS','OPENAI_BASE_URL','OPENAI_API_BASE','ANTHROPIC_BASE_URL'];
  for (const k of keep){ if (process.env[k]) out[k] = k.includes('WORKSPACE') ? redactPath(process.env[k]) : String(process.env[k]); }

  // Secrets presence summary (booleans only; no secret values or op refs)
  try {
    const agentHomeRoot = resolveAgentHomeRoot();
    const { bindings } = await secrets.listNames(agentHomeRoot);
    const providers = ['openai','openai-compatible','deepseek','azure-openai-responses','anthropic','google','google-vertex','mistral','groq','cerebras','xai','openrouter','vercel-ai-gateway','minimax','moonshot','generic'];
    const flags = {};
    for (const prov of providers){
      const name = providerApiKeyName(prov);
      const b = bindings && bindings[name];
      const hasAgent = !!(b && b.hasAgent);
      const hasGlobal = !!(b && b.hasGlobal && b.inherited !== false);
      flags[prov] = !!(hasAgent || hasGlobal);
    }
    out.secrets_present = flags;
  } catch {
    out.secrets_present = {};
  }

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

function networkSummary(){
  const summary = {};
  try {
    const ifaces = os.networkInterfaces() || {};
    for (const name of Object.keys(ifaces)){
      const addrs = Array.isArray(ifaces[name]) ? ifaces[name] : [];
      const info = {
        address_count: 0,
        ipv4_count: 0,
        ipv6_count: 0,
        internal: false,
        has_external_ipv4: false,
        has_external_ipv6: false,
      };
      for (const addr of addrs){
        info.address_count += 1;
        const family = addr && addr.family;
        const isV6 = family === 'IPv6' || family === 6;
        if (isV6){
          info.ipv6_count += 1;
        } else {
          info.ipv4_count += 1;
        }
        const isInternal = !!(addr && addr.internal);
        if (isInternal){
          info.internal = true;
        } else if (isV6){
          info.has_external_ipv6 = true;
        } else {
          info.has_external_ipv4 = true;
        }
      }
      summary[name] = info;
    }
  } catch {
    return {};
  }
  return summary;
}

function safeDiskStats(path){
  try{
    if (!path) return null;
    if (typeof fs.statfsSync !== 'function') return null;
  } catch {
    return null;
  }
  try{
    const st = fs.statfsSync(path);
    if (!st) return null;
    const blockSize = typeof st.bsize === 'number' && st.bsize > 0 ? st.bsize : 1;
    const total = typeof st.blocks === 'number' ? st.blocks * blockSize : null;
    const free = typeof st.bfree === 'number' ? st.bfree * blockSize : null;
    const available = typeof st.bavail === 'number' ? st.bavail * blockSize : null;
    return {
      path: redactPath(path),
      total_bytes: total,
      free_bytes: free,
      available_bytes: available,
    };
  } catch {
    return null;
  }
}

function systemSummary({ baseDir, cwd }){
  const sys = {};
  try{
    const now = new Date();
    const workspaceCwd = cwd || process.cwd();
    let workspaceRoot = '';
    try {
      workspaceRoot = resolveWorkspaceRoot();
    } catch {}
    let agentHomeRoot = '';
    try {
      agentHomeRoot = resolveAgentHomeRoot();
    } catch {}

    sys.workspace_root = workspaceRoot ? redactPath(workspaceRoot) : '';
    sys.homedir = '<HOME>';
    sys.cwd = redactPath(workspaceCwd);
    if (agentHomeRoot) sys.agent_home_root = redactPath(agentHomeRoot);

    try{
      sys.os = {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        version: os.version ? os.version() : '',
        type: os.type(),
      };
    } catch {}

    try{
      let timeZone = '';
      try{
        const tz = Intl && Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (typeof tz === 'string') timeZone = tz;
      } catch {}
      sys.runtime = {
        node_version: process.version,
        process_versions: process.versions,
        uptime_seconds: typeof process.uptime === 'function' ? process.uptime() : null,
        timestamp: now.toISOString(),
        timezone: timeZone,
      };
    } catch {}

    try{
      sys.loadavg = os.loadavg();
    } catch {}

    try{
      sys.memory = {
        total_bytes: os.totalmem(),
        free_bytes: os.freemem(),
      };
    } catch {}

    try{
      const cpus = os.cpus() || [];
      const cpuCount = cpus.length || 0;
      const models = [];
      for (const c of cpus){
        if (c && typeof c.model === 'string' && !models.includes(c.model)) models.push(c.model);
      }
      sys.cpu = {
        count: cpuCount,
        model: models.length ? models[0] : '',
        models,
      };
    } catch {}

    try{
      sys.network = networkSummary();
    } catch {}

    try{
      const disk = {};
      if (workspaceRoot){
        const wsStats = safeDiskStats(workspaceRoot);
        if (wsStats) disk.workspace_root = wsStats;
      }
      const bundleStats = safeDiskStats(baseDir);
      if (bundleStats) disk.bundle_output_dir = bundleStats;
      sys.disk = disk;
    } catch {}

  } catch (err){
    sys.error = 'system_info_error';
    try{
      const workspaceRoot = resolveWorkspaceRoot();
      sys.workspace_root = redactPath(workspaceRoot);
    } catch {}
    sys.homedir = '<HOME>';
  }
  return sys;
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
  const env = await envSummary();
  writeFileSync(join(baseDir,'env.sanitized.json'), JSON.stringify(env, null, 2));

  // versions
  writeFileSync(join(baseDir,'versions.json'), JSON.stringify(versionSummary(), null, 2));

  // plugin load info
  const { errors, pluginFiles } = await loadArcanaPlugins(cwd||process.cwd());
  const pluginInfo = {
    files: (pluginFiles||[]).map(p=>({ file: basename(p) })),
    errors: (errors||[]).map(e=>({ file: e.file ? basename(e.file) : '', message: e.message }))
  };
  writeFileSync(join(baseDir,'plugins.json'), JSON.stringify(pluginInfo, null, 2));

  // system info snapshot (privacy-conscious, redacted paths)
  try {
    const sys = systemSummary({ baseDir, cwd: cwd||process.cwd() });
    writeFileSync(join(baseDir,'system.json'), JSON.stringify(sys, null, 2));
  } catch {}

  // Try to create tar.gz if tar is available
  let tarPath = '';
  try {
    execFileSync('tar',['-czf', baseDir + '.tar.gz', '-C', baseDir, '.'], { stdio: 'ignore' });
    tarPath = baseDir + '.tar.gz';
  } catch {}

  return { dir: baseDir, tarPath: tarPath || null };
}

export default { createSupportBundle };
