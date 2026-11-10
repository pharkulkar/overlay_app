const {
  app, BrowserWindow, ipcMain, screen, globalShortcut, desktopCapturer, session, systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const StealthUI = require('./stealth-ui.js');

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
// [AUDIO-TAB-DISABLED] const HOTKEY_ASK_NOW = process.env.HOTKEY_ASK_NOW || 'CommandOrControl+Shift+A';

let overlayWindow;
let selectionWindow;

// Capture mode is permanently 'vision' (send image to OpenAI via the popup).
// [OCR-DISABLED] was: // Capture mode: 'ocr' (default, local OCR) | 'vision' (send image to OpenAI).
// [OCR-DISABLED] was: let captureMode = 'ocr';
const captureMode = 'vision';

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

let saveWindowStateTimer = null;
function scheduleSaveWindowState() {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
  saveWindowStateTimer = setTimeout(() => {
    saveWindowStateTimer = null;
    saveWindowState();
  }, 300);
}

// Never open new windows or navigate away (e.g. a file dropped on the window):
// any such surface would be a native window outside content protection.
function lockNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// setBounds on a resizable:false window works on macOS (NSWindow setFrame) and
// Windows (SetWindowPos). On Windows a non-resizable window can come back with a
// shrunken size after a DPI change (electron#27054), so re-apply once if it differs.
function setOverlayBounds(b) {
  overlayWindow.setBounds(b);
  if (process.platform === 'win32') {
    const got = overlayWindow.getBounds();
    if (got.width !== b.width || got.height !== b.height) overlayWindow.setBounds(b);
  }
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
    // Stealth: a user-resizable window makes the OS draw edge-resize cursors
    // outside the content-protected surface. Resizing is done by the in-window
    // grip (overlay-resize-* IPC) via setBounds, which works on non-resizable windows.
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockNavigation(overlayWindow);

  // Pin to all virtual desktops / spaces (macOS & Windows).
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Highest always-on-top priority: stays above full-screen apps.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Hide from screen sharing / recording (Zoom, QuickTime, etc.).
  overlayWindow.setContentProtection(true);

  // Load the local overlay UI (four-state surface).
  overlayWindow.loadFile('index.html');

  // Persist position/size when the user moves or resizes the overlay.
  // Debounced: on macOS 'moved' is an alias of 'move' and fires continuously
  // while the window is being dragged. A synchronous file write on every one of
  // those events makes dragging stutter, so coalesce them into one trailing save.
  overlayWindow.on('moved', scheduleSaveWindowState);
  overlayWindow.on('resized', scheduleSaveWindowState);
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
  lockNavigation(selectionWindow);
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
    sendToOverlay('capture-error', { error: 'Region capture failed: ' + String(err.message || err) });
  }
});

ipcMain.on('region-cancelled', () => {
  if (selectionWindow) {
    selectionWindow.close();
    selectionWindow = null;
  }
});

// ── Capture delivery (vision popup) ───────────────────────────────────────

