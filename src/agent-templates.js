import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { parseFrontmatter } from '@mariozechner/pi-coding-agent';

function arcanaPkgRoot(){
  try {
    const here = fileURLToPath(new URL('.', import.meta.url)); // arcana/src/
    return join(here, '..'); // arcana/
  } catch {
    return process.cwd();
  }
}

export function getAgentTemplatesDir(){
  try {
    const root = arcanaPkgRoot();
    return join(root, 'docs', 'reference', 'templates');
  } catch {
    return '';
  }
}

export function loadAgentTemplate(name){
  try {
    const dir = getAgentTemplatesDir();
    if (!dir) return '';
    const baseName = String(name || '').trim();
    if (!baseName) return '';
    const p = join(dir, baseName);
    if (!existsSync(p)) return '';
    const raw = readFileSync(p, 'utf-8');
    if (!raw) return '';
    try {
      const parsed = parseFrontmatter(raw);
      if (parsed && typeof parsed.body === 'string' && parsed.body.trim()){
        return parsed.body;
      }
    } catch {}
    return raw;
  } catch {
    return '';
  }
}

export default { getAgentTemplatesDir, loadAgentTemplate };

