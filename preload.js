const { contextBridge, ipcRenderer } = require('electron');

// Backend base URL (same values main.js uses). Exposed so the local overlay
// page can reach the Python backend without hardcoding it in HTML.
const BACKEND_HOST = process.env.BACKEND_HOST || 'localhost';
const BACKEND_PORT = process.env.BACKEND_PORT || '3000';
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

// Interviewer-capture VAD timings, tunable via env (VAD_SILENCE_MS, etc.) or
// overlay.config.json. IMPORTANT: this preload runs SANDBOXED (Electron's
// default), where require('fs')/require('path') THROW and abort the whole
// preload — which previously wiped out the entire electronAPI bridge (making
// askText/listRecords/backendUrl all undefined). So the file read lives in the
// MAIN process; we fetch the resolved VAD config here via a sandbox-safe sync
// IPC call. Only require('electron') is used in this preload.
let VAD_CONFIG = {};
try {
  VAD_CONFIG = ipcRenderer.sendSync('get-vad-config') || {};
} catch (_) { VAD_CONFIG = {}; }

contextBridge.exposeInMainWorld('electronAPI', {
  // Backend config
  backendUrl: BACKEND_URL,

  // Interviewer-capture VAD timing overrides (from env; undefined keys keep
  // interview.js defaults).
  vadConfig: VAD_CONFIG,
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
  // `language` (optional) pins the answer language; omitted when undefined so
  // the Answer tab's 3-arg calls stay byte-for-byte today's request.
  askText: async (text, tone, recordId, language) => {
    const body = { text, tone, record_id: recordId };
    if (language) body.language = language;
    const res = await fetch(`${BACKEND_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },

  // Parse an uploaded resume (PDF/DOCX/TXT) into a candidate-profile string.
  // Stateless on the backend: the parsed profile is held only in the renderer
  // and sent on the /ws/interview start frame. `distill` (default true) asks
  // the backend to LLM-summarize the resume; false returns capped raw text.
  parseResume: async (file, distill = true) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('distill', String(distill));
    const res = await fetch(`${BACKEND_URL}/api/resume/parse`, { method: 'POST', body: fd });
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
