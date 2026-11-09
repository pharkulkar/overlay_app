# Verification: stealth-safe hover and interaction

No Electron instance and no server was launched. No commits. `screen_shot/` and `.env` files untouched. No `review.json` existed, so this is a from-scratch implementation.

## Commands run and results

All from `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app`.

| Command | Result |
|---|---|
| `node --check main.js` | ok |
| `node --check preload.js` | ok |
| `node --check stealth-ui.js` | ok |
| `npm test` (= `node test/interview.test.js && node test/stealth-audit.test.js`) | exit 0. interview: **32 passed, 0 failed** (unchanged). stealth-audit: **37 passed, 0 failed** |

The 37 audit tests are: 23 StealthUI helper tables, 11 audit-pattern self-tests (incl. comment stripping and a clean-baseline check), and 3 real-file checks. The real-file checks are:
- No violations in `index.html`, `selection.html`, `main.js`, `preload.js` (and renderer JS files).
- Every inline `<script>` block of `index.html` and `selection.html` compiles with `vm.Script`.
- Every id referenced by active JS (`getElementById('x')`, `#x` in `querySelector*`) exists exactly once in the markup. Ids created at runtime via `.id = '...'` are exempt.

### Audit must fail when a violation is reintroduced (scratch copies only)
The test accepts `STEALTH_AUDIT_DIR` to audit a different directory. I copied the files to a `mktemp -d` dir, injected one violation per copy, ran `STEALTH_AUDIT_DIR=<copy> node test/stealth-audit.test.js`, then deleted the dir (confirmed gone). Real files were never edited for this.

| Injected violation (scratch copy) | Audit result |
|---|---|
| global `cursor: default !important` removed + `.x { cursor: pointer; }` added | FAIL: `index.html: [cursor-global] ...` |
| `title` attribute on `#btn-ask` | FAIL: `index.html: [title-attr] a markup element has a title= attribute` |
| `data-sd-select` removed from `#tone-select` (3 native selects) | FAIL: `index.html: [select-native] native <select> not marked ...` (3 violations) |
| `confirm('Delete this capture?')` replacing `overlayConfirm` | FAIL: `index.html: [native-dialog] active confirm( / alert( / prompt( call` |
| `resizable: true` in `main.js` | FAIL: `main.js: [resizable-true] ...` (2 violations: also overlay-resizable) |

Inside the repo, the in-memory self-tests also prove the rules for: `style.cursor`, inline-style cursor, cssText cursor, `.title =`, `setAttribute("title")`, title in a JS template string, `createElement('select')`, `alert`/`prompt`/`window.confirm`, missing `setContentProtection(true)` (overlay, selection, and an extra unprotected window), `setResizable(true)`, `<a href>`, `window.open`, a second file input, `<input type=color>`, `<datalist>`, non-electron `require` in preload, `dialog.`/`Menu.buildFromTemplate`/`shell.` in main. They also prove commented-out code and `overlayConfirm(` do not false-positive.

## What changed (files)
- `stealth-ui.js` (new): UMD pure helpers (title to data-tip decision, tooltip/dropdown positioning, option snapshot/equality/keyboard nav, `clampResize`, `MIN_RESIZE` 380x300).
- `index.html`: global cursor rule first in the stylesheet; every other cursor declaration removed (CSS, 3 inline styles, 1 cssText); `textarea { resize: none }`; all 28 static `title` attributes plus the Gallery template and 3 JS assignments became `data-tip` (aria-label added to glyph-only controls); stealth block (tooltip, MutationObserver converter, custom select, `overlayConfirm`/`overlayNotice`); `data-sd-select` on the 3 selects; Gallery delete-one and clear-all use `overlayConfirm`; resume "Paste text instead" + hint, `loadResumeFile()` shared by both routes; resize grip + `initWindowResize`.
- `selection.html`: global cursor rule first; `cursor: crosshair` removed.
- `main.js`: overlay `resizable: false`; `setOverlayBounds()` (used by drag-move, compact on/off, resize); `overlay-resize-start/move/end` handlers; `lockNavigation()` (deny window.open, block navigation) on both windows; `overlayDot` flag; drag/resize state cleared on compact/dot changes.
- `preload.js`: `resizeStart/resizeMove/resizeEnd` (still only `require('electron')`).
- `package.json`: test script; `test/stealth-audit.test.js` (new).

Drag-anywhere logic is untouched: the grip carries `no-window-drag`, which the existing `INTERACTIVE` selector already excludes, so no edit to `initWindowDrag` was needed. The only drag-adjacent edit is that main's `overlay-drag-move` now calls `setOverlayBounds()` (same bounds on macOS; Windows self-heal only).

## Platform finding: setBounds/setSize on a non-resizable window
Not run live (no Electron launch allowed). Evidence:
- `node_modules/electron/electron.d.ts`: `resizable` is documented as "whether window is resizable" and `setResizable` as "whether the window can be manually resized by the user". `setBounds`/`setSize` carry no resizable caveat. The only documented limitation on `setSize` is Wayland (Linux), which this app does not target.
- macOS: Electron implements these via `NSWindow setFrame:`, which ignores the resizable style-mask bit. Windows: `SetWindowPos`, which ignores `WS_THICKFRAME`. This is from Electron's known behavior, not tested here.
- Known Windows caveats from the plan research: electron#27054 (non-resizable window can shrink on a DPI change) and #51244 (toggling `setResizable(true -> false)` inflates `getBounds()` on frameless windows). Mitigation: window is created `resizable:false` and never toggled, and `setOverlayBounds()` re-applies the bounds once on win32 if `getBounds()` width/height differ. The transient `setResizable(true)` fallback was therefore NOT used. If the live Windows check fails, the fallback is `setResizable(true)` inside `setOverlayBounds` only (the audit's no-`setResizable(true)` rule would need a narrow exemption).
- Not verified: macOS and Windows live behavior of compact panel, dot and grip with `resizable:false`.

