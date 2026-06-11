// Platform SDK for Arcana services.
//
// Services receive this as `ctx.sdk` in start(ctx). It is the SANCTIONED way
// for a service to reach Arcana capabilities — instead of importing ../src/*
// internals directly (which has no stability contract and breaks under
// process isolation).
//
// The same surface works in both execution modes:
//   - in-process: capabilities call Arcana modules directly
//   - isolated child: secrets are brokered over IPC to the gateway process
//     (the vault's derived key never leaves the gateway); everything else is
//     file- or HTTP-based and works in any process
//
// Secrets are scoped per service: services/services.config.json declares
//   { "<serviceId>": { "secrets": ["NAME_A", "NAME_B"] } }   // or "*"
// Undeclared services get an empty allowlist (deny by default). Enforcement
// happens in the SDK and — for isolated children — again in the gateway-side
// broker, which is the real trust boundary.

import { join } from 'node:path';
import { promises as fsp } from 'node:fs';
import { ensureArcanaHomeDir } from '../arcana-home.js';
import { loadOrCreateApiToken, API_TOKEN_HEADER } from '../auth/api-token.js';
import { loadSession, listSessions, appendMessage } from '../sessions-store.js';
import { getSessionIdForKey, resolveSessionIdForKey } from '../session-key-store.js';
import { registerSecretValue } from '../secrets/redaction.js';

export const SDK_VERSION = 1;
const DEFAULT_AGENT_ID = 'default';

export function normalizeSecretsAllowlist(raw){
  if (raw === '*' || raw === true) return '*';
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw){
    const name = String(item || '').trim();
    if (name) out.push(name);
  }
  return out;
}

export function isSecretAllowed(allowlist, name){
  if (allowlist === '*') return true;
  if (!Array.isArray(allowlist)) return false;
  return allowlist.includes(String(name || '').trim());
}

function secretDeniedError(serviceId, name){
  const err = new Error(
    'secret "' + name + '" is not declared for service "' + serviceId + '"; ' +
    'add it to services/services.config.json under { "' + serviceId + '": { "secrets": [...] } }',
  );
  err.code = 'SECRET_NOT_ALLOWED';
  return err;
}

