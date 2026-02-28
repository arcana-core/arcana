const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API for the web app to pick a workspace directory
try {
  contextBridge.exposeInMainWorld('arcana', {
    pickWorkspace: (opts) => ipcRenderer.invoke('arcana:pickWorkspace', opts || {}),
  });
} catch {}

