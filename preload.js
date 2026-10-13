const { contextBridge, ipcRenderer } = require('electron');

// Backend base URL (same values main.js uses). Exposed so the local overlay
// page can reach the Python backend without hardcoding it in HTML.
const BACKEND_HOST = process.env.BACKEND_HOST || 'localhost';
const BACKEND_PORT = process.env.BACKEND_PORT || '3000';
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

contextBridge.exposeInMainWorld('electronAPI', {
  // Backend config
  backendUrl: BACKEND_URL,
  health: async () => {
    const res = await fetch(`${BACKEND_URL}/api/health`);
    return res.json();
  },

  // Overlay controls
  toggleOverlayMode: (isMinimized) => ipcRenderer.send('toggle-overlay-mode', isMinimized),
  saveTranscript: (speaker, text) => ipcRenderer.send('save-transcript', { speaker, text }),

  // Region selection window -> main process
  sendRegion: (rect) => ipcRenderer.send('region-selected', rect),
  cancelRegion: () => ipcRenderer.send('region-cancelled'),

  // Overlay UI -> main: set the active answer tone (applied to hotkey captures)
  setTone: (tone) => ipcRenderer.send('set-tone', tone),

  // Main process -> overlay renderer (capture/solve lifecycle)
  onSolveStatus: (cb) => ipcRenderer.on('solve-status', (_e, payload) => cb(payload)),
  onSolveAnswer: (cb) => ipcRenderer.on('solve-answer', (_e, payload) => cb(payload)),
  onSolveError: (cb) => ipcRenderer.on('solve-error', (_e, payload) => cb(payload)),

  // Main process -> overlay: ask-now hotkey pressed (request a suggestion)
  onAskNow: (cb) => ipcRenderer.on('ask-now', (_e, payload) => cb(payload)),

  // Main process -> overlay: OCR text ready (editable before asking)
  onOcrReady: (cb) => ipcRenderer.on('ocr-ready', (_e, payload) => cb(payload)),

  // Main process -> overlay: the app is about to quit. Lets the renderer stop
  // audio capture / close sockets cleanly. One-way, no payload trusted.
  onAppWillQuit: (cb) => ipcRenderer.on('app-will-quit', () => {
    if (typeof cb === 'function') cb();
  }),


  // Ask OpenAI with (possibly edited) text; optionally persist onto a record.
  askText: async (text, tone, recordId) => {
    const res = await fetch(`${BACKEND_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, tone, record_id: recordId }),
    });
    return res.json();
  },

  // ── Backend REST helpers (gallery + caching, Phase 2b) ──────────────────
  listRecords: async () => {
    const res = await fetch(`${BACKEND_URL}/api/records`);
    return res.json();
  },
  getRecord: async (id) => {
    const res = await fetch(`${BACKEND_URL}/api/records/${id}`);
    return res.json();
  },
  solveRecord: async (id, force = false, tone = null) => {
    const res = await fetch(`${BACKEND_URL}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: id, force, tone }),
    });
    return res.json();
  },
  deleteRecord: async (id) => {
    const res = await fetch(`${BACKEND_URL}/api/records/${id}`, { method: 'DELETE' });
    return res.json();
  },
  clearRecords: async () => {
    const res = await fetch(`${BACKEND_URL}/api/records/clear`, { method: 'POST' });
    return res.json();
  },

  // Live transcript (Phase 5)
  clearTranscript: async () => {
    const res = await fetch(`${BACKEND_URL}/api/transcript/clear`, { method: 'POST' });
    return res.json();
  },
  // Opt-in transcript save (Phase 7)
  saveTranscriptToDisk: async () => {
    const res = await fetch(`${BACKEND_URL}/api/transcript/save`, { method: 'POST' });
    return res.json();
  },
});
