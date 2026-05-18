import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureArcanaHomeDir } from './arcana-home.js';

function groupsDir(){
  const baseHome = ensureArcanaHomeDir();
  const d = join(baseHome, 'group-sessions');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function nowIso(){
  try { return new Date().toISOString(); } catch { return String(new Date()); }
}

function slug(s){
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\-_\s]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'group';
}

function writeGroupFileAtomic(path, obj){
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  try {
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(path); } catch {}
    renameSync(tmp, path);
  }
}

function generateGroupEventId(){
  const stamp = Date.now().toString(36);
  let rand = '';
  try {
    rand = Number.parseInt(randomBytes(4).toString('hex'), 16).toString(36);
  } catch {
    rand = Math.random().toString(36).slice(2);
  }
  return 'gevt_' + stamp + '_' + rand;
}

function normalizeOptionalString(raw){
  const value = String(raw == null ? '' : raw).trim();
  return value || '';
}

function normalizeOptionalStringList(raw){
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw){
    const value = normalizeOptionalString(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeGroupEventSender(raw){
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const type = normalizeOptionalString(raw.type);
  const agentId = normalizeOptionalString(raw.agentId);
  if (type) out.type = type;
  if (agentId) out.agentId = agentId;
  return Object.keys(out).length ? out : null;
}

function normalizeGroupEventSource(raw){
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const kind = normalizeOptionalString(raw.kind);
  const fromAgentId = normalizeOptionalString(raw.fromAgentId);
  const triggerEventId = normalizeOptionalString(raw.triggerEventId);
  if (kind) out.kind = kind;
  if (fromAgentId) out.fromAgentId = fromAgentId;
  if (triggerEventId) out.triggerEventId = triggerEventId;
  return Object.keys(out).length ? out : null;
}

function normalizeGroupEventRouting(raw){
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const mode = normalizeOptionalString(raw.mode);
  const mentionedAgentIds = normalizeOptionalStringList(raw.mentionedAgentIds);
  const deliveredAgentIds = normalizeOptionalStringList(raw.deliveredAgentIds);
  const parsedFrom = normalizeOptionalString(raw.parsedFrom);
  if (mode) out.mode = mode;
  if (mentionedAgentIds.length) out.mentionedAgentIds = mentionedAgentIds;
  if (deliveredAgentIds.length) out.deliveredAgentIds = deliveredAgentIds;
  if (parsedFrom) out.parsedFrom = parsedFrom;
  return Object.keys(out).length ? out : null;
}

function normalizeGroupEventHandoff(raw){
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const hopNum = Number(raw.hop);
  const fromAgentId = normalizeOptionalString(raw.fromAgentId);
  const toAgentId = normalizeOptionalString(raw.toAgentId);
  const triggerEventId = normalizeOptionalString(raw.triggerEventId);
  if (Number.isFinite(hopNum) && hopNum >= 0) out.hop = Math.trunc(hopNum);
  if (fromAgentId) out.fromAgentId = fromAgentId;
  if (toAgentId) out.toAgentId = toAgentId;
  if (triggerEventId) out.triggerEventId = triggerEventId;
  return Object.keys(out).length ? out : null;
}

function normalizeGroupEvent(event){
  const src = (event && typeof event === 'object') ? event : {};
  const role = String(src.role || 'user').trim() || 'user';
  const out = {
    id: normalizeOptionalString(src.id) || generateGroupEventId(),
    type: String(src.type || 'message').trim() || 'message',
    role,
    text: String(src.text || ''),
    ts: String(src.ts || nowIso()),
  };
  const agentId = String(src.agentId || '').trim();
  if (agentId) out.agentId = agentId;
  const sender = normalizeGroupEventSender(src.sender);
  if (sender) out.sender = sender;
  const source = normalizeGroupEventSource(src.source);
  if (source) out.source = source;
  const routing = normalizeGroupEventRouting(src.routing);
  if (routing) out.routing = routing;
  const handoff = normalizeGroupEventHandoff(src.handoff);
  if (handoff) out.handoff = handoff;
  const clientMessageId = normalizeOptionalString(src.clientMessageId);
  if (clientMessageId) out.clientMessageId = clientMessageId;
  return out;
}

function normalizeMember(member){
  const src = (member && typeof member === 'object') ? member : {};
  const agentId = String(src.agentId || '').trim();
  const memberSessionId = String(src.memberSessionId || '').trim();
  const memberSessionKey = String(src.memberSessionKey || memberSessionId).trim();
  return {
    agentId,
    memberSessionId,
    memberSessionKey,
  };
}

function normalizeGroup(obj){
  if (!obj || typeof obj !== 'object') return null;
  const members = Array.isArray(obj.members)
    ? obj.members.map((member) => normalizeMember(member)).filter((member) => member.agentId && member.memberSessionId)
    : [];
  const events = Array.isArray(obj.events)
    ? obj.events.map((event) => normalizeGroupEvent(event))
    : [];
  const out = {
    id: String(obj.id || '').trim(),
    kind: 'group',
    title: String(obj.title || '').trim(),
    workspace: String(obj.workspace || '').trim(),
    createdAt: String(obj.createdAt || nowIso()),
    updatedAt: String(obj.updatedAt || obj.createdAt || nowIso()),
    archived: obj.archived === true,
    members,
    events,
  };
  if (!out.id) return null;
  return out;
}

function saveGroupInternal(obj){
  const normalized = normalizeGroup(obj);
  if (!normalized || !normalized.id) return false;
  normalized.updatedAt = nowIso();
  const p = join(groupsDir(), normalized.id + '.json');
  writeGroupFileAtomic(p, normalized);
  return true;
}

export function createGroupSession({ title, workspace, members, events } = {}){
  const stamp = nowIso().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const rand = randomBytes(4).toString('hex');
  const t = String(title || '').trim();
  const obj = normalizeGroup({
    id: stamp + '--group--' + slug(t) + '--' + rand,
    kind: 'group',
    title: t,
    workspace: String(workspace || '').trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    archived: false,
    members: Array.isArray(members) ? members : [],
    events: Array.isArray(events) ? events : [],
  });
  if (!obj) return null;
  const p = join(groupsDir(), obj.id + '.json');
  writeGroupFileAtomic(p, obj);
  return obj;
}

export function listGroupSessions(opts){
  const options = (opts && typeof opts === 'object') ? opts : {};
  const workspace = String(options.workspace || '').trim();
  const includeArchived = options.includeArchived === true;
  const out = [];
  for (const name of readdirSync(groupsDir())){
    if (!name.endsWith('.json')) continue;
    const p = join(groupsDir(), name);
    try {
      const st = statSync(p);
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      const obj = normalizeGroup(raw);
      if (!obj) continue;
      if (!includeArchived && obj.archived === true) continue;
      if (workspace !== obj.workspace) continue;
      const createdAt = obj.createdAt || new Date(st.ctimeMs).toISOString();
      const updatedAt = obj.updatedAt || new Date(st.mtimeMs).toISOString();
      const last = obj.events.length ? obj.events[obj.events.length - 1] : null;
      out.push({
        id: obj.id,
        kind: 'group',
        title: obj.title,
        workspace: obj.workspace,
        createdAt,
        updatedAt,
        archived: obj.archived === true,
        members: obj.members,
        last,
      });
    } catch {}
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

export function loadGroupSession(id){
  const gid = String(id || '').trim();
  if (!gid) return null;
  const p = join(groupsDir(), gid + '.json');
  if (!existsSync(p)) return null;
  try {
    return normalizeGroup(JSON.parse(readFileSync(p, 'utf-8')));
  } catch {
    return null;
  }
}

export function saveGroupSession(obj){
  return saveGroupInternal(obj);
}

export function appendGroupEvent(id, event){
  const gid = String(id || '').trim();
  if (!gid) return null;
  const obj = loadGroupSession(gid);
  if (!obj) return null;
  const nextEvent = normalizeGroupEvent(event);
  obj.events = Array.isArray(obj.events) ? obj.events : [];
  obj.events.push(nextEvent);
  obj.updatedAt = String(nextEvent.ts || nowIso());
  if (!saveGroupInternal(obj)) return null;
  return { group: obj, event: nextEvent };
}

export function deleteGroupSession(id){
  const gid = String(id || '').trim();
  if (!gid) return false;
  const p = join(groupsDir(), gid + '.json');
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export default {
  createGroupSession,
  listGroupSessions,
  loadGroupSession,
  saveGroupSession,
  appendGroupEvent,
  deleteGroupSession,
};
