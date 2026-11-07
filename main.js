const {
  app, BrowserWindow, ipcMain, screen, globalShortcut, desktopCapturer, session,
} = require('electron');
const path = require('path');
const fs = require('fs');

// NOTE: hardware acceleration was previously disabled (common workaround for
// transparent-window flicker), but it makes dragging laggy. Re-enabled for
// smoother dragging. If the overlay flickers or shows artifacts on your Mac,
// restore the line below:
//   app.disableHardwareAcceleration();

// ── Backend connection config ─────────────────────────────────────────────
// The Python backend runs on the same machine (localhost) by default.
// Override with env vars when needed (e.g. a LAN IP for a second-screen view).
const BACKEND_HOST = process.env.BACKEND_HOST || 'localhost';
const BACKEND_PORT = process.env.BACKEND_PORT || '3000';
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

// ── Global hotkeys (configurable via env; sensible defaults) ───────────────
const HOTKEY_CAPTURE_FULL = process.env.HOTKEY_CAPTURE_FULL || 'CommandOrControl+Shift+1';
const HOTKEY_CAPTURE_REGION = process.env.HOTKEY_CAPTURE_REGION || 'CommandOrControl+Shift+2';
const HOTKEY_TOGGLE_OVERLAY = process.env.HOTKEY_TOGGLE_OVERLAY || 'CommandOrControl+Shift+H';
const HOTKEY_ASK_NOW = process.env.HOTKEY_ASK_NOW || 'CommandOrControl+Shift+A';

let overlayWindow;
let selectionWindow;

// Current answer tone (set by the overlay UI; applied to captures).
let currentTone = process.env.ANSWER_TONE || 'concise';
// Capture mode: 'ocr' (default, local OCR) | 'vision' (send image to OpenAI).
let captureMode = 'ocr';

// ── Overlay window ─────────────────────────────────────────────────────────

// Remember the overlay's position/size between launches (simple JSON file).
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'overlay-window.json');
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8')); } catch (_) { return null; }
}
// True while the overlay is shrunk into the small solution panel. The panel's
// size/position must NOT be saved as the window state, or the next launch would
// open at panel size (so saveWindowState is a no-op while compact).
let overlayCompact = false;

function saveWindowState() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayCompact) return;
  try {
    const b = overlayWindow.getBounds();
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(b));
  } catch (_) {}
}

function createOverlayWindow() {
  const saved = loadWindowState();
  overlayWindow = new BrowserWindow({
    width: (saved && saved.width) || 1200,
    height: (saved && saved.height) || 850,
    x: saved && saved.x,
    y: saved && saved.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Pin to all virtual desktops / spaces (macOS & Windows).
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Highest always-on-top priority: stays above full-screen apps.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Hide from screen sharing / recording (Zoom, QuickTime, etc.).
  overlayWindow.setContentProtection(true);

  // Load the local overlay UI (four-state surface).
  overlayWindow.loadFile('index.html');

  // Persist position/size when the user moves or resizes the overlay.
  overlayWindow.on('moved', saveWindowState);
  overlayWindow.on('resized', saveWindowState);
}

// ── Screen capture ─────────────────────────────────────────────────────────

/**
 * Capture a full display as a PNG data URL at physical resolution.
 * Returns { dataUrl, display } where display carries bounds + scaleFactor.
 */
async function captureDisplay(display) {
  // Request thumbnails at the display's PHYSICAL pixel size so Retina (2x)
  // screens aren't downscaled. scaleFactor converts logical -> physical.
  const scale = display.scaleFactor || 1;
  const physWidth = Math.round(display.bounds.width * scale);
  const physHeight = Math.round(display.bounds.height * scale);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physWidth, height: physHeight },
  });

  // Match the source to the requested display when possible (multi-monitor).
  let source = sources.find((s) => String(s.display_id) === String(display.id));
  if (!source) source = sources[0];
  if (!source) throw new Error('No screen source available for capture.');

  return { thumbnail: source.thumbnail, scale, display };
}

