# Stealth-safe hover and interaction: global default cursor, in-overlay UI, IPC resize grip

The change removes every OS-drawn hover cue from the overlay. It forces `cursor: default !important` globally in both HTML files, replaces `title` tooltips with an in-overlay tooltip, replaces native selects and confirm dialogs with in-overlay widgets, and sets the overlay to `resizable:false`. A bottom-right grip drives resizing through IPC, and a static audit test plus a UMD helper (`stealth-ui.js`) guard against regressions. The coder's verification record shows `npm test` passing (interview 32/32, stealth-audit 37/37). It also shows the audit failing on five scratch-copy violations. I re-ran only the audit test as a spot check and it passed.

Watch for: (1) the live macOS and Windows behavior of `setBounds` on a non-resizable window is unverified and documented as such (possible, low risk); (2) the native file picker for resume upload is still outside content protection (acknowledged, mitigated by the paste-text route).

**Verdict**: APPROVED

## High-level view

Cursor safety is handled once, globally, at the top of both stylesheets. Every other cursor declaration was removed, and the audit enforces this.

Tooltips, selects and confirms all stay inside the protected window. A title-to-`data-tip` converter with a MutationObserver feeds a fixed-position, non-interactive tooltip. Selects are hidden but kept, with a combobox/listbox layered over them and re-synced on mutation. Confirm is promise-based and sits above the edit modal.

Resizing moved from the OS to an in-window grip. Main validates the sender, reads the live cursor, clamps to the minimum size and the work area, ignores the gesture in compact and dot modes, and persists through `saveWindowState`.

Existing work (drag-anywhere, compact panel, `[OCR-DISABLED]` tags) is intact. `preload.js` still requires only `electron`. No new BrowserWindow, native menu, dialog or shell call was added, and the backend is untouched.

<details>
<summary>Issues (2)</summary>

1. **setBounds on non-resizable window unverified live** (possible) — run the live macOS/Windows check listed in verification.md before release. Keep the `setResizable(true)` fallback in mind for Windows.
2. **Native file picker visible when sharing** (confirmed, acknowledged) — informational. The hint text and the paste route mitigate it.

</details>

<details>
<summary>Details</summary>

## Resize without OS edges
The window is created `resizable:false`, so no edge-resize cursors exist. The grip carries `no-window-drag`, so it is excluded from drag-anywhere. Start, move and end handlers all check `isOverlaySender`, and start/move are no-ops while compact or in dot mode. The remaining risk is Windows-specific behavior with non-resizable frameless windows (electron#27054, #51244). The code re-applies the bounds once on win32 if they differ, but this has not been exercised live.

## Spot checks
`index.html` has one active `cursor` rule. The other `cursor` and `title=` matches are inside CSS or HTML comments, including `[OCR-DISABLED]` blocks. The `innerHTML` assignments with dynamic content predate this change.

</details>

<details>
<summary>File map</summary>

- index.html: stealth block, cursor rules, data-tip, select enhancer, overlayConfirm, resume paste, grip
- selection.html: global cursor rule
- main.js: resizable:false, setOverlayBounds, resize IPC, navigation lock
- preload.js: resize wrappers
- package.json: test script runs both test files
- stealth-ui.js: new UMD helpers
- test/stealth-audit.test.js: new static audit

</details>
