// Minimal electron-builder configuration for Arcana desktop DMG builds

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.arcana.desktop',
  productName: 'Arcana',
  directories: {
    app: '.',
    output: 'dist',
  },
  files: [
    'src/**/*',
    'package.json',
  ],
  mac: {
    target: 'dmg',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'entitlements.mac.plist',
    entitlementsInherit: 'entitlements.mac.inherit.plist',
  },
  afterSign: 'scripts/notarize.cjs',
  extraResources: [
    { from: '../../server', to: 'server' },
    { from: '../../src', to: 'src' },
    { from: '../../web', to: 'web' },
    // Minimal packaged skills set
    { from: '../../skills/secrets', to: 'skills/secrets' },
    { from: '../../skills/create_skill', to: 'skills/create_skill' },
    { from: '../../skills/create_tool', to: 'skills/create_tool' },
    { from: '../../skills/feishu', to: 'skills/feishu' },
    { from: '../../skills/services', to: 'skills/services' },
    // Core bundled service entrypoints
    { from: '../../services/cron_runner.mjs', to: 'services/cron.mjs' },
    { from: '../../services/heartbeat_runner.mjs', to: 'services/heartbeat.mjs' },
    { from: '../../services/tool_daemon.mjs', to: 'services/tool_daemon.mjs' },
    // Non-autostart Feishu service template
    { from: '../../services/feishu.service.mjs', to: 'services/feishu.mjs.example' },
    { from: '../../plugins', to: 'plugins' },
    { from: '../../tools', to: 'tools' },
    { from: '../../node_modules', to: 'node_modules' },
    { from: 'resources/src/package.json', to: 'src/package.json' },
  ],
};