/** Full-screen capture on the display under the cursor. */
async function captureFullScreen() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const { thumbnail } = await captureDisplay(display);
  const dataUrl = thumbnail.toDataURL();
  await routeCapture(dataUrl, 'screenshot-full');
}

/**
 * Region capture: crop the display image to the selected rectangle.
 * rect is in LOGICAL (CSS) pixels relative to the display's top-left.
 */
async function captureRegion(display, rect) {
  const { thumbnail, scale } = await captureDisplay(display);

  // Convert logical selection rect -> physical pixels for cropping.
  const cropRect = {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };

  // Guard against zero/negative selections.
  if (cropRect.width < 2 || cropRect.height < 2) {
    throw new Error('Selected region is too small.');
  }

  const cropped = thumbnail.crop(cropRect);
  const dataUrl = cropped.toDataURL();
  await routeCapture(dataUrl, 'screenshot-region');
}

// ── Region selection overlay window ─────────────────────────────────────────

/** Open a transparent full-screen window for the user to drag a rectangle. */
function openRegionSelector() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const { x, y, width, height } = display.bounds;

  selectionWindow = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    // Create hidden so content protection is in force BEFORE the first paint;
    // showing a transparent window before protection applies can leak it into
    // screen-share for a frame or more.
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Apply protection + levels while still hidden.
  selectionWindow.setContentProtection(true);
  selectionWindow.setAlwaysOnTop(true, 'screen-saver');
  selectionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Remember which display we're selecting on for the crop step.
  selectionWindow._targetDisplay = display;

  // Only reveal once the page is ready AND protection is set.
  selectionWindow.once('ready-to-show', () => {
    if (!selectionWindow) return;
    selectionWindow.setContentProtection(true); // re-assert, belt-and-suspenders
    selectionWindow.showInactive();
    selectionWindow.focus();
  });

  selectionWindow.loadFile('selection.html');
}

// Selection result from the selection window's renderer.
ipcMain.on('region-selected', async (event, rect) => {
  const display = selectionWindow ? selectionWindow._targetDisplay : null;
  if (selectionWindow) {
    selectionWindow.close();
    selectionWindow = null;
  }
  if (!display || !rect) return;
  try {
    await captureRegion(display, rect);
  } catch (err) {
    console.error('Region capture failed:', err);
    sendToOverlay('solve-error', { error: String(err.message || err) });
  }
});

ipcMain.on('region-cancelled', () => {
  if (selectionWindow) {
    selectionWindow.close();
    selectionWindow = null;
  }
});

// ── Send capture to backend /api/solve ───────────────────────────────────────

