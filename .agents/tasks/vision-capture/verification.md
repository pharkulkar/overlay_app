# Verification: direct OpenAI vision capture (iteration 2: renderer added)

## Commands and results (run this iteration)
- `cd screen_shot && .venv/bin/python -m pytest tests/ -q` -> 134 passed, 5 warnings
- `env -u OPENAI_API_KEY .venv/bin/python -c "import server"` -> import ok
- `cd overlay_app && node --check main.js` / `preload.js` / `vision-batch.js` -> all rc=0
- `npm test` -> 24 passed, 0 failed
- preload.js: only one real `require(` (line 1, `require('electron')`); other grep hits are comments
- Inline-script check (temp script, deleted): last inline `<script>` parses via `new Function`; every `getElementById('x')` has a matching `id="x"` (missing: none)
- `grep -c vision|initVisionCapture|VisionBatch|cm-vision index.html` -> 21 (was 0)

## Changed files
overlay_app:
- index.html: gear `#btn-settings`, `#settings-pop` (capture-mode radios), `#vision-popup` (thumb strip, Coding/Scenario radios, Add another / Send / Cancel), CSS, `<script src="vision-batch.js">`, `expandOverlay()` extracted from dot click handler (behavior unchanged), `initVisionCapture` IIFE. User/backend text only via textContent / DOM properties.
- main.js: `captureMode` (default 'ocr'), `set-capture-mode` IPC (whitelist), `routeCapture`, `deliverVisionCapture` (show if hidden, then send `vision-capture`). `sendToSolve` untouched.
- preload.js: `setCaptureMode`, `onVisionCapture`, `visionAsk` (only require('electron')).
- vision-batch.js (new): pure batch helpers.
- test/interview.test.js: 8 batch helper tests.
screen_shot:
- ai.py: `VISION_MODEL`, `VISION_SYSTEM_PROMPTS`, `_build_vision_messages`, `ask_with_images`.
- server.py: image decode/downscale helpers, `_save_vision_batch`, `POST /api/vision-ask`, `vision_model` in /api/health; this iteration: PNGs written for a batch are deleted if saving the record fails (review finding 4).
- tests/test_vision_ask.py (new): 22 tests, OpenAI stubbed.
No commits, no .env touched, daemon.py untouched.

## Endpoint contract
`POST /api/vision-ask` body `{images:[dataURL...], mode:'coding'|'scenario', tone?, language?, source_types?[]}` -> `{success:true, answer, record_id, image_count}`; errors `{success:false, error}` with 400 (invalid), 413 (too many/oversized), 502 (AIError), 503 (unconfigured), 500 (unexpected, or save failure which still includes `answer`). Record is created only after OpenAI succeeds. Env knobs: OPENAI_VISION_MODEL, VISION_MAX_IMAGES (6), VISION_MAX_SIDE (2000), VISION_MAX_IMAGE_BYTES (15MB).

## IPC / preload names
`set-capture-mode` (renderer->main, 'ocr'|'vision'), `vision-capture` {dataUrl, sourceType} (main->renderer); preload `setCaptureMode(mode)`, `onVisionCapture(cb)`, `visionAsk(images, mode, tone, language, sourceTypes)`; localStorage key `captureMode`.

## Mode flow
Settings radio -> localStorage + `api.setCaptureMode` (also pushed at startup) -> main `captureMode` -> hotkey capture calls `routeCapture`: 'vision' -> `deliverVisionCapture`, otherwise unchanged `sendToSolve` (local OCR).

## Minimized/hidden handling
Hidden (toggle hotkey): main calls `overlayWindow.show()` before sending. Minimized dot: renderer's `onVisionCapture` calls `expandOverlay()` (hides dot, shows card, `toggleOverlayMode(false)`) before showing the popup.

## Needs live user verification (not run: Electron/hotkeys not launched)
- Hotkey capture in vision mode shows the popup (also from hidden and from dot state)
- Add another image batching (up to 6, cap message, remove thumbs), Escape/Cancel
- Send: answer appears in Answer tab, error shown with batch kept on failure
- Gallery shows the new record (label "[Vision · mode · N images]")
- Local OCR mode still behaves as before

## Restart steps
Restart the backend (`python3 server.py`); fully quit and relaunch the overlay app (main.js/preload.js changed).
