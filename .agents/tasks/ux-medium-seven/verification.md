# Verification: ux-medium-seven (M1-M7)

No review.json existed, so this was a from-scratch implementation. Nothing was committed.

## Per item
- M1 Interview default and Setup: `index.html` header tabs reordered (Interview first, active), `view-interview` visible, `view-answer` hidden, `currentView='interview'`. RUN row is Start, one `#iv-pause` toggle, Stop, Clear. A collapsed `<details id="iv-setup">` holds Languages, English letters, Tone, and the Resume controls plus the file-picker tip and the paste block. `#iv-resume` and `el.resume` are removed. `setControls()` switches the label and `data-tip` between Pause and Resume. `loadHealth()` now runs at startup.
- M2 Status line: one `<div id="status-line" aria-live="polite">` sits as a body-level sibling right after `#overlay-card` (z-index 2500, above `#edit-modal` at 2000). An empty `.status-slot` reserves space in the card. The outer `setStatus` writes to it and the header dot changes only when a state is passed. Errors and untyped messages stay until replaced. `ok` and `idle` text clears after 6s. The modal's inner `setStatus`, `#edit-status`, `statusEl`, dead `showBusy` and the `#answer-status` id are deleted. `showCaptureError` now shows the real message, which covers hotkey failures.
- M3 Sticky action bar: `#edit-vision-box` is now a `div.edit-bar` (was a fieldset) holding the radios, `#edit-add-shot` and Get solution, plus a Ctrl/Cmd+Enter hint. The Get Answer row is also `.edit-bar`. Both use `position: sticky; bottom: 0` inside `#edit-body`, with `#edit-image-tools {display: contents}`. The modal has top padding so the card clears the status line. `#edit-add-shot` is shown only in fresh mode. `capture-flow.js`, the batch cap of 6 and the Escape handling are untouched.
- M4 Opacity: three `.seg-btn` buttons (`#op-glass`, `#op-dim`, `#op-solid`) with `aria-pressed` in the header. They set `--card-alpha` on `#overlay-card` (0.78 / 0.9 / 1). The choice is stored in `localStorage` under `overlayOpacity` and applied by script B during parsing, before first paint. `normalizeOpacity` lives in `ux-helpers.js`. `#compact-view` has its own background and was left alone.
- M5 Small windows: two media blocks at the end of the CSS. At max-width 560px: title hidden, tighter tabs, 2-column gallery, `.lbl` text hidden on icon buttons, smaller hotkey strip. At max-height 560px: smaller textareas, canvas and transcript, and a scrollable consent banner.
- M6 Tabs: `role=tablist`, `role=tab` with `aria-selected`, `aria-controls` and roving `tabindex`, and `role=tabpanel` with `aria-labelledby` on all four views. `showView` sets the aria state and tabindex. One keydown listener handles Left/Right (wrapping), Home and End, and calls `click()` so the lazy Audio and Interview listeners still run. `:focus-visible` outlines were added.
- M7 First-run banner: `#consent` keeps its text and the single "Got it" button. It now also shows the hotkey line (copied from `#hotkey-strip` text, so no duplicated strings) and three rows: Backend (from `checkBackend`), Microphone, Screen Recording. Permissions come from the new read-only `ipcMain.handle('get-permissions')` in `main.js` (`systemPreferences.getMediaAccessStatus`, macOS only; other platforms return `not-required`). `preload.js` gets one line, `getPermissions`. `describePermission` in `ux-helpers.js` maps status to text.

## Other files changed
`ux-helpers.js` (+2 helpers), `main.js` (+1 IPC, +`systemPreferences` import), `preload.js` (+1 line), `test/interview.test.js` (+2 tests: helper tests and an HTML contract test).

## Commands and results
- `node --check main.js preload.js interview.js audio.js ux-helpers.js capture-flow.js`: OK.
- `npm test`: interview tests 59 passed, 0 failed. Stealth audit 37 passed, 0 failed. This includes the inline-script compile check and the "every id referenced by active JS exists exactly once" check.

## Verified vs only statically verified
- Verified by running: syntax, unit tests, the stealth audit (cursor rule, no `title=`, no native select, one file input, preload requires only electron), and inline script compilation.
- Static trace only. jsdom is not installed (and was not installed), and Electron was not launched.
  - Default tab: Interview has `active`, `aria-selected=true` and `tabindex=0`, the other views are `hidden`, and `loadHealth()` runs at init.
  - Pause/Resume: the button is disabled while stopped. Running shows "Pause". A click calls `IV.pause()`, `isPaused()` becomes true, and the label becomes "Resume". Another click calls `IV.resume()`. Stop resets the paused state and disables the button.
  - Tab keys: Right on the last tab wraps to the first, Home and End work, and the roving tabindex is updated in `showView`.
  - Opacity: clicking Dim sets `--card-alpha` to 0.9, updates `aria-pressed` and stores `dim`. On reload the stored value is applied before the listeners run. An invalid value falls back to glass.
  - Status line with the modal open: the line is a body sibling above `#edit-modal`, and the modal's old `setStatus` calls now resolve to the outer one.
  - Sticky bar and small-window layout: not rendered, so not visually confirmed. Please eyeball them once in Electron.

## Decisions
- Tone relocation: the Answer tab no longer shows a Tone control. The single `#tone-select` now lives in Interview > Setup. Its id, the `toneSelect` const and every reader (Answer, Interview, `setTone` to main) are unchanged. This is a visible change.
- Status-line sources: the outer `setStatus`, all former modal `setStatus` calls, `notifyMain` (staged/queued/limit messages), `showCaptureError` and hotkey failures, and `checkBackend`. Generic labels were reworded: `Answer ready`, `Cached answer`, `No OpenAI key set`.
- Removed ids: `iv-resume`, `edit-status`, `answer-status`. Added ids: `status-line`, `op-glass`, `op-dim`, `op-solid`, `iv-setup`, `consent-hotkeys`, `consent-checks`, `chk-backend`, `chk-mic`, `chk-screen`.
- Startup `loadHealth()`: the Interview tab is now the first tab, so health is loaded at launch. A missing OpenAI key therefore shows up earlier.
- The file-picker privacy tip is kept at the same size but now sits inside the collapsed Setup.
- Temp files in `/tmp` were deleted.
