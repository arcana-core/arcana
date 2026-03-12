'use strict';

const path = require('path');
const { notarize } = require('@electron/notarize');

/**
 * Electron Builder afterSign hook for macOS notarization.
 *
 * Supports two auth modes, checked in this order:
 *  - API key: APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER
 *  - Apple ID: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 *
 * If neither set of env vars is present, notarization is skipped.
 * No secrets are logged.
 */
module.exports = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    console.log('[notarize] Skipping notarization: non-macOS build.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const {
    APPLE_API_KEY_PATH,
    APPLE_API_KEY_ID,
    APPLE_API_ISSUER,
    APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID,
  } = process.env;

  try {
    if (APPLE_API_KEY_PATH && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
      console.log('[notarize] Notarizing with Apple API key credentials...');

      await notarize({
        appBundleId: 'io.arcana.desktop',
        appPath,
        tool: 'notarytool',
        appleApiKey: APPLE_API_KEY_PATH,
        appleApiKeyId: APPLE_API_KEY_ID,
        appleApiIssuer: APPLE_API_ISSUER,
      });

      console.log('[notarize] Notarization completed with Apple API key.');
      return;
    }

    if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
      console.log('[notarize] Notarizing with Apple ID credentials...');

      await notarize({
        appBundleId: 'io.arcana.desktop',
        appPath,
        tool: 'notarytool',
        appleId: APPLE_ID,
        appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
        teamId: APPLE_TEAM_ID,
      });

      console.log('[notarize] Notarization completed with Apple ID.');
      return;
    }

    console.log('[notarize] Skipping notarization: required Apple credentials not set.');
  } catch (error) {
    console.error('[notarize] Failed to notarize app:', error);
    throw error;
  }
};

