// stealth-ui.js — pure helpers for the stealth-safe UI layer (no DOM, no Node-only
// APIs). Loaded by index.html via <script> (attaches window.StealthUI), by main.js
// and by node tests via require().
(function () {
  'use strict';

  const MIN_RESIZE = { width: 380, height: 300 };

  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

  // ── Tooltips ──────────────────────────────────────────────────────────────
  // Decide how to convert a native `title` attribute into a data-tip. `text` is
  // the element's textContent. Glyph-only controls ("✕", "—", emoji) have no
  // letters/digits, so they get the old title as aria-label (unless they have one).
  function decideTitleConversion(input) {
    const o = input || {};
    const title = str(o.title).trim();
    if (!title) return { removeTitle: true, tip: null, ariaLabel: null };
    const tip = str(o.tip).trim() || title;
    const hasVisibleText = /[\p{L}\p{N}]/u.test(str(o.text));
    const hasAria = str(o.ariaLabel).trim() !== '';
    return { removeTitle: true, tip, ariaLabel: !hasAria && !hasVisibleText ? title : null };
  }

  // Place a tooltip below its anchor (flip above on overflow), clamped to the viewport.
  function tooltipPosition(o) {
    const a = o.anchor, t = o.tip, vp = o.viewport;
    const gap = num(o.gap, 8), pad = num(o.pad, 6);
    let placement = 'below';
    let top = a.bottom + gap;
    if (top + t.height + pad > vp.height) {
      const above = a.top - gap - t.height;
      if (above >= pad) { top = above; placement = 'above'; }
    }
    let left = a.left + (a.right - a.left) / 2 - t.width / 2;
    left = clamp(left, pad, vp.width - t.width - pad);
    top = clamp(top, pad, vp.height - t.height - pad);
    return { left: Math.round(left), top: Math.round(top), placement };
  }

  // Place a dropdown list under (or above) its trigger; long lists scroll via maxHeight.
  function dropdownPosition(o) {
    const a = o.anchor, vp = o.viewport;
    const gap = num(o.gap, 4), pad = num(o.pad, 6), cap = num(o.maxHeightCap, 240);
    const content = num(o.contentHeight, 0);
    const width = Math.max(a.right - a.left, num(o.minWidth, 0));
    const below = vp.height - a.bottom - gap - pad;
    const above = a.top - gap - pad;
    const need = Math.min(content, 120);
    const placeBelow = below >= need || below >= above;
    const room = Math.max(0, placeBelow ? below : above);
    const maxHeight = Math.max(0, Math.min(cap, room));
    const height = Math.min(content, maxHeight);
    const top = placeBelow ? a.bottom + gap : a.top - gap - height;
    const left = clamp(a.left, pad, vp.width - width - pad);
    return {
      left: Math.round(left), top: Math.round(Math.max(pad, top)), width: Math.round(width),
      maxHeight: Math.round(maxHeight), placement: placeBelow ? 'below' : 'above',
    };
  }

  // ── Dropdown option sync ──────────────────────────────────────────────────
  function snapshotOptions(optionLikes, selectValue, selectDisabled) {
    const list = Array.prototype.slice.call(optionLikes || []);
    const items = list.map((o) => ({
      value: str(o.value),
      label: str(o.label != null && o.label !== '' ? o.label : o.textContent),
      disabled: !!o.disabled,
    }));
    let selectedIndex = -1;
    if (selectValue != null) selectedIndex = items.findIndex((it) => it.value === String(selectValue));
    if (selectedIndex < 0) selectedIndex = list.findIndex((o) => !!o.selected);
    if (selectedIndex < 0 && items.length) selectedIndex = 0;
    return { items, selectedIndex, disabled: !!selectDisabled };
  }

  function optionsEqual(a, b) {
    if (!a || !b) return a === b;
    if (a.selectedIndex !== b.selectedIndex || a.disabled !== b.disabled) return false;
    if (a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) {
      const x = a.items[i], y = b.items[i];
      if (x.value !== y.value || x.label !== y.label || x.disabled !== y.disabled) return false;
    }
    return true;
  }

  // Keyboard navigation over enabled items; clamps at the ends (no wrap).
  function nextIndex(items, current, key) {
    const enabled = [];
    items.forEach((it, i) => { if (!it.disabled) enabled.push(i); });
    if (!enabled.length) return -1;
    if (key === 'Home') return enabled[0];
    if (key === 'End') return enabled[enabled.length - 1];
    if (key === 'ArrowDown') {
      const n = enabled.find((i) => i > current);
      return n === undefined ? (enabled.includes(current) ? current : enabled[enabled.length - 1]) : n;
    }
    if (key === 'ArrowUp') {
      let p;
      enabled.forEach((i) => { if (i < current) p = i; });
      return p === undefined ? (enabled.includes(current) ? current : enabled[0]) : p;
    }
    return current;
  }

  // Prefix type-ahead over enabled items; starts after `current`, wraps. -1 if none.
  function typeaheadIndex(items, current, buffer) {
    const q = str(buffer).toLowerCase();
    if (!q) return -1;
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const i = (current + k + n) % n;
      if (!items[i].disabled && items[i].label.toLowerCase().indexOf(q) === 0) return i;
    }
    return -1;
  }

  // ── Window resize (also used by main.js) ──────────────────────────────────
  // Top-left stays fixed; size = start size + cursor delta, clamped to the minimum
  // and to the display work area.
  function clampResize(o) {
    const s = o.start, wa = o.workArea, min = o.min || MIN_RESIZE;
    const dx = num(o.dx, 0), dy = num(o.dy, 0);
    const maxW = Math.max(min.width, wa.x + wa.width - s.x);
    const maxH = Math.max(min.height, wa.y + wa.height - s.y);
    return {
      x: s.x, y: s.y,
      width: Math.round(clamp(s.width + dx, min.width, maxW)),
      height: Math.round(clamp(s.height + dy, min.height, maxH)),
    };
  }

  const api = {
    MIN_RESIZE, decideTitleConversion, tooltipPosition, dropdownPosition,
    snapshotOptions, optionsEqual, nextIndex, typeaheadIndex, clampResize,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.StealthUI = api;
})();
