import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInjectedLocalToolsSystemPrompt,
  decideToolExecutionMode,
  loadLocalBootstrapSkills,
  normalizeLocalBootstrapFiles,
  normalizeInjectedLocalToolDefinitions,
  resolveToolDaemonWorkspaceRoot,
  shouldEnableServerManagedBash,
  summarizeInjectedLocalToolDefinitionsForDebug,
} from './session.js';

test('normalizeInjectedLocalToolDefinitions returns an empty list when no local tool definitions are provided', () => {
  assert.deepEqual(normalizeInjectedLocalToolDefinitions(undefined), []);
  assert.deepEqual(normalizeInjectedLocalToolDefinitions(null), []);
});

test('normalizeLocalBootstrapFiles keeps valid bootstrap files and drops invalid duplicates', () => {
  const actual = normalizeLocalBootstrapFiles([
    null,
    {},
    { name: 'SOUL.md', path: '/agent/SOUL.md', content: 'alpha', mtimeMs: 10 },
    { name: 'SOUL.md', path: '/agent/SOUL.md', content: 'duplicate' },
    { name: 'MEMORY.md', path: '/agent/MEMORY.md', content: 'beta' },
    { name: '', path: '/agent/USER.md', content: 'skip' },
  ]);

  assert.deepEqual(actual, [
    { name: 'SOUL.md', path: '/agent/SOUL.md', content: 'alpha', mtimeMs: 10 },
    { name: 'MEMORY.md', path: '/agent/MEMORY.md', content: 'beta' },
  ]);
});

test('loadLocalBootstrapSkills registers client AgentHome skill docs with device paths', () => {
  const content = '---\nname: video-quality-check\ndescription: Check publish readiness\n---\n\n# Video Quality Check\n';
  const actual = loadLocalBootstrapSkills({
    files: [
      {
        name: 'skills/video-quality-check/SKILL.md',
        path: '/private/var/mobile/Containers/Data/Application/DEMO/Library/Application Support/CutPilot/AgentHome/skills/video-quality-check/SKILL.md',
        content,
      },
      {
        name: 'SOUL.md',
        path: '/private/var/mobile/Containers/Data/Application/DEMO/Library/Application Support/CutPilot/AgentHome/SOUL.md',
        content: 'not a skill',
      },
    ],
  });

  assert.deepEqual(actual, [
    {
      name: 'video-quality-check',
      description: 'Check publish readiness',
      filePath: '/private/var/mobile/Containers/Data/Application/DEMO/Library/Application Support/CutPilot/AgentHome/skills/video-quality-check/SKILL.md',
      tools: [],
      arcanaLocalClientSkill: true,
    },
  ]);
});

test('normalizeInjectedLocalToolDefinitions keeps valid local tools and drops invalid or duplicate entries', () => {
  const actual = normalizeInjectedLocalToolDefinitions([
    null,
    {},
    { name: '  cutpilot_lookup  ', description: '  Look up clip metadata  ', parameters: { type: 'object', properties: { clipId: { type: 'string' } } } },
    { name: 'cutpilot_lookup', description: 'duplicate', parameters: { type: 'object' } },
    { name: 'cutpilot_ping' },
  ]);

  assert.deepEqual(actual, [
    {
      name: 'cutpilot_lookup',
      description: 'Look up clip metadata',
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
        },
      },
    },
    {
      name: 'cutpilot_ping',
    },
  ]);
});

test('buildInjectedLocalToolsSystemPrompt exposes injected tools to the model prompt', () => {
  const prompt = buildInjectedLocalToolsSystemPrompt([
    {
      name: 'cutpilot_lookup',
      description: 'Look up clip metadata',
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          includeDrafts: { type: 'boolean' },
        },
      },
    },
  ]);

  assert.match(prompt, /client injected tools/i);
  assert.match(prompt, /cutpilot_lookup/);
  assert.match(prompt, /Look up clip metadata/);
  assert.match(prompt, /clipId/);
  assert.match(prompt, /includeDrafts/);
});

