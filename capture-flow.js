// capture-flow.js — pure decision logic for "capture opens the edit screen
// directly" (no DOM, no Electron). Loaded by index.html via <script> (attaches
// window.CaptureFlow; needs window.VisionBatch loaded first) and by node tests
// via require(). All functions are immutable: they return new state objects.
//
// State: { mode: 'closed'|'fresh'|'record', staged: [{id,dataUrl,sourceType}],
//          current: null|{dataUrl,sourceType}, busy: boolean, sent: boolean }
(function () {
  'use strict';
  const VB = (typeof module !== 'undefined' && module.exports)
    ? require('./vision-batch.js') : window.VisionBatch;
  const STORAGE_KEY = 'visionMode';
  const MAX = VB.MAX_BATCH;

  function createState() {
    return { mode: 'closed', staged: [], current: null, busy: false, sent: false };
  }
  function fullMessage(max) { return 'Batch limit reached (' + (max || MAX) + ' images). Send or remove one.'; }
  function normItem(p) {
    return { dataUrl: p.dataUrl, sourceType: p.sourceType || 'screenshot-full' };
  }
  function validPayload(p) { return !!p && typeof p.dataUrl === 'string' && p.dataUrl.length > 0; }
  function res(action, state, extra) {
    return Object.assign({ action, state, message: '' }, extra || {});
  }

  // Decide what to do when a capture arrives.
  function onCapture(state, payload, max) {
    const limit = max || MAX;
    if (!validPayload(payload)) return res('ignore', state);
    const item = normItem(payload);
    const n = state.staged.length;
    if (state.mode === 'record') {
      return res('replace-record', { mode: 'fresh', staged: [], current: item, busy: false, sent: false });
    }
    if (state.mode === 'fresh') {
      if (state.busy) return res('defer', state);
      if (state.sent) return res('replace-sent', Object.assign({}, state, { current: item, sent: false }));
      if (n + 2 > limit) return res('full', state, { message: fullMessage(limit) });
      // Caller must stageCurrent(edited canvas) then loadCurrent(pendingCurrent).
      return res('stage-and-replace', state, { stageCurrent: true, pendingCurrent: item });
    }
    // closed
    if (n + 1 > limit) return res('full', state, { message: fullMessage(limit) });
    return res('open-fresh', Object.assign({}, state, { mode: 'fresh', current: item, busy: false, sent: false }));
  }

  function canStage(state, max) {
    const limit = max || MAX;
    return state.mode === 'fresh' && !state.busy && !state.sent && !!state.current
      && state.staged.length + 2 <= limit;
  }
  // Append the edited current image to the staged list (current is unchanged).
  function stageCurrent(state, editedDataUrl, sourceType, max) {
    const limit = max || MAX;
    if (state.staged.length + 1 >= limit) return { state, added: false, capped: true };
    const r = VB.addImage(state.staged, { dataUrl: editedDataUrl, sourceType }, limit);
    if (!r.added) return { state, added: false, capped: r.capped };
    return { state: Object.assign({}, state, { staged: r.batch }), added: true, capped: false };
  }
  function loadCurrent(state, item) {
    return Object.assign({}, state, { mode: 'fresh', current: normItem(item), sent: false });
  }
  function removeStaged(state, id) {
    return Object.assign({}, state, { staged: VB.removeImage(state.staged, id) });
  }
  function closeKeepStaged(state) {
    return { mode: 'closed', staged: state.staged, current: null, busy: false, sent: false };
  }
  function discard() { return createState(); }
  function markSent(state) { return Object.assign({}, state, { staged: [], sent: true, busy: false }); }
  function setBusy(state, on) { return Object.assign({}, state, { busy: !!on }); }

  // Assemble the single vision request: staged in order, then the current image.
  function imagesToSend(state, currentDataUrl, max) {
    const limit = max || MAX;
    const bad = (error) => ({ ok: false, images: [], source_types: [], count: 0, error });
    if (typeof currentDataUrl !== 'string' || !currentDataUrl) return bad('No image to send.');
    const total = state.staged.length + 1;
    if (total > limit) return bad(fullMessage(limit));
    const curType = (state.current && state.current.sourceType) || 'screenshot-full';
    return {
      ok: true,
      images: state.staged.map((s) => s.dataUrl).concat([currentDataUrl]),
      source_types: state.staged.map((s) => s.sourceType).concat([curType]),
      count: total,
      error: '',
    };
  }
  function normalizeLastMode(v) { return VB.normalizeMode(v); }
  function sendLabel(count) {
    return count <= 1 ? 'Get solution from image' : 'Get solution (' + count + ' images)';
  }
  function countLabel(state) {
    const n = state.staged.length;
    return n + ' staged + current (' + (n + 1) + ' of ' + MAX + ')';
  }

  const api = {
    STORAGE_KEY, createState, onCapture, canStage, stageCurrent, loadCurrent, removeStaged,
    closeKeepStaged, discard, markSent, setBusy, imagesToSend, normalizeLastMode, sendLabel, countLabel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.CaptureFlow = api;
})();
