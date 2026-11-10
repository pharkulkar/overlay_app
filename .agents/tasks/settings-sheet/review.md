# Settings sheet for language, resume and opacity controls

Adds a header gear that toggles one in-card Settings sheet. The language selector, English-letters checkbox, Resume controls and Glass/Dim/Solid opacity control were moved into it with their ids unchanged. The Interview "Setup" row and its CSS were removed, and one test was added. Header, tabs, status line, hotkey strip and first-run banner stay visible while it is open.

Watch for: switching tabs while the sheet is open shows no visible change (likely, non-blocking); the language dropdown may clip inside the scrolling sheet (possible, unverified without a GUI).

**Verdict**: APPROVED

## High-level view

The sheet is an in-flow flex child of the card, placed before the views. A sibling rule hides the views while it is open, so it takes the views' space and never covers the header, tabs, banner or strips. Focus goes to Close on open and back to the gear on close. Escape closes it unless another handler already consumed the key.

Nodes were moved, not copied: each id appears once, and interview.js is untouched. The opacity control moved from the header into the sheet. No new settings, dependencies, windows, native dialogs, title tooltips or native selects were added. The commented [OCR-DISABLED], [VISION-POPUP-DISABLED] and [AUDIO-TAB-DISABLED] blocks are untouched. I ran `node --check` on the five files, and it passed. `npm test` reports 38 passed and 0 failed.

<details>
<summary>Issues (3)</summary>

1. **Tab click while open is a no-op** (likely, non-blocking) — the tab selection changes but the sheet keeps hiding the views. Optionally close the sheet on tab change. Not required.
2. **Language dropdown inside scrolling sheet** (possible) — the absolutely positioned list may clip at the sheet bottom. Check it once in Electron.
3. **Stale CSS comment placement** (confirmed, trivial) — the "Multi-select language dropdown" comment now sits below the `.settings-group` rule.

</details>

<details>
<summary>Details</summary>

### Sheet placement and focus

The gear sits after the tabs in DOM order and has aria-label, data-tip, aria-expanded and aria-controls. The sheet has role=dialog and an aria-label, and there is no animation. At small sizes it scrolls inside the card via `overflow-y:auto` and `min-height:0`. The Escape listener checks `defaultPrevented`, so the capture-editor and dialog Escape handlers, which call preventDefault or stopPropagation, take precedence. The sheet does not trap Tab, so it works as an inline region.

### Behaviour preserved

The languages control had no "disabled while running" logic in the base branch. grep finds no `disabled` in interview.js, so nothing was lost. No user-visible text referenced "Setup". The privacy tip hint and the paste flow ids are intact. The new test asserts that the controls live inside the sheet and that `iv-setup` is gone.

### Not verified

There was no GUI run and no jsdom here. Visual layout, focus return in Electron and the dropdown clipping are untested. The branch is Version_3.0, not ObservationsAtul. Nothing was committed. The backend repo shows no changes.

</details>

<details>
<summary>File map</summary>

- index.html: gear, sheet markup, CSS, toggle JS, Setup row removed
- test/stealth-audit.test.js: one new sheet test

Full diff: `git diff` in overlay_app.

</details>