// Capture -> OCR ONLY. The overlay shows the editable extracted text; the
// user reviews/edits it and presses Ask to get an answer (/api/ask).
// Route a finished capture by the user's capture mode. 'ocr' keeps the
// original local-OCR flow untouched.
function routeCapture(dataUrl, sourceType) {
  if (captureMode === 'vision') return deliverVisionCapture(dataUrl, sourceType);
  return sendToSolve(dataUrl, sourceType);
}
// Vision mode: hand the image to the renderer, which shows the send popup.
// Main only un-hides the window; the renderer owns dot/expanded state and
// expands itself (avoids a double-resize race).
function deliverVisionCapture(dataUrl, sourceType) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!overlayWindow.isVisible()) overlayWindow.show();
  sendToOverlay('vision-capture', { dataUrl, sourceType });
}
async function sendToSolve(dataUrl, sourceType) {
  sendToOverlay('solve-status', { status: 'ocr' });
  try {
    const res = await fetch(`${BACKEND_URL}/api/ocr-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, source_type: sourceType }),
    });
    const data = await res.json();
    if (data.success) {
      sendToOverlay('ocr-ready', {
        text: data.extracted_text || '',
        recordId: data.record_id,
      });
    } else {
      sendToOverlay('solve-error', { error: data.error || 'OCR failed.' });
    }
  } catch (err) {
    sendToOverlay('solve-error', { error: `Backend unreachable: ${err.message || err}` });
  }
}

function sendToOverlay(channel, payload) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, payload);
  }
}

// ── IPC: existing overlay controls ───────────────────────────────────────────

ipcMain.on('save-transcript', (event, { speaker, text }) => {
  const logFilePath = path.join(__dirname, 'conversation.txt');
  const timestamp = new Date().toLocaleTimeString();
  const logLine = `[${timestamp}] ${speaker}: ${text}\n`;
  fs.appendFile(logFilePath, logLine, (err) => {
    if (err) console.error('Failed to write transcript:', err);
  });
});

// Remember the expanded size so we can restore it after the floating-dot state.
let expandedBounds = null;

ipcMain.on('toggle-overlay-mode', (event, isMinimized) => {
  if (!overlayWindow) return;
  if (isMinimized) {
    // Save current (expanded) size, then shrink to the dot.
    expandedBounds = overlayWindow.getBounds();
    overlayWindow.setSize(64, 64);
  } else {
    // Restore the previous expanded size (fallback to a sensible default).
    const w = (expandedBounds && expandedBounds.width) || 1000;
    const h = (expandedBounds && expandedBounds.height) || 720;
    overlayWindow.setSize(w, h);
  }
});

// Resolve interviewer-capture VAD timings from env + overlay.config.json and
// return them to the (sandboxed) preload synchronously. Reading the file MUST
// happen here in the main process — a sandboxed preload cannot require('fs').
// Precedence: env var > overlay.config.json "vad" block > undefined (renderer
// falls back to interview.js defaults). Only finite positive numbers pass.
ipcMain.on('get-vad-config', (event) => {
  const num = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  let fileVad = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'overlay.config.json'), 'utf8'));
    if (cfg && typeof cfg.vad === 'object' && cfg.vad) fileVad = cfg.vad;
  } catch (_) { /* no/invalid config file -> defaults */ }
  const pick = (envName, key) => {
    const e = num(process.env[envName]);
    return e !== undefined ? e : num(fileVad[key]);
  };
  event.returnValue = {
    silenceMs: pick('VAD_SILENCE_MS', 'silenceMs'),
    minSpeechMs: pick('VAD_MIN_SPEECH_MS', 'minSpeechMs'),
    maxUtterMs: pick('VAD_MAX_UTTER_MS', 'maxUtterMs'),
    speechLevel: pick('VAD_SPEECH_LEVEL', 'speechLevel'),
  };
});

// ── Small solution panel ─────────────────────────────────────────────────────
// "Pop out" shrinks THIS window (same renderer, same content protection, still
// always-on-top) to a small panel in the top-right of the current display, so
// the rest of the screen is free for typing the solution elsewhere. Turning it
// off restores the exact previous bounds. Kept separate from the dot's
// expandedBounds so the two features never overwrite each other's state.
const COMPACT_W = 460;
const COMPACT_H = 380;
let preCompactBounds = null;

ipcMain.on('set-compact-mode', (event, on) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (on) {
    if (overlayCompact) return;
    preCompactBounds = overlayWindow.getBounds();
    overlayCompact = true;
    const wa = screen.getDisplayMatching(preCompactBounds).workArea;
    const margin = 16;
    overlayWindow.setBounds({
      x: Math.round(wa.x + wa.width - COMPACT_W - margin),
      y: Math.round(wa.y + margin),
      width: COMPACT_W,
      height: COMPACT_H,
    });
  } else {
    if (!overlayCompact) return;
    overlayCompact = false;
    if (preCompactBounds && preCompactBounds.width && preCompactBounds.height) {
      overlayWindow.setBounds(preCompactBounds);
    }
    preCompactBounds = null;
  }
});

// Overlay UI sets the active answer tone; applied to hotkey captures.
ipcMain.on('set-tone', (event, tone) => {
  if (typeof tone === 'string' && tone) currentTone = tone;
});

// Overlay UI sets the capture mode ('ocr' | 'vision'); anything else ignored.
ipcMain.on('set-capture-mode', (event, mode) => {
  if (mode === 'ocr' || mode === 'vision') captureMode = mode;
});
// NOTE: the transcript "Ask" menu is now drawn as an in-overlay HTML menu
// inside the content-protected overlay window (see index.html). A native
// Electron Menu.popup() renders in an OS surface that is NOT covered by
// setContentProtection, so it would be visible during screen sharing — hence
// we no longer use a native menu here.

// ── Global shortcuts ─────────────────────────────────────────────────────────

// Shared entry points: the global hotkeys AND the on-screen overlay buttons both
// call these, so a click and a keypress always behave identically (local OCR or
// the vision popup, per the current capture mode).
function triggerFullCapture() {
  captureFullScreen().catch((err) => {
    console.error('Full capture failed:', err);
    sendToOverlay('solve-error', { error: String(err.message || err) });
  });
}
function triggerRegionCapture() {
  if (!selectionWindow) openRegionSelector();
}

// Overlay buttons -> same capture paths as the hotkeys. Only the two known
// kinds are accepted; anything else is ignored.
ipcMain.on('trigger-capture', (event, kind) => {
  if (kind === 'full') triggerFullCapture();
  else if (kind === 'region') triggerRegionCapture();
});

function registerShortcuts() {
  globalShortcut.register(HOTKEY_CAPTURE_FULL, triggerFullCapture);
  globalShortcut.register(HOTKEY_CAPTURE_REGION, triggerRegionCapture);

  globalShortcut.register(HOTKEY_TOGGLE_OVERLAY, () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.show();
  });

  // Ask-now: tell the overlay to request a suggestion over its open WebSocket.
  globalShortcut.register(HOTKEY_ASK_NOW, () => {
    if (overlayWindow && overlayWindow.isVisible === undefined) return;
    if (overlayWindow && !overlayWindow.isVisible()) overlayWindow.show();
    sendToOverlay('ask-now', {});
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Allow the renderer to use the microphone (audio capture, Phase 4).
// The OS still shows its own Microphone permission prompt on first use (macOS).
function configureMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture') return callback(true);
    callback(false);
  });
  if (ses.setPermissionCheckHandler) {
    ses.setPermissionCheckHandler((webContents, permission) =>
      permission === 'media' || permission === 'audioCapture');
  }

  // Loopback (system) audio capture for the "Them" stream.
  // When the renderer calls getDisplayMedia({ audio: true, video: true }), we
  // answer with a screen video source plus the OS audio loopback. This lets us
  // capture the remote caller's voice (what plays out of the speakers) WITHOUT
  // any third-party driver (BlackHole / VB-CABLE / Stereo Mix).
  //   - Windows: full system-audio loopback is supported.
  //   - macOS 13+: supported; the first use shows a system permission prompt.
  if (ses.setDisplayMediaRequestHandler) {
    // NOTE: on Electron 39+ (we ship 44), `audio: 'loopback'` is the NATIVE
    // macOS 12.3+ / Windows 10+ system-audio capture path — no BlackHole / VB-
    // CABLE / Stereo Mix driver required. We must NOT pass `{ useSystemPicker:
    // false }` here: on macOS that option suppresses the audio-sharing path and
    // yields a video-only stream (silent capture). Leaving options unset lets
    // the OS grant the loopback audio track alongside the screen video source
    // (the renderer immediately drops the video track and keeps only audio).
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources || !sources.length) {
          console.error('[capture] No screen sources available; cannot grant loopback audio.');
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.error('[capture] setDisplayMediaRequestHandler failed:', err);
        callback({});
      }
    });
  }
}

app.whenReady().then(() => {
  configureMediaPermissions();
  createOverlayWindow();
  registerShortcuts();
});

// Graceful shutdown: give the overlay renderer a chance to stop audio capture,
// close its WebSocket, and release tracks before the process exits. The
// renderer also listens to window 'beforeunload' as a belt-and-suspenders.
app.on('before-quit', () => {
  sendToOverlay('app-will-quit', {});
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
