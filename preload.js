const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  toggleOverlayMode: (isMinimized) => ipcRenderer.send('toggle-overlay-mode', isMinimized),
  saveTranscript: (speaker, text) => ipcRenderer.send('save-transcript', { speaker, text })
});