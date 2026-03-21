// Minimal electron-builder configuration for Arcana desktop DMG builds

const enableCodeSign = process.env.ARCANA_CODESIGN === '1';

const macConfig = {
  target: 'dmg',
  hardenedRuntime: true,
  gatekeeperAssess: false,
  entitlements: 'entitlements.mac.plist',
  entitlementsInherit: 'entitlements.mac.inherit.plist',
};

if (!enableCodeSign) {
  macConfig.identity = null;
  macConfig.hardenedRuntime = false;
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'io.arcana.desktop',
  productName: 'Arcana',
  directories: {
    app: '.',
    output: 'dist',
  },
  files: [
    'src/**/*',
    'package.json',
    '!node_modules/**',
  ],
  mac: macConfig,
  extraResources: [
    { from: '../../server', to: 'server' },
    { from: '../../src', to: 'src' },
    { from: '../../web', to: 'web', filter: ['**/*', '!models/**'] },
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
    {
      from: 'node_modules',
      to: 'node_modules',
      filter: [
        '**/*',
        '!**/*.map',
        '!**/*.d.ts',
        '!**/test/**',
        '!**/tests/**',
        '!**/docs/**',
        '!**/examples/**',
        '!**/*.md',
        '!electron/**',
        '!electron-builder/**',
        '!@electron/notarize/**',
        '!**/.bin/**',
        // Exclude non-mac koffi prebuilds to reduce bundle size
        '!koffi/build/koffi/linux_*/**',
        '!koffi/build/koffi/musl_*/**',
        '!koffi/build/koffi/win32_*/**',
        '!koffi/build/koffi/freebsd_*/**',
        '!koffi/build/koffi/openbsd_*/**',
      ],
    },
    { from: 'resources/src/package.json', to: 'src/package.json' },
  ],
};

if (enableCodeSign) {
  config.afterSign = 'scripts/notarize.cjs';
}

module.exports = config;
