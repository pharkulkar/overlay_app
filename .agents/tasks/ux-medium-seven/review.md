# Review: seven medium UX changes (M1-M7)

All seven items are present on disk. No new dependencies, new windows, native dialogs, tooltips or sounds were found. The preload gains exactly one line, and main.js gains one read-only IPC. The stealth audit passed on a spot-check re-run, and the coder's evidence (syntax checks, 59 interview tests, 37 stealth tests) is present.

**Watch for:** the sticky bar and small-window rules were not visually rendered by anyone (possible). `loadHealth()` now runs at launch (confirmed, deliberate). Tone left the Answer tab (confirmed, deliberate). **Verdict**: APPROVED

## High-level view

Interview is the default tab, split into a run row and a collapsed Setup. A single toggle replaces Pause and Resume. The ids for tone, languages and resume are unchanged.

One body-level aria-live status line sits above the edit modal. It replaces the modal's own status and the Answer label, and no toast queue was added.

The edit-card action bars are sticky. Opacity is a three-button aria-pressed control driven by a CSS variable and persisted in localStorage. Tabs have full ARIA roles and keyboard navigation through the existing click path. The consent banner gained the hotkey line and three live checks through a read-only IPC.

<details>
<summary>Issues (2)</summary>

1. **Layout unverified visually** (possible) - sticky bar, status-line offset and the 560px rules were only reasoned about. Open once in Electron to confirm.
2. **Startup health call** (confirmed, informational) - a missing OpenAI key now shows at launch rather than on the Interview tab. This matches the new default tab.

</details>

<details>
<summary>Details</summary>

## Status line fed from existing paths
The line is a sibling of the card at z-index 2500, above the modal at 2000. It is fed by the outer setStatus, notifyMain, showCaptureError and checkBackend. The `edit-status`, `answer-status` and dead `showBusy` were removed, and no active JS references them. The stealth audit's id-uniqueness check passes.

## Pause/Resume toggle
`#iv-resume` was removed with its references. The single `#iv-pause` toggles via `IV.isPaused()`, is disabled when stopped, and swaps label and data-tip.

## Opacity
The alpha is applied from localStorage during parsing, before the listeners. Glass equals 0.78, matching the previous background. Invalid stored values fall back to glass.

## First-run banner
There is still one "Got it" button. The hotkey line copies the footer strip text, so the strings are not duplicated. Permission status is read-only through `getMediaAccessStatus`, with non-darwin platforms returning not-required. No prompts are triggered.

</details>

<details>
<summary>File map</summary>

- index.html - all UI, CSS and renderer logic for M1-M7
- main.js - read-only get-permissions IPC
- preload.js - getPermissions bridge line
- ux-helpers.js - normalizeOpacity, describePermission
- test/interview.test.js - two added tests

</details>
