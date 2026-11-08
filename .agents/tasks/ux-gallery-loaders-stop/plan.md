# Implementation Plan: auto-updating Gallery, loaders, Stop button

Constraints for the implementer: edit in place; do NOT commit, switch branches, revert or reformat. `overlay_app` is a git repo with uncommitted changes to index.html, main.js and preload.js, so add to those files and never rewrite them. `screen_shot` is not a git repo. Do not read or touch any `.env`. Do not launch Electron or a server. preload.js may only `require('electron')`. Do not change `daemon.py`, the Interview/Audio tab logic, `initWindowDrag`, or `initSolutionPanel`.

Paths: FE = `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app`, BE = `/Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot`.

## Findings from reading the code (these drive the decisions)
- `loadGallery()` (index.html ~L1107) always writes "Loading…", re-fetches `api.listRecords()` (500 rows) and rebuilds `galleryGrid.innerHTML`. It is called from showView('gallery'), #gallery-refresh, clear/delete, and after ask/OCR/vision. `api.onOcrReady` (~L1080) does NOT call it, which is why hotkey captures stay invisible. Vision-mode captures only appear after Send succeeds, which already calls it.
- The `listRecords` preload wrapper takes no args. `GET /api/records` already supports `limit` and `offset`, so no backend change is needed for polling. Records have no `updated_at` column (id, created_at, source_type, input_ref, extracted_text, answer, status). The cheap newest-record signature is therefore `id|status|answer?1:0`.
- Backend `/api/ocr-only` saves and creates the record before OCR. `/api/vision-ask` persists only after OpenAI. `/api/ask` persists after OpenAI, either on the existing record_id or by creating a "manual" record. On AIError with a record_id it sets status "error". The cancel check must go before any of this.
- `api_ask` has a streaming branch (stream=true, SSE). The overlay never uses it, so `request_id` is honored only on the non-streaming JSON path. Document this in a comment.
- `server.py` has `/api/interview/<id>/cancel`, but no `/api/cancel`, so there is no route conflict. Modules are bound as `ai_helper` and `db_layer`. Tests monkeypatch `ai._get_client` or `ai.ask_with_images`. See the fixtures in `tests/test_vision_ask.py` (db `_conn`/`DB_PATH` reset, `server.SHOTS_DIR`/`server.ROOT` pointed at tmp_path).
- The edit modal has its own local `setStatus(msg)` writing `#edit-status` (a span in `.actions`). The Answer tab's `setStatus(label, state)` writes `#answer-status`. The vision popup uses `#vp-msg` (role=status). `.act-btn`, `.muted` and `@keyframes pulse` already exist. `initWindowDrag` skips `button`, so Stop buttons are safe.

## Design decisions
1. Pure logic goes in a new UMD module `ux-helpers.js` (same style as vision-batch.js: `window.UxHelpers` or `module.exports`). It holds the gallery signature, changed-check, poll-guard, request-id and cancel-result helpers. It is node-testable.
2. The spinner is built once in index.html as `createLoader(label, onStop)` plus `showLoader(container, label, onStop)`. It needs the DOM, so it stays in index.html and is not unit tested. Dynamic text goes in via `textContent` only.
3. Cancellation is client-side first: the wrapper resolves `{success:false, cancelled:true, error:'Cancelled'}` as soon as the AbortController fires. The backend registry only prevents persistence. Cancelled backend responses use HTTP 200 with that body. 499 is nonstandard, and the client discards the body anyway, so one status is simplest.
4. Polling asks for `listRecords(1, 0)` every 3000 ms (a few hundred bytes). It does a full silent reload only when the newest-record signature changed. Trade-off: a deletion or status change of an older record made by something other than the overlay is not seen until focus, tab open or Refresh. Overlay-originated changes already trigger `loadGallery()`. This is accepted and documented in a comment.

## Backend (BE) steps

