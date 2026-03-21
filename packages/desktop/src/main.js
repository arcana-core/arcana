import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Minimal Electron shell that embeds Arcana's web server.
 * Phase 1: desktop-first shell with a per-user workspace.
 */

let arcanaServer = null;
let arcanaPort = null;
let arcanaHomeDir = null;
const __dirname = fileURLToPath(new URL('.', import.meta.url));

function getErrorLogPath(){
  const base = app.getPath('userData');
  return join(base, 'startup-error.log');
}

function formatErrorForLogging(error, context){
  const timestamp = new Date().toISOString();
  let details = '';
  if (error && typeof error === 'object'){
    const err = error;
    if (err.stack){
      details = String(err.stack);
    } else if (err.message){
      details = String(err.message);
    } else {
      try{
        details = JSON.stringify(err);
      } catch {
        details = String(err);
      }
    }
  } else if (error){
    details = String(error);
  } else {
    details = 'Unknown error';
  }
  if (context){
    return '[' + timestamp + '] ' + context + '\n' + details;
  }
  return '[' + timestamp + '] ' + details;
}

function logAndDisplayFatalError(error, context){
  try{
    const message = formatErrorForLogging(error, context);
    console.error(message);
    try{
      const logPath = getErrorLogPath();
      writeFileSync(logPath, message + '\n', { flag: 'a' });
    } catch (fileError){
      console.error('Failed to write startup error log:', fileError);
    }
    try{
      dialog.showErrorBox('Arcana error', message);
    } catch (dialogError){
      console.error('Failed to show error dialog:', dialogError);
    }
  } catch (handlerError){
    console.error('Failed while handling fatal error:', handlerError);
  } finally {
    try{
      if (app){
        app.exit(1);
      } else {
        process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  }
}

process.on('uncaughtException', (error) => {
  logAndDisplayFatalError(error, 'Uncaught exception in main process');
});

process.on('unhandledRejection', (reason) => {
  logAndDisplayFatalError(reason, 'Unhandled promise rejection in main process');
});

// Persistent storage partition for BrowserWindow. This isolates
// cookies/localStorage/IndexedDB from other Electron or browser instances.
const DEFAULT_ELECTRON_PARTITION = 'persist:arcana-desktop';
function getElectronPartition(){
  const raw = process.env.ARCANA_ELECTRON_PARTITION;
  if (typeof raw === 'string'){
    const v = raw.trim();
    if (v) return v;
  }
  return DEFAULT_ELECTRON_PARTITION;
}

function ensureUserWorkspace(){
  const base = app.getPath('userData');
  const ws = join(base, 'workspace');
  const home = join(base, 'arcana-home');
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true });
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const cfg = join(home, 'config.json');
  return { workspace: ws, arcanaHome: home, config: cfg };
}

