import store from './store.js';
import { providerApiKeyName } from './well-known.js';

export function createSecretsContext(options = {}){
  const agentHomeRoot = options.agentHomeRoot;
  const cache = new Map();
  const TTL_MS = 30000;

  async function getText(name){
    const key = String(name || '').trim();
    if (!key) return '';

    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAtMs > now){
      return cached.value;
    }

    let value;
    try {
      value = await store.getText(key, agentHomeRoot);
    } catch (e) {
      if (e && (e.code === 'VAULT_LOCKED' || e.code === 'VAULT_UNINITIALIZED')){
        throw e;
      }
      return '';
    }

    const v = String(value || '');
    if (!v) return '';
    cache.set(key, { value: v, expiresAtMs: now + TTL_MS });
    return v;
  }

  async function check(names){
    const list = Array.isArray(names) ? names : [names];
    const missing = [];
    const values = {};

    for (const n of list){
      const key = String(n || '').trim();
      if (!key) continue;
      const v = await getText(key);
      if (!v){
        missing.push(key);
      } else {
        values[key] = v;
      }
    }

    return { ok: missing.length === 0, missing, values };
  }

  async function require(names){
    const { ok, missing, values } = await check(names);
    if (!ok){
      const msg = missing.length === 1
        ? `Missing secret: ${missing[0]}`
        : `Missing secrets: ${missing.join(', ')}`;
      const err = new Error(msg);
      try { err.code = 'MISSING_SECRET'; } catch {}
      try { err.missing = missing.slice(); } catch {}
      throw err;
    }
    return values;
  }

  async function getProviderApiKey(provider){
    const prov = String(provider || '').trim().toLowerCase();
    if (!prov) return '';

    const name = providerApiKeyName(prov);
    if (!name) return '';

    const key = await getText(name);
    return key || '';
  }

  async function buildEnv(map){
    if (!map || typeof map !== 'object') return {};
    const out = {};
    for (const [envName, secretNameRaw] of Object.entries(map)){
      const k = String(envName || '').trim();
      if (!k) continue;
      const secretName = String(secretNameRaw || k).trim();
      if (!secretName) continue;
      const v = await getText(secretName);
      if (!v) continue;
      out[k] = v;
    }
    return out;
  }

  return {
    getText,
    check,
    require,
    getProviderApiKey,
    buildEnv,
  };
}

export default { createSecretsContext };
