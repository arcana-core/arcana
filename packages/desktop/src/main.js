import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal Electron shell that embeds Arcana's web server.
 * Phase 1: desktop-first shell with a per-user workspace.
 */

let arcanaServer = null;
let arcanaPort = null;
const __dirname = fileURLToPath(new URL('.', import.meta.url));

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
  const win = new BrowserWindow({
    width: 1220,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs'),
    },
    title: 'Arcana',
  });
  const url = 'http://localhost:' + arcanaPort;
  await win.loadURL(url);
}

async function start(){
  const { workspace, arcanaHome, config } = ensureUserWorkspace();
  // Expose workspace and config locations to Arcana server
  process.env.ARCANA_WORKSPACE = workspace; // default/fallback workspace
  process.env.ARCANA_HOME = arcanaHome;
  process.env.ARCANA_CONFIG = config;

  // Desktop folder picker bridge
  ipcMain.handle('arcana:pickWorkspace', async (_ev, opts)=>{
    const def = (opts && opts.defaultPath) ? String(opts.defaultPath) : workspace;
    return dialog.showOpenDialog({ defaultPath: def, properties: ['openDirectory'] });
  });
  // Import server lazily so it picks up env and does not auto-start
  const mod = await import('../../arcana/server/server.mjs');
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