async function createWindow(){
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Arcana',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    vibrancy: isMac ? 'sidebar' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    backgroundColor: isMac ? '#00000000' : '#f6f7fb',
    webPreferences: {
      partition: getElectronPartition(),
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  const url = 'http://127.0.0.1:' + arcanaPort;
  await win.loadURL(url);
}

async function start(){
  try{
    const isMac = process.platform === 'darwin';
    if (isMac && app.isPackaged){
      let shouldBlock = false;
      try{
        if (typeof app.isInApplicationsFolder === 'function'){
          const inApps = app.isInApplicationsFolder();
          if (!inApps) shouldBlock = true;
        }
      } catch {}

      try{
        const execPath = process.execPath || '';
        if (execPath.startsWith('/Volumes/')) shouldBlock = true;
      } catch {}

      try{
        const appPath = app.getAppPath && app.getAppPath();
        if (typeof appPath === 'string' && appPath.startsWith('/Volumes/')){
          shouldBlock = true;
        }
      } catch {}

      if (shouldBlock){
        const message = [
          'Arcana is currently running from a disk image (DMG).',
          '',
          'To install Arcana properly, please move it to the /Applications folder.',
          '',
          'After moving Arcana to /Applications, please launch it again from there.'
        ].join('\n');

        const buttons = [];
        let moveIndex = -1;
        if (typeof app.moveToApplicationsFolder === 'function'){
          buttons.push('Move to Applications');
          moveIndex = 0;
          buttons.push('Quit');
        } else {
          buttons.push('OK');
        }

        try{
          const result = dialog.showMessageBoxSync({
            type: 'info',
            buttons,
            defaultId: 0,
            cancelId: buttons.length - 1,
            title: 'Move Arcana to Applications',
            message: 'Arcana needs to be moved to /Applications before it can run.',
            detail: message,
          });

          if (moveIndex !== -1 && result === moveIndex){
            try{
              const moved = app.moveToApplicationsFolder();
              if (moved){
                app.relaunch();
              }
            } catch {}
          }
        } catch {}

        try{
          app.exit(0);
        } catch {
          process.exit(0);
        }
        return;
      }
    }

    const { workspace, arcanaHome, config } = ensureUserWorkspace();
    arcanaHomeDir = arcanaHome;
    // Expose workspace and config locations to Arcana server
    process.env.ARCANA_WORKSPACE = workspace; // default/fallback workspace
    process.env.ARCANA_HOME = arcanaHome;
    process.env.ARCANA_CONFIG = config;

    // Desktop folder picker bridge
    ipcMain.handle('arcana:pickWorkspace', async (_ev, opts)=>{
      const def = (opts && opts.defaultPath) ? String(opts.defaultPath) : workspace;
      return dialog.showOpenDialog({ defaultPath: def, properties: ['openDirectory'] });
    });

    ipcMain.handle('arcana:getApiToken', async (ev)=>{
      try{
        const frame = (ev && ev.senderFrame) ? ev.senderFrame : null;
        const frameUrl = (frame && typeof frame.url === 'string') ? frame.url : '';
        if (!frameUrl) return '';
        const isLocalhost = frameUrl.startsWith('http://localhost:');
        const isLoopback = frameUrl.startsWith('http://127.0.0.1:');
        if (!isLocalhost && !isLoopback) return '';

        const home = arcanaHomeDir;
        if (!home) return '';

        const primary = join(home, 'api_token');
        const fallback = join(home, 'api-token');
        let raw = '';
        if (existsSync(primary)){
          try{ raw = readFileSync(primary, 'utf8'); } catch { raw = ''; }
        } else if (existsSync(fallback)){
          try{ raw = readFileSync(fallback, 'utf8'); } catch { raw = ''; }
        }
        if (!raw) return '';
        return String(raw || '').trim();
      } catch {
        return '';
      }
    });

    // Import gateway lazily so it picks up env and does not auto-start
    const repoRoot = join(__dirname, '..', '..', '..');
    let mod;

    if (!app.isPackaged){
      // Development: use the gateway from the repo checkout via file URL
      const devGatewayPath = join(repoRoot, 'server', 'gateway.mjs');
      const devGatewayUrl = pathToFileURL(devGatewayPath).href;
      mod = await import(devGatewayUrl);
    } else {
      // Packaged: load gateway from process.resourcesPath
      const resourcesRoot = process.resourcesPath || process.cwd();

      // Enable bundled services in packaged builds so the core
      // server can discover services under the bundled resources.
      process.env.ARCANA_ENABLE_BUNDLED_SERVICES = '1';
      process.env.ARCANA_BUNDLED_ROOT = resourcesRoot;

      const bundledGatewayPath = join(resourcesRoot, 'server', 'gateway.mjs');

      if (!existsSync(bundledGatewayPath)){
        throw new Error(
          'Arcana bundled gateway entry server/gateway.mjs not found at ' +
          bundledGatewayPath +
          '; ensure electron-builder extraResources includes the server directory.'
        );
      }

      const bundledGatewayUrl = pathToFileURL(bundledGatewayPath).href;
      mod = await import(bundledGatewayUrl);
    }

    const { server, port } = await mod.startGatewayV2({ port: 0 });
    arcanaServer = server;
    arcanaPort = port;
    await createWindow();
  } catch (error){
    logAndDisplayFatalError(error, 'Failed to start Arcana desktop shell');
  }
}

app.whenReady().then(start).catch((error)=>{
  logAndDisplayFatalError(error, 'Failed during app.whenReady/start');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (arcanaServer){
    try { arcanaServer.close(); } catch {}
    arcanaServer = null;
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0 && arcanaPort){
    await createWindow();
  }
});