## Must be verified live
1. No cursor change over any control: buttons, nav tabs, Gallery items and hover actions, summary/language list, inputs, textareas (no resize handle), disabled buttons, the edit canvas, drag areas, the grip, and while dragging/resizing. Also the region-selection screen (should be an arrow, not a crosshair).
2. No window-edge resize cursor on any edge or corner of the overlay.
3. Tooltips: appear about 400ms after hover and on keyboard focus, clamp inside the window, hide on click/scroll/blur; Gallery, Interview cards and modals (late nodes) get them; `document.querySelectorAll('[title]').length` is 0.
4. Dropdowns (Tone, Me, Them): open with click/ArrowDown, keys Enter/Space/Arrows/Home/End/Escape/typeahead work, outside click closes, long lists scroll; picking a value changes `toneSelect.value` and the next Ask/vision send uses it; device lists repopulate after Rescan and keep their selection on Start.
5. Confirm dialog: Gallery delete-one and Clear-all; Escape cancels without closing the edit modal; Tab stays inside; looks right over the edit modal and in compact mode.
6. Resume: upload still works; "Paste text instead" parses through the same path (loading text, success label, error message, Clear resets).
7. Resize grip: bottom-right, fixed top-left, stops at 380x300 and at the display work area, size persists after quit/relaunch, hidden in compact and dot modes. Pop out solution, Full overlay, minimize to dot and expand still resize correctly with `resizable:false`, on macOS and Windows (include dragging between monitors with different DPI on Windows).
8. Real stealth test: join Zoom/Meet/Teams, "share entire screen", watch from a second device, and hover/click everything (all tabs, dropdowns, tooltips, dialog, Gallery, edit modal, grip, region capture).

## Restart steps
Fully quit the overlay (Cmd+Q, or end the Electron process) and relaunch with `npm start`. A window reload is not enough because `main.js` and `preload.js` changed. No backend restart is needed.

## Residual risks
- The native file picker on "Upload Resume" is an OS dialog outside content protection and can be visible. The UI shows a hint to choose the file before sharing; "Paste text instead" avoids it entirely.
- The Dock/Cmd-Tab (macOS) or taskbar/Alt-Tab (Windows) presence of the app is not changed here.
- The OS-level mouse cursor is not part of the protected window: it is drawn by the OS and may be seen moving or hidden over the overlay area. We only guarantee its shape stays the default arrow.
- `<title>` of the document is kept (not an attribute tooltip).
- Disabled controls show no tooltip (browsers do not deliver mouse events to disabled buttons).
- Textareas lost their drag-to-resize handle (`resize: none`), a small deliberate behavior change for cursor safety.
- The audit is static text analysis: a tokenizer strips comments and keeps string/template contents, so it can miss exotic constructs (e.g. building an attribute name from concatenated strings).

## Select syncing (design notes)
`enhanceSelect()` keeps the real `<select>` in the DOM (class `sd-native`: visually hidden, `aria-hidden`, `tabindex=-1`, `data-enhanced`) and renders a `button[role=combobox]` plus a shared `#sd-list[role=listbox]` appended to `body` (`position:fixed`, so never clipped). A snapshot (`snapshotOptions`) of options/value/disabled is compared with `optionsEqual` so no-op renders are skipped. It re-syncs through three paths:
- A `MutationObserver` on the select (childList, subtree, characterData, and attributes `disabled`/`value`/`selected`/`label`) catches `fillDeviceSelect()` (`innerHTML = ''` then appends).
- Instance-level `value`/`selectedIndex`/`disabled` accessors delegate to the native `HTMLSelectElement.prototype` descriptors and then re-render, covering programmatic assignment (e.g. `toneSelect.value = ...`) that fires no DOM mutation. `.value`, `.options`, `.selectedIndex` otherwise behave natively.
- A `change` listener on the select.
User picks set `select.value`, then dispatch a bubbling `change` only when the value actually changed. Late-added `<select>` nodes are enhanced by the shared body MutationObserver.

## Resize (design notes)
Renderer grip (`#resize-grip`, class `no-window-drag`, Pointer Events with pointer capture): `resizeStart` on press, one `resizeMove` per animation frame, `resizeEnd` on release/cancel/lost capture/blur. `main.js` validates the sender with `isOverlaySender`, ignores the gesture while compact or in dot mode, reads the live cursor (`screen.getCursorScreenPoint()`), and applies `setBounds` with the start x/y fixed and size = start size + cursor delta, clamped by `StealthUI.clampResize` to a minimum of 380x300 and to the display work area. `resizeEnd` calls `saveWindowState()` (a no-op while compact). Since the window is `resizable:false`, Electron's `resized` event does not fire for programmatic changes, so persistence relies on that explicit save.
