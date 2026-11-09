# Implementation Plan: stealth-safe hover and interaction

Repo: `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app` (modify in place; no commits, no branch switches, no reverts of uncommitted work; never touch `screen_shot/`; never read or modify any `.env`).
Build/test commands (from `package.json`): `npm test` (currently `node test/interview.test.js`), `npm start` (`electron .`). Electron is `44.7.0`. There is no bundler and no linter. Tests are plain Node scripts with a hand-rolled `test(name, fn)` harness (see `test/interview.test.js` lines 42-48 and 382-386); I reuse that exact harness style.

Line numbers below are from the current working tree (uncommitted, includes the OCR-disable and vision work). They will shift as edits land, so locate by the quoted text, not by number.

## 0. Scan results (my own grep, not just the brief)

### 0.1 Cursor surfaces (all must go; global `cursor: default !important` wins, but every active non-default declaration is removed so the audit can forbid them)
`index.html` (19 declarations, matches the brief):
- L55 `.nav-btn` pointer; L63 `.icon-btn` pointer; L105 `.act-btn` pointer; L121 `.g-item` pointer; L131 `.g-del` pointer
- L148 `#floating-dot` pointer; L165 `#ctx-menu .ctx-item` pointer; L203 `.iv-langs > summary` pointer; L213 `.iv-langs-list label` pointer
- L283 `.g-act` pointer; L323 `#edit-canvas` crosshair; L355 `#settings-pop label, #vision-popup fieldset label` pointer (this rule sits inside an `[OCR-DISABLED]` CSS comment block starting ~L346, so it is inactive; leave it)
- L359 `#vision-popup fieldset label` pointer; L382 `#vp-strip` remove-button (`.vp-x`-style) pointer; L385 `.vp-actions .act-btn:disabled` **not-allowed**; L404 `#compact-body` **text**
- Inline styles: L455 `#input-toggle` `style="cursor:pointer; ..."`; L487 `#history-toggle` `style="cursor:pointer;"`; L589 `#transcript-live` `cursor:text` inside the multi-line `style="..."`
- JS: L1933 `row.style.cssText = '... cursor:pointer; ...'` (suggestion rows)
- No `style.cursor =` / `document.body.style.cursor` assignment exists in `index.html`, `audio.js`, `interview.js`, `ux-helpers.js`, `solution-format.js` (grep for `cursor` in those is empty). `main.js` L373 `cursor:` is `dragState = { cursor: ..., bounds }`, a variable, not CSS. The audit must not flag it (it only scans HTML/CSS-ish contexts for `cursor:` plus `style.cursor`).
`selection.html`: L11 `cursor: crosshair` on `html, body`.
Implicit cursor sources that CSS `*` also covers: UA `cursor:text` on inputs/textarea, `cursor:pointer` on `<summary>`/`<select>`, disabled buttons, scrollbars. One exception to check: the textarea resize corner (`#ocr-input { resize: vertical }`, ~L81) can show a resize cursor that CSS may not override. Decision: set `resize: none` on every textarea (new global rule `textarea { resize: none; }`) so no resizer exists. This is a deliberate small behavior change driven by requirement 1; mention it in the final summary.

### 0.2 Title attributes (28 static + 5 JS)
Static `title="..."` in `index.html`: L435 (inside `<!-- [OCR-DISABLED] -->` comment, inactive, leave), L437 `#btn-minimize`, L460 `#btn-capture-full`, L461 `#btn-capture-region`, L462 `#btn-ask`, L463 `#btn-clear-input`, L480 `#btn-regenerate`, L482 `#btn-popout`, L496 `#iv-start`, L497 `#iv-pause`, L498 `#iv-resume`, L499 `#iv-stop`, L500 `<details id="iv-langs">`, L507 `#iv-cv-btn`, L509 `#iv-cv-clear`, L511 `#iv-clear`, L517 `.iv-meter` (span, no text), L563 `#audio-devices-toggle`, L564 `#btn-ask-now`, L577 `#audio-refresh`, L584 `#transcript-save`, L585 `#transcript-clear`, L629 `#edit-close`, L660 `#edit-vision-send`, L679 `#edit-popout`, L722 `#compact-restore`, L728 `#floating-dot`.
Inside JS template literal (Gallery render, L1267/L1268): `title="Edit"` and `title="Delete"` on the `.g-act` spans (glyph-only text, so they need `aria-label`).
JS assignments: L909 `stop.title = 'Stop waiting for this request'` (loader Stop button); L1936 `row.title = 'Click to copy'`; L2560 `addBtn.title = full ? 'Batch limit reached (...)' : ''`.
Not titles (leave): `<title>` elements in both HTML files (document title, no tooltip; frameless window has no title bar), `class="title"`, `#vp-title`, `#compact-title`, `titleEl.textContent`, the `open(text, title)` parameter.

