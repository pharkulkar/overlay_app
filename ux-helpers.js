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
  const api = {
    POLL_INTERVAL_MS, recordSignature, recordsSignature, newestSignature,
    galleryChanged, shouldPoll, newRequestId, isCancelled,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.UxHelpers = api;
})();