// Route a finished capture: always to the vision send popup.
function routeCapture(dataUrl, sourceType) {
  // [OCR-DISABLED] if (captureMode === 'vision') return deliverVisionCapture(dataUrl, sourceType);
  // [OCR-DISABLED] return sendToSolve(dataUrl, sourceType);
  return deliverVisionCapture(dataUrl, sourceType);
}
// Vision mode: hand the image to the renderer, which shows the send popup.
// Main only un-hides the window.
function deliverVisionCapture(dataUrl, sourceType) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    console.error('[capture] overlay window is gone; capture dropped');
    return;
  }
  // Show AND raise the overlay: a window that is visible but sitting behind the
  // active app looks exactly like "the editor did not open". showInactive()
  // raises it without stealing keyboard focus from the meeting app (the
  // editor's own focus handling takes over once the user clicks into it).
  if (overlayWindow.isMinimized()) overlayWindow.restore();
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  overlayWindow.moveTop();
  console.log(`[capture] delivering ${sourceType} (${Math.round(dataUrl.length / 1024)} KB) to the overlay`);
  sendToOverlay('vision-capture', { dataUrl, sourceType });
}
// [OCR-DISABLED] // Controller of the in-flight local-OCR request (null when idle). Cancelling
// [OCR-DISABLED] // ('cancel-ocr' IPC) only stops WAITING: the backend has already saved the
// [OCR-DISABLED] // capture/record before OCR runs, so it stays in the Gallery, and OCR itself
// [OCR-DISABLED] // finishes in the background on the server (its result is ignored here).
// [OCR-DISABLED] let ocrAbort = null;
// [OCR-DISABLED] async function sendToSolve(dataUrl, sourceType) {
// [OCR-DISABLED]   if (ocrAbort) {  // a newer capture supersedes the older wait, silently
// [OCR-DISABLED]     ocrAbort.superseded = true;
// [OCR-DISABLED]     ocrAbort.abort();
// [OCR-DISABLED]   }
// [OCR-DISABLED]   const ac = new AbortController();
// [OCR-DISABLED]   ocrAbort = ac;
// [OCR-DISABLED]   sendToOverlay('solve-status', { status: 'ocr' });
// [OCR-DISABLED]   try {
// [OCR-DISABLED]     const res = await fetch(`${BACKEND_URL}/api/ocr-only`, {
// [OCR-DISABLED]       method: 'POST',
// [OCR-DISABLED]       headers: { 'Content-Type': 'application/json' },
// [OCR-DISABLED]       body: JSON.stringify({ image: dataUrl, source_type: sourceType }),
// [OCR-DISABLED]       signal: ac.signal,
// [OCR-DISABLED]     });
// [OCR-DISABLED]     const data = await res.json();
// [OCR-DISABLED]     if (ac.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
// [OCR-DISABLED]     if (data.success) {
// [OCR-DISABLED]       sendToOverlay('ocr-ready', {
// [OCR-DISABLED]         text: data.extracted_text || '',
// [OCR-DISABLED]         recordId: data.record_id,
// [OCR-DISABLED]       });
// [OCR-DISABLED]     } else {
// [OCR-DISABLED]       sendToOverlay('solve-error', { error: data.error || 'OCR failed.' });
// [OCR-DISABLED]     }
// [OCR-DISABLED]   } catch (err) {
// [OCR-DISABLED]     if (err && err.name === 'AbortError' || ac.signal.aborted) {
// [OCR-DISABLED]       if (!ac.superseded) sendToOverlay('solve-status', { status: 'cancelled' });
// [OCR-DISABLED]       return;
// [OCR-DISABLED]     }
// [OCR-DISABLED]     sendToOverlay('solve-error', { error: `Backend unreachable: ${err.message || err}` });
// [OCR-DISABLED]   } finally {
// [OCR-DISABLED]     if (ocrAbort === ac) ocrAbort = null;
// [OCR-DISABLED]   }
// [OCR-DISABLED] }
// [OCR-DISABLED] ipcMain.on('cancel-ocr', (event) => {
// [OCR-DISABLED]   if (!isOverlaySender(event)) return;
// [OCR-DISABLED]   if (ocrAbort) ocrAbort.abort();
// [OCR-DISABLED] });
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

// Real accelerators (env overrides included) so the overlay's hint strip is accurate.
ipcMain.on('get-hotkeys', (event) => {
  event.returnValue = {
    capture: HOTKEY_CAPTURE_FULL, region: HOTKEY_CAPTURE_REGION,
    toggle: HOTKEY_TOGGLE_OVERLAY, // [AUDIO-TAB-DISABLED] ask: HOTKEY_ASK_NOW,
  };
});

// Read-only permission status for the first-run checklist (never prompts).
ipcMain.handle('get-permissions', () => (process.platform === 'darwin'
  ? {
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen'),
  }
  : { microphone: 'not-required', screen: 'not-required' }));