- [ ] 1. Add a cancellation registry and `POST /api/cancel` in `BE/server.py`.
      Near the other helpers, before `api_ask` (~L1212), add `_CANCEL_MAX = 1000`, `_cancelled = OrderedDict()` (import `from collections import OrderedDict`; `threading` is already imported), `_cancel_lock = threading.Lock()`, and `_REQUEST_ID_MAX_LEN = 128`.
      Add helpers:
      - `_valid_request_id(v)`: a str that is non-empty after strip and at most 128 chars, else None.
      - `_mark_cancelled(rid)`: add under the lock, refresh position if already present, and evict oldest-first with `popitem(last=False)` while `len > _CANCEL_MAX`.
      - `_consume_cancelled(rid)`: under the lock, pop and return True if present, else False. This clears the id once handled.
      - `_cancelled_response()`: returns `jsonify({"success": False, "cancelled": True, "error": "Cancelled"}), 200`.
      Add route `@app.route("/api/cancel", methods=["POST"]) def api_cancel()`:
      - Body is `request.get_json(silent=True)`. Non-dict, or a missing, non-str, empty or over-long `request_id`, returns `{"success": False, "error": ...}` with 400.
      - Otherwise mark it and return `{"success": True}`.
      - It is idempotent: a repeat call returns success again.
      - It always returns JSON.
      Add a comment: the registry is in-memory and per-process, so it does not survive a restart. Cancel only stops the result being saved; it cannot abort the in-flight OpenAI call, so tokens may still be consumed.
      Files: `BE/server.py`
      Verify: `cd BE && .venv/bin/python -c "import server"` boots without OPENAI_API_KEY. The new tests from step 3 pass.

- [ ] 2. Apply the cancel check in `api_ask` and `api_vision_ask` in `BE/server.py`.
      - `api_ask`: read `request_id = _valid_request_id(data.get("request_id"))` next to the other `data.get` calls. Leave the streaming branch untouched (comment that it ignores request_id). In the non-streaming path, immediately after `ai_helper.ask(...)` returns, and before `db_layer` is used, add `if request_id and _consume_cancelled(request_id): return _cancelled_response()`.
      - Also check in the `except ai_helper.AIError` branch, before `db_layer.update_record(record_id, status="error")`. A cancelled request must not mutate the record, so on cancel return `_cancelled_response()` there too.
      - `api_vision_ask`: read `request_id` after the `data` dict validation. Right after the `ask_with_images` try/except succeeds, and before `_save_vision_batch`, add the same check. Nothing is written: no image files, no record, no history. Also consume the id in the AIError and generic-Exception branches so the registry does not leak. In those branches, return the cancelled response if it was cancelled, otherwise keep today's 502 or 500.
      - With no `request_id`, behavior is byte-for-byte unchanged.
      - Leave `/api/ocr-only` and `/api/solve` alone. Add a comment on `api_ocr_only` that cancelling only means the client stops waiting, and the already-saved record stays.
      Files: `BE/server.py`
      Verify: the whole existing suite still passes, `cd BE && .venv/bin/python -m pytest tests/ -q`, including the unchanged `test_vision_ask.py`.

- [ ] 3. Add backend tests in new file `BE/tests/test_cancel.py`, offline. Reuse the `client` fixture pattern and the `_FakeClient`/`make_data_url` helpers from `tests/test_vision_ask.py` (copy the minimal pieces; do not import across test modules).
      Cover:
      - `/api/cancel` validation: missing body, non-JSON, non-str id, empty id, id over 128 chars all return 400 JSON. A valid id returns 200 `{success: true}`. A repeat call is idempotent.
      - Registry bounded eviction: monkeypatch `server._CANCEL_MAX` to 3, mark 5 ids, assert only the newest 3 remain and the oldest are evicted. Assert `_consume_cancelled` returns True once, then False.
      - Cancelled `/api/ask`: first POST `/api/cancel` for id X, with `ai.ask` monkeypatched to return "A". Then POST `/api/ask` with `request_id` X. Assert the response is `{success:false, cancelled:true, error:"Cancelled"}`, `db.list_records() == []`, and `db.get_history` is empty. Also run the variant with an existing `record_id` and assert its answer and status are unchanged.
      - Cancelled `/api/ask` when the AI raises AIError: assert the record status is not set to "error".
      - Cancelled `/api/vision-ask`: use the `_FakeClient` stub. Assert no record, `list(server.SHOTS_DIR.rglob("*"))` has no files, and no history rows.
      - Normal paths unchanged: `/api/ask` and `/api/vision-ask` without `request_id` still succeed and persist. `/api/ask` with an uncancelled `request_id` succeeds and persists, and a later cancel for that id does not affect the saved record.
      - The cancel id is cleared once handled: after a cancelled request, a second request reusing the id succeeds.
      Files: `BE/tests/test_cancel.py`
      Verify: `cd BE && .venv/bin/python -m pytest tests/test_cancel.py -q`, then `.venv/bin/python -m pytest tests/ -q` (all pass; expect ~134 + new). Finally `.venv/bin/python -c "import server"`.

