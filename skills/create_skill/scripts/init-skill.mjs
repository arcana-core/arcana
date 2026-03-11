#!/usr/bin/env node
// init-skill.mjs - Create a new skill folder under the active agent home (~/.arcana/agents/<agentId>/skills) by default.
// Use --shared or --workspace to create under ./skills instead.
// Usage: node skills/create_skill/scripts/init-skill.mjs <name> [--resources scripts,references,assets] [--examples] [--shared]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentHomeRoot } from '../../../src/agent-guard.js';

function toHyphenCase(s){
  return String(s||'').trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

function parseArgs(argv){
  const out = { name: '', resources: [], examples:false, shared:false };
  const a = argv.slice(2);
  if (!a[0] || a[0].startsWith('--')){
    console.error('Usage: init-skill.mjs <name> [--resources scripts,references,assets] [--examples] [--shared]');
    process.exit(2);
  }
  out.name = toHyphenCase(a[0]);
  for (let i=1;i<a.length;i++){
    const t = a[i];
    if (t === '--examples') { out.examples = true; continue; }
    if (t === '--shared' || t === '--workspace') { out.shared = true; continue; }
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
  const { name, resources, examples, shared } = parseArgs(process.argv);
  const workspaceRoot = process.cwd();

  let skillsBase = workspaceRoot;
  if (!shared){
    try {
      const agentHomeRoot = resolveAgentHomeRoot();
      if (agentHomeRoot) skillsBase = agentHomeRoot;
    } catch {
      // Fallback: keep workspaceRoot when agent home cannot be resolved
      skillsBase = workspaceRoot;
    }
  }

  const skillsDir = join(skillsBase, 'skills');
  const dir = join(skillsDir, name);
  if (existsSync(dir)) { console.error('Skill already exists:', dir); process.exit(1); }
  mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    'description: "TODO: One-line description: what it does + when to use."',
    'arcana:',
    '  tools:',
    '    - name: example',
    '      description: "TODO: Short tool description."',
    '      mode: node',
    '      entry: scripts/example.js',
    '---',
    '',
    '# TODO: Skill Title',
    '',
    'Brief workflow. Keep concise. Link details to references/.',
    '',
    '## Secrets',
    '',
    '- Do not read process.env for API keys or secrets.',
    "- Use ctx.secrets.getText('<logical-name>') inside tools.",
    '- Common logical names:',
    '  - providers/openai/api_key',
    '  - providers/google/api_key',
    '  - services/feishu/app_id',
    '  - services/wechat/app_secret',
    "- If a secret is missing, call the secrets tool with names: ['<logical-name>'] to open the UI.",
    '',
    '## Example',
    '',
    '```js',
    "export const tool = {",
    "  name: 'example',",
    '  async execute(ctx, input) {',
    "    const apiKey = await ctx.secrets.getText('providers/openai/api_key');",
    '    // Use apiKey in your call.',
    '  },',
    '};',
    '```',
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
