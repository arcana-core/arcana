import { Type } from '@sinclair/typebox';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { ensureAgentReadAllowed, resolveAgentHomeRoot } from '../agent-guard.js';

// Minimal deterministic memory tools (read/search only).
// Files live under <agent home> (e.g. ~/.arcana/agents/<agentId>/MEMORY.md,
// optional memory.md, and memory/**/*.md).

function listAllowedMemoryFiles() {
  const root = resolveAgentHomeRoot();
  const out = [];
  const rootLongA = resolve(root, 'MEMORY.md');
  const rootLongB = resolve(root, 'memory.md');
  if (existsSync(rootLongA)) out.push('MEMORY.md');
  if (existsSync(rootLongB)) out.push('memory.md');
  const memDir = resolve(root, 'memory');
  if (existsSync(memDir)) {
    const walk = (dirAbs, relPrefix) => {
      let entries;
      try {
        entries = readdirSync(dirAbs, { withFileTypes: true }) || [];
      } catch {
        return;
      }
      for (const ent of entries) {
        if (!ent || typeof ent.name !== 'string') continue;
        if (ent.isSymbolicLink && ent.isSymbolicLink()) continue;
        const name = ent.name;
        const childAbs = resolve(dirAbs, name);
        const childRel = relPrefix ? relPrefix + '/' + name : name;
        if (ent.isDirectory && ent.isDirectory()) {
          walk(childAbs, childRel);
        } else if (ent.isFile && ent.isFile()) {
          if (name.toLowerCase().endsWith('.md')) {
            out.push(childRel.replace(/\\/g, '/'));
          }
        }
      }
    };
    walk(memDir, 'memory');
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function isAllowedMemoryRelPath(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (p === 'MEMORY.md' || p === 'memory.md') return true;
  if (p.startsWith('memory/') && p.toLowerCase().endsWith('.md')) return true;
  return false;
}


function normalizeToAllowedRelPath(p) {
  // Accept relative or absolute under agent home; return clean relative forward-slash path.
  const root = resolveAgentHomeRoot();
  const abs = ensureAgentReadAllowed(p);
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (!isAllowedMemoryRelPath(rel)) {
    const err = new Error('Path not allowed: only MEMORY.md, memory.md, or memory/**/*.md');
    err.code = 'MEMORY_PATH_FORBIDDEN';
    throw err;
  }
  return rel;
}
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

const MAX_SEARCH_CONTENT_CHARS = 20000;

function toAsciiPlain(text){
  return String(text || '').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
}

export function createMemoryTools(){
  // memory_search
  const SearchParams = Type.Object({
    query: Type.String({ description: 'Case-insensitive substring to search for.' }),
    maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: 'Max results (default 8).' })),
    contextLines: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: 'Lines of context around a hit (default 2).' })),
  });

  const memorySearch = {
    label: 'Memory Search',
    name: 'memory_search',
    description: 'Search MEMORY.md and memory/**/*.md for a substring.',
    parameters: SearchParams,
    async execute(_id, args){
      const q = String(args.query || '').toLowerCase();
      if (!q) return { content:[{ type:'text', text: 'query required.' }], details:{ ok:false, error:'missing_query' } };
      const max = typeof args.maxResults === 'number' ? clamp(args.maxResults, 1, 100) : 8;
      const ctx = typeof args.contextLines === 'number' ? clamp(args.contextLines, 0, 10) : 2;
      const files = listAllowedMemoryFiles();
      const matches = [];
      for (const rel of files) {
        if (matches.length >= max) break;
        let txt = '';
        try { txt = readFileSync(ensureAgentReadAllowed(rel), 'utf-8'); } catch { continue; }
        const lines = String(txt).split(/\r?\n/);
        let lastEnd = -1;
        for (let i = 0; i < lines.length && matches.length < max; i++) {
          const line = lines[i] || '';
          if (line.toLowerCase().includes(q)) {
            const start = clamp(i - ctx, 0, Math.max(0, lines.length - 1));
            const end = clamp(i + ctx, 0, Math.max(0, lines.length - 1));
            if (start <= lastEnd) continue; // avoid overlapping snippets per file
            lastEnd = end;
            const snippet = lines.slice(start, end + 1).join('\n');
            matches.push({ path: rel, startLine: start + 1, endLine: end + 1, snippet });
          }
        }
      }
      const header = 'memory_search: ' + matches.length + ' match(es)';
      let text = header;
      if (matches.length) {
        const parts = [];
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i];
          parts.push(
            '[' + (i + 1) + '] ' + m.path + ' lines ' + m.startLine + '-' + m.endLine,
            m.snippet,
            ''
          );
        }
        text += '\n\n' + parts.join('\n');
      }
      text = toAsciiPlain(text);
      if (text.length > MAX_SEARCH_CONTENT_CHARS) {
        text = text.slice(0, MAX_SEARCH_CONTENT_CHARS - 80);
        text += '\n\n[output truncated; see tool details for full matches]';
      }
      return { content:[{ type:'text', text }], details:{ ok:true, query:q, maxResults:max, contextLines:ctx, matches } };
    }
  };
  // memory_get
  const GetParams = Type.Object({
    path: Type.String({ description: 'Relative path: MEMORY.md, memory.md, or memory/**/*.md' }),
    from: Type.Optional(Type.Number({ minimum: 1, description: '1-based starting line (default 1).' })),
    lines: Type.Optional(Type.Number({ minimum: 1, maximum: 1000, description: 'Number of lines to read (default 80).' })),
  });
  const memoryGet = {
    label: 'Memory Get',
    name: 'memory_get',
    description: 'Read a safe snippet from memory files.',
    parameters: GetParams,
    async execute(_id, args){
      let rel;
      try { rel = normalizeToAllowedRelPath(args.path); } catch (e) {
        return { content:[{ type:'text', text: e.message || 'path not allowed' }], details:{ ok:false, error:'path_forbidden' } };
      }

      const from1 = typeof args.from === 'number' ? Math.max(1, Math.floor(args.from)) : 1;
      const count = typeof args.lines === 'number' ? clamp(Math.floor(args.lines), 1, 1000) : 80;

      let text = '';
      let lines = [];
      let totalLines = 0;
      let missing = false;

      try {
        text = readFileSync(ensureAgentReadAllowed(rel), 'utf-8');
        lines = String(text).split(/\r?\n/);
        totalLines = lines.length;
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          missing = true;
          const citation = rel + ' (missing)';
          const info = {
            ok: true,
            path: rel,
            from: from1,
            endLine: 0,
            totalLines: 0,
            snippet: '',
            missing: true,
            citation
          };
          return {
            content:[
              { type:'text', text: '' },
              { type:'text', text: 'Source: ' + citation }
            ],
            details: info
          };
        }
        return { content:[{ type:'text', text: 'read error' }], details:{ ok:false, error:'read_error', path: rel } };
      }

      let snippet = '';
      let endLine = 0;

      if (from1 <= totalLines) {
        const startIdx = from1 - 1;
        const endExclusive = startIdx + count;
        snippet = lines.slice(startIdx, endExclusive).join('\n');
        const lastLine = from1 + count - 1;
        endLine = lastLine > totalLines ? totalLines : lastLine;
      } else {
        snippet = '';
        endLine = totalLines;
      }

      const info = {
        ok: true,
        path: rel,
        from: from1,
        endLine,
        totalLines,
        snippet,
        missing
      };

      let citation;
      if (endLine < from1) {
        citation = rel + '#L' + from1 + ' (past EOF; totalLines=' + totalLines + ')';
      } else if (from1 === endLine) {
        citation = rel + '#L' + from1;
      } else {
        citation = rel + '#L' + from1 + '-L' + endLine;
      }
      info.citation = citation;

      const sourceLine = 'Source: ' + citation;
      return {
        content:[
          { type:'text', text: snippet },
          { type:'text', text: sourceLine }
        ],
        details: info
      };
    }
  };

  return [memorySearch, memoryGet];
}

export default createMemoryTools;
