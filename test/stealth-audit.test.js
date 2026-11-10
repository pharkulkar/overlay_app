// test/stealth-audit.test.js — regression guard for the stealth-safe UI.
//
// content protection (setContentProtection) hides what is drawn INSIDE our windows,
// but OS-drawn surfaces still leak to a screen-share viewer: cursor shape, native
// title tooltips, native <select> popups, native confirm/alert/prompt, window-edge
// resize cursors. This file (1) unit-tests the pure helpers in stealth-ui.js and
// (2) statically audits index.html, selection.html, main.js and preload.js.
//
//   Run:  node test/stealth-audit.test.js   (or: npm test)
//   Set STEALTH_AUDIT_DIR to audit a scratch copy of the files instead of the repo.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const SU = require('../stealth-ui.js');

const ROOT = process.env.STEALTH_AUDIT_DIR || path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  \u2713 ' + name); }
  catch (e) { failed++; failures.push({ name, e }); console.log('  \u2717 ' + name + '\n      ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Comment stripping (so rules never fire on commented-out code)
// ═══════════════════════════════════════════════════════════════════════════

// Remove // and /* */ comments from JS-like text. Respects '...', "..." and `...`
// literals so "http://x" or '/*' inside strings survive. blankStrings=true also
// empties '...' and "..." literals (template literals are kept: they hold markup).
function stripJs(code, blankStrings) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === q) break;
        if (code[j] === '\n' && q !== '`') break;   // unterminated (e.g. a regex literal quote)
        j++;
      }
      const body = code.slice(i + 1, j);
      out += (blankStrings && q !== '`') ? q + q : q + body + q;
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ');