## Frontend (FE) steps

- [ ] 4. Create `FE/ux-helpers.js` (UMD, no DOM or Node-only APIs, same wrapper as vision-batch.js: `module.exports` under node, else `window.UxHelpers`). Export:
      - `recordSignature(r)` returns `id|status|(answer ? 1 : 0)`.
      - `recordsSignature(records)` returns the ordered signatures joined by `;` (the empty list gives `''`).
      - `galleryChanged(prevSig, nextSig)`.
      - `newestSignature(records)` returns the first record's signature or `''`.
      - `shouldPoll({view, visible, inFlight, hasBridge})` is true only if view === 'gallery' && visible === 'visible' && !inFlight && hasBridge.
      - `newRequestId(prefix)` returns `prefix-<timestamp base36>-<counter>-<random base36>`, unique per call and always a string under 128 chars.
      - `isCancelled(data)` is true when `data && data.cancelled === true`.
      - `POLL_INTERVAL_MS = 3000`.
      Files: `FE/ux-helpers.js`
      Verify: `cd FE && node --check ux-helpers.js`.

- [ ] 5. Unit-test the helper in `FE/test/interview.test.js`. Append after the solution-format tests and before the final `console.log` summary. Add `const UxHelpers = require('../ux-helpers.js');` beside the other requires and use the existing `test(name, fn)` harness.
      Cover:
      - Signature is stable for identical lists and changes on a new id, a status change, or an answer appearing.
      - The empty list gives `''`.
      - `galleryChanged` is true/false correctly.
      - `shouldPoll` truth table: gallery+visible+idle is true. It is false when the view is not gallery, when `visible` is 'hidden', when inFlight, or when there is no bridge.
      - `newRequestId` returns 200 distinct strings, each of length at most 128.
      - `isCancelled` handles null, `{}`, and `{cancelled:true}`.
      Files: `FE/test/interview.test.js`
      Verify: `cd FE && npm test` runs 27 original plus the new tests, all passing, 0 failed.

- [ ] 6. Update `FE/preload.js` (only `require('electron')`; no other requires).
      Add an internal `const inflight = new Map();`.
      Add the internal helper `trackedFetch(url, options, requestId)`:
      - Without a requestId, do a plain fetch and return `res.json()` as today.
      - With a requestId, create an `AbortController`, register it, and call fetch with `signal`.
      - On `AbortError`, resolve `{success:false, cancelled:true, error:'Cancelled'}` (resolve, not throw).
      - Remove the Map entry in a `finally`, but only if the stored controller is still this one, so a reused id is not clobbered.
      - If the response body is not JSON, return `{success:false, error:'HTTP <status>'}`.
      - Re-throw network errors other than abort as before.
      Add an optional trailing `requestId` to these wrappers. Existing positional params stay unchanged:
      - `askText(text, tone, recordId, language, requestId)`: send `request_id` in the body only when provided.
      - `visionAsk(images, mode, tone, language, sourceTypes, requestId)`: send `request_id` only when provided.
      - `ocrImage(dataUrl, sourceType, requestId)`: tracked locally only. Do not send `request_id` to the backend.
      - `solveRecord(id, force, tone, requestId)`: tracked locally only.
      Add `cancelRequest(requestId)`: abort and delete the controller if present. Then fire a best-effort `fetch(BACKEND_URL + '/api/cancel', POST, JSON {request_id})` with `.catch(() => {})`. Return a boolean for whether a local request was aborted.
      Extend `listRecords(limit, offset)`: build the query only when the arguments are finite non-negative ints, giving `/api/records?limit=1&offset=0`. With no arguments the URL is unchanged.
      Add `cancelOcr: () => ipcRenderer.send('cancel-ocr')`.
      Add a comment documenting the limits: aborting the fetch cannot abort the upstream OpenAI call, and server-side OCR finishes in the background.
      Files: `FE/preload.js`
      Verify: `cd FE && node --check preload.js`. Confirm no new `require(` other than `electron` (visual check of the diff). Existing call sites with fewer args still work.

