// ux-helpers.js — pure helpers for gallery auto-refresh, polling guard and
// cancellable requests (no DOM, no Node-only APIs). Loaded by index.html via
// <script> (attaches window.UxHelpers) and by node tests via require().
(function () {
  'use strict';
  const POLL_INTERVAL_MS = 3000;
  let counter = 0;
  // Cheap per-record signature: id + status + whether an answer exists.
  function recordSignature(r) {
    if (!r) return '';
    return String(r.id) + '|' + String(r.status || '') + '|' + (r.answer ? 1 : 0);
  }
  function recordsSignature(records) {
    if (!Array.isArray(records)) return '';
    return records.map(recordSignature).join(';');
  }
  function newestSignature(records) {
    if (!Array.isArray(records) || !records.length) return '';
    return recordSignature(records[0]);
  }
  function galleryChanged(prevSig, nextSig) { return prevSig !== nextSig; }
  function shouldPoll(s) {
    s = s || {};
    return s.view === 'gallery' && s.visible === 'visible' && !s.inFlight && !!s.hasBridge;
  }
  function newRequestId(prefix) {
    counter += 1;
    const p = String(prefix || 'req').replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'req';
    const rnd = Math.random().toString(36).slice(2, 10);
    return p + '-' + Date.now().toString(36) + '-' + counter.toString(36) + '-' + rnd;
  }
  function isCancelled(data) { return !!(data && data.cancelled === true); }
  // 'CommandOrControl+Shift+1' -> '⌘⇧1' (macOS) or 'Ctrl+Shift+1' (elsewhere).
  function formatAccelerator(accel, isMac) {
    const map = isMac
      ? { commandorcontrol: '⌘', cmdorctrl: '⌘', command: '⌘', cmd: '⌘', control: '⌃', ctrl: '⌃', shift: '⇧', alt: '⌥', option: '⌥' }
      : { commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', command: 'Ctrl', cmd: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', option: 'Alt' };
    const parts = String(accel || '').split('+').map((p) => map[p.toLowerCase()] || p);
    return isMac ? parts.join('') : parts.join('+');
  }
  // One short, human line for a failed request; the raw error stays in the console.
  function friendlyError(err, backendUrl) {
    const msg = String(err && err.message ? err.message : err || '');
    if (err instanceof TypeError || /failed to fetch|network|econnrefused/i.test(msg)) {
      const port = (String(backendUrl || '').match(/:(\d+)/) || [])[1];
      return "Can't reach the backend. Is it running" + (port ? ' on port ' + port : '') + '?';
    }
    return 'Something went wrong. Please try again.';
  }
  const api = {
    POLL_INTERVAL_MS, recordSignature, recordsSignature, newestSignature,
    galleryChanged, shouldPoll, newRequestId, isCancelled, formatAccelerator, friendlyError,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.UxHelpers = api;
})();