// ── Drag the window from anywhere ────────────────────────────────────────────
// Electron's native -webkit-app-region drag only covers whatever is NOT marked
// no-drag, which left only scattered gaps draggable. The renderer now decides
// when a press on non-interactive UI becomes a drag and tells us with three
// messages. On every move we read the LIVE cursor position here (same DIP
// coordinate space as window bounds, correct across displays) and place the
// window at start-position + cursor-delta, keeping its size fixed.
let dragState = null;

function isOverlaySender(event) {
  return overlayWindow && !overlayWindow.isDestroyed()
    && BrowserWindow.fromWebContents(event.sender) === overlayWindow;
}

ipcMain.on('overlay-drag-start', (event) => {
  if (!isOverlaySender(event)) return;
  dragState = { cursor: screen.getCursorScreenPoint(), bounds: overlayWindow.getBounds() };
});

ipcMain.on('overlay-drag-move', (event) => {
  if (!dragState || !isOverlaySender(event)) return;
  const cur = screen.getCursorScreenPoint();
  setOverlayBounds({
    x: Math.round(dragState.bounds.x + cur.x - dragState.cursor.x),
    y: Math.round(dragState.bounds.y + cur.y - dragState.cursor.y),
    width: dragState.bounds.width,     // size stays fixed while dragging
    height: dragState.bounds.height,
  });
});

ipcMain.on('overlay-drag-end', (event) => {
  if (!isOverlaySender(event)) return;
  dragState = null;
  saveWindowState();   // persist the final position right away (no-op when compact)
});

// ── In-window resize grip ────────────────────────────────────────────────────
// Same shape as drag: start / one move per frame / end, live cursor read here.
// Top-left stays fixed; size = start size + cursor delta (clamped in stealth-ui).
let resizeState = null;

ipcMain.on('overlay-resize-start', (event) => {
  if (!isOverlaySender(event) || overlayCompact) return;
  const bounds = overlayWindow.getBounds();
  resizeState = {
    cursor: screen.getCursorScreenPoint(),
    bounds,
    workArea: screen.getDisplayMatching(bounds).workArea,
  };
});

ipcMain.on('overlay-resize-move', (event) => {
  if (!resizeState || !isOverlaySender(event)) return;
  const cur = screen.getCursorScreenPoint();
  setOverlayBounds(StealthUI.clampResize({
    start: resizeState.bounds,
    dx: cur.x - resizeState.cursor.x,
    dy: cur.y - resizeState.cursor.y,
    workArea: resizeState.workArea,
    min: StealthUI.MIN_RESIZE,
  }));
});

ipcMain.on('overlay-resize-end', (event) => {
  if (!isOverlaySender(event)) return;
  resizeState = null;
  saveWindowState();   // persist final size (no-op when compact)
});

// ── Small solution panel ─────────────────────────────────────────────────────
// "Pop out" shrinks THIS window (same renderer, same content protection, still
// always-on-top) to a small panel in the top-right of the current display, so
// the rest of the screen is free for typing the solution elsewhere. Turning it
// off restores the exact previous bounds.
const COMPACT_W = 460;
const COMPACT_H = 380;
let preCompactBounds = null;

ipcMain.on('set-compact-mode', (event, on) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (on) {
    if (overlayCompact) return;
    preCompactBounds = overlayWindow.getBounds();
    overlayCompact = true;
    dragState = null;
    resizeState = null;
    const wa = screen.getDisplayMatching(preCompactBounds).workArea;
    const margin = 16;
    setOverlayBounds({
      x: Math.round(wa.x + wa.width - COMPACT_W - margin),
      y: Math.round(wa.y + margin),
      width: COMPACT_W,
      height: COMPACT_H,
    });
  } else {
    if (!overlayCompact) return;
    overlayCompact = false;
    if (preCompactBounds && preCompactBounds.width && preCompactBounds.height) {
      setOverlayBounds(preCompactBounds);
    }
    preCompactBounds = null;
  }
});


