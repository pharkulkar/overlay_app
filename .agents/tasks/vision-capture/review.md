# Direct OpenAI vision capture mode (settings toggle, send popup, /api/vision-ask)

Adds a capture-mode setting (Local OCR default, or send image directly to OpenAI). In vision mode the hotkey capture opens an in-overlay popup with a thumbnail strip, Coding/Scenario radios, and Add another / Send / Cancel. The batch goes to a new `POST /api/vision-ask` that downscales with PIL, calls `ai.ask_with_images`, and stores one record with one answer_history entry. Mode flows settings -> localStorage -> IPC -> main, and is pushed at startup. Verification evidence is present and was not re-run (backend 134 passed, npm test 24 passed, syntax/id checks).

Watch for: (1) a post-OpenAI save failure returns 500 with `answer`, but the renderer shows only "Failed" and discards the answer (confirmed, non-blocking). (2) The popup was not visually verified because Electron was not launched (confirmed, needs live check). (3) Modified `logs/daemon.log` and an untracked screenshot PNG in screen_shot are runtime artifacts of the user's running daemon, not part of this change (likely; do not commit them).

**Verdict**: APPROVED

## High-level view

Local OCR stays the default and the original path. `routeCapture` in main.js delegates to the unchanged `sendToSolve` unless `captureMode === 'vision'`. `set-capture-mode` whitelists 'ocr' or 'vision'. preload.js still requires only 'electron'.

For hidden windows, main calls `show()` before sending. For the minimized dot, the renderer calls `expandOverlay()`, extracted from the dot click handler. Splitting the work this way avoids a double-resize race.

The popup is built with DOM properties and textContent, so user and backend text is never injected as HTML. It has a staged-thumbnail strip with per-item remove, radios defaulting to coding, a batch cap with a message, a busy state that disables controls, and a capture-phase Escape that cancels. On failure the real error is shown and the batch is kept. On success it switches to the Answer tab and refreshes the Gallery.

The backend validates in order: 503 when unavailable, 400 for bad JSON, images or mode, 413 for too many or oversized images, 502 for AIError, and 500 with a generic message for anything unexpected, with no stack traces. Images are decoded and downscaled to PNG, `ask_with_images` uses the lazy client, `_wrap_openai_errors`, tone and language, and a record is created only after OpenAI succeeds. There is no DB schema change.

<details>
<summary>Issues (3)</summary>

1. **Save-failure answer dropped in UI** (confirmed, non-blocking) — on a 500 that includes `answer`, the renderer shows only "Failed: ...". Consider displaying `data.answer` when present.
2. **Popup not live-verified** (confirmed, non-blocking) — hotkey, hidden and dot states, batching and Escape need a manual run after restarting backend and overlay.
3. **Stray runtime artifacts in screen_shot** (likely, non-blocking) — `logs/daemon.log` and `screenshots/2026-11-06/capture-...png` are daemon byproducts. Exclude them from any commit.

</details>

<details>
<summary>Details</summary>

## Failure semantics after OpenAI succeeds

In `api_vision_ask`, the record is saved after the answer is obtained. If saving fails, written PNGs are deleted, so no orphans remain, and the 500 body carries `answer`. The renderer's `else` branch reads only `data.error`, so the user loses a paid answer and sees an error. The batch is kept, so a retry works but costs another call.

## Test coverage

Backend: tests/test_vision_ask.py has 16 test functions (some parametrized), with OpenAI stubbed. They cover message structure and modes, error wrapping, single and three-image success with one record and one call, 400 cases, 413 count and size, 502 for AIError, raw client exceptions and an unconfigured key, a generic 500, downscaling, and tone and language passthrough. Frontend: 8 pure batch-helper tests in test/interview.test.js. Not tested: the popup DOM, the main.js routing and IPC, and the show-from-hidden path, because Electron was not run.

## Scope hygiene

No `.env` changes and no commits. daemon.py and the Interview/Audio code are untouched. Changed files are index.html, main.js, preload.js and vision-batch.js (new) plus test/interview.test.js in overlay_app, and ai.py, server.py and tests/test_vision_ask.py in screen_shot.

</details>

<details>
<summary>File map</summary>

- overlay_app/index.html: settings gear and popover, vision popup, expandOverlay extraction, initVisionCapture
- overlay_app/main.js: captureMode, routeCapture, deliverVisionCapture, set-capture-mode IPC
- overlay_app/preload.js: setCaptureMode, onVisionCapture, visionAsk
- overlay_app/vision-batch.js: pure batch helpers
- overlay_app/test/interview.test.js: batch helper tests
- screen_shot/ai.py: vision prompts and ask_with_images
- screen_shot/server.py: image helpers, /api/vision-ask, vision_model in health
- screen_shot/tests/test_vision_ask.py: endpoint and ai tests

Full diff: `git -C <repo> diff`

</details>
