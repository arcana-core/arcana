import { Type } from '@sinclair/typebox';
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { ensureReadAllowed, ensureWriteAllowed, resolveWorkspaceRoot } from '../workspace-guard.js';

// Minimal deterministic memory tools (append-only).
// Files: <workspace>/MEMORY.md, optional <workspace>/memory.md, and <workspace>/memory/YYYY-MM-DD.md

function listAllowedMemoryFiles() {
  const root = resolveWorkspaceRoot();
  const out = [];
  const rootLongA = resolve(root, 'MEMORY.md');
  const rootLongB = resolve(root, 'memory.md');
  if (existsSync(rootLongA)) out.push('MEMORY.md');
  if (existsSync(rootLongB)) out.push('memory.md');
  const memDir = resolve(root, 'memory');
  if (existsSync(memDir)) {
    try {
      const items = readdirSync(memDir) || [];
      for (const name of items) {
        if (typeof name === 'string' && name.toLowerCase().endsWith('.md')) {
          out.push('memory/' + name);
        }
      }
    } catch {}
  }
  out.sort((a,b)=> a.localeCompare(b));
  return out;
}

function isAllowedMemoryRelPath(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (p === 'MEMORY.md' || p === 'memory.md') return true;
  if (p.startsWith('memory/')) {
    const parts = p.split('/');
    if (parts.length === 2 && parts[1].toLowerCase().endsWith('.md')) return true;
  }
  return false;
}


function normalizeToAllowedRelPath(p) {
  // Accept relative or absolute under workspace; return clean relative forward-slash path.
  const root = resolveWorkspaceRoot();
  const abs = ensureReadAllowed(p);
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (!isAllowedMemoryRelPath(rel)) {
    const err = new Error('Path not allowed: only MEMORY.md, memory.md, or memory/*.md');
    err.code = 'MEMORY_PATH_FORBIDDEN';
    throw err;
  }
  return rel;
}
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function pad2(n){ return String(n).padStart(2, '0'); }
function localParts(d = new Date()) {
  return {
    Y: d.getFullYear(),
    M: pad2(d.getMonth() + 1),
    D: pad2(d.getDate()),
    h: pad2(d.getHours()),
    m: pad2(d.getMinutes()),
    s: pad2(d.getSeconds()),
  };
}

function pickDailyFilename(dateStr) {
  // dateStr YYYY-MM-DD in local time (optional)
  let Y, M, D;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) {
    const [y, m, d] = String(dateStr).split('-');
    Y = y; M = m; D = d;
  } else {
    const p = localParts();
    Y = String(p.Y); M = p.M; D = p.D;
  }
  return 'memory/' + Y + '-' + M + '-' + D + '.md';
}

function buildAppendBlock(target, heading, content) {
  const p = localParts();
  const stamp = p.Y + '-' + p.M + '-' + p.D + ' ' + p.h + ':' + p.m;
  const head = heading ? (' - ' + heading) : '';
  // Keep very small structure; always separate with blank lines.
  return '\n\n## ' + (target === 'daily' ? (p.h + ':' + p.m) : stamp) + head + '\n\n' + String(content || '').replace(/\s+$/, '') + '\n';
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
    description: 'Search MEMORY.md and memory/*.md for a substring (no embeddings).',
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
        try { txt = readFileSync(ensureReadAllowed(rel), 'utf-8'); } catch { continue; }
        const lines = String(txt).split(/\r?\n/);
        let lastEnd = -1;
        for (let i = 0; i < lines.length && matches.length < max; i++) {
          const line = lines[i] || '';
          if (line.toLowerCase().includes(q)) {
            const start = clamp(i - ctx, 0, lines.length - 1);
            const end = clamp(i + ctx, 0, lines.length - 1);
            if (start <= lastEnd) continue; // avoid overlapping snippets per file
            lastEnd = end;
            const snippet = lines.slice(start, end + 1).join('\n');
            matches.push({ path: rel, startLine: start + 1, endLine: end + 1, snippet });
          }
        }
      }
      const header = 'memory_search: ' + matches.length + ' match(es)';
      return { content:[{ type:'text', text: header }], details:{ ok:true, query:q, maxResults:max, contextLines:ctx, matches } };
    }
  };
  // memory_get
  const GetParams = Type.Object({
    path: Type.String({ description: 'Relative path: MEMORY.md, memory.md, or memory/YYYY-MM-DD.md' }),
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
      let text = '';
      try { text = readFileSync(ensureReadAllowed(rel), 'utf-8'); } catch {
        return { content:[{ type:'text', text: 'file not found' }], details:{ ok:false, error:'not_found', path: rel } };
      }
      const lines = String(text).split(/\r?\n/);
      const from1 = typeof args.from === 'number' ? Math.max(1, Math.floor(args.from)) : 1;
      const count = typeof args.lines === 'number' ? clamp(Math.floor(args.lines), 1, 1000) : 80;
      const startIdx = clamp(from1 - 1, 0, Math.max(0, lines.length - 1));
      const endIdx = clamp(startIdx + count - 1, 0, Math.max(0, lines.length - 1));
      const snippet = lines.slice(startIdx, endIdx + 1).join('\n');
      const info = { ok:true, path: rel, from: startIdx + 1, endLine: endIdx + 1, totalLines: lines.length, snippet };
      return { content:[{ type:'text', text: snippet }], details: info };
    }
  };
  // memory_append
  const AppendParams = Type.Object({
    target: Type.Union([Type.Literal('daily'), Type.Literal('longterm')]),
    content: Type.String({ description: 'Text to append (required).' }),
    date: Type.Optional(Type.String({ description: 'YYYY-MM-DD for daily target (optional).' })),
    heading: Type.Optional(Type.String({ description: 'Optional short heading.' })),
  });

  const memoryAppend = {
    label: 'Memory Append',
    name: 'memory_append',
    description: 'Append timestamped content to MEMORY.md or memory/YYYY-MM-DD.md.',
    parameters: AppendParams,
    async execute(_id, args){
      const target = String(args.target||'').toLowerCase();
      const raw = String(args.content||'');
      const content = raw.trim();
      if (!target || !content) {
        return { content:[{ type:'text', text: 'target and content are required.' }], details:{ ok:false, error:'missing_params' } };
      }
      let relPath;
      if (target === 'daily') {
        relPath = pickDailyFilename(args.date);
        // Ensure memory/ directory exists before appending.
        try { mkdirSync(resolve(resolveWorkspaceRoot(), 'memory'), { recursive: true }); } catch {}
      } else if (target === 'longterm') {
        relPath = 'MEMORY.md';
      } else {
        return { content:[{ type:'text', text: 'target must be daily or longterm' }], details:{ ok:false, error:'bad_target' } };
      }
      const block = buildAppendBlock(target, args.heading, content);
      try { appendFileSync(ensureWriteAllowed(relPath), block, { encoding:'utf-8' }); } catch (e) {
        return { content:[{ type:'text', text: 'append failed' }], details:{ ok:false, error:'append_failed', message: String(e&&e.message||e) } };
      }
      return { content:[{ type:'text', text: 'memory_append: wrote ' + relPath }], details:{ ok:true, path: relPath, bytes: Buffer.byteLength(block, 'utf-8') } };
    }
  };

  return [memorySearch, memoryGet, memoryAppend];
}

export default createMemoryTools;
