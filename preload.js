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

// In-flight cancellable requests, keyed by a caller-supplied string requestId
// (contextBridge cannot pass an AbortSignal, so the renderer uses ids).
// LIMITS: aborting the fetch only stops WAITING; it cannot abort the upstream
// OpenAI call (tokens may still be consumed), and OCR already running on the
// server finishes in the background (the UI ignores its result).
const inflight = new Map();
const CANCELLED = () => ({ success: false, cancelled: true, error: 'Cancelled' });
async function trackedFetch(url, options, requestId) {
  if (!requestId) {
    const res = await fetch(url, options);
    return res.json();
  }
  const ac = new AbortController();
  inflight.set(requestId, ac);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: ac.signal }));
    try {
      return await res.json();
    } catch (e) {
      if (ac.signal.aborted) return CANCELLED();
      return { success: false, error: `HTTP ${res.status}` };
    }
  } catch (e) {
    if (ac.signal.aborted || (e && e.name === 'AbortError')) return CANCELLED();
    throw e;
  } finally {
    if (inflight.get(requestId) === ac) inflight.delete(requestId);
  }
}
const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
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
  setCaptureMode: (mode) => ipcRenderer.send('set-capture-mode', mode),
  // On-screen alternative to the capture hotkeys: kind = 'full' | 'region'.
  triggerCapture: (kind) => ipcRenderer.send('trigger-capture', kind),
  // Shrink the window into the small solution panel (true) or restore it (false).
  setCompactMode: (on) => ipcRenderer.send('set-compact-mode', !!on),
  // Drag the window from anywhere on non-interactive UI (see index.html). The
  // main process reads the live cursor position itself, so no coordinates are sent.
  dragStart: () => ipcRenderer.send('overlay-drag-start'),
  dragMove: () => ipcRenderer.send('overlay-drag-move'),
  dragEnd: () => ipcRenderer.send('overlay-drag-end'),

  // Main process -> overlay renderer (capture/solve lifecycle)
  onSolveStatus: (cb) => ipcRenderer.on('solve-status', (_e, payload) => cb(payload)),
  onSolveAnswer: (cb) => ipcRenderer.on('solve-answer', (_e, payload) => cb(payload)),
  onSolveError: (cb) => ipcRenderer.on('solve-error', (_e, payload) => cb(payload)),

  // Main process -> overlay: ask-now hotkey pressed (request a suggestion)
  onAskNow: (cb) => ipcRenderer.on('ask-now', (_e, payload) => cb(payload)),

  // Main process -> overlay: OCR text ready (editable before asking)
  onVisionCapture: (cb) => ipcRenderer.on('vision-capture', (_e, payload) => cb(payload)),
  onOcrReady: (cb) => ipcRenderer.on('ocr-ready', (_e, payload) => cb(payload)),

  // Main process -> overlay: the app is about to quit. Lets the renderer stop
  // audio capture / close sockets cleanly. One-way, no payload trusted.
  onAppWillQuit: (cb) => ipcRenderer.on('app-will-quit', () => {
    if (typeof cb === 'function') cb();
  }),


  // Ask OpenAI with (possibly edited) text; optionally persist onto a record.
  // `language` (optional) pins the answer language; omitted when undefined so
  // the Answer tab's 3-arg calls stay byte-for-byte today's request.
  askText: async (text, tone, recordId, language, requestId) => {
    const body = { text, tone, record_id: recordId };
    if (language) body.language = language;
    if (requestId) body.request_id = requestId;
    return trackedFetch(`${BACKEND_URL}/api/ask`, jsonPost(body), requestId);
  },
  // Stop waiting for a tracked request: abort locally, then best-effort tell
  // the backend (fire-and-forget) so it discards the result instead of saving.
  cancelRequest: (requestId) => {
    if (!requestId) return false;
    const ac = inflight.get(requestId);
    if (ac) { ac.abort(); inflight.delete(requestId); }
    try {
      fetch(`${BACKEND_URL}/api/cancel`, jsonPost({ request_id: requestId })).catch(() => {});
    } catch (_e) { /* ignore */ }
    return !!ac;
  },
  // Stop waiting for the main-process (hotkey/button) local OCR request.
  cancelOcr: () => ipcRenderer.send('cancel-ocr'),

  // Send one or more screenshots straight to OpenAI vision (no local OCR).
  visionAsk: async (images, mode, tone, language, sourceTypes, requestId) => {
    const body = { images, mode };
    if (tone) body.tone = tone;
    if (language) body.language = language;
    if (Array.isArray(sourceTypes)) body.source_types = sourceTypes;
    if (requestId) body.request_id = requestId;
    return trackedFetch(`${BACKEND_URL}/api/vision-ask`, jsonPost(body), requestId);
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
  // Optional limit/offset (non-negative ints) for cheap polling, e.g. (1, 0).
  listRecords: async (limit, offset) => {
    let qs = '';
    if (Number.isInteger(limit) && limit >= 0) {
      qs = `?limit=${limit}`;
      if (Number.isInteger(offset) && offset >= 0) qs += `&offset=${offset}`;
    }
    const res = await fetch(`${BACKEND_URL}/api/records${qs}`);
    return res.json();
  },
  getRecord: async (id) => {
    const res = await fetch(`${BACKEND_URL}/api/records/${id}`);
    return res.json();
  },
  // OCR an edited/cropped image. Creates a NEW record on the backend (the
  // "new version" Gallery entry) with the posted image saved to disk and
  // OCR'd. Returns { success, record_id, extracted_text }.
  // requestId (optional) is tracked locally only; the backend never sees it.
  ocrImage: async (dataUrl, sourceType = 'screenshot-region', requestId) => {
    return trackedFetch(`${BACKEND_URL}/api/ocr-only`,
      jsonPost({ image: dataUrl, source_type: sourceType }), requestId);
  },
  // requestId (optional) is tracked locally only: cancelling stops waiting, but
  // /api/solve never sees the id, so the backend may still persist the answer.
  solveRecord: async (id, force = false, tone = null, requestId) => {
    return trackedFetch(`${BACKEND_URL}/api/solve`,
      jsonPost({ record_id: id, force, tone }), requestId);
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
