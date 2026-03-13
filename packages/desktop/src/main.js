import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
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
  const url = 'http://localhost:' + arcanaPort;
  await win.loadURL(url);
}

async function start(){
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
      if (!frameUrl || !frameUrl.startsWith('http://localhost:')) return '';

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

  // Import server lazily so it picks up env and does not auto-start
  const repoRoot = join(__dirname, '..', '..', '..');
  let mod;

  if (!app.isPackaged){
    // Development: use the server from the repo checkout via file URL
    const devServerPath = join(repoRoot, 'server', 'server.mjs');
    const devServerUrl = pathToFileURL(devServerPath).href;
    mod = await import(devServerUrl);
  } else {
    // Packaged: load server from process.resourcesPath
    const resourcesRoot = process.resourcesPath || process.cwd();
    const bundledServerPath = join(resourcesRoot, 'server', 'server.mjs');

    if (!existsSync(bundledServerPath)){
      throw new Error(
        'Arcana bundled server not found at ' +
        bundledServerPath +
        '; ensure electron-builder extraResources includes the server directory.'
      );
    }

    const bundledServerUrl = pathToFileURL(bundledServerPath).href;
    mod = await import(bundledServerUrl);
  }

  const { server, port } = await mod.startArcanaWebServer({ port: 0, workspaceRoot: workspace });
  arcanaServer = server;
  arcanaPort = port;
  await createWindow();
}

app.whenReady().then(start);

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