### 0.3 Native `<select>` (3)
- L466 `<select class="tone" id="tone-select">` (options concise/detailed/...; consumers: `toneSelect.value` at L960, 987, 1605, 1654, 1885, 1950, 1998, 2248, 2363, 2604, and `change` listeners at L959, 2012, 2406)
- L571 `<select class="tone interactive" id="dev-me" style="flex:1;">` and L575 `id="dev-them"` (filled by `fillDeviceSelect(sel, devices, selectedId, includeNone)` at ~L1747-1760, called from `initAudio` L1773 and L1777; it does `sel.innerHTML = ''` then `appendChild(option)` and sets `o.selected = true` as a property; consumers: `devMe.value` / `devThem.value` at L1983 and L2001)
- No other selects, no `createElement('select')`, no datalist, no `<input type=date|color|...>` anywhere.
- CSS: `select.tone` (L108-112) is the look to match. `select` is in the `-webkit-app-region: no-drag` list (L28-31) and in `INTERACTIVE` of `initWindowDrag` (L~754).

### 0.4 Native dialogs
- `confirm()` x2: L1185 (`gallery-clear` click handler: `'Clear all history? (Records removed; images on disk kept.)'`) and L1287 (`.g-act.del` click handler: `'Delete this capture?'`). Both handlers are already `async`.
- `alert(` / `prompt(` / `window.confirm`: none in any renderer file (grep confirmed). `main.js` has no `dialog` import.

### 0.5 File input
- L506 `<input type="file" id="iv-cv-input" accept=".pdf,.docx,.txt" style="display:none;">`, L507 `#iv-cv-btn` (calls `el.cvInput.click()` at ~L2418), L508 `#iv-cv-label`, L509 `#iv-cv-clear`. Handler: `el.cvInput.addEventListener('change', ...)` at ~L2419-2442 uses `api.parseResume(file)` then `IV.setCandidateProfile(res.profile || '')`, sets `el.cvLabel`, `noteResumeApplies()`, `showError()`, and `finally { el.cvInput.value = ''; }`. The `el` map is at ~L2030-2047 (`cvInput`, `cvBtn`, `cvLabel`, `cvClear`). Bridge: `preload.js` `parseResume(file, distill=true)` builds a `FormData` with `file.name`, so a synthetic `File` works unchanged.

### 0.6 Other native surfaces
- `contextmenu`: only L1835 (`transcriptLive.addEventListener('contextmenu', ...)`), which drives the in-overlay `#ctx-menu`. It returns early without `preventDefault()` when nothing is selected. Electron shows no native context menu by default (no `context-menu` handler in `main.js`), so this is not a leak today. Hardening: add one document-level `contextmenu` listener that calls `preventDefault()` (bubble phase, so the transcript handler still runs first).
- `window.open`, `<a href`, `<iframe>`, `<webview>`, `<datalist>`, `<input type=date|color>`: none (grep confirmed).
- Drag-and-drop: dropping a file onto the window would navigate to it. Hardening in `main.js`: `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` and a `will-navigate` handler that `preventDefault()`s anything not the local `file://.../index.html`.
- `<details>`/`<summary>` language picker (`#iv-langs`, `.iv-langs-list`) is pure in-page HTML (position:absolute list); only its cursor and `title` need handling. It stays as is.
- `main.js` `new BrowserWindow(` count is 2: overlay (L~58) and selection (L~159). Both call `setContentProtection(true)` (L~86 and L~189/195). Overlay is `resizable: true` (L~66). Selection is `resizable: false`, `movable: false`.
- Z-index map (for new layers): ctx-menu 1000, edit-modal 2000, vision-popup 2100, compact-view 3000. New: dropdown list 3400, dialog 3500, tooltip 4000.
- Escape handling that I must not break: edit modal capture-phase `document` listener (~L1466), ctx menu (L~1854), vision popup (~L2590). New dropdown/dialog Escape handlers attach to `window` in the capture phase (fires before `document` capture) and call `stopPropagation()` only when they are open.

## 1. Design decisions (brief rationale)

- Title handling: rewrite all static and JS-assigned titles to `data-tip` in source (no flash of native tooltips, and the audit stays trivially strict: zero `title=` / `.title =` anywhere). The MutationObserver conversion stays as a runtime safety net for anything added later. Because the source then never matches the forbidden patterns, the "single converter" needs no exemption; it uses `getAttribute('title')` / `removeAttribute('title')`, which the audit patterns do not match.
- Where code lives: pure logic in `stealth-ui.js` (UMD, like `vision-batch.js`: `if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.StealthUI = api;`). DOM glue (tooltip, dropdown, dialog, observers) in one new inline `<script>` block in `index.html` placed right after `<script src="stealth-ui.js">` and BEFORE the big main script, so `overlayConfirm`, `enhanceSelect` and the observers exist before main-script code runs. No new window, no native API.
- `main.js` may `require('./stealth-ui.js')` for `clampResize` (main is not sandboxed). `preload.js` must NOT (sandbox: only `require('electron')`).
- Resizable false and setBounds: see section 5; the helper `setOverlayBounds()` is a single choke point for fallback.
- Custom dropdown mount point: list element appended to `document.body` (`position: fixed`), so it is never clipped by `overflow` in the card and is never affected by `backdrop-filter` stacking.
- Grip uses Pointer Events with `setPointerCapture` so resize keeps working when the cursor leaves the window mid-resize (mouse events would stop). It carries class `no-window-drag`, which `initWindowDrag` already excludes through its `INTERACTIVE` selector, so the drag-anywhere code needs no edit for the grip.

