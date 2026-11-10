# Settings sheet: coder notes

## Ran
- `node --check main.js preload.js interview.js ux-helpers.js capture-flow.js`: OK
- `npm test`: 38 passed, 0 failed (stealth audit, inline scripts compile, ids exist exactly once, new sheet assertion)
- jsdom is not in node_modules, so no DOM smoke test. No GUI run.

## Changes
- index.html (header, ~line 582): header opacity segmented control removed; gear `#settings-btn` added (aria-label, data-tip, aria-expanded, aria-controls). The commented [OCR-DISABLED] `#btn-settings` block is untouched.
- index.html (~607-645): new `#settings-sheet` (role=dialog, aria-label "Settings") inside `#overlay-card`, placed before the Answer view. It has a Close button and groups Language, Resume and Appearance.
- index.html (CSS ~222-230): added `#settings-sheet` and `.settings-group`. The sheet is absolutely positioned below the header and status slot, bottom-anchored, `overflow-y:auto`, so it scrolls inside the card at small sizes. `#overlay-card` gained `position: relative`. Focus-visible rule now covers `.icon-btn` and no longer lists `.iv-setup > summary`.
- index.html (JS, after the opacity code): gear toggles the sheet. Close button and Escape (when not already handled) close it. Focus goes to Close on open and back to the gear on close.
- index.html (Interview tab): `#iv-setup` details row and its CSS (`.iv-setup > summary`, `.iv-setup-body`) deleted.
- test/stealth-audit.test.js: one new test (sheet and gear exist once; lang/roman/resume/opacity controls are inside the sheet; `iv-setup` is gone).

## Moved, not duplicated (ids unchanged)
`iv-langs`, `iv-lang-summary`, `iv-langs-list`, `iv-roman`, `iv-cv-input`, `iv-cv-btn`, `iv-cv-paste-btn`, `iv-cv-label`, `iv-cv-clear`, `iv-cv-hint` (the file picker privacy tip), `iv-cv-paste` and its children, and `op-glass`, `op-dim`, `op-solid`.

## Removed
The Interview "Setup" summary row, and the header opacity control (now in the sheet).

## Decisions and ambiguities
- Branch is `Version_3.0`, not `ObservationsAtul`. I did not switch branches. Nothing was committed.
- There was no existing "disabled while running" logic for languages (`setControls` only toggles start/pause/stop), so none was added.
- No text mentioning "Setup" or the old location exists in index.html, interview.js, README or features.md (grep), so none changed.
- The language dropdown list is absolutely positioned inside the scrolling sheet, so it scrolls with the sheet.
- The sheet does not trap Tab. Escape does nothing extra if a handler already called preventDefault.
- No animation was added.

## Unverified
Visual layout, the language dropdown inside the scrolling sheet, and focus behaviour in Electron (no GUI run, no jsdom).

## Review round 1 fixes
- index.html CSS (~223-229): `#settings-sheet` is now in-flow (`flex:1; min-height:0`, scrolls inside) instead of absolute with magic-number top/bottom. Added `#settings-sheet:not(.hidden) ~ .view { display:none !important; }` so the sheet takes the views' space while open; header, tabs, first-run banner, status line and hotkey strip stay visible and uncovered.
- Removed the `position: relative` I had added to `#overlay-card` (a pre-existing one at ~481 remains).
- Language dropdown list still scrolls with the sheet (possible clip, unverified in Electron; no GUI/jsdom).
- Re-ran `node --check` (all OK) and `npm test`: 38 passed, 0 failed.