function normalizeAgentId(raw){
  try {
    const s = String(raw || '').trim();
    if (!s) return DEFAULT_AGENT_ID;
    const safe = s.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe || DEFAULT_AGENT_ID;
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function agentHomeRootFor(agentId){
  const base = ensureArcanaHomeDir();
  return join(base, 'agents', normalizeAgentId(agentId));
}

export function resolveGatewayUrl(){
  const raw = String(process.env.ARCANA_URL || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787;
  return 'http://127.0.0.1:' + port;
}

function resolveApiToken(){
  const env = String(process.env.ARCANA_API_TOKEN || '').trim();
  if (env) return env;
  try { return loadOrCreateApiToken() || ''; } catch { return ''; }
}

// Gateway-side resolvers used by the in-process SDK and by the IPC broker.
// Imported lazily so isolated children never load the vault machinery.
async function loadSecretsStore(){
  const mod = await import('../secrets/index.js');
  const store = mod.secrets || (mod.default && mod.default.secrets);
  if (!store || typeof store.getText !== 'function'){
    const err = new Error('secrets store unavailable');
    err.code = 'SECRETS_UNAVAILABLE';
    throw err;
  }
  return store;
}

export async function resolveSecretFromStore({ name, agentId } = {}){
  const store = await loadSecretsStore();
  const agentHomeRoot = agentId ? agentHomeRootFor(agentId) : undefined;
  const value = store.getText(String(name || '').trim(), agentHomeRoot);
  // Track every resolved secret so it is scrubbed from outbound events/logs.
  try { if (value) registerSecretValue(value); } catch {}
  return value;
}

export async function resolveSecretStatusFromStore(){
  const store = await loadSecretsStore();
  if (typeof store.status !== 'function') return { initialized: null, locked: null };
  const st = store.status() || {};
  return {
    initialized: typeof st.initialized === 'boolean' ? st.initialized : null,
    locked: typeof st.locked === 'boolean' ? st.locked : null,
  };
}

export async function resolveSecretNamesFromStore({ agentId } = {}){
  const store = await loadSecretsStore();
  if (typeof store.listNames !== 'function') return { bindings: {} };
  const agentHomeRoot = agentId ? agentHomeRootFor(agentId) : undefined;
  const listed = await store.listNames(agentHomeRoot);
  return listed && typeof listed === 'object' ? listed : { bindings: {} };
}

// Restrict binding metadata to the service's declared secret names.
export function filterBindingsToAllowlist(listed, allowlist){
  if (!listed || typeof listed !== 'object') return { bindings: {} };
  if (allowlist === '*') return listed;
  const bindings = (listed.bindings && typeof listed.bindings === 'object') ? listed.bindings : {};
  const filtered = {};
  for (const k of Object.keys(bindings)){
    if (Array.isArray(allowlist) && allowlist.includes(k)) filtered[k] = bindings[k];
  }
  return { ...listed, bindings: filtered };
}

export function buildServiceSdk(opts = {}){
  const serviceId = String(opts.serviceId || '').trim() || 'unknown';
  const workspaceRoot = String(opts.workspaceRoot || '') || process.cwd();
  const logDir = String(opts.logDir || '') || workspaceRoot;
  const mode = opts.mode === 'child' ? 'child' : 'in-process';
  const allowlist = normalizeSecretsAllowlist(opts.secretsAllowlist);
  const ipcCall = typeof opts.ipcCall === 'function' ? opts.ipcCall : null;
  // injectable for tests
  const fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : fetch;
  const resolveSecret = typeof opts.resolveSecretFn === 'function' ? opts.resolveSecretFn : resolveSecretFromStore;
  const resolveStatus = typeof opts.resolveSecretStatusFn === 'function' ? opts.resolveSecretStatusFn : resolveSecretStatusFromStore;
  const resolveNames = typeof opts.resolveSecretNamesFn === 'function' ? opts.resolveSecretNamesFn : resolveSecretNamesFromStore;

  const gatewayUrl = resolveGatewayUrl();
  let cachedToken = null;
  function getApiToken(){
    if (cachedToken == null) cachedToken = resolveApiToken();
    return cachedToken;
  }

  async function callGateway(path, body, { method = 'POST' } = {}){
    const url = gatewayUrl + (String(path || '').startsWith('/') ? path : '/' + path);
    const token = getApiToken();
    const headers = { 'content-type': 'application/json' };
    if (token){
      headers.authorization = 'Bearer ' + token;
      headers[API_TOKEN_HEADER] = token;
    }
    const init = { method, headers };
    if (body !== undefined && method !== 'GET') init.body = JSON.stringify(body);
    const res = await fetchFn(url, init);
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok){
      const err = new Error('gateway ' + method + ' ' + path + ' failed: HTTP ' + res.status
        + (json && (json.message || json.error) ? (' ' + (json.message || json.error)) : ''));
      err.code = 'GATEWAY_HTTP_' + res.status;
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  function streamUrl(params = {}){
    const base = new URL(gatewayUrl);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = '/v2/stream';
    const token = getApiToken();
    if (token) base.searchParams.set('token', token);
    for (const [k, v] of Object.entries(params)){
      if (v == null) continue;
      const s = String(v).trim();
      if (s) base.searchParams.set(k, s);
    }
    return base.toString();
  }

  async function getSecret(name, { agentId } = {}){
    const key = String(name || '').trim();
    if (!key){
      const err = new Error('secret name required');
      err.code = 'SECRET_NAME_REQUIRED';
      throw err;
    }
    if (!isSecretAllowed(allowlist, key)) throw secretDeniedError(serviceId, key);
    if (mode === 'child'){
      if (!ipcCall){
        const err = new Error('sdk ipc unavailable');
        err.code = 'SDK_IPC_UNAVAILABLE';
        throw err;
      }
      return ipcCall('secrets.get', { name: key, agentId: agentId ? String(agentId) : undefined });
    }
    return resolveSecret({ name: key, agentId });
  }

  async function getSecretStatus(){
    if (mode === 'child'){
      if (!ipcCall){ const e = new Error('sdk ipc unavailable'); e.code = 'SDK_IPC_UNAVAILABLE'; throw e; }
      return ipcCall('secrets.status', {});
    }
    return resolveStatus();
  }

  async function getSecretNames({ agentId } = {}){
    let listed;
    if (mode === 'child'){
      if (!ipcCall){ const e = new Error('sdk ipc unavailable'); e.code = 'SDK_IPC_UNAVAILABLE'; throw e; }
      // The broker already scopes to the allowlist; filter again locally so
      // both sides agree even if the broker is permissive.
      listed = await ipcCall('secrets.listNames', { agentId: agentId ? String(agentId) : undefined });
    } else {
      listed = await resolveNames({ agentId });
    }
    return filterBindingsToAllowlist(listed, allowlist);
  }

  async function log(level, message){
    const line = '[' + new Date().toISOString() + '] [' + String(level || 'info') + '] ' + String(message || '') + '\n';
    try { await fsp.appendFile(join(logDir, 'sdk.log'), line, 'utf-8'); } catch {}
  }

  return {
    version: SDK_VERSION,
    serviceId,
    workspaceRoot,
    mode,
    agent: {
      gatewayUrl,
      getApiToken,
      call: callGateway,
      turn: (payload) => callGateway('/v2/turn-sync', payload),
      turnAsync: (payload) => callGateway('/v2/turn-async', payload),
      streamUrl,
    },
    secrets: {
      get: getSecret,
      status: getSecretStatus,
      listNames: getSecretNames,
      // The declared contract, not the vault contents: deterministic in both
      // modes and never touches the store.
      list: async () => (allowlist === '*' ? '*' : allowlist.slice()),
    },
    sessions: {
      load: (sessionId, o) => loadSession(sessionId, o),
      list: (agentId) => listSessions(agentId),
      append: (sessionId, message) => appendMessage(sessionId, message),
      idForKey: (o) => getSessionIdForKey(o),
      resolveIdForKey: (o) => resolveSessionIdForKey(o),
    },
    agents: {
      normalizeId: normalizeAgentId,
      homeRoot: agentHomeRootFor,
    },
    log,
  };
}

export default { SDK_VERSION, buildServiceSdk, normalizeSecretsAllowlist, isSecretAllowed, resolveGatewayUrl, resolveSecretFromStore };