## 2. `stealth-ui.js` API (new file at repo root, pure, no DOM, no Node-only APIs)

```
StealthUI = {
  // Tooltips
  decideTitleConversion({ title, tip, ariaLabel, text }) ->
      { removeTitle: true, tip: string|null, ariaLabel: string|null }
      // title/tip/ariaLabel/text are the current attribute values / element textContent (strings or null).
      // trimmed title empty -> { removeTitle:true, tip: null, ariaLabel: null }
      // tip = existing data-tip if non-empty, else trimmed title
      // ariaLabel = trimmed title ONLY when the element has no aria-label AND no "visible text";
      //            visible text = /[\p{L}\p{N}]/u matches text (so "✕", "—", "⚙︎", "×", emoji-only count as none)
  tooltipPosition({ anchor:{left,top,right,bottom}, tip:{width,height}, viewport:{width,height}, gap=8, pad=6 })
      -> { left, top, placement:'below'|'above' }   // default below, flip above if it would overflow bottom,
                                                    // then clamp left/top into [pad, viewport - size - pad]
  dropdownPosition({ anchor, contentHeight, viewport, minWidth, gap=4, pad=6, maxHeightCap=240 })
      -> { left, top, width, maxHeight, placement }  // width >= anchor width; opens below if room >= min(contentHeight, 120),
                                                    // else above; maxHeight = available space (<= cap) so long lists scroll
  // Dropdown option sync
  snapshotOptions(optionLikes /* [{value,textContent|label,disabled,selected}] */, selectValue, selectDisabled)
      -> { items:[{value,label,disabled}], selectedIndex, disabled }
      // selectedIndex = index of option whose value === selectValue, else first `selected`, else 0 if any, else -1
  optionsEqual(a, b) -> boolean            // shallow compare of snapshot items+selectedIndex+disabled, to skip no-op re-renders
  nextIndex(items, current, key) -> number // 'ArrowDown'|'ArrowUp'|'Home'|'End' skipping disabled items; -1 if none enabled
  typeaheadIndex(items, current, buffer) -> number // optional: prefix match on label (case-insensitive)
  // Window resize (also used by main.js)
  clampResize({ start:{x,y,width,height}, dx, dy, workArea:{x,y,width,height}, min:{width,height} })
      -> { x:start.x, y:start.y, width, height }
      // width  = clamp(start.width + dx,  min.width,  max(min.width,  workArea.x + workArea.width  - start.x))
      // height = clamp(start.height + dy, min.height, max(min.height, workArea.y + workArea.height - start.y))
      // position fixed; non-finite dx/dy treated as 0; results rounded to integers
  MIN_RESIZE: { width: 380, height: 300 }
}
```
Unit-tested (item 1) with tables: title conversion cases (empty, whitespace, text button keeps no aria-label, glyph-only gets aria-label, existing aria-label preserved, existing data-tip preserved); tooltip near right/bottom edges and larger-than-viewport; dropdown with few and many options, anchor near the bottom; snapshot/equality with dynamic repopulation (device list replaced); `nextIndex` skipping disabled and wrapping rules (no wrap: clamps at ends); `clampResize` min clamp, work-area max clamp, negative deltas, window already beyond the work area.

## 3. Select-sync design (inside the inline DOM block)

`enhanceSelect(select)`:
1. Idempotent (`select.dataset.sdEnhanced`). Build wrapper `div.sd-select` (inherit `flex` from `select.style.flex`, so `dev-me`/`dev-them` `style="flex:1;"` keeps layout), trigger `button.sd-trigger.tone` (`type="button"`, `role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`, `aria-label` copied from the zone label text when available, else the select id), insert wrapper right after the select, then hide the real select: class `sd-native` (visually hidden: `position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; clip-path:inset(50%)`), `aria-hidden="true"`, `tabindex="-1"`.
2. `render()` = `snapshotOptions(...)` from `select.options`, skip if `optionsEqual` with the last snapshot, update trigger label (`textContent` of selected option, or a placeholder when none) and `disabled`, and rebuild the listbox rows if it is open (rows are `div[role=option][id]` created with `textContent`, never `innerHTML`).
3. Sources of change that trigger `render()`:
   - `MutationObserver(select, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['disabled','value','selected','label'] })` handles `fillDeviceSelect` (`innerHTML=''` + appends) and attribute changes.
   - Instance-level property shims for programmatic assignments that fire no DOM mutation: `Object.defineProperty(select, 'value'|'selectedIndex'|'disabled', { get/set })` delegating to the `HTMLSelectElement.prototype` descriptor, then `render()`. This keeps `.value`, `.options`, `.selectedIndex` fully native for existing code.
   - A `change` listener on the real select (e.g. set by other code) calls `render()`.
   - `fillDeviceSelect` sets `o.selected = true` as a property before the append mutation is delivered; the observer callback runs after the whole population, so it reads the final state.