- [ ] 7. Update `FE/main.js` so the local-OCR flow in `sendToSolve` can be cancelled.
      - Add a module-level `let ocrAbort = null;`.
      - In `sendToSolve(dataUrl, sourceType)`, create `const ac = new AbortController(); ocrAbort = ac;`. Pass `signal: ac.signal` to the existing fetch.
      - In `catch`, if `err.name === 'AbortError'` (or `ac.signal.aborted`), call `sendToOverlay('solve-status', {status:'cancelled'})` and return without sending `solve-error`.
      - In `finally`, set `ocrAbort = null` only if `ocrAbort === ac`.
      - If a new capture starts while an earlier one is running, abort the earlier one silently first. Mark it superseded (a flag on the controller) so no stray 'cancelled' status is sent for it.
      - Add `ipcMain.on('cancel-ocr', (event) => { if (!isOverlaySender(event)) return; if (ocrAbort) ocrAbort.abort(); })`, placed near the other `ipcMain.on` handlers. `isOverlaySender` already exists.
      - Comment: cancel only stops waiting, and the record the backend already saved stays in the Gallery.
      - Do not touch routeCapture, the vision path or the drag handlers.
      Files: `FE/main.js`
      Verify: `cd FE && node --check main.js`.

- [ ] 8. In `FE/index.html`, add the loader CSS, the `<script src="ux-helpers.js">`, and the shared loader helper.
      CSS (in the existing `<style>`, next to `.muted`/`@keyframes ivspin`):
      - `.loader` (inline-flex, gap, align center, small muted text).
      - `.loader-spinner` (14px circle with a border-top accent, dark-theme colors, `animation: loader-spin .8s linear infinite`).
      - `@media (prefers-reduced-motion: reduce) { .loader-spinner { animation: none; } }`. Because there is no spin, the spinner should instead keep a static dashed-ish ring, so the label alone still conveys busy.
      - `.loader .act-btn` sizing for the Stop button.
      Markup: add `<script src="ux-helpers.js"></script>` after the solution-format.js tag (~L711).
      JS: inside the main inline script, near `esc()`/`setStatus` (~L810), add:
      - `createLoader(label, onStop)` builds a `div.loader` containing `span.loader-spinner[aria-hidden=true]`, a `span.loader-text[role=status][aria-live=polite]` set via `textContent`, and, when `onStop` is given, a `button.act-btn` with `textContent='Stop'`, `type='button'`, `title='Stop waiting for this request'`, `aria-label='Stop'`, wired to `onStop`.
      - `showLoader(container, label, onStop)` clears the container with `textContent = ''` and appends the loader. Returns the node.
      - `genRequestId(prefix)` delegates to `window.UxHelpers.newRequestId` (with a fallback if the helper failed to load).
      - A shared `runCancellable(prefix, fn)` helper is optional; use it if it keeps the call sites short. It does `const id = genRequestId(prefix)`, calls `fn(id)`, and exposes `stop = () => api.cancelRequest && api.cancelRequest(id)`.
      Files: `FE/index.html`
      Verify: compile every inline `<script>` block with node `vm.Script` (see the Verification section) and run `npm test`.

