#!/usr/bin/env node
// init-skill.mjs — Create a new skill folder under ./skills with minimal boilerplate.
// Usage: node skills/create_skill/scripts/init-skill.mjs <name> [--resources scripts,references,assets] [--examples]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function toHyphenCase(s){
  return String(s||'').trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

function parseArgs(argv){
  const out = { name: '', resources: [], examples:false };
  const a = argv.slice(2);
  if (!a[0] || a[0].startsWith('--')){
    console.error('Usage: init-skill.mjs <name> [--resources scripts,references,assets] [--examples]');
    process.exit(2);
  }
  out.name = toHyphenCase(a[0]);
  for (let i=1;i<a.length;i++){
    const t = a[i];
    if (t === '--examples') { out.examples = true; continue; }
    if (t === '--resources'){
      const val = a[i+1] || '';
      i++;
      out.resources = String(val).split(',').map(s=>s.trim()).filter(Boolean);
      continue;
    }
  }
  return out;
}

function write(p, s){ writeFileSync(p, s, { encoding: 'utf8', flag: 'wx' }); }

function main(){
  const { name, resources, examples } = parseArgs(process.argv);
  const root = process.cwd();
  const skillsDir = join(root, 'skills');
  const dir = join(skillsDir, name);
  if (existsSync(dir)) { console.error('Skill already exists:', dir); process.exit(1); }
  mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    'description: "TODO: One-line description: what it does + when to use."',
    '---',
    '',
    '# TODO: Skill Title',
    '',
    'Brief workflow. Keep concise. Link details to references/.',
    '',
  ].join('\n');
  write(join(dir, 'SKILL.md'), fm);

  const valid = new Set(['scripts','references','assets']);
  for (const r of resources){ if (!valid.has(r)) continue; mkdirSync(join(dir, r), { recursive: true }); }

  if (examples){
    if (resources.includes('scripts')){
      write(join(dir, 'scripts', 'hello.js'), '// example script: console.log("hello")\n');
    }
    if (resources.includes('references')){
      write(join(dir, 'references', 'NOTES.md'), '# Notes\n\nAdd detailed docs here.\n');
    }
    if (resources.includes('assets')){
      write(join(dir, 'assets', '.gitkeep'), '');
    }
  }

  console.log('Created skill at', dir);
}

main();