4. User selection: set `select.value = row.value` (through the shim; render runs), then `select.dispatchEvent(new Event('change', { bubbles: true }))`. Only dispatch when the value actually changed. No `input` event needed (no listeners found).
5. Open/close: trigger click, Enter, Space, ArrowDown/ArrowUp opens; inside: ArrowUp/Down/Home/End via `nextIndex`, Enter/Space select, Escape closes (and returns focus to the trigger), Tab closes, typeahead optional. Close on outside `mousedown` (capture), `blur` of the window, `resize`, and scroll of any ancestor (`scroll` capture). Position with `dropdownPosition()` using trigger `getBoundingClientRect()` and `window.innerWidth/innerHeight`; list is `max-height` + `overflow-y:auto`; the active row is scrolled into view with `scrollIntoView({ block:'nearest' })`. Use `aria-activedescendant` on the trigger.
6. Styling: `.sd-trigger` copies the `select.tone` look (`background:#1c1c24; color:#e8e8ea; border:1px solid rgba(255,255,255,0.18); border-radius:7px; font-size:11px; padding:4px 6px;` plus a `▾` caret via `::after`, `text-align:left`, ellipsis). `#sd-list` is `background:#1d1f24; border:1px solid rgba(255,255,255,0.14); border-radius:8px;` matching `.iv-langs-list` (L206-211), `.sd-opt:hover/.active` uses the `rgba(76,154,255,0.9)` highlight of `#ctx-menu .ctx-item:hover`. It carries class `no-window-drag` (so `initWindowDrag` ignores presses on it) and `-webkit-app-region: no-drag`.
7. Apply to `#tone-select`, `#dev-me`, `#dev-them` via `document.querySelectorAll('select').forEach(enhanceSelect)` at script run time (the DOM is already parsed since scripts sit at the end of `<body>`), and a `MutationObserver` on `document.body` childList+subtree that enhances any later-added `<select>` (safety net; audit also forbids `createElement('select')`).

## 4. Resize IPC design