// Split an HTML file into { markup, css, js, jsNoStr, scripts } with comments removed.
function splitHtml(html) {
  const clean = stripHtmlComments(html);
  const css = [], scripts = [];
  const markup = clean
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, body) => { css.push(stripCss(body)); return '<style></style>'; })
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
      if (!/\bsrc\s*=/.test(attrs)) scripts.push(body);
      return '<script' + attrs + '></script>';
    });
  return {
    markup,
    css: css.join('\n'),
    scripts,
    js: scripts.map((s) => stripJs(s, false)).join('\n'),
    jsNoStr: scripts.map((s) => stripJs(s, true)).join('\n'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. The audit
// ═══════════════════════════════════════════════════════════════════════════

const GLOBAL_CURSOR_RE = /^\s*\*\s*,\s*\*::before\s*,\s*\*::after\s*\{\s*cursor\s*:\s*default\s*!important\s*;?\s*\}/;
const BAD_CURSOR_RE = /(^|[^\w-])cursor\s*:\s*(?!default\b)/;

// files: { indexHtml, selectionHtml, mainJs, preloadJs, rendererJs: { name: source } }
// -> [{ file, rule, message }]
function runAudit(files) {
  const v = [];
  const add = (file, rule, message) => v.push({ file, rule, message });

  const index = splitHtml(files.indexHtml);
  const selection = splitHtml(files.selectionHtml);
  const main = stripJs(files.mainJs, false);
  const mainNoStr = stripJs(files.mainJs, true);
  const preload = stripJs(files.preloadJs, false);
  const renderer = {};   // name -> { js, jsNoStr }
  Object.keys(files.rendererJs || {}).forEach((k) => {
    renderer[k] = { js: stripJs(files.rendererJs[k], false), jsNoStr: stripJs(files.rendererJs[k], true) };
  });
  // Every piece of renderer-side JS, with (js) and without (jsNoStr) string contents.
  const rendererAll = [{ name: 'index.html', js: index.js, jsNoStr: index.jsNoStr }]
    .concat([{ name: 'selection.html', js: selection.js, jsNoStr: selection.jsNoStr }])
    .concat(Object.keys(renderer).map((k) => ({ name: k, js: renderer[k].js, jsNoStr: renderer[k].jsNoStr })));

  // ── cursor ──
  [['index.html', index], ['selection.html', selection]].forEach(([name, h]) => {
    const firstCss = h.css.trim();
    if (!GLOBAL_CURSOR_RE.test(firstCss)) {
      add(name, 'cursor-global', 'the first stylesheet rule must be `*, *::before, *::after { cursor: default !important; }`');
    }
    const cssWithoutGlobal = h.css.replace(GLOBAL_CURSOR_RE, '');
    if (BAD_CURSOR_RE.test(cssWithoutGlobal)) {
      add(name, 'cursor-css', 'a CSS rule sets a non-default cursor (the OS draws it outside content protection)');
    }
    const inlineStyles = (h.markup.match(/\sstyle\s*=\s*"[^"]*"/g) || []).join('\n');
    if (BAD_CURSOR_RE.test(inlineStyles)) add(name, 'cursor-inline', 'an inline style="" sets a non-default cursor');
    if (BAD_CURSOR_RE.test(h.js)) add(name, 'cursor-js-string', 'script text (e.g. a cssText string) sets a non-default cursor');
  });
  rendererAll.forEach((r) => {
    if (/\.cursor\s*=(?!=)/.test(r.jsNoStr) || /setProperty\(\s*['"]cursor['"]/.test(r.js)) {
      add(r.name, 'cursor-assign', 'JS assigns style.cursor / setProperty("cursor")');
    }
  });

  // ── titles (native tooltips) ──
  const TAG_TITLE_RE = /<[a-zA-Z][^<>]*?\stitle\s*=/;
  [['index.html', index], ['selection.html', selection]].forEach(([name, h]) => {
    if (TAG_TITLE_RE.test(h.markup)) add(name, 'title-attr', 'a markup element has a title= attribute (native tooltip)');
    if (TAG_TITLE_RE.test(h.js)) add(name, 'title-attr-js', 'script markup (template string) has a title= attribute');
  });
  rendererAll.forEach((r) => {
    if (/\.title\s*=(?!=)/.test(r.jsNoStr)) add(r.name, 'title-prop', 'JS assigns .title = (native tooltip)');
    if (/setAttribute\(\s*['"]title['"]/.test(r.js)) add(r.name, 'title-setattr', 'JS calls setAttribute("title", ...)');
  });
  if (!/attributeFilter\s*:\s*\[\s*['"]title['"]\s*\]/.test(index.js)) {
    add('index.html', 'title-observer', 'missing MutationObserver with attributeFilter: ["title"] (late nodes would keep native tooltips)');
  }
  if ((index.js.match(/removeAttribute\(\s*['"]title['"]\s*\)/g) || []).length !== 1) {
    add('index.html', 'title-single-converter', 'there must be exactly one place that converts title -> data-tip');
  }
  if (!/data-tip/.test(index.markup + index.js)) add('index.html', 'title-data-tip', 'no data-tip tooltips found');

  // ── native <select> popups ──
  (index.markup.match(/<select\b[^>]*>/gi) || []).forEach((tag) => {
    if (!/\bdata-sd-select\b/.test(tag)) add('index.html', 'select-native', 'native <select> not marked data-sd-select: ' + tag);
  });
  (selection.markup.match(/<select\b/gi) || []).forEach(() => add('selection.html', 'select-native', 'native <select>'));
  if (!/function\s+enhanceSelect\s*\(/.test(index.js) || !/\.forEach\(\s*enhanceSelect\s*\)/.test(index.js)) {
    add('index.html', 'select-enhancer', 'enhanceSelect is not defined and applied to every <select>');
  }
  if (!/data-enhanced|dataset\.enhanced/.test(index.js)) add('index.html', 'select-enhanced-mark', 'enhanced selects are not marked');
  rendererAll.forEach((r) => {
    const n = (r.js.match(/createElement\(\s*['"]select['"]\s*\)/g) || []).length;
    if (n) add(r.name, 'select-created', 'JS creates a <select> (would show a native popup)');
  });

  // ── native dialogs / menus / notifications ──
  const DIALOG_RE = /(^|[^.\w$])(confirm|alert|prompt)\s*\(/;
  rendererAll.forEach((r) => {
    if (DIALOG_RE.test(r.jsNoStr) || /\bwindow\s*\.\s*(confirm|alert|prompt)\s*\(/.test(r.jsNoStr)) {
      add(r.name, 'native-dialog', 'active confirm( / alert( / prompt( call (native dialog is not content-protected)');
    }
    if (/\bnew\s+Notification\s*\(/.test(r.jsNoStr)) add(r.name, 'notification', 'renderer creates a native Notification');
  });
  [['main.js', mainNoStr], ['preload.js', stripJs(files.preloadJs, true)]].forEach(([name, src]) => {
    if (/\bdialog\s*\./.test(src)) add(name, 'main-dialog', 'uses electron dialog.* (native, not content-protected)');
    if (/Menu\s*\.\s*buildFromTemplate|\.popup\s*\(/.test(src)) add(name, 'main-menu', 'native menu / popup');
    if (/\bnew\s+Notification\s*\(/.test(src)) add(name, 'main-notification', 'native Notification');
    if (/\bshell\s*\./.test(src)) add(name, 'main-shell', 'shell.* call (opens external surfaces)');
  });

  // ── file input / other native pickers ──
  const fileInputs = index.markup.match(/<input\b[^>]*\btype\s*=\s*["']?file["']?[^>]*>/gi) || [];
  if (fileInputs.length !== 1 || !/\bid\s*=\s*["']iv-cv-input["']/.test(fileInputs[0] || '')) {
    add('index.html', 'file-input', 'exactly one <input type="file"> (id="iv-cv-input") is allowed; found ' + fileInputs.length);
  }
  [['index.html', index], ['selection.html', selection]].forEach(([name, h]) => {
    if (/<input\b[^>]*\btype\s*=\s*["']?(date|time|datetime-local|month|week|color)\b/i.test(h.markup + h.js)) {
      add(name, 'native-input-type', 'native date/time/color picker input');
    }
    if (/<datalist\b/i.test(h.markup + h.js)) add(name, 'datalist', '<datalist> shows a native suggestion popup');
  });

  // ── navigation / external surfaces ──
  [['index.html', index], ['selection.html', selection]].forEach(([name, h]) => {
    if (/<a\b[^>]*\bhref/i.test(h.markup + h.js)) add(name, 'anchor-href', '<a href> could navigate or open externally');
    if (/<(iframe|webview|embed|object)\b/i.test(h.markup + h.js)) add(name, 'embed', 'iframe/webview/embed/object');
  });
  rendererAll.forEach((r) => {
    if (/\bwindow\s*\.\s*open\s*\(/.test(r.jsNoStr)) add(r.name, 'window-open', 'window.open( opens a new native window');
    if (/\blocation\s*\.\s*href\s*=(?!=)/.test(r.jsNoStr)) add(r.name, 'location-href', 'location.href assignment navigates');
  });

  // ── windows ──
  if (/resizable\s*:\s*true/.test(main) || /setResizable\s*\(\s*true\s*\)/.test(main)) {
    add('main.js', 'resizable-true', 'a window is resizable (OS draws edge-resize cursors outside content protection)');
  }
  const winRe = /(\w+)\s*=\s*new\s+BrowserWindow\s*\(/g;
  let wm;
  const winNames = [];
  while ((wm = winRe.exec(main))) winNames.push({ name: wm[1], index: wm.index });
  if (!winNames.length) add('main.js', 'windows', 'no BrowserWindow found');
  winNames.forEach((w) => {
    if (!new RegExp('\\b' + w.name + '\\s*\\.\\s*setContentProtection\\s*\\(\\s*true\\s*\\)').test(main)) {
      add('main.js', 'content-protection', w.name + ' is a BrowserWindow without setContentProtection(true)');
    }
  });
  if ((main.match(/new\s+BrowserWindow\s*\(/g) || []).length !== winNames.length) {
    add('main.js', 'windows', 'a BrowserWindow is created without being assigned to a named variable');
  }
  ['overlayWindow', 'selectionWindow'].forEach((nm) => {
    if (!new RegExp('\\b' + nm + '\\s*\\.\\s*setContentProtection\\s*\\(\\s*true\\s*\\)').test(main)) {
      add('main.js', 'content-protection', nm + '.setContentProtection(true) is missing');
    }
  });
  const ov = winNames.find((w) => w.name === 'overlayWindow');
  if (ov) {
    const opts = main.slice(ov.index, main.indexOf('});', ov.index));
    if (!/resizable\s*:\s*false/.test(opts)) add('main.js', 'overlay-resizable', 'overlay BrowserWindow must set resizable: false');
  } else {
    add('main.js', 'windows', 'overlayWindow BrowserWindow not found');
  }

  // ── preload sandbox ──
  (preload.match(/\brequire\s*\(\s*[^)]*\)/g) || []).forEach((call) => {
    if (!/^require\s*\(\s*['"]electron['"]\s*\)$/.test(call.trim())) {
      add('preload.js', 'preload-sandbox', 'sandboxed preload may only require("electron"): ' + call);
    }
  });

  return v;
}

function readRealFiles() {
  const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const rendererJs = {};
  ['audio.js', 'interview.js', 'ux-helpers.js', 'vision-batch.js', 'solution-format.js', 'stealth-ui.js'].forEach((f) => {
    if (fs.existsSync(path.join(ROOT, f))) rendererJs[f] = rd(f);
  });
  return {
    indexHtml: rd('index.html'), selectionHtml: rd('selection.html'),
    mainJs: rd('main.js'), preloadJs: rd('preload.js'), rendererJs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Unit tests: stealth-ui.js
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nStealthUI helpers');

test('decideTitleConversion: empty / whitespace title just removes the attribute', () => {
  assert.deepStrictEqual(SU.decideTitleConversion({ title: '', text: 'Go' }), { removeTitle: true, tip: null, ariaLabel: null });
  assert.deepStrictEqual(SU.decideTitleConversion({ title: '   ', text: 'Go' }), { removeTitle: true, tip: null, ariaLabel: null });
  assert.deepStrictEqual(SU.decideTitleConversion({}), { removeTitle: true, tip: null, ariaLabel: null });
});
test('decideTitleConversion: text button keeps no aria-label', () => {
  const d = SU.decideTitleConversion({ title: ' Ask OpenAI ', text: '➤ Ask' });
  assert.deepStrictEqual(d, { removeTitle: true, tip: 'Ask OpenAI', ariaLabel: null });
});
test('decideTitleConversion: glyph-only / emoji-only controls get aria-label', () => {
  ['✕', '—', '×', '⚙︎', '💾', ''].forEach((text) => {
    const d = SU.decideTitleConversion({ title: 'Close', text });
    assert.strictEqual(d.ariaLabel, 'Close', 'text=' + JSON.stringify(text));
  });
});
test('decideTitleConversion: existing aria-label and data-tip are preserved', () => {
  const d = SU.decideTitleConversion({ title: 'Old', tip: 'Keep me', ariaLabel: 'Mine', text: '✕' });
  assert.deepStrictEqual(d, { removeTitle: true, tip: 'Keep me', ariaLabel: null });
});
test('decideTitleConversion: digits and non-latin letters count as visible text', () => {
  assert.strictEqual(SU.decideTitleConversion({ title: 'x', text: '3' }).ariaLabel, null);
  assert.strictEqual(SU.decideTitleConversion({ title: 'x', text: '日本' }).ariaLabel, null);
});

test('tooltipPosition: below and centered when there is room', () => {
  const p = SU.tooltipPosition({ anchor: { left: 100, top: 100, right: 160, bottom: 120 }, tip: { width: 80, height: 24 }, viewport: { width: 800, height: 600 } });
  assert.deepStrictEqual(p, { left: 90, top: 128, placement: 'below' });
});
test('tooltipPosition: flips above near the bottom edge', () => {
  const p = SU.tooltipPosition({ anchor: { left: 100, top: 570, right: 160, bottom: 590 }, tip: { width: 80, height: 24 }, viewport: { width: 800, height: 600 } });
  assert.strictEqual(p.placement, 'above');
  assert.strictEqual(p.top, 570 - 8 - 24);
});
test('tooltipPosition: clamps inside the window at left/right edges', () => {
  const vp = { width: 400, height: 300 };
  const l = SU.tooltipPosition({ anchor: { left: 0, top: 10, right: 10, bottom: 30 }, tip: { width: 120, height: 20 }, viewport: vp });
  assert.strictEqual(l.left, 6);
  const r = SU.tooltipPosition({ anchor: { left: 390, top: 10, right: 400, bottom: 30 }, tip: { width: 120, height: 20 }, viewport: vp });
  assert.strictEqual(r.left, 400 - 120 - 6);
});
test('tooltipPosition: tip larger than the viewport stays clamped to the padding', () => {
  const p = SU.tooltipPosition({ anchor: { left: 5, top: 5, right: 15, bottom: 15 }, tip: { width: 500, height: 400 }, viewport: { width: 300, height: 200 } });
  assert.strictEqual(p.left, 6);
  assert.strictEqual(p.top, 6);
});

test('dropdownPosition: few options open below at anchor width', () => {
  const p = SU.dropdownPosition({ anchor: { left: 50, top: 40, right: 150, bottom: 64 }, contentHeight: 100, viewport: { width: 600, height: 500 }, minWidth: 80 });
  assert.strictEqual(p.placement, 'below');
  assert.strictEqual(p.top, 68);
  assert.strictEqual(p.width, 100);
  assert.strictEqual(p.maxHeight, 240);
});
test('dropdownPosition: anchor near the bottom opens above', () => {
  const p = SU.dropdownPosition({ anchor: { left: 50, top: 460, right: 150, bottom: 484 }, contentHeight: 150, viewport: { width: 600, height: 500 } });
  assert.strictEqual(p.placement, 'above');
  assert.ok(p.top + 150 <= 460 - 4 + 0.5, 'list ends above the anchor');
});
test('dropdownPosition: long lists are capped so they scroll', () => {
  const p = SU.dropdownPosition({ anchor: { left: 10, top: 10, right: 110, bottom: 34 }, contentHeight: 2000, viewport: { width: 600, height: 900 } });
  assert.strictEqual(p.maxHeight, 240);
  const small = SU.dropdownPosition({ anchor: { left: 10, top: 10, right: 110, bottom: 34 }, contentHeight: 2000, viewport: { width: 600, height: 150 } });
  assert.ok(small.maxHeight <= 150 - 34 - 4 - 6);
});
test('dropdownPosition: clamped inside the window horizontally and honors minWidth', () => {
  const p = SU.dropdownPosition({ anchor: { left: 560, top: 10, right: 590, bottom: 30 }, contentHeight: 50, viewport: { width: 600, height: 400 }, minWidth: 120 });
  assert.strictEqual(p.width, 120);
  assert.strictEqual(p.left, 600 - 120 - 6);
});

const opt = (value, textContent, extra) => Object.assign({ value, textContent, disabled: false, selected: false }, extra || {});
test('snapshotOptions: selects by value, else first selected, else 0, else -1', () => {
  const opts = [opt('a', 'A'), opt('b', 'B', { selected: true }), opt('c', 'C')];
  assert.strictEqual(SU.snapshotOptions(opts, 'c', false).selectedIndex, 2);
  assert.strictEqual(SU.snapshotOptions(opts, 'zzz', false).selectedIndex, 1);
  assert.strictEqual(SU.snapshotOptions([opt('a', 'A'), opt('b', 'B')], 'zzz', false).selectedIndex, 0);
  assert.strictEqual(SU.snapshotOptions([], '', false).selectedIndex, -1);
});
test('snapshotOptions: empty-string value matches the "(none)" option; label wins over text', () => {
  const s = SU.snapshotOptions([opt('', '(none)'), opt('id1', 'x', { label: 'Mic 1' })], '', true);
  assert.strictEqual(s.selectedIndex, 0);
  assert.strictEqual(s.items[1].label, 'Mic 1');
  assert.strictEqual(s.disabled, true);
});
test('optionsEqual: detects repopulated device lists and skips no-ops', () => {
  const a = SU.snapshotOptions([opt('', '(none)'), opt('d1', 'Mic')], 'd1', false);
  const same = SU.snapshotOptions([opt('', '(none)'), opt('d1', 'Mic')], 'd1', false);
  assert.ok(SU.optionsEqual(a, same));
  assert.ok(!SU.optionsEqual(a, SU.snapshotOptions([opt('', '(none)'), opt('d2', 'Mic')], 'd2', false)), 'value changed');
  assert.ok(!SU.optionsEqual(a, SU.snapshotOptions([opt('', '(none)'), opt('d1', 'Mic'), opt('d3', 'Cam')], 'd1', false)), 'length changed');
  assert.ok(!SU.optionsEqual(a, SU.snapshotOptions([opt('', '(none)'), opt('d1', 'Mic')], '', false)), 'selection changed');
  assert.ok(!SU.optionsEqual(a, SU.snapshotOptions([opt('', '(none)'), opt('d1', 'Mic')], 'd1', true)), 'disabled changed');
  assert.ok(!SU.optionsEqual(null, a));
  assert.ok(SU.optionsEqual(null, null));
});

test('nextIndex: skips disabled items and clamps at the ends (no wrap)', () => {
  const items = [{ disabled: false }, { disabled: true }, { disabled: false }, { disabled: false }];
  assert.strictEqual(SU.nextIndex(items, 0, 'ArrowDown'), 2);
  assert.strictEqual(SU.nextIndex(items, 3, 'ArrowDown'), 3);
  assert.strictEqual(SU.nextIndex(items, 2, 'ArrowUp'), 0);
  assert.strictEqual(SU.nextIndex(items, 0, 'ArrowUp'), 0);
  assert.strictEqual(SU.nextIndex(items, 2, 'Home'), 0);
  assert.strictEqual(SU.nextIndex(items, 0, 'End'), 3);
  assert.strictEqual(SU.nextIndex([{ disabled: true }], 0, 'ArrowDown'), -1);
  assert.strictEqual(SU.nextIndex(items, -1, 'ArrowDown'), 0);
});
test('typeaheadIndex: prefix match, case-insensitive, skips disabled, wraps', () => {
  const items = [{ label: 'Concise', disabled: false }, { label: 'Casual', disabled: true }, { label: 'Detailed', disabled: false }, { label: 'Casual 2', disabled: false }];
  assert.strictEqual(SU.typeaheadIndex(items, 0, 'd'), 2);
  assert.strictEqual(SU.typeaheadIndex(items, 0, 'ca'), 3);
  assert.strictEqual(SU.typeaheadIndex(items, 2, 'CON'), 0);
  assert.strictEqual(SU.typeaheadIndex(items, 0, 'zz'), -1);
  assert.strictEqual(SU.typeaheadIndex(items, 0, ''), -1);
});

const WA = { x: 0, y: 0, width: 1440, height: 900 };
test('clampResize: size = start + delta with a fixed top-left', () => {
  const r = SU.clampResize({ start: { x: 100, y: 50, width: 800, height: 600 }, dx: 120, dy: 40, workArea: WA, min: SU.MIN_RESIZE });
  assert.deepStrictEqual(r, { x: 100, y: 50, width: 920, height: 640 });
});
test('clampResize: clamps to the minimum size (negative deltas)', () => {
  const r = SU.clampResize({ start: { x: 0, y: 0, width: 800, height: 600 }, dx: -5000, dy: -5000, workArea: WA, min: SU.MIN_RESIZE });
  assert.strictEqual(r.width, 380);
  assert.strictEqual(r.height, 300);
  assert.deepStrictEqual(SU.MIN_RESIZE, { width: 380, height: 300 });
});
test('clampResize: clamps to the display work area', () => {
  const r = SU.clampResize({ start: { x: 1000, y: 500, width: 300, height: 100 }, dx: 9999, dy: 9999, workArea: WA, min: SU.MIN_RESIZE });
  assert.strictEqual(r.width, 440);    // 1440 - 1000
  assert.strictEqual(r.height, 400);   // 900 - 500
});
test('clampResize: a window already beyond the work area is held at the minimum, not shrunk to nothing', () => {
  const r = SU.clampResize({ start: { x: 1400, y: 880, width: 600, height: 500 }, dx: 0, dy: 0, workArea: WA, min: SU.MIN_RESIZE });
  assert.strictEqual(r.width, 380);
  assert.strictEqual(r.height, 300);
});
test('clampResize: non-finite deltas are treated as 0 and results are integers', () => {
  const r = SU.clampResize({ start: { x: 0, y: 0, width: 700.4, height: 500.6 }, dx: NaN, dy: Infinity, workArea: WA, min: SU.MIN_RESIZE });
  assert.strictEqual(r.width, 700);
  assert.ok(Number.isInteger(r.height));
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Audit self-tests (each rule must actually fire on a bad snippet)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nAudit patterns');

const real = readRealFiles();
const rules = (violations) => violations.map((x) => x.rule);
function mutate(patch) {
  const f = Object.assign({}, real, { rendererJs: Object.assign({}, real.rendererJs) });
  patch(f);
  return runAudit(f);
}

test('comment stripping keeps live tokens and drops commented-out code', () => {
  const js = stripJs("const a = 'http://x.test'; // confirm('x')\n/* alert(1) */ confirm2('/* not a comment */');\n", true);
  assert.ok(!/confirm\('x'\)/.test(js) && !/alert/.test(js));
  assert.ok(/confirm2/.test(js));
  const main = stripJs(real.mainJs, false);
  assert.ok(/setContentProtection\(true\)/.test(main));
  assert.ok(!/\/\/ \[OCR-DISABLED\]/.test(main));
  const idx = splitHtml(real.indexHtml);
  assert.ok(/id="overlay-card"/.test(idx.markup));
  assert.ok(!/id="btn-settings"/.test(idx.markup), 'HTML comments are stripped');
  assert.ok(/contextBridge\.exposeInMainWorld/.test(stripJs(real.preloadJs, false)));
});

test('self-test: baseline real files produce no violations (sanity for the mutations below)', () => {
  assert.deepStrictEqual(runAudit(real).map((x) => x.rule), []);
});
test('self-test: missing global cursor rule is reported (both files)', () => {
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace(/\*, \*::before, \*::after \{ cursor: default !important; \}/, ''); })).includes('cursor-global'));
  assert.ok(rules(mutate((f) => { f.selectionHtml = f.selectionHtml.replace(/\*, \*::before, \*::after \{ cursor: default !important; \}/, ''); })).includes('cursor-global'));
});
test('self-test: cursor:pointer in CSS / inline style / cssText / style.cursor is reported', () => {
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('.hidden { display: none !important; }', '.hidden { display: none !important; } .x { cursor: pointer; }'); })).includes('cursor-css'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('id="ocr-input"', 'id="ocr-input" style="cursor:pointer"'); })).includes('cursor-inline'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', "const api = window.electronAPI || {}; document.body.style.cssText = 'cursor:pointer;';"); })).includes('cursor-js-string'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; document.body.style.cursor = "wait";'); })).includes('cursor-assign'));
  assert.ok(rules(mutate((f) => { f.selectionHtml = f.selectionHtml.replace('user-select: none;', 'user-select: none; cursor: crosshair;'); })).includes('cursor-css'));
});
test('self-test: title= attribute / .title = / setAttribute("title") are reported; comments are not', () => {
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('id="btn-ask"', 'id="btn-ask" title="x"'); })).includes('title-attr'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; document.body.title = "x";'); })).includes('title-prop'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; document.body.setAttribute("title", "x");'); })).includes('title-setattr'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('data-tip="Edit"', 'title="Edit"'); })).includes('title-attr-js'));
  assert.deepStrictEqual(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('<title>', '<!-- <b title="x"> --><title>'); })), []);
  assert.deepStrictEqual(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; // el.title = "x"'); })), []);
});
test('self-test: a native <select> (unmarked or created in JS) is reported', () => {
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('<textarea id="ocr-input"', '<select id="x"></select><textarea id="ocr-input"'); })).includes('select-native'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; document.createElement("select");'); })).includes('select-created'));
});
test('self-test: confirm( / alert( / prompt( are reported; overlayConfirm( and comments are not', () => {
  ['confirm', 'alert', 'prompt'].forEach((fn) => {
    assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; ' + fn + '("x");'); })).includes('native-dialog'), fn);
  });
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; window.confirm("x");'); })).includes('native-dialog'));
  assert.deepStrictEqual(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; // confirm("x")\n overlayConfirm("x");'); })), []);
});
test('self-test: resizable:true, setResizable(true) and a missing setContentProtection are reported', () => {
  assert.ok(rules(mutate((f) => { f.mainJs = f.mainJs.replace('resizable: false,\n    hasShadow', 'resizable: true,\n    hasShadow'); })).includes('resizable-true'));
  assert.ok(rules(mutate((f) => { f.mainJs = f.mainJs.replace('overlayWindow.setContentProtection(true);', ''); })).includes('content-protection'));
  assert.ok(rules(mutate((f) => { f.mainJs = f.mainJs.replace(/selectionWindow\.setContentProtection\(true\);/g, ''); })).includes('content-protection'));
  assert.ok(rules(mutate((f) => { f.mainJs += '\noverlayWindow.setResizable(true);\n'; })).includes('resizable-true'));
  assert.ok(rules(mutate((f) => { f.mainJs += '\nconst w3 = new BrowserWindow({});\n'; })).includes('content-protection'));
});
test('self-test: <a href>, window.open, extra file input, datalist and native pickers are reported', () => {
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('<body>', '<body><a href="https://x.test">x</a>'); })).includes('anchor-href'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('const api = window.electronAPI || {};', 'const api = window.electronAPI || {}; window.open("x");'); })).includes('window-open'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('<body>', '<body><input type="file" id="second">'); })).includes('file-input'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('<body>', '<body><input type="color">'); })).includes('native-input-type'));
  assert.ok(rules(mutate((f) => { f.indexHtml = f.indexHtml.replace('<body>', '<body><datalist id="d"></datalist>'); })).includes('datalist'));
});
test('self-test: preload requiring anything but electron is reported', () => {
  assert.ok(rules(mutate((f) => { f.preloadJs = "const fs = require('fs');\n" + f.preloadJs; })).includes('preload-sandbox'));
});
test('self-test: native dialog / menu / shell in main.js are reported', () => {
  assert.ok(rules(mutate((f) => { f.mainJs += "\ndialog.showMessageBox({});\n"; })).includes('main-dialog'));
  assert.ok(rules(mutate((f) => { f.mainJs += "\nMenu.buildFromTemplate([]);\n"; })).includes('main-menu'));
  assert.ok(rules(mutate((f) => { f.mainJs += "\nshell.openExternal('x');\n"; })).includes('main-shell'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The audit on the real files
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nStealth audit (real files in ' + ROOT + ')');

test('stealth audit: no violations in index.html / selection.html / main.js / preload.js', () => {
  const violations = runAudit(readRealFiles());
  assert.ok(violations.length === 0,
    violations.length + ' stealth violation(s):\n      ' + violations.map((x) => x.file + ': [' + x.rule + '] ' + x.message).join('\n      '));
});

test('every inline <script> in index.html and selection.html compiles', () => {
  ['index.html', 'selection.html'].forEach((f) => {
    const h = splitHtml(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.ok(h.scripts.length > 0, f + ' has inline scripts');
    h.scripts.forEach((code, i) => { new vm.Script(code, { filename: f + '#script' + i }); });
  });
});

test('every id referenced by active JS exists exactly once in the markup', () => {
  const problems = [];
  [['index.html'], ['selection.html']].forEach(([f]) => {
    const h = splitHtml(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const ids = {};
    (h.markup.match(/\sid\s*=\s*"([^"]+)"/g) || []).forEach((m) => {
      const id = m.replace(/^\s*id\s*=\s*"/, '').slice(0, -1);
      ids[id] = (ids[id] || 0) + 1;
    });
    const created = new Set();   // ids assigned at runtime (el.id = 'x')
    let m;
    const createdRe = /\.id\s*=\s*['"]([\w-]+)['"]/g;
    while ((m = createdRe.exec(h.js))) created.add(m[1]);
    const refs = new Set();
    const getRe = /getElementById\(\s*['"]([\w-]+)['"]\s*\)/g;
    while ((m = getRe.exec(h.js))) refs.add(m[1]);
    const qRe = /querySelector(?:All)?\(\s*(['"`])([^'"`]*)\1/g;
    while ((m = qRe.exec(h.js))) {
      const idRe = /#([A-Za-z_][\w-]*)/g;
      let k;
      while ((k = idRe.exec(m[2]))) refs.add(k[1]);
    }
    refs.forEach((id) => {
      const n = ids[id] || 0;
      if (created.has(id) && n === 0) return;
      if (n !== 1) problems.push(f + ': #' + id + ' appears ' + n + ' time(s) in the markup');
    });
    Object.keys(ids).forEach((id) => { if (ids[id] > 1) problems.push(f + ': duplicate id ' + id); });
  });
  assert.deepStrictEqual(problems, []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) {
  for (const f of failures) console.log('FAILED: ' + f.name + '\n' + (f.e.stack || f.e.message) + '\n');
  process.exit(1);
}
