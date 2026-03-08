import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BOOTSTRAP_MAX_CHARS = 20000;
const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 150000;
const MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64;
const BOOTSTRAP_HEAD_RATIO = 0.7;
const BOOTSTRAP_TAIL_RATIO = 0.2;

function parsePositiveIntEnv(name, fallback){
  try {
    const raw = String(process.env[name] || '').trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  } catch {
    return fallback;
  }
}

export function resolveBootstrapMaxCharsFromEnv(){
  return parsePositiveIntEnv('ARCANA_BOOTSTRAP_MAX_CHARS', DEFAULT_BOOTSTRAP_MAX_CHARS);
}

export function resolveBootstrapTotalMaxCharsFromEnv(maxChars){
  const base = parsePositiveIntEnv('ARCANA_BOOTSTRAP_TOTAL_MAX_CHARS', DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  const perFile = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_BOOTSTRAP_MAX_CHARS;
  const candidate = base && base > 0 ? base : DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;
  return Math.max(candidate, perFile);
}

function isHighSurrogate(codeUnit){
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit){
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function sliceUtf16Safe(input, start, end){
  const len = input.length;

  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to = end === undefined ? len : (end < 0 ? Math.max(len + end, 0) : Math.min(end, len));

  if (to < from){
    const tmp = from; from = to; to = tmp;
  }

  if (from > 0 && from < len){
    const codeUnit = input.charCodeAt(from);
    if (isLowSurrogate(codeUnit) && isHighSurrogate(input.charCodeAt(from - 1))){
      from += 1;
    }
  }

  if (to > 0 && to < len){
    const codeUnit = input.charCodeAt(to - 1);
    if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(to))){
      to -= 1;
    }
  }

  return input.slice(from, to);
}

function truncateUtf16Safe(input, maxLen){
  const limit = Math.max(0, Math.floor(maxLen));
  if (input.length <= limit) return input;
  return sliceUtf16Safe(input, 0, limit);
}

function trimBootstrapContent(rawContent, fileName, maxChars){
  const limit = Math.max(1, Math.floor(maxChars || 0));
  const trimmed = String(rawContent || '').trimEnd();
  if (!trimmed){
    return { content: '', truncated: false, maxChars: limit, originalLength: 0 };
  }
  if (trimmed.length <= limit){
    return { content: trimmed, truncated: false, maxChars: limit, originalLength: trimmed.length };
  }
  const headChars = Math.floor(limit * BOOTSTRAP_HEAD_RATIO);
  const tailChars = Math.floor(limit * BOOTSTRAP_TAIL_RATIO);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);
  const markerLines = [
    '',
    '[...truncated, read ' + fileName + ' for full content...]',
    '…(truncated ' + fileName + ': kept ' + headChars + '+' + tailChars + ' chars of ' + trimmed.length + ')…',
    '',
  ];
  const marker = markerLines.join('\n');
  const contentWithMarker = [head, marker, tail].join('\n');
  return { content: contentWithMarker, truncated: true, maxChars: limit, originalLength: trimmed.length };
}

function clampToBudget(content, budget){
  const limit = Math.max(0, Math.floor(budget));
  if (limit <= 0) return '';
  if (!content) return '';
  if (content.length <= limit) return content;
  if (limit <= 3) return truncateUtf16Safe(content, limit);
  const safe = limit - 1;
  return truncateUtf16Safe(content, safe) + '…';
}

function readAgentFile(path){
  try {
    if (!existsSync(path)) return { missing: true, content: '' };
    const raw = readFileSync(path, 'utf-8');
    return { missing: false, content: raw == null ? '' : String(raw) };
  } catch {
    return { missing: true, content: '' };
  }
}

function loadBootstrapFilesFromAgentHome(agentHomeRoot, { minimal } = {}){
  const base = String(agentHomeRoot || '').trim();
  if (!base) return [];
  const files = [];
  const coreNames = minimal
    ? ['AGENTS.md','TOOLS.md']
    : ['AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md','USER.md','HEARTBEAT.md','BOOTSTRAP.md'];
  for (const name of coreNames){
    const path = join(base, name);
    const info = readAgentFile(path);
    files.push({ name, path, missing: info.missing, content: info.content });
  }
  if (!minimal){
    const memNames = ['MEMORY.md','memory.md'];
    for (const name of memNames){
      const path = join(base, name);
      const info = readAgentFile(path);
      if (!info.missing){
        files.push({ name, path, missing: false, content: info.content });
      }
    }
  }
  return files;
}

export function buildAgentBootstrapContext(agentHomeRoot, opts = {}){
  const minimal = !!opts.minimal;
  const maxChars = typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars) && opts.maxChars > 0
    ? Math.floor(opts.maxChars)
    : resolveBootstrapMaxCharsFromEnv();
  const totalMaxChars = typeof opts.totalMaxChars === 'number' && Number.isFinite(opts.totalMaxChars) && opts.totalMaxChars > 0
    ? Math.floor(opts.totalMaxChars)
    : resolveBootstrapTotalMaxCharsFromEnv(maxChars);

  const bootstrapFiles = loadBootstrapFilesFromAgentHome(agentHomeRoot, { minimal });
  if (!bootstrapFiles.length){
    return { contextFiles: [], hasSoul: false };
  }

  const hasSoul = !minimal && bootstrapFiles.some((f)=> f && f.name === 'SOUL.md' && !f.missing);

  let remainingTotalChars = Math.max(1, totalMaxChars);
  const contextFiles = [];

  for (const file of bootstrapFiles){
    if (remainingTotalChars <= 0) break;
    const pathValue = typeof file.path === 'string' ? file.path.trim() : '';
    if (!pathValue) continue;

    if (file.missing){
      const missingText = '[MISSING] Expected at: ' + pathValue;
      const capped = clampToBudget(missingText, remainingTotalChars);
      if (!capped) break;
      remainingTotalChars = Math.max(0, remainingTotalChars - capped.length);
      contextFiles.push({ path: pathValue, content: capped });
      continue;
    }

    if (remainingTotalChars < MIN_BOOTSTRAP_FILE_BUDGET_CHARS){
      break;
    }

    const fileMaxChars = Math.max(1, Math.min(maxChars, remainingTotalChars));
    const trimmed = trimBootstrapContent(file.content || '', file.name, fileMaxChars);
    const withinBudget = clampToBudget(trimmed.content, remainingTotalChars);
    if (!withinBudget) continue;
    remainingTotalChars = Math.max(0, remainingTotalChars - withinBudget.length);
    contextFiles.push({ path: pathValue, content: withinBudget });
  }

  return { contextFiles, hasSoul };
}

export default {
  buildAgentBootstrapContext,
  resolveBootstrapMaxCharsFromEnv,
  resolveBootstrapTotalMaxCharsFromEnv,
};