Renderer (`index.html`, new `initWindowResize` IIFE placed right after `initWindowDrag`, bridge-missing guard like drag's `if (!api.resizeStart ...) return;`):
- Markup: `<div id="resize-grip" class="no-window-drag" aria-hidden="true"></div>` as the last child of `#overlay-card` (card gets `position: relative`). CSS: `position:absolute; right:4px; bottom:4px; width:16px; height:16px; opacity:0.55;` background of diagonal dots via two `radial-gradient`s or an inline SVG data URI (no external fetch), `:hover { opacity: 1 }`, `touch-action: none`. Cursor stays default (global rule). It is inside `#overlay-card`, which gets class `hidden` in both compact and dot modes, so the grip is automatically hidden then (explicitly assert this in verification).
- Events: `pointerdown` (button 0) -> `e.preventDefault()`, `grip.setPointerCapture(e.pointerId)`, `api.resizeStart()`; `pointermove` while captured -> one `api.resizeMove()` per `requestAnimationFrame` (same `if (!frame) frame = requestAnimationFrame(...)` pattern as drag); `pointerup`/`pointercancel`/`lostpointercapture`/window `blur` -> cancel rAF, `api.resizeEnd()` once. Reuse the `swallowClick` idea is not needed (grip has no click handler).
- Hover tooltip for the grip: `data-tip="Drag to resize"`.

Preload (`preload.js`, next to `dragStart/dragMove/dragEnd`, ~L66-68; electron-only):
```
resizeStart: () => ipcRenderer.send('overlay-resize-start'),
resizeMove:  () => ipcRenderer.send('overlay-resize-move'),
resizeEnd:   () => ipcRenderer.send('overlay-resize-end'),
```

Main (`main.js`, right after the `overlay-drag-*` handlers, ~L388):
```
const StealthUI = require('./stealth-ui.js');
let resizeState = null;
let overlayDot = false;                       // set in 'toggle-overlay-mode' (isMinimized)
ipcMain.on('overlay-resize-start', (e) => {
  if (!isOverlaySender(e) || overlayCompact || overlayDot) return;     // no-op while compact / dot
  const bounds = overlayWindow.getBounds();
  resizeState = { cursor: screen.getCursorScreenPoint(), bounds,
                  workArea: screen.getDisplayMatching(bounds).workArea };
});
ipcMain.on('overlay-resize-move', (e) => {
  if (!resizeState || !isOverlaySender(e)) return;
  const cur = screen.getCursorScreenPoint();
  setOverlayBounds(StealthUI.clampResize({ start: resizeState.bounds,
    dx: cur.x - resizeState.cursor.x, dy: cur.y - resizeState.cursor.y,
    workArea: resizeState.workArea, min: StealthUI.MIN_RESIZE }));
});
ipcMain.on('overlay-resize-end', (e) => {
  if (!isOverlaySender(e)) return;
  resizeState = null;
  saveWindowState();                           // existing path; already a no-op while compact
});
```
Also clear `resizeState` (and `dragState`) inside `set-compact-mode` and `toggle-overlay-mode`. Because `resizable:false`, Electron does not emit `resized` for our programmatic changes, so persistence relies on the explicit `saveWindowState()` at resize-end (the existing `'moved'`/`'resized'` listeners stay).
`setOverlayBounds(b)`: `overlayWindow.setBounds(b)`; on `win32`, if `getBounds()` width/height differ from `b`, call `setBounds(b)` once more (self-heal for the Windows DPI shrink issue below). Used by resize-move and compact set/restore. The drag-move handler is switched to the same helper (behavior-identical on macOS; this is the one deliberate touch of drag code, justified by section 5 risk; mention it in the summary).

## 5. Does `setBounds`/`setSize` still work on a non-resizable window? (research and how to verify)

Findings (Electron docs and issues):
- `resizable` only controls whether the USER can resize; Electron's `setSize`/`setBounds` are programmatic and are documented to work regardless. On macOS this maps to NSWindow `setFrame:`, which ignores the style mask's resizable flag. On Windows it maps to `SetWindowPos`, which also ignores `WS_THICKFRAME`. I did not find any report that macOS refuses programmatic resize on non-resizable windows.
- Windows caveats found: [electron/electron#27054](https://github.com/electron/electron/issues/27054) (height shrinks on each `setBounds(getBounds())` for NON-resizable windows after moving to a monitor with a different DPI) and [#51244](https://github.com/electron/electron/issues/51244) (frameless `getBounds()` inflated after toggling `setResizable(true -> false)`, regression in 41.2.1). Consequences for this plan: (a) create the window with `resizable:false` from the start and never toggle it (toggling is what triggers #51244), so the transient `setResizable(true)` fallback is NOT adopted unless verification proves setBounds fails; (b) the `setOverlayBounds` re-apply guard covers #27054 for drag/resize/compact.
- Cannot verify Windows from this macOS machine. State this in the final report with the manual Windows checklist below.

Verification the implementer must run (macOS, here):
1. Write a throwaway script OUTSIDE the repo, e.g. `$TMPDIR/bounds-check/main.js`: `app.whenReady` -> `new BrowserWindow({ show:false, frame:false, transparent:true, resizable:false, width:1200, height:850 })` -> for each of `setSize(64,64)`, `setSize(1000,720)`, `setBounds({x:100,y:100,width:460,height:380})`, `setBounds({x:100,y:100,width:777,height:555})` print `getBounds()` and `process.exitCode = 1` if size differs by more than 1px -> `app.quit()`. Run: `cd /Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app && ./node_modules/.bin/electron "$TMPDIR/bounds-check/main.js"`. Expected: all four sizes echo back exactly, exit code 0. Delete the temp dir afterwards.
2. Run the same script with `resizable:true` once as a control (same output).
3. Manual run `npm start` (backend not required for UI-only checks): exercise Pop out solution (compact panel) and Full overlay restore, Minimize to dot and back, drag-anywhere, and the new grip; confirm sizes restore correctly and relaunch restores the last grip-resized size.
Windows manual checklist (to hand to the user): same four actions on a Windows machine, including dragging the window between two monitors with different DPI scaling and confirming the window height does not shrink; if it does, the fallback is `setResizable(true)` wrapped transiently inside the main-process handlers only, and the audit's "no `setResizable(true)`" rule must then be relaxed to allow it inside `setOverlayBounds` only.

## 6. Ordered work items

- [ ] 1. Create `stealth-ui.js` and its unit tests.
      Implement the API from section 2 (UMD, no DOM). Create `test/stealth-audit.test.js` with the same harness as `test/interview.test.js` and add the "StealthUI" unit tests (tables listed in section 2). Update `package.json` `"test"` to `node test/interview.test.js && node test/stealth-audit.test.js`. At this point the audit file only contains the unit tests (the static audit is added in item 10 once the code complies).
      Files: `stealth-ui.js` (new), `test/stealth-audit.test.js` (new), `package.json`
      Verify: `npm test` — both files run; interview tests unchanged and green; new StealthUI tests pass.

- [ ] 2. Main-process and preload changes for window edges (no renderer change yet, so the app still builds and runs).
      In `main.js`: set `resizable: false` in the overlay `BrowserWindow` options (~L66); add `setOverlayBounds()` and route `set-compact-mode` (both `setBounds` calls) and `overlay-drag-move` through it; add `overlayDot` flag set in `toggle-overlay-mode`; add the three `overlay-resize-*` handlers from section 4 and clear `dragState`/`resizeState` on mode changes; add `require('./stealth-ui.js')`; hardening: in `createOverlayWindow` add `overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` and a `will-navigate` handler that calls `preventDefault()` unless the URL starts with the overlay's own `file://` URL (do the same two calls for the selection window). Do NOT touch `setContentProtection` calls. In `preload.js`: add `resizeStart/resizeMove/resizeEnd` after `dragEnd` (electron-only requires; do not add any other `require`).
      Files: `main.js`, `preload.js`
      Verify: `node --check main.js && node --check preload.js` then `npm test`; then the macOS bounds script from section 5 step 1 and `npm start` smoke: window opens, compact panel and dot still resize (the grip does not exist yet).

- [ ] 3. Global cursor rule + removal of every cursor declaration (both HTML files).
      `index.html`: make the first rule inside `<style>` (before the existing `* , *::before, *::after { box-sizing... }` rule at L8) `*, *::before, *::after { cursor: default !important; }` with a 2-line comment (OS-drawn cursor shapes are not covered by `setContentProtection`, so any non-default cursor reveals the invisible UI to a screen-share viewer). Remove each declaration listed in 0.1: the 15 CSS rules (just delete the `cursor: ...;` token), the L385 `not-allowed`, the L404 `text`, the three inline `style="cursor:..."` (L455, L487, L589), and the `cursor:pointer;` in the L1933 `style.cssText` string. Add `textarea { resize: none; }` (and drop `resize: vertical` from `#ocr-input`). Leave `[OCR-DISABLED]` comment blocks untouched. `selection.html`: first rule in `<style>` is the same global rule; remove `cursor: crosshair` from `html, body` (L11).
      Files: `index.html`, `selection.html`
      Verify: `npm test` still passes; `node -e "..."`-free check is replaced by the audit in item 10; manual: `npm start`, hover buttons, nav tabs, gallery items, textarea, selects, the edit canvas and a disabled button, and confirm the arrow never changes; trigger region capture (Cmd+Shift+2) and confirm no crosshair appears.

- [ ] 4. Tooltips: convert titles to `data-tip` and add the in-overlay tooltip.
      (a) Add `<script src="stealth-ui.js"></script>` after `ux-helpers.js` (L736) and a new inline `<script>` block (stealth DOM layer) between it and the main script (L737). (b) In markup, replace every active `title="X"` from 0.2 with `data-tip="X"`; for glyph-only controls add `aria-label` where missing (`#btn-minimize` -> "Minimize to dot", `#iv-cv-clear` -> "Clear the loaded resume", `#transcript-save`, `#audio-devices-toggle`, `#edit-close`, the Gallery `.g-act` Edit/Delete spans in the L1267-1268 template literal: `data-tip="Edit" aria-label="Edit"`, `data-tip="Delete" aria-label="Delete"`). (c) JS: L909 -> `stop.setAttribute('data-tip', 'Stop waiting for this request')`; L1936 -> `row.setAttribute('data-tip', 'Click to copy')`; L2560 -> `if (full) addBtn.setAttribute('data-tip', 'Batch limit reached (' + VB.MAX_BATCH + ' images)'); else addBtn.removeAttribute('data-tip');`. (d) In the new block: `convertTitles(root)` (uses `StealthUI.decideTitleConversion`, then `removeAttribute('title')`, sets `data-tip` / `aria-label`), run once over `document` and from a `MutationObserver(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['title'] })`; tooltip element `div#sd-tooltip[role=tooltip]` appended to `body` (`position:fixed; z-index:4000; pointer-events:none; max-width:260px; font-size:11px; padding:5px 8px; border-radius:6px; background:rgba(18,18,26,0.96); border:1px solid rgba(255,255,255,0.16); color:#e8e8ea; box-shadow:0 6px 18px rgba(0,0,0,0.45)`; hidden by default). Delegated listeners: `mouseover`/`focusin` (capture) find `closest('[data-tip]')`, start a 400ms timer; `mouseout`/`focusout`/`mousedown`/`keydown`/`scroll`(capture)/`blur`/`wheel` hide it and clear the timer; on show re-check `el.isConnected` and not `disabled`-hidden, set `textContent` (never innerHTML), measure, place with `StealthUI.tooltipPosition`, set `aria-describedby` on the anchor while shown. It never touches the cursor. Also add in this block: the document-level `contextmenu` `preventDefault()` listener (bubble phase).
      Files: `index.html`
      Verify: `npm test`; manual `npm start`: hover Capture, Ask, Minimize, Gallery edit/delete and a Stop button for 0.5s and see the in-overlay tooltip clamped inside the window; in devtools `document.querySelectorAll('[title]').length` is 0, including after opening Gallery and the Interview tab; keyboard Tab focus shows the tip.

- [ ] 5. Dropdowns: custom in-overlay select for the three selects.
      Implement `enhanceSelect` in the stealth DOM block per section 3, add the CSS (`.sd-select`, `.sd-trigger`, `.sd-native`, `#sd-list`, `.sd-opt`, `.sd-opt.active`, `.sd-opt[aria-disabled=true]`) in the `<style>` block next to `select.tone`, add `data-sd-select` to the three `<select>` tags at L466, L571, L575 (the marker the audit checks; the enhancer sets it too), and run `document.querySelectorAll('select').forEach(enhanceSelect)` plus the body observer for later-added selects. Do NOT change `fillDeviceSelect`, the `toneSelect`/`devMe`/`devThem` consumers, or any `change` listener.
      Files: `index.html`
      Verify: `npm test`; manual: open the Tone dropdown (mouse and keyboard Enter/Arrows/Escape), pick "Detailed", confirm `toneSelect.value` is `detailed` (devtools) and a following Ask uses it; Audio tab: toggle device settings, confirm both device lists populate after `initAudio`, selection persists and `devMe.value` matches the shown label; long list scrolls inside the window; clicking outside closes; no native popup ever appears.

- [ ] 6. Dialogs: in-overlay confirm/notice and Gallery wiring.
      In the stealth block add `overlayConfirm(message, opts)` and `overlayNotice(message, opts)` (promise-based, `opts`: `confirmText`, `cancelText`, `danger`; calls are queued so two dialogs never stack), exposed as globals. Markup built lazily with DOM APIs: `div#sd-dialog` (`position:fixed; inset:0; z-index:3500; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.55); -webkit-app-region:no-drag`), card `role="alertdialog" aria-modal="true" aria-labelledby aria-describedby`, message via `textContent`, `.act-btn` Confirm/Cancel buttons (Confirm styled like `.g-act.del` red when `danger`). Behavior: initial focus on Cancel for destructive confirms, Tab/Shift+Tab trapped between the two buttons, Escape resolves `false` (window-capture keydown with `stopPropagation()` while open so the edit-modal Escape handler does not also fire), backdrop click resolves `false`, focus returns to the previously focused element, `body` `inert`-free (no new APIs needed). Replace `if (!confirm('Clear all history? ...')) return;` (L1185) with `if (!(await overlayConfirm('Clear all history? (Records removed; images on disk kept.)', { confirmText:'Clear all', danger:true }))) return;` and L1287 with `if (!(await overlayConfirm('Delete this capture?', { confirmText:'Delete', danger:true }))) return;` (both handlers are already `async`). Because z-index 3500 > compact 3000 > edit 2000, it layers correctly in compact mode and over the edit modal; at 460x380 compact size the card uses `width:min(92%,360px)`.
      Files: `index.html`
      Verify: `npm test`; manual: Gallery trash on an item -> in-overlay dialog, Escape cancels (item stays, edit modal does not close), Delete confirms (item removed); "Clear" all history likewise; Tab cycles only inside the dialog.

- [ ] 7. Resume: "Paste text instead" path and hint.
      Markup near L506-509: add `<span class="muted" id="iv-cv-hint">Tip: choose the file before you start sharing your screen - the system file picker can be visible to others.</span>` as its own full-width line after the `.actions` row's resume controls (own `div`, `font-size:10px`), a `<button class="act-btn" id="iv-cv-paste-btn" type="button">Paste text instead</button>` next to `#iv-cv-btn`, and a collapsed block `<div id="iv-cv-paste" class="hidden interactive">` containing `<textarea id="iv-cv-text" placeholder="Paste your resume text here" rows="6">` plus `<button class="act-btn" id="iv-cv-paste-submit">Use this text</button>` and `<button class="act-btn" id="iv-cv-paste-cancel">Cancel</button>` (add `data-tip`s, no `title`). JS (resume section ~L2410-2450, inside the same IIFE where `el`, `showError`, `noteResumeApplies`, `IV` are in scope): add the new ids to the `el` map; extract the body of the current `change` handler into `async function loadResumeFile(file)` (same `parseResume` call, same `Parsing…` / label / `setCandidateProfile` / error branches); the `change` handler becomes `{ const f = ...; if (!f) return; try { await loadResumeFile(f); } finally { el.cvInput.value = ''; } }`; the paste button toggles `#iv-cv-paste` (and focuses the textarea); submit trims the text, shows `showError('Paste some resume text first.')` on empty, otherwise `await loadResumeFile(new File([text], 'resume.txt', { type: 'text/plain' }))` and on success clears and collapses the block. Session-only behavior is unchanged (profile stays in `IV` state, nothing stored). The textarea is already excluded from drag (`textarea` in `INTERACTIVE`).
      Files: `index.html`
      Verify: `npm test`; manual with backend running: upload a `.txt` through the file route still works; paste text -> label shows "Resume loaded (N chars)"; Clear resets to "No resume"; empty paste shows the error; with the backend stopped, the paste route shows "Backend unreachable — could not parse resume." (same as file route).

- [ ] 8. Resize grip in the renderer.
      Add the grip element, CSS, and `initWindowResize` IIFE from section 4 (after `initWindowDrag`, ~L821). No change to `initWindowDrag` itself.
      Files: `index.html`
      Verify: `npm test`; manual `npm start`: drag the bottom-right grip, window grows/shrinks smoothly with fixed top-left, stops at 380x300 minimum and at the screen work-area edge, cursor stays an arrow; quit and relaunch to confirm size persisted; Pop out solution -> grip not visible and a press there does nothing; restore returns the pre-compact size; minimize to dot -> grip hidden; drag-anywhere still works elsewhere and pressing the grip never starts a window drag; Edit modal and the dialogs still sit above the grip.

- [ ] 9. Pass over remaining stragglers.
      Re-grep both HTML files and all renderer JS for `title`, `cursor`, `confirm(`, `alert(`, `prompt(`, `<select`, `window.open`, `<a `, `style.cursor` and fix leftovers (for example any `title=` in dynamically built HTML strings, or a select added late). Confirm `[OCR-DISABLED]` blocks are untouched.
      Files: `index.html`, `selection.html` (only if leftovers)
      Verify: `npm test`.

- [ ] 10. Regression guard: finish `test/stealth-audit.test.js`.
      Structure: `stripComments(source, kind)` (remove `<!-- -->` and `/* */` anywhere; for JS blocks remove `//` comments only when not part of `://` and not inside a quote on that line), `runAudit({ indexHtml, selectionHtml, mainJs, preloadJs, rendererJs: {audio, interview, ux-helpers, vision-batch, solution-format, stealth-ui} })` -> array of `{ file, rule, message }`, and `test()` cases: (1) a sanity test that stripping real files keeps known tokens (`setContentProtection(true)`, `contextBridge.exposeInMainWorld`) and removes `[OCR-DISABLED]` lines; (2) one NEGATIVE unit test per rule that feeds a small bad snippet to `runAudit`/the rule function and asserts it reports the violation (proves the patterns are live); (3) one test that runs the audit on the real repo files and asserts zero violations, printing one line per violation (`<file>: <rule> - <message>`) on failure. Also compile every inline `<script>` of `index.html` with `new vm.Script(code)` to catch syntax errors, since there is no browser test.
      Rules (all against comment-stripped active code):
      - global cursor: in BOTH html files, the first rule in the first `<style>` is `*, *::before, *::after { cursor: default !important; }` (regex tolerant of spacing/`* ,`), and no other `cursor\s*:\s*(?!default\b)` exists in CSS, inline `style="..."` or `cssText` strings; no `style.cursor\s*=` / `setProperty('cursor'` / `.cursor\s*=` on style objects in any renderer file.
      - titles: no `\stitle\s*=` inside any tag in either HTML file (note `<title>` and `class="title"` do not match), no `\.title\s*=(?!=)` and no `setAttribute\(\s*['"]title['"]` in any renderer JS, and `index.html` contains `attributeFilter: ['title']` plus `data-tip` handling (positive check).
      - selects: every `<select\b` in `index.html` has `data-sd-select`; `enhanceSelect(` is defined and invoked; no `createElement('select')` outside the enhancer.
      - dialogs: no `(^|[^.\w$])(confirm|alert|prompt)\s*\(` and no `window.(confirm|alert|prompt)\s*\(` in any renderer file (so `overlayConfirm(` is fine); `main.js` has no `dialog.show`, `Menu.buildFromTemplate`, `.popup(`, `new Notification`, `shell.`.
      - file input: exactly one `<input type="file">` and it has `id="iv-cv-input"`; no `type="(date|time|datetime-local|month|week|color)"`, no `<datalist`.
      - navigation: no `<a\b[^>]*\bhref`, no `window.open(`, no `location.href\s*=`, no `<iframe|<webview|<embed|<object`.
      - windows: `main.js` has no `resizable:\s*true`, no `setResizable(true)`, `new BrowserWindow(` count is exactly 2, and both `overlayWindow.setContentProtection(true)` and `selectionWindow.setContentProtection(true)` appear; the overlay options block contains `resizable: false`.
      - preload sandbox: every `require(` in `preload.js` has the argument `'electron'`.
      Files: `test/stealth-audit.test.js`
      Verify: `npm test` — all green; temporarily proving the guard: run `node -e` is NOT needed because the negative unit tests already cover each rule; additionally do one manual sanity check by adding `title="x"` to a scratch copy in the negative test only (never to real files).

- [ ] 11. Final verification and cleanup.
      Run `npm test`; run the macOS bounds script (section 5) and delete its temp dir; do the manual smoke checklist (items 3-8 verify steps once more, including: tone feeds Ask and `visionAsk`, audio device selects keep values on Start, Gallery delete/clear with the new dialog, resume upload, vision popup, Pop out/restore, minimize/expand, drag-anywhere, region capture). Confirm `git status --short` shows only `index.html`, `main.js`, `preload.js`, `selection.html`, `package.json`, `stealth-ui.js`, `test/stealth-audit.test.js` as changed/new (plus the pre-existing uncommitted items), `screen_shot/` and every `.env` untouched, no commits made.
      Files: none (verification only)
      Verify: `npm test` exit code 0; `git status --short` as described.

## 7. Assumptions and risks

- Windows behavior of `setBounds` on a non-resizable frameless transparent window cannot be tested here; mitigations are in section 5. If the macOS control run shows a size mismatch, stop and switch to the transient `setResizable(true)` approach inside `setOverlayBounds` only.
- The `resize: none` change on textareas removes the vertical drag handle on the question box (needed so no OS/Chromium resizer cursor can appear).
- `title`-attribute tooltips used to appear for disabled buttons too; `data-tip` on disabled elements still shows because mouse events on disabled buttons are not delivered in Chromium, so use `mouseover` on the parent via delegation only for enabled elements. Disabled controls simply show no tip (acceptable, and safer).
- `<title>` of the HTML documents is kept (not an attribute; frameless window shows no title bar). It can show in OS window lists, which is pre-existing and out of scope.
- The tooltip, dropdown list and dialog live in the content-protected overlay window; nothing opens a new `BrowserWindow`, native menu, `Notification` or `shell` call.
- Backend (`screen_shot/`), Interview/Audio logic, vision popup logic, gallery polling/loaders/Stop logic and `.env` files are not modified. Only the minimal touches of existing logic: the three consumers listed in item 4(c) (title -> data-tip), item 6 (confirm replacement), item 7 (extract `loadResumeFile`), and the drag-move helper swap in item 2.
