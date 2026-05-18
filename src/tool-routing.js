import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VALID_EXECUTION = new Set(['local', 'cloud', 'auto']);
const VALID_FALLBACK = new Set(['deny', 'cloud', 'queue']);

function normalizeExecution(value){
  const v = String(value || '').trim().toLowerCase();
  return VALID_EXECUTION.has(v) ? v : 'auto';
}

function normalizeFallback(value){
  const v = String(value || '').trim().toLowerCase();
  return VALID_FALLBACK.has(v) ? v : 'cloud';
}

function normalizeRoute(raw){
  const route = (raw && typeof raw === 'object') ? raw : {};
  return {
    ...route,
    execution: normalizeExecution(route.execution),
    fallback: normalizeFallback(route.fallback),
  };
}

function parseJsonFile(filePath){
  try {
    if (!filePath || !existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractToolMap(input){
  if (!input || typeof input !== 'object') return {};

  if (input.tools && typeof input.tools === 'object' && !Array.isArray(input.tools)){
    return input.tools;
  }

  if (input.routes && typeof input.routes === 'object' && !Array.isArray(input.routes)){
    return input.routes;
  }

  const out = {};
  for (const [key, value] of Object.entries(input)){
    if (key === 'version') continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    out[key] = value;
  }
  return out;
}

function mergeToolMaps(base, patch){
  const out = { ...(base || {}) };
  const source = patch && typeof patch === 'object' ? patch : {};
  for (const [toolName, nextRouteRaw] of Object.entries(source)){
    if (!toolName) continue;
    const prevRoute = (out[toolName] && typeof out[toolName] === 'object') ? out[toolName] : {};
    const nextRoute = (nextRouteRaw && typeof nextRouteRaw === 'object') ? nextRouteRaw : {};
    out[toolName] = { ...prevRoute, ...nextRoute };
  }
  return out;
}

export function loadToolRouting({ workspaceRoot, repoRoot, overrides } = {}){
  const defaultPath = repoRoot ? join(repoRoot, 'tool-routing.json') : '';
  const workspacePath = workspaceRoot ? join(workspaceRoot, '.arcana', 'tool-routing.json') : '';

  const defaultCfg = parseJsonFile(defaultPath) || {};
  const workspaceCfg = parseJsonFile(workspacePath) || {};
  const overrideCfg = (overrides && typeof overrides === 'object') ? overrides : {};

  const defaultTools = extractToolMap(defaultCfg);
  const workspaceTools = extractToolMap(workspaceCfg);
  const overrideTools = extractToolMap(overrideCfg);

  const mergedTools = mergeToolMaps(
    mergeToolMaps(defaultTools, workspaceTools),
    overrideTools,
  );

  const normalizedTools = {};
  for (const [toolName, routeRaw] of Object.entries(mergedTools)){
    if (!toolName) continue;
    normalizedTools[toolName] = normalizeRoute(routeRaw);
  }

  return {
    version: overrideCfg.version ?? workspaceCfg.version ?? defaultCfg.version ?? 1,
    tools: normalizedTools,
  };
}

export function resolveToolRoute(routing, toolName){
  const name = String(toolName || '').trim();
  const tools = (routing && routing.tools && typeof routing.tools === 'object') ? routing.tools : {};
  const raw = (name && tools[name] && typeof tools[name] === 'object') ? tools[name] : {};
  return normalizeRoute(raw);
}

export default { loadToolRouting, resolveToolRoute };
