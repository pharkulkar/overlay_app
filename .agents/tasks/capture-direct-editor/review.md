# Screenshot capture opens the edit modal directly

Hotkey and on-screen captures now call `window.openFreshCapture`, which opens the existing edit modal in a "fresh" mode with the capture drawn on the canvas and no backend call until send. Batch/staging decisions live in the new pure UMD helper `capture-flow.js` (built on `VisionBatch`, cap 6 including the current image). The old vision popup is commented out under `[VISION-POPUP-DISABLED]`. `main.js`, `preload.js`, backend and `.env` are untouched (git status shows only `index.html`, `test/interview.test.js`, `capture-flow.js` and the task dir).

Watch for: (1) Close/Escape/backdrop are refused while a fresh send is in flight (status "Press Stop first, then close.") rather than discarding; this deviates slightly from "close discards" and slows a panic-dismiss (confirmed, `closeModal`). (2) Nothing was exercised in a running Electron app; the evidence lists live checks as not run (confirmed, verification.md). (3) Ctrl/Cmd+Enter is bound on the modal element, so it needs keyboard focus inside the modal; focus after a hotkey capture while another app is active is unverified (possible).

**Verdict**: APPROVED

## High-level view

Capture routing is a small dispatcher over `CaptureFlow.onCapture`, which returns an action (open-fresh, stage-and-replace, replace-sent, replace-record, defer, full, ignore) and the caller applies it. This keeps the branching testable without DOM. Staged images are downscaled edited canvases; the current image is only converted at send/stage time. Send builds `[staged..., current]` with parallel sourceTypes into one `visionAsk`.

Session isolation relies on a `gen` counter so late responses from a replaced or closed session only refresh the gallery. Record-mode `openEditModal` fully resets fresh state (staged, labels, radios), and the compact panel only toggles the `open` class so flow state is untouched.

Stealth rules hold in the new code: tooltips use `data-tip`, thumbnails set `draggable = false`, content is written via `textContent`, no native dialogs, no cursor rules added. The only `title=` hit is inside an OCR-disabled HTML comment.

## Issues (3)

1. **Close refused while busy** — Close/Escape/backdrop do nothing but show a status while a fresh send runs; consider allowing close (cancel the request then discard) or document it. Non-blocking.
2. **Live behavior unverified** — Hotkey-to-editor, Stop, rapid double capture, compact restore and focus for Ctrl/Cmd+Enter were not run in Electron; run the listed live checks before shipping. Non-blocking.
3. **Un-downscaled staged fallback** — If the next capture arrives before the current one finished loading, the raw capture is staged without downscaling (possible memory growth, acknowledged by the author). Non-blocking.

<details>
<summary>Details</summary>

### Close semantics during an in-flight send

`closeModal` returns early when `flow.mode === 'fresh' && flow.busy`. All other close paths discard current, staged and the pending capture, bump `gen`, and reset the fresh UI as required. The busy refusal avoids orphaning a request, and Stop is available in the loader, but Escape appearing dead during a request may surprise a user who wants to hide the screen quickly (confirmed in code).

### Capture while a send is running

A capture arriving during a fresh send is held in a single `pendingCapture` slot (latest wins) and opened in the send's `finally`. Earlier queued captures are dropped silently. This is an acceptable trade-off but means a rapid third capture replaces the second (confirmed).

### Evidence gap

Unit tests (55 and 37 passing per the evidence) cover the helper and a static check that index.html has no active popup references. Not tested: the DOM wiring in `openFreshCapture`, `sendFresh` and `btnAddShot`, the Stop path, and compact-panel restore in either mode.

</details>

<details>
<summary>File map</summary>

- `capture-flow.js` (new): pure state/decision helper.
- `index.html`: staged strip markup/CSS, fresh mode in `initEditModal`, dispatcher in `initVisionCapture`, popup retired.
- `test/interview.test.js`: 18 new tests.
- Full diff: `git diff` plus untracked `capture-flow.js`.

</details>
