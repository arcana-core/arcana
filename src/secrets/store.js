import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { arcanaHomePath } from '../arcana-home.js';

const DEFAULT_SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function isValidName(n){
  try {
    const s = String(n || '');
    return /^[A-Za-z_][A-Za-z0-9_/-]*$/.test(s);
  } catch { return false; }
}

function filterValues(raw){
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(src)){
    if (!isValidName(k)) continue;
    if (v == null) continue;
    const s = String(v);
    if (!s) continue;
    out[k] = s;
  }
  return out;
}

function ensureParentDir(path){
  try {
    if (!path) return;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {}
}

function deriveKey(passphrase, kdfParams){
  const base = kdfParams || {};
  const N = typeof base.N === 'number' && base.N > 0 ? base.N : DEFAULT_SCRYPT_PARAMS.N;
  const r = typeof base.r === 'number' && base.r > 0 ? base.r : DEFAULT_SCRYPT_PARAMS.r;
  const p = typeof base.p === 'number' && base.p > 0 ? base.p : DEFAULT_SCRYPT_PARAMS.p;
  const maxmem = typeof base.maxmem === 'number' && base.maxmem > 0 ? base.maxmem : DEFAULT_SCRYPT_PARAMS.maxmem;
  const saltB64 = base.saltB64 || randomBytes(16).toString('base64');
  const salt = Buffer.from(String(saltB64), 'base64');
  const key = scryptSync(String(passphrase || ''), salt, 32, { N, r, p, maxmem });
  return { key, kdf:{ name: 'scrypt', saltB64, N, r, p, maxmem } };
}

function encryptValuesWithKey(values, key, kdf, extra){
  const clean = filterValues(values);
  const payload = { values: clean };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const names = Object.keys(clean);
  return {
    version: 1,
    kdf,
    cipher: {
      alg: 'aes-256-gcm',
      ivB64: iv.toString('base64'),
      tagB64: tag.toString('base64'),
    },
    ciphertextB64: ciphertext.toString('base64'),
    names,
    updatedAt: new Date().toISOString(),
    ...(extra || {}),
  };
}

function decryptValuesWithKey(fileObj, key){
  if (!fileObj || typeof fileObj !== 'object') return {};
  const cipherMeta = fileObj.cipher || {};
  const ivB64 = cipherMeta.ivB64 || fileObj.ivB64 || fileObj.iv;
  const tagB64 = cipherMeta.tagB64 || fileObj.tagB64 || fileObj.tag;
  const ciphertextB64 = fileObj.ciphertextB64 || fileObj.ciphertext;
  const iv = Buffer.from(String(ivB64 || ''), 'base64');
  const tag = Buffer.from(String(tagB64 || ''), 'base64');
  const enc = Buffer.from(String(ciphertextB64 || ''), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  const obj = JSON.parse(out.toString('utf8') || '{}');
  const vals = obj && typeof obj === 'object' && obj.values && typeof obj.values === 'object' ? obj.values : {};
  return filterValues(vals);
}

function readJsonIfExists(path){
  try {
    if (!path || !existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    if (!raw || !raw.trim()) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function writeJsonSecure(path, obj){
  const json = JSON.stringify(obj, null, 2);
  ensureParentDir(path);
  try {
    writeFileSync(path, json, { mode: 0o600 });
  } catch {
    writeFileSync(path, json);
  }
  try { chmodSync(path, 0o600); } catch {}
}

function globalVaultPath(){
  return arcanaHomePath('secrets.enc');
}

function agentVaultPath(agentHomeRoot){
  const base = String(agentHomeRoot || '').trim();
  if (!base) return '';
  return join(base, 'secrets.enc');
}

let derivedKey = null;
let derivedKdf = null;

function setDerived(key, kdf){
  derivedKey = key || null;
  derivedKdf = kdf || null;
}

function ensureInitializedStatus(){
  const path = globalVaultPath();
  const initialized = !!(path && existsSync(path));
  const locked = initialized ? !derivedKey : false;
  return { initialized, locked };
}

export function status(){
  return ensureInitializedStatus();
}

export function lock(){
  setDerived(null, null);
}

function ensureInitialized(){
  const st = ensureInitializedStatus();
  if (!st.initialized){
    const err = new Error('vault_uninitialized');
    try { err.code = 'VAULT_UNINITIALIZED'; } catch {}
    throw err;
  }
  return st;
}

function ensureUnlocked(){
  const st = ensureInitialized();
  if (st.locked){
    const err = new Error('vault_locked');
    try { err.code = 'VAULT_LOCKED'; } catch {}
    throw err;
  }
  return st;
}

export function init(password){
  const path = globalVaultPath();
  if (path && existsSync(path)){
    const err = new Error('vault_already_initialized');
    try { err.code = 'VAULT_ALREADY_INITIALIZED'; } catch {}
    throw err;
  }
  const pass = String(password || '');
  if (!pass){
    const err = new Error('password_required');
    try { err.code = 'VAULT_PASSWORD_REQUIRED'; } catch {}
    throw err;
  }
  const { key, kdf } = deriveKey(pass, null);
  const fileObj = encryptValuesWithKey({}, key, kdf, {});
  writeJsonSecure(path, fileObj);
  setDerived(key, kdf);
  return { initialized: true, locked: false };
}

export function unlock(password){
  const path = globalVaultPath();
  if (!path || !existsSync(path)){
    const err = new Error('vault_uninitialized');
    try { err.code = 'VAULT_UNINITIALIZED'; } catch {}
    throw err;
  }
  const pass = String(password || '');
  if (!pass){
    const err = new Error('password_required');
    try { err.code = 'VAULT_PASSWORD_REQUIRED'; } catch {}
    throw err;
  }
  const data = readJsonIfExists(path);
  if (!data){
    const err = new Error('vault_uninitialized');
    try { err.code = 'VAULT_UNINITIALIZED'; } catch {}
    throw err;
  }
  const { key, kdf } = deriveKey(pass, data.kdf || null);
  try {
    decryptValuesWithKey(data, key);
  } catch (e) {
    const err = new Error('vault_bad_passphrase');
    try { err.code = 'VAULT_BAD_PASSPHRASE'; } catch {}
    throw err;
  }
  setDerived(key, kdf);
  return { initialized: true, locked: false };
}

function readDecrypted(path){
  ensureUnlocked();
  const data = readJsonIfExists(path);
  if (!data) return { values: {}, meta: {} };
  if (!derivedKey || !derivedKdf){
    const err = new Error('vault_locked');
    try { err.code = 'VAULT_LOCKED'; } catch {}
    throw err;
  }
  const values = decryptValuesWithKey(data, derivedKey);
  const meta = {
    path,
    names: Array.isArray(data.names) ? data.names.slice() : Object.keys(values),
    inheritGlobal: typeof data.inheritGlobal === 'boolean' ? data.inheritGlobal : true,
  };
  return { values, meta };
}

function writeEncrypted(path, values, extra){
  ensureUnlocked();
  if (!derivedKey || !derivedKdf){
    const err = new Error('vault_locked');
    try { err.code = 'VAULT_LOCKED'; } catch {}
    throw err;
  }
  const obj = encryptValuesWithKey(values, derivedKey, derivedKdf, extra || {});
  writeJsonSecure(path, obj);
}

export function reset(agentHomeRoot){
  try {
    const gPath = globalVaultPath();
    const aPath = agentVaultPath(agentHomeRoot);
    let g = false;
    let a = false;
    try { if (gPath && existsSync(gPath)) { unlinkSync(gPath); g = true; } } catch {}
    try { if (aPath && existsSync(aPath)) { unlinkSync(aPath); a = true; } } catch {}
    try { lock(); } catch {}
    return { global: g, agent: a };
  } catch {
    try { lock(); } catch {}
    return { global: false, agent: false };
  }
}

export function getText(name, agentHomeRoot){
  const key = String(name || '').trim();
  if (!key) return Promise.resolve('');
  ensureUnlocked();
  try {
    const gPath = globalVaultPath();
    const aPath = agentVaultPath(agentHomeRoot);
    const hasGlobalFile = !!(gPath && existsSync(gPath));
    if (!hasGlobalFile){
      const err = new Error('vault_uninitialized');
      try { err.code = 'VAULT_UNINITIALIZED'; } catch {}
      throw err;
    }
    let agentValues = null;
    let inheritGlobal = true;
    if (aPath && existsSync(aPath)){
      const { values, meta } = readDecrypted(aPath);
      agentValues = values;
      inheritGlobal = meta.inheritGlobal !== false;
      if (Object.prototype.hasOwnProperty.call(agentValues, key)){
        return Promise.resolve(agentValues[key] || '');
      }
    }
    if (inheritGlobal){
      const { values: gValues } = readDecrypted(gPath);
      const v = Object.prototype.hasOwnProperty.call(gValues, key) ? gValues[key] : '';
      return Promise.resolve(v || '');
    }
    return Promise.resolve('');
  } catch (e) {
    return Promise.reject(e);
  }
}

export function setText(name, value, scope, agentHomeRoot){
  const key = String(name || '').trim();
  if (!isValidName(key)){
    const err = new Error('invalid_name');
    try { err.code = 'VAULT_INVALID_NAME'; } catch {}
    return Promise.reject(err);
  }
  const val = String(value || '');
  if (!val){
    const err = new Error('value_required');
    try { err.code = 'VAULT_VALUE_REQUIRED'; } catch {}
    return Promise.reject(err);
  }
  const scopeRaw = String(scope || '').trim().toLowerCase();
  const sc = scopeRaw === 'agent' ? 'agent' : 'global';
  try {
    ensureUnlocked();
    const gPath = globalVaultPath();
    const aPath = agentVaultPath(agentHomeRoot);
    const hasGlobalFile = !!(gPath && existsSync(gPath));
    if (!hasGlobalFile){
      const err = new Error('vault_uninitialized');
      try { err.code = 'VAULT_UNINITIALIZED'; } catch {}
      throw err;
    }
    if (sc === 'global'){
      const { values } = readDecrypted(gPath);
      values[key] = val;
      writeEncrypted(gPath, values, {});
      return Promise.resolve({ scope: 'global', name: key });
    }
    if (!aPath){
      const err = new Error('agent_home_required');
      try { err.code = 'VAULT_AGENT_HOME_REQUIRED'; } catch {}
      throw err;
    }
    let baseValues = {};
    let inheritGlobal = true;
    if (existsSync(aPath)){
      const { values, meta } = readDecrypted(aPath);
      baseValues = values;
      inheritGlobal = meta.inheritGlobal !== false;
    }
    baseValues[key] = val;
    writeEncrypted(aPath, baseValues, { inheritGlobal });
    return Promise.resolve({ scope: 'agent', name: key });
  } catch (e) {
    return Promise.reject(e);
  }
}

export function unset(name, scope, agentHomeRoot){
  const key = String(name || '').trim();
  if (!key) return Promise.resolve({ scope: '', name: '' });
  const scopeRaw = String(scope || '').trim().toLowerCase();
  const sc = scopeRaw === 'agent' ? 'agent' : (scopeRaw === 'global' ? 'global' : '');
  try {
    ensureUnlocked();
    const gPath = globalVaultPath();
    const aPath = agentVaultPath(agentHomeRoot);
    const hasGlobalFile = !!(gPath && existsSync(gPath));
    if (!hasGlobalFile){
      const err = new Error('vault_uninitialized');
      try { err.code = 'VAULT_UNINITIALIZED'; } catch {}
      throw err;
    }
    if (sc === 'global'){
      const { values } = readDecrypted(gPath);
      delete values[key];
      writeEncrypted(gPath, values, {});
      return Promise.resolve({ scope: 'global', name: key });
    }
    if (sc === 'agent'){
      if (!aPath || !existsSync(aPath)) return Promise.resolve({ scope: 'agent', name: key });
      const { values, meta } = readDecrypted(aPath);
      delete values[key];
      writeEncrypted(aPath, values, { inheritGlobal: meta.inheritGlobal !== false });
      return Promise.resolve({ scope: 'agent', name: key });
    }
    return Promise.resolve({ scope: '', name: key });
  } catch (e) {
    return Promise.reject(e);
  }
}

export function listNames(agentHomeRoot){
  try {
    const gPath = globalVaultPath();
    const aPath = agentVaultPath(agentHomeRoot);
    const initialized = !!(gPath && existsSync(gPath));
    const locked = initialized ? !derivedKey : false;
    let globalNames = [];
    let agentNames = [];
    let inheritGlobal = true;
    if (gPath && existsSync(gPath)){
      const data = readJsonIfExists(gPath) || {};
      if (Array.isArray(data.names)) globalNames = data.names.filter((n)=>isValidName(n));
    }
    if (aPath && existsSync(aPath)){
      const data = readJsonIfExists(aPath) || {};
      if (Array.isArray(data.names)) agentNames = data.names.filter((n)=>isValidName(n));
      if (typeof data.inheritGlobal === 'boolean') inheritGlobal = data.inheritGlobal;
    }
    const allSet = new Set();
    for (const n of globalNames){ allSet.add(n); }
    for (const n of agentNames){ allSet.add(n); }
    const allNames = Array.from(allSet).sort();
    const bindings = {};
    for (const n of allNames){
      const hasGlobal = globalNames.includes(n);
      const hasAgent = agentNames.includes(n);
      const scope = hasAgent ? 'agent' : (hasGlobal ? 'global' : '');
      bindings[n] = {
        name: n,
        scope,
        hasGlobal,
        hasAgent,
        inherited: inheritGlobal,
      };
    }
    const meta = {
      global: {
        path: gPath || '',
        hasFile: !!(gPath && existsSync(gPath)),
        initialized,
        locked,
      },
      agent: {
        path: aPath || '',
        hasFile: !!(aPath && existsSync(aPath)),
        inheritGlobal,
      },
    };
    return Promise.resolve({ bindings, meta });
  } catch (e) {
    return Promise.reject(e);
  }
}

export default {
  status,
  init,
  unlock,
  lock,
  getText,
  setText,
  unset,
  listNames,
  globalVaultPath,
  agentVaultPath,
  reset
};