- [ ] 9. Gallery: silent refresh, polling and loader in `FE/index.html`.
      Refactor `loadGallery()` to `loadGallery(opts)` where `opts = {silent}`.
      - Guard against a click event being passed as opts. The Refresh button currently passes the event, so change the listener to `() => loadGallery()` and also treat a non-plain `opts` as non-silent.
      - Keep module state: `lastGallerySig = null`, `galleryLoading = false` (a single in-flight guard), `galleryFetchSeq` (a counter so a stale response cannot overwrite a newer one).
      - Non-silent path: show the shared loader (`showLoader(galleryGrid, 'Loading…')`, no Stop button here, per the spec) instead of the plain text. Keep the existing visible error messages exactly.
      - Silent path:
        - No loader.
        - Record `const st = galleryGrid.scrollTop`.
        - Fetch `api.listRecords()`.
        - Compute `UxHelpers.recordsSignature(records)`.
        - If it equals `lastGallerySig`, return without touching the DOM.
        - Otherwise re-render and restore `galleryGrid.scrollTop = st`.
        - Errors are `console.warn`/`console.error` only. Never write to the grid.
      - Both paths update `lastGallerySig` after a successful render. Keep the existing rendering/escaping code as it is, factoring only what is needed.
      - The existing handlers (delete, edit, openRecord) keep calling `loadGallery()` unchanged.
      Polling:
      - `pollTimer`, `pollInFlight`, `lastNewestSig`.
      - `startGalleryPoll()` starts `setInterval(pollGallery, UxHelpers.POLL_INTERVAL_MS)` if it is not running.
      - `stopGalleryPoll()` clears it.
      - `pollGallery()`:
        - Return early unless `UxHelpers.shouldPoll({view:'gallery', visible:document.visibilityState, inFlight:pollInFlight, hasBridge:!!api.listRecords})`. Track the current view in a `currentView` variable set in `showView`.
        - Set `pollInFlight = true`.
        - Call `api.listRecords(1, 0)`.
        - Compare `UxHelpers.newestSignature(data.records)` with `lastNewestSig`. If it differs, set it and `await loadGallery({silent:true})`.
        - Reset `pollInFlight` in a `finally`.
        - Swallow errors with `console.warn`.
      - `showView(which)`: set `currentView = which`. If which === 'gallery', call `loadGallery()` (existing behavior) and `startGalleryPoll()`. Otherwise `stopGalleryPoll()`. Make the minimal edit to the existing function (~L865) and keep its other logic as is.
      - Seed `lastNewestSig` after every render from `records[0]`, so the first poll does not trigger a redundant reload.
      Other triggers:
      - `window.addEventListener('focus', ...)`, and a `document.addEventListener('visibilitychange', ...)` handler that fires only when visible. When currentView === 'gallery', call `loadGallery({silent:true})`.
      - In `api.onOcrReady` (~L1080), call `loadGallery({silent:true})` after the UI update.
      - Other loadGallery() call sites that fire after an action (ask, delete, vision send, edit modal, clear) stay as they are. They already refresh, now via the same signature-diffed path where silent makes sense. Passing `{silent:true}` for the background post-action refreshes (ask, OCR, vision, edit modal) avoids a "Loading…" flash. Keep manual Refresh, clear and delete non-silent.
      Files: `FE/index.html`
      Verify: vm.Script compile of all inline scripts. `npm test`. Live check is listed under User verification.

