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
    { from: '../server', to: 'server' },
    { from: '../src', to: 'src' },
    { from: '../web', to: 'web' },
    { from: '../skills', to: 'skills' },
    { from: '../plugins', to: 'plugins' },
    { from: '../tools', to: 'tools' },
    { from: '../node_modules', to: 'node_modules' },
  ],
};

