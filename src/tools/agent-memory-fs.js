import { Type } from '@sinclair/typebox';
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { ensureAgentReadAllowed, ensureAgentWriteAllowed, resolveAgentHomeRoot } from '../agent-guard.js';

function listAllowedRoots(){
  const root = resolveAgentHomeRoot();
  const memoryRoot = resolve(root, 'memory');
  return { root, memoryRoot };
}

function isAllowedMemoryRelPath(rel){
  const p = String(rel || '').replace(/\\/g, '/');
  if (p === 'MEMORY.md') return true;
  if (p.startsWith('memory/')){
    if (p.toLowerCase().endsWith('.md')) return true;
  }
  return false;
}

function normalizeMemoryPathForWrite(rawPath){
  const { root } = listAllowedRoots();
  const raw = String(rawPath || '').trim();
  if (!raw){
    const err = new Error('path is required');
    err.code = 'MEMORY_FS_PATH_REQUIRED';
    throw err;
  }
  const candidate = ensureAgentWriteAllowed(raw);
  const rel = relative(root, candidate).replace(/\\/g, '/');
  if (!isAllowedMemoryRelPath(rel)){
    const err = new Error('Path not allowed: only MEMORY.md and memory/**/*.md');
    err.code = 'MEMORY_FS_PATH_FORBIDDEN';
    throw err;
  }
  return { abs: candidate, rel };
}

function normalizeMemoryPathForRead(rawPath){
  const { root } = listAllowedRoots();
  const raw = String(rawPath || '').trim();
  if (!raw){
    const err = new Error('path is required');
    err.code = 'MEMORY_FS_PATH_REQUIRED';
    throw err;
  }
  const candidate = ensureAgentReadAllowed(raw);
  const rel = relative(root, candidate).replace(/\\/g, '/');
  if (!isAllowedMemoryRelPath(rel)){
    const err = new Error('Path not allowed: only MEMORY.md and memory/**/*.md');
    err.code = 'MEMORY_FS_PATH_FORBIDDEN';
    throw err;
  }
  return { abs: candidate, rel };
}

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

export function createAgentMemoryFsTools(){
  const WriteParams = Type.Object({
    path: Type.String({ description: 'Relative or absolute path; must resolve to MEMORY.md or memory/**/*.md under agent home.' }),
    content: Type.String({ description: 'UTF-8 markdown content to write.' }),
    mode: Type.Optional(Type.Union([
      Type.Literal('append'),
      Type.Literal('overwrite'),
    ])),
  });

  const writeTool = {
    label: 'Agent Memory Write',
    name: 'memory_write',
    description: 'Append to or overwrite MEMORY.md and memory/**/*.md under the agent home.',
    parameters: WriteParams,
    async execute(_id, args){
      let abs;
      let rel;
      try {
        const norm = normalizeMemoryPathForWrite(args.path);
        abs = norm.abs;
        rel = norm.rel;
      } catch (e){
        const msg = e && e.message ? String(e.message) : 'path not allowed';
        return { content:[{ type:'text', text: msg }], details:{ ok:false, error:'path_forbidden' } };
      }
      const modeRaw = typeof args.mode === 'string' ? args.mode : 'append';
      const mode = modeRaw === 'overwrite' ? 'overwrite' : 'append';
      const text = String(args.content || '');
      try {
        const dir = dirname(abs);
        await fsp.mkdir(dir, { recursive: true });
        if (mode === 'overwrite'){
          await fsp.writeFile(abs, text, 'utf-8');
        } else {
          let prefix = '';
          try {
            if (existsSync(abs)){
              const existing = readFileSync(abs, 'utf-8');
              if (existing && !existing.endsWith('\n')) prefix = '\n';
            }
          } catch {}
          await fsp.appendFile(abs, prefix + text, 'utf-8');
        }
        return { content:[{ type:'text', text: 'ok' }], details:{ ok:true, path: rel, mode } };
      } catch (e){
        const msg = e && e.message ? String(e.message) : 'write_failed';
        return { content:[{ type:'text', text: msg }], details:{ ok:false, error:'write_failed', path: rel, mode } };
      }
    }
  };

  const EditParams = Type.Object({
    path: Type.String({ description: 'Relative or absolute path; must resolve to MEMORY.md or memory/**/*.md under agent home.' }),
    oldText: Type.String({ description: 'Exact text to replace. Must be present in the file.' }),
    newText: Type.String({ description: 'Replacement text.' }),
    replaceAll: Type.Optional(Type.Boolean({ description: 'If true, replace all occurrences; otherwise only the first.' })),
  });

  const editTool = {
    label: 'Agent Memory Edit',
    name: 'memory_edit',
    description: 'Search and replace within MEMORY.md and memory/**/*.md under the agent home.',
    parameters: EditParams,
    async execute(_id, args){
      let abs;
      let rel;
      try {
        const norm = normalizeMemoryPathForWrite(args.path);
        abs = norm.abs;
        rel = norm.rel;
      } catch (e){
        const msg = e && e.message ? String(e.message) : 'path not allowed';
        return { content:[{ type:'text', text: msg }], details:{ ok:false, error:'path_forbidden' } };
      }
      const needle = String(args.oldText || '');
      const replacement = String(args.newText || '');
      if (!needle){
        const msg = 'oldText is required';
        return { content:[{ type:'text', text: msg }], details:{ ok:false, error:'old_text_required', path: rel } };
      }
      let text = '';
      try {
        const readNorm = normalizeMemoryPathForRead(args.path);
        const readAbs = readNorm.abs;
        text = await fsp.readFile(readAbs, 'utf-8');
      } catch (e){
        const msg = e && e.message ? String(e.message) : 'read_failed';
        return { content:[{ type:'text', text: msg }], details:{ ok:false, error:'read_failed', path: rel } };
      }
      if (!text.includes(needle)){
        const msg = 'oldText not found in file';
        return { content:[{ type:'text', text: msg }], details:{ ok:false, error:'old_text_not_found', path: rel } };
      }
      const replaceAll = !!args.replaceAll;
      let newContent;
      let count = 0;
      if (replaceAll){
        const parts = text.split(needle);
        count = clamp(parts.length - 1, 0, Number.MAX_SAFE_INTEGER);
        newContent = parts.join(replacement);
      } else {
        const idx = text.indexOf(needle);
        if (idx === -1){
          const msg = 'oldText not found in file';
          return { content:[{ type:'text', text: msg }], details:{ ok:false, error:'old_text_not_found', path: rel } };
        }
        count = 1;
        newContent = text.slice(0, idx) + replacement + text.slice(idx + needle.length);
      }
      try {
        await fsp.writeFile(abs, newContent, 'utf-8');
        const summary = 'edit ok: ' + String(count) + ' replacement(s)';
        return { content:[{ type:'text', text: summary }], details:{ ok:true, path: rel, replacements: count, replaceAll } };
      } catch (e){
        const msg = e && e.message ? String(e.message) : 'write_failed';
        return { content:[{ type:'text', text: msg }], details:{ ok:false, error:'write_failed', path: rel, replaceAll } };
      }
    }
  };

  return [writeTool, editTool];
}

export default createAgentMemoryFsTools;