- [ ] 10. Answer-tab loaders and Stop in `FE/index.html`.
      `askCurrentText()` (~L898), used by Ask, Regenerate and Cmd+Enter:
      - Add a module flag `askBusy`; return early if already busy.
      - Generate `rid = genRequestId('ask')`.
      - Replace the `answerBody.innerHTML = '<span class="muted">Asking the assistant…</span>'` line with `showLoader(answerBody, 'Asking the assistant…', () => api.cancelRequest && api.cancelRequest(rid))`.
      - Disable `#btn-ask` and `#btn-regenerate` while busy.
      - Call `api.askText(text, toneSelect.value, activeRecordId, undefined, rid)`.
      - After the await, if `UxHelpers.isCancelled(data)`: call `setStatus('Cancelled.', 'idle')`, restore `answerBody` to the muted placeholder `Cancelled. Press ➤ Ask to try again.` via textContent/DOM, and DO NOT write the error text. `ocrInput.value` is left untouched.
      - Put the button re-enable and the `askBusy` reset in a `finally`.
      - Keep every existing success/error branch otherwise.
      - Make sure the existing "bridge unavailable" early-return still resets `askBusy`.
      Local-OCR "Reading screen…" state:
      - In `api.onSolveStatus` (~L1070), for `status === 'ocr'`, replace the `answerBody.innerHTML = '<span class="muted">Extracting text from the capture…</span>'` line with `showLoader(answerBody, 'Reading screen…', () => api.cancelOcr && api.cancelOcr())`. Keep the other lines and `setStatus('Reading screen…','thinking')`.
      - Add a branch for `p.status === 'cancelled'`: `setStatus('Cancelled.', 'idle')` and set the answer body to a muted "Cancelled. The capture is saved in the Gallery." message using textContent. No error styling.
      - `onOcrReady` and `onSolveError` already overwrite `answerBody`, which removes the loader. Verify that both paths clear it.
      - Make sure `ocrInput` is left alone (it is cleared at the start of the OCR state, which is today's behavior and not a user input to preserve).
      Files: `FE/index.html`
      Verify: vm.Script compile; `npm test`.

- [ ] 11. Vision capture popup loader and Stop in `FE/index.html` (`initVisionCapture`, send handler ~L2399).
      - Add `const stopBtn = ...` created dynamically (or add a hidden `#vp-stop` button in the `.vp-actions` markup with `class="act-btn hidden"`, title and aria-label "Stop"). Prefer the loader helper: render `showLoader(msgEl, 'Sending N image(s) to OpenAI…', stop)` in `#vp-msg`, whose existing role=status/aria-live is kept.
      - Make the send handler generate `rid = genRequestId('vis')` and call `api.visionAsk(req.images, req.mode, toneSelect.value, undefined, req.source_types, rid)`.
      - If `UxHelpers.isCancelled(data)`: `msgEl.textContent = 'Cancelled.'`. Do NOT clear `batch`, do NOT close the popup, and do not set an error status. The user can press Send again or Cancel. Reset `sending = false` and call `renderPopup()` in the existing `finally`.
      - `renderPopup()` already disables Send, Remove, Add and Cancel while sending and relabels Send to 'Sending…'. Keep that. The Stop button lives next to the loader.
      - The popup's own Cancel is still disabled while sending; Stop is the way out.
      - Escape handling is unchanged (it ignores Escape while sending, via `cancelBatch`).
      Files: `FE/index.html`
      Verify: vm.Script compile; `npm test`.

- [ ] 12. Edit-modal loaders and Stop in `FE/index.html` (`initEditModal`).
      The modal's local `setStatus(msg)` writes plain text into `#edit-status`. Keep it for plain messages. Add a small local helper `showBusy(label, onStop)` that clears `statusEl` and appends `createLoader(label, onStop)`. The next `setStatus(...)` call clears the loader because it sets `textContent`.
      - Perform OCR (`btnOcr` handler): generate `rid = genRequestId('ocr')`. Replace `setStatus('Running OCR…')` with `showBusy('Running OCR…', () => api.cancelRequest(rid))`. Call `api.ocrImage(dataUrl, 'screenshot-region', rid)`. If cancelled: `setStatus('Cancelled.')`, and keep the canvas and `textArea` as they are (do not touch editRecordId, so a previous version is not lost). Keep `btnOcr.disabled = false` in the existing `finally`.
      - Get Answer (`btnGetAnswer`): `rid = genRequestId('ask')`. Replace the `answerEl.innerHTML` 'Thinking…' with `showLoader(answerEl, 'Thinking…', stop)` or `showBusy`, whichever places a single Stop button next to the loader (use `showLoader` on `answerEl` plus a plain `setStatus('Asking the assistant…')`; avoid two Stop buttons). Call `api.askText(text, toneSelect.value, editRecordId, undefined, rid)`. If cancelled: restore the previous answer or the muted placeholder in `answerEl`, `setStatus('Cancelled.')`, and keep `textArea.value`.
      - Get solution from image (`btnVision`): `rid = genRequestId('vis')`. Show the loader in `answerEl` (replacing 'Analyzing the image…') with Stop. Call `api.visionAsk([dataUrl], mode, toneSelect.value, undefined, ['screenshot-region'], rid)`. If cancelled: `setStatus('Cancelled.')`, restore the placeholder, and leave the canvas untouched.
      - For all three, the existing `finally` re-enables the buttons. Also disable the other two long-op buttons while one is in flight so the three requests cannot overlap (a simple `setBusy(bool)` toggling btnOcr, btnGetAnswer, btnVision).
      - A cancel must not show the 'failed' status line, and the `catch` branches stay for real errors.
      - Cancelled results never reach `loadGallery()`.
      Files: `FE/index.html`
      Verify: vm.Script compile; `npm test`.

- [ ] 13. Other `askText` call sites: leave `handleAskSelection` (~L1690) and the Audio tab (~L2054) as they are (no requestId means unchanged behavior; the Audio and Interview tab behavior must not change). Leave `solveRecord` unused by the UI. It only gets the optional parameter for completeness.
      Files: none
      Verify: `grep`-free check, by running `npm test` and the vm.Script compile after all edits.

## Verification commands (run all; no Electron, no live server)
- Backend suite: `cd /Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot && .venv/bin/python -m pytest tests/ -q` (all pass).
- Backend boots without a key: `cd /Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot && env -u OPENAI_API_KEY .venv/bin/python -c "import server; print('ok')"`.
- Syntax: `cd /Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app && node --check main.js && node --check preload.js && node --check ux-helpers.js`.
- Inline scripts: run from FE with node:
  `node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('index.html','utf8');const re=/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;let m,n=0;while((m=re.exec(h))){new vm.Script(m[1]);n++}console.log('compiled',n,'inline scripts')"`.
- Frontend tests: `cd /Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app && npm test` (the 27 original tests plus the new helper tests, 0 failed).
- Clean up any temporary files created during verification.

## Final summary requirements (for the implementer's last message)
List every file changed and why. Give the new names and contracts: `POST /api/cancel {request_id}`, the `request_id` body field on /api/ask and /api/vision-ask, `cancelRequest(requestId)`, `cancelOcr()`, IPC `cancel-ocr`, the optional `requestId` parameters, `listRecords(limit, offset)`, and the cancelled result `{success:false, cancelled:true, error:'Cancelled'}` (HTTP 200 from the backend). Describe the polling design and its cost: one 3-second `GET /api/records?limit=1` while the Gallery is visible and the window is focused, and a full reload only on change. Explain the cancel flow from the Stop button: `cancelRequest` aborts the fetch locally and fires POST /api/cancel, and the backend discards the result before persisting. State the limits: the upstream OpenAI call cannot be aborted so tokens may still be used, and server-side OCR finishes in the background with the saved record staying in the Gallery. Report exact test results.

## User must verify live (cannot be done here)
1. Restart the backend: stop the old server, then run `cd screen_shot && .venv/bin/python server.py`.
2. Fully quit the overlay (Cmd+Q, not just hide) and relaunch it with `npm start`, because preload.js and main.js changed.
3. With the Gallery tab open, take a screenshot with the overlay hotkey, then with the C x4 daemon. The thumbnail should appear within about 3 seconds and without a "Loading…" flash. Scroll position should be kept.
4. Press Ask, Regenerate, hotkey OCR, vision Send, and the three edit-modal actions. Each should show a spinner with a Stop button, and Stop should restore the UI with "Cancelled." and keep the typed text, staged batch and edited canvas.
5. After a cancelled ask or vision request, confirm no new Gallery entry appears. Also confirm that with reduced motion enabled the spinner does not animate.