// [OCR-DISABLED] // Overlay UI sets the capture mode ('ocr' | 'vision'); anything else ignored.
// [OCR-DISABLED] ipcMain.on('set-capture-mode', (event, mode) => {
// [OCR-DISABLED]   if (mode === 'ocr' || mode === 'vision') captureMode = mode;
// [OCR-DISABLED] });
// NOTE: the transcript "Ask" menu is now drawn as an in-overlay HTML menu
// inside the content-protected overlay window (see index.html). A native
// Electron Menu.popup() renders in an OS surface that is NOT covered by
// setContentProtection, so it would be visible during screen sharing — hence
// we no longer use a native menu here.

// ── Global shortcuts ─────────────────────────────────────────────────────────

// Shared entry points: the global hotkeys AND the on-screen overlay buttons both
// call these, so a click and a keypress always behave identically (always the
// vision popup).
function triggerFullCapture() {
  captureFullScreen().catch((err) => {
    console.error('Full capture failed:', err);
    sendToOverlay('capture-error', { error: 'Screen capture failed: ' + String(err.message || err) });
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

// Renderer-side capture diagnostics, printed in the terminal running `npm start`
// so the whole capture chain can be followed in one place.
ipcMain.on('capture-log', (event, msg) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (BrowserWindow.fromWebContents(event.sender) !== overlayWindow) return;
  console.log('[capture][overlay] ' + String(msg).slice(0, 500));
});

// Register a global hotkey and REPORT the result: register() returns false when
// macOS/another app already owns the combination, and the hotkey then silently
// does nothing. Failures are logged and surfaced in the overlay status bar.
const hotkeyFailures = [];
function registerHotkey(accelerator, handler, label) {
  let ok = false;
  try { ok = globalShortcut.register(accelerator, handler); } catch (err) { ok = false; }
  if (!ok) {
    hotkeyFailures.push(`${label} (${accelerator})`);
    console.error(`[hotkey] could not register ${label} ${accelerator} - it is used by macOS or another app`);
  } else {
    console.log(`[hotkey] registered ${label} ${accelerator}`);
  }
  return ok;
}

function registerShortcuts() {
  registerHotkey(HOTKEY_CAPTURE_FULL, () => { console.log('[capture] full-screen hotkey pressed'); triggerFullCapture(); }, 'full-screen capture');
  registerHotkey(HOTKEY_CAPTURE_REGION, () => { console.log('[capture] region hotkey pressed'); triggerRegionCapture(); }, 'region capture');

  registerHotkey(HOTKEY_TOGGLE_OVERLAY, () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else { overlayWindow.showInactive(); overlayWindow.moveTop(); }
  }, 'hide/show');

  // [AUDIO-TAB-DISABLED] Ask-now: tell the overlay to request a suggestion over its open WebSocket.
  // [AUDIO-TAB-DISABLED] registerHotkey(HOTKEY_ASK_NOW, () => {
  // [AUDIO-TAB-DISABLED]   if (overlayWindow && !overlayWindow.isVisible()) { overlayWindow.showInactive(); overlayWindow.moveTop(); }
  // [AUDIO-TAB-DISABLED]   sendToOverlay('ask-now', {});
  // [AUDIO-TAB-DISABLED] }, 'ask now');
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
  // Tell the overlay (once it has loaded) if a capture hotkey could not be registered.
  if (hotkeyFailures.length && overlayWindow) {
    overlayWindow.webContents.once('did-finish-load', () => {
      sendToOverlay('capture-error', {
        error: 'Hotkey not available: ' + hotkeyFailures.join(', ')
          + '. Another app already uses it; set a different key with the matching HOTKEY_* variable '
          + '(capture can still be used from the buttons in the Answer tab).',
      });
    });
  }
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
