// vision-batch.js — pure helpers for the "send screenshots directly to OpenAI"
// batch (no DOM, no Node-only APIs). Loaded by index.html via <script> (attaches
// window.VisionBatch) and by node tests via require().
(function () {
  'use strict';
  const MAX_BATCH = 6;
  let counter = 0;

  function createBatch() { return []; }
  function clearBatch() { return []; }
  function isFull(batch, max) { return batch.length >= (max || MAX_BATCH); }

  // Immutable add. Returns { batch, added, capped }.
  function addImage(batch, item, max) {
    const limit = max || MAX_BATCH;
    const list = Array.isArray(batch) ? batch : [];
    if (!item || typeof item.dataUrl !== 'string' || !item.dataUrl) {
      return { batch: list, added: false, capped: false };
    }
    if (list.length >= limit) return { batch: list, added: false, capped: true };
    counter += 1;
    const entry = { id: 'vb' + counter, dataUrl: item.dataUrl, sourceType: item.sourceType || 'screenshot-full' };
    return { batch: list.concat([entry]), added: true, capped: false };
  }

  function removeImage(batch, id) { return batch.filter((b) => b.id !== id); }

  function normalizeMode(m) { return (m === 'coding' || m === 'scenario') ? m : 'generic'; }
  function normalizeCaptureMode(m) { return m === 'vision' ? 'vision' : 'ocr'; }

  function buildVisionRequest(batch, mode) {
    return {
      images: batch.map((b) => b.dataUrl),
      source_types: batch.map((b) => b.sourceType),
      mode: normalizeMode(mode),
    };
  }

  function batchLabel(n) { return n === 1 ? '1 image' : n + ' images'; }

  const api = {
    MAX_BATCH, createBatch, clearBatch, isFull, addImage, removeImage,
    normalizeMode, normalizeCaptureMode, buildVisionRequest, batchLabel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.VisionBatch = api;
})();