test('summarizeInjectedLocalToolDefinitionsForDebug returns compact debug metadata', () => {
  const summary = summarizeInjectedLocalToolDefinitionsForDebug([
    {
      name: 'cutpilot_lookup',
      description: 'Look up clip metadata',
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          includeDrafts: { type: 'boolean' },
        },
      },
    },
    {
      name: 'cutpilot_ping',
    },
  ]);

  assert.deepEqual(summary, {
    count: 2,
    names: ['cutpilot_lookup', 'cutpilot_ping'],
    describedCount: 1,
    parameterizedCount: 1,
    parameterKeysByTool: {
      cutpilot_lookup: ['clipId', 'includeDrafts'],
      cutpilot_ping: [],
    },
  });
});

test('decideToolExecutionMode forces injected local tools through the client proxy when available', () => {
  const mode = decideToolExecutionMode({
    tool: { name: 'cutpilot_lookup', arcanaInjectedLocalProxy: true },
    route: { execution: 'default' },
    hasLocalToolProxyInvoke: true,
    enforceToolRouting: true,
  });

  assert.equal(mode, 'proxied_local');
});

test('decideToolExecutionMode routes client AgentHome reads to local proxy by path', () => {
  const mode = decideToolExecutionMode({
    tool: { name: 'read' },
    route: { execution: 'local', fallback: 'deny' },
    args: {
      path: '/private/var/mobile/Containers/Data/Application/DEMO/Library/Application Support/CutPilot/AgentHome/skills/video-quality-check/SKILL.md',
    },
    clientReadableRoots: [
      '/private/var/mobile/Containers/Data/Application/DEMO/Documents/CutPilotProject',
      '/private/var/mobile/Containers/Data/Application/DEMO/Library/Application Support/CutPilot/AgentHome',
    ],
    hasLocalToolProxyInvoke: true,
    enforceToolRouting: true,
  });

  assert.equal(mode, 'proxied_local');
});

test('decideToolExecutionMode lets server skill reads execute in cloud when path is not a client root', () => {
  const mode = decideToolExecutionMode({
    tool: { name: 'read' },
    route: { execution: 'local', fallback: 'deny' },
    args: {
      path: '/Users/example/.codex/skills/.system/openai-docs/SKILL.md',
    },
    clientReadableRoots: [
      '/private/var/mobile/Containers/Data/Application/DEMO/Documents/CutPilotProject',
      '/private/var/mobile/Containers/Data/Application/DEMO/Library/Application Support/CutPilot/AgentHome',
    ],
    hasLocalToolProxyInvoke: true,
    enforceToolRouting: true,
  });

  assert.equal(mode, 'local_exec');
});

test('decideToolExecutionMode routes relative project reads to local proxy', () => {
  const mode = decideToolExecutionMode({
    tool: { name: 'read' },
    route: { execution: 'local', fallback: 'deny' },
    args: { path: 'edl.json' },
    clientReadableRoots: [
      '/private/var/mobile/Containers/Data/Application/DEMO/Documents/CutPilotProject',
      '/private/var/mobile/Containers/Data/Application/DEMO/Library/Application Support/CutPilot/AgentHome',
    ],
    hasLocalToolProxyInvoke: true,
    enforceToolRouting: true,
  });

  assert.equal(mode, 'proxied_local');
});

test('shouldEnableServerManagedBash disables server bash when injected local bash is present', () => {
  assert.equal(shouldEnableServerManagedBash({
    execPolicy: 'restricted',
    injectedLocalToolDefinitions: [{ name: 'bash' }],
  }), false);

  assert.equal(shouldEnableServerManagedBash({
    execPolicy: 'open',
    injectedLocalToolDefinitions: [{ name: 'bash' }],
  }), false);

  assert.equal(shouldEnableServerManagedBash({
    execPolicy: 'open',
    injectedLocalToolDefinitions: [{ name: 'cutpilot_lookup' }],
  }), true);
});

test('resolveToolDaemonWorkspaceRoot keeps daemon state under the Arcana package root by default', () => {
  const actual = resolveToolDaemonWorkspaceRoot({
    workspaceRoot: '/tmp/cutpilot/project-1',
    pkgRoot: '/opt/arcana',
  });

  assert.equal(actual, '/opt/arcana');
});

test('resolveToolDaemonWorkspaceRoot allows an explicit daemon root override', () => {
  const actual = resolveToolDaemonWorkspaceRoot({
    workspaceRoot: '/tmp/cutpilot/project-1',
    pkgRoot: '/opt/arcana',
    toolDaemonWorkspaceRoot: '/var/lib/arcana-daemon',
  });

  assert.equal(actual, '/var/lib/arcana-daemon');
});
