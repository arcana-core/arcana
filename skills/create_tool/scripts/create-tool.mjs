#!/usr/bin/env node
// create-tool.mjs - Scaffold a new Arcana tool bound to a Skill (skill-scoped: <skill>/tools/<tool>/).
// Usage: node skills/create_tool/scripts/create-tool.mjs <skill> <tool> [--desc "Description"] [--label "Label"] [--shared-skill] [--init-skill]
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentHomeRoot } from '../../../src/agent-guard.js';

function toHyphenCase(s){
  return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}
function toTitleCase(s){
  return toHyphenCase(s).split('-').map(w=> w ? (w[0].toUpperCase()+w.slice(1)) : '').join(' ');
}

function normalizeLabel(label, tool){
  const raw = String(label || '').trim();
  return raw ? raw : toTitleCase(tool);
}

function write(p, s){ writeFileSync(p, s, { encoding: 'utf8', flag: 'wx' }); }

function parseArgs(argv){
  const a = argv.slice(2);
  if (!a[0] || !a[1] || a[0].startsWith('--') || a[1].startsWith('--')){
    console.error('Usage: create-tool.mjs <skill> <tool> [--desc "Description"] [--label "Label"] [--shared-skill] [--init-skill]');
    process.exit(2);
  }
  const out = {
    skill: toHyphenCase(a[0]),
    tool: toHyphenCase(a[1]),
    desc: 'Custom tool',
    label: '',
    sharedSkill: false,
    initSkill: false,
  };
  for (let i=2;i<a.length;i++){
    const t = a[i];
    if (t === '--desc'){ out.desc = String(a[i+1]||out.desc); i++; continue; }
    if (t === '--label'){ out.label = String(a[i+1]||out.label); i++; continue; }
    if (t === '--shared-skill'){ out.sharedSkill = true; continue; }
    if (t === '--init-skill'){ out.initSkill = true; continue; }
  }
  return out;
}

function ensureSkillDir(baseRoot, skill, initSkill){
  const skillsRoot = join(baseRoot, 'skills');
  const skillDir = join(skillsRoot, skill);
  if (existsSync(skillDir)){
    if (!statSync(skillDir).isDirectory()){
      console.error('Skill path exists but is not a directory:', skillDir);
      process.exit(1);
    }
    return skillDir;
  }
  if (!initSkill){
    console.error('Skill directory not found:', skillDir);
    console.error('Hint: re-run with --init-skill to create it.');
    process.exit(1);
  }
  mkdirSync(skillsRoot, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  console.log('Initialized skill directory at', skillDir);
  return skillDir;
}

function buildToolSource({ tool, desc, label }){
  const Label = normalizeLabel(label, tool);
  const descLiteral = JSON.stringify(desc || `Tool ${tool}`);
  const labelLiteral = JSON.stringify(Label);
  const notImplText = JSON.stringify(`${Label} is not implemented yet.`);
  return `// ${tool}/tool.js - Arcana Skill tool (ESM).\n`+
`// Located under <skill>/tools/${tool}/tool.js.\n`+
`// This file can live under agent home (~/.arcana/agents/<agentId>/skills) or workspace ./skills.\n`+
`// It dynamically loads wrapArcanaTool from the Arcana package using ARCANA_PKG_ROOT.\n\n`+
`import { join } from 'node:path';\n`+
`import { fileURLToPath, pathToFileURL } from 'node:url';\n\n`+
`async function loadWrapArcanaTool(){\n`+
`  const root = process.env.ARCANA_PKG_ROOT;\n`+
`  if (!root){\n`+
`    throw new Error('ARCANA_PKG_ROOT is not set; cannot resolve wrap-arcana-tool.js');\n`+
`  }\n`+
`  const p = join(root, 'src', 'tools', 'wrap-arcana-tool.js');\n`+
`  const mod = await import(pathToFileURL(p).href);\n`+
`  const fn = mod.wrapArcanaTool || (mod.default && mod.default.wrapArcanaTool);\n`+
`  if (typeof fn !== 'function'){\n`+
`    throw new Error('wrapArcanaTool not found in ' + p);\n`+
`  }\n`+
`  return fn;\n`+
`}\n\n`+
`function createTool(){\n`+
`  const parameters = {\n`+
`    type: 'object',\n`+
`    properties: {},\n`+
`    additionalProperties: true,\n`+
`  };\n\n`+
`  return {\n`+
`    name: '${tool}',\n`+
`    label: ${labelLiteral},\n`+
`    description: ${descLiteral},\n`+
`    parameters,\n`+
`    async execute(callId, args, signal, onUpdate, ctx){\n`+
`      // TODO: implement tool behavior.\n`+
`      return {\n`+
`        content: [{ type: 'text', text: ${notImplText} }],\n`+
`        details: { ok: false, error: 'not_implemented' },\n`+
`      };\n`+
`    },\n`+
`  };\n`+
`}\n\n`+
`export default async function(){\n`+
`  const wrapArcanaTool = await loadWrapArcanaTool();\n`+
`  const skillDir = fileURLToPath(new URL('..\/..', import.meta.url));\n`+
`  return wrapArcanaTool(createTool, { skillDir });\n`+
`}\n`;
}

function buildSkillFrontmatter({ skill, tool, desc, label }){
  const Label = normalizeLabel(label, tool);
  const descLiteral = JSON.stringify(desc || `Tool ${tool}`);
  const labelLiteral = JSON.stringify(Label);
  const skillNameLiteral = JSON.stringify(skill);
  const skillDescLiteral = JSON.stringify('TODO: describe this skill.');
  const toolNameLiteral = JSON.stringify(tool);
  return '---\n'
    + 'name: ' + skillNameLiteral + '\n'
    + 'description: ' + skillDescLiteral + '\n'
    + 'arcana:\n'
    + '  tools:\n'
    + '    - name: ' + toolNameLiteral + '\n'
    + '      label: ' + labelLiteral + '\n'
    + '      description: ' + descLiteral + '\n'
    + '---\n';
}

function maybeInitSkillMd(skillDir, { skill, tool, desc, label, initSkill }){
  if (!initSkill) return;
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (existsSync(skillMdPath)){
    console.log('SKILL.md already exists for skill', skill + '; remember to add this tool under arcana.tools.');
    return;
  }
  const frontmatter = buildSkillFrontmatter({ skill, tool, desc, label });
  write(skillMdPath, frontmatter);
  console.log('Created SKILL.md at', skillMdPath);
}

function main(){
  const { skill, tool, desc, label, sharedSkill, initSkill } = parseArgs(process.argv);
  const workspaceRoot = process.cwd();
  let baseRoot = workspaceRoot;
  if (!sharedSkill){
    try {
      const agentHomeRoot = resolveAgentHomeRoot();
      if (agentHomeRoot) baseRoot = agentHomeRoot;
    } catch {
      baseRoot = workspaceRoot;
    }
  }
  const skillDir = ensureSkillDir(baseRoot, skill, initSkill);
  maybeInitSkillMd(skillDir, { skill, tool, desc, label, initSkill });
  const toolDir = join(skillDir, 'tools', tool);
  if (existsSync(toolDir)){
    console.error('Tool already exists:', toolDir);
    process.exit(1);
  }
  mkdirSync(toolDir, { recursive: true });
  const toolPath = join(toolDir, 'tool.js');
  const gitignorePath = join(toolDir, '.gitignore');
  const src = buildToolSource({ tool, desc, label });
  write(toolPath, src);
  const gitignore = '# Local-only artifacts for this tool\n';
  write(gitignorePath, gitignore);
  console.log('Created tool at', toolPath);
}

main();
