# Verification: capture opens the edit screen directly

## Commands run (all from the overlay_app root)
| Command | Result |
|---|---|
| `node --check main.js preload.js capture-flow.js vision-batch.js` | OK, no output (main.js/preload.js untouched) |
| compile every inline `<script>` of index.html (2 blocks) and selection.html (1 block) with `vm.Script` | all compile |
| script: every id used by ACTIVE JS (`getElementById('..')`, `$('..')`, comment lines excluded) occurs exactly once in markup with HTML comments stripped | 102 ids checked, 0 problems |
| `npm test` | `test/interview.test.js`: 55 passed, 0 failed (37 baseline + 18 new). `test/stealth-audit.test.js`: 37 passed, 0 failed |

Electron and servers were not launched. Nothing below "Live checks" was exercised in a running app.

## Grep audit: no active reference to the disabled popup
Pattern: `vision-popup | 'vp- | vm-coding (not edit-vm-coding) | vm-scenario | name="vision-mode" | renderPopup | openPopup | closePopup | cancelBatch | vmRadios`

| Hit location | Status |
|---|---|
| CSS lines ~359-361 | inside the older `[OCR-DISABLED]` CSS comment |
| CSS lines ~364-396 | inside the `[VISION-POPUP-DISABLED]` CSS comment |
| markup lines ~815-822 | inside the `[VISION-POPUP-DISABLED]` HTML comment |
| JS in `initVisionCapture` | every line prefixed `// [VISION-POPUP-DISABLED]` |
| any other (active) location | none (also asserted by the new test "index.html: capture-flow wired, popup retired", which strips HTML/CSS comments and `//` lines) |

## Files changed and why
- `capture-flow.js` (new): pure UMD decision logic (`onCapture`, `canStage`, `stageCurrent`, `loadCurrent`, `removeStaged`, `closeKeepStaged`, `discard`, `markSent`, `setBusy`, `imagesToSend`, `normalizeLastMode`, `sendLabel`, `countLabel`). Uses VisionBatch.
- `index.html`: staged strip markup/CSS in the edit modal, `<script src="capture-flow.js">`, fresh-capture mode inside `initEditModal` (`window.openFreshCapture`), `initVisionCapture` reduced to a dispatcher, popup markup/CSS/JS commented out with `[VISION-POPUP-DISABLED]`.
- `test/interview.test.js`: 18 new tests (17 helper tests + 1 static index.html test). `package.json` unchanged (script already runs this file).
- Not touched: main.js, preload.js, vision-batch.js, screen_shot/, .env, backend.

## State machine (`flow = { mode, staged, current, busy, sent }`)
- closed --capture--> fresh (`open-fresh`; staged kept, may be non-empty after "Add another"). Staged already 6 -> `full` message.
- fresh idle --capture--> fresh (`stage-and-replace`: edited canvas, downscaled <=2000px, appended to staged; new capture loaded). If staged+2 > 6 -> `full`, nothing dropped.
- fresh sent --capture--> fresh (`replace-sent`: replaces the answered image, no staging, answer cleared).
- fresh busy --capture--> `defer`: one pending slot (latest wins), opened in the send `finally`.
- record --capture--> fresh (`replace-record`, staged []).
- fresh --"Add another screenshot"--> closed, staged kept, current dropped.
- fresh/record --Close | Escape | backdrop--> closed, staged/current/pending discarded (in fresh+busy it is refused with "Press Stop first, then close.").
- fresh --send ok (or answer with save error)--> fresh, `sent=true`, staged cleared, modal stays open. Cancel/failure: all kept, busy cleared.
- `openEditModal` (record) --> mode record, staged cleared, fresh UI reset, radios back to Coding. A `gen` counter makes late responses from a replaced session only refresh the Gallery.
- Compact panel hiding/restoring only toggles the `open` class on the modal; `flow` is never touched.

Send: `[staged..., current canvas]` in ONE `api.visionAsk(images, mode, tone, undefined, sourceTypes, requestId)`; button label "Get solution (N images)"; last mode stored in `localStorage['visionMode']` and preselected on open. Ctrl/Cmd+Enter sends in fresh mode when idle.

## How the popup was retired / restored
Markup, CSS and handlers in `initVisionCapture` are commented out; every disabled block carries `[VISION-POPUP-DISABLED]`. To restore: `grep -n "VISION-POPUP-DISABLED" index.html`, uncomment those blocks, and make `onVisionCapture` call the popup again instead of `window.openFreshCapture` (VisionBatch is still loaded).

## Live checks still required (not run)
- Hotkey capture opens the editor immediately with the overlay hidden, as the dot, and while the compact solution panel is showing; image fits the frame; Reset Image restores the capture.
- Draw, Crop, Apply Crop.
- Add another screenshot: editor closes, next capture shows the strip with 1 thumb and "Get solution (2 images)"; remove button works.
- Rapid double capture auto-stages the first image.
- Send with several images yields ONE Gallery record; Pop out solution works.
- Stop mid-send: "Cancelled.", edits and staged list intact.
- Error path keeps everything for retry; answer plus save error case.
- Escape, Close and backdrop discard the batch (reopen shows no strip).
- Ctrl/Cmd+Enter sends; last mode preselected.
- Gallery Edit of saved image, manual and audio records unchanged (no strip, original button text, OCR-disabled layout).
- Closing the compact panel re-opens the editor in both modes.

## Restart
Fully quit and relaunch the overlay app (renderer files changed). Backend restart is not needed.

## Residual risks
- Memory: six large PNG data URLs (staged are downscaled to <=2000px, the current is not until send) plus the canvas.
- A staged image that was captured but not yet loaded when the next capture arrives is staged as the raw capture (not downscaled).
- Focus: `btnVision.focus()` runs on open, falling back to the card. Whether the OS gives the window keyboard focus when it is shown by a hotkey while another app is focused is existing main.js behavior, unchanged and unverified here, so Ctrl/Cmd+Enter may need a click first in that case.
- The `full` message with the editor closed goes to the main status line.
- A capture that arrives during a send is queued, not shown, until the send finishes.
