# Plan: disable local OCR (vision-only)

Conventions (from spec): every disabled line/block carries `[OCR-DISABLED]`. Python `# [OCR-DISABLED] ` per line; JS `// [OCR-DISABLED] ` per line (or `/* */` if block has no `*/`); HTML `<!-- [OCR-DISABLED] ... -->` (no inner `-->`); CSS `/* */`. No git ops, no `.env`, no `requirements.txt`, no package removal, do not touch uncommitted unrelated work. Line numbers below are current-tree approximations; re-grep before editing.

Implement BACKEND first (frontend daemon/gallery depend on `/api/register-capture`), then FRONTEND, then inventory + verification.

---------------------------------------------------------------------------
# BACKEND  (/Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot, venv `.venv/bin/python`)
---------------------------------------------------------------------------

## B1. Whole-file comment-out
- `ocr_engine.py` (257 lines) and `OCR.py` (1596 lines): prefix EVERY line (including blank lines) with `# [OCR-DISABLED] `. Add a 3-line header (not prefixed with the per-line tag form that sed would strip; use `# [OCR-FILE-DISABLED] ...`) explaining restore: `sed -i '' 's/^# \[OCR-DISABLED\] //' ocr_engine.py OCR.py` (macOS) and removing the header. Use a small python one-liner (not hand-editing) to do this; `py_compile` both afterwards. Note: OCR.py may contain `"""` docstrings and `*/`-like text; per-line `#` is safe.
- Only importers: `server.py` (`import ocr_engine`). `OCR.py` has no importers besides `ocr_engine.py` (SmartQuestionOCR). No test imports either.

## B2. server.py
1. Lines ~55-65: `try: import ocr_engine / except: ocr_engine = None` block -> comment out; then set a tagged-comment note. Do not keep `ocr_engine = None` active unless some active code still references it (after B2.4-6 none should). Update adjacent comment "and unified OCR".
2. Lines ~88-107: `reader = None` + `import easyocr` / `easyocr.Reader` / `set_easyocr_reader` try/except -> comment out whole block. `reader` is only referenced by `/api/ocr` (line ~1157/1172), which is also disabled, so no stub needed. This removes the torch/easyocr import at boot (must be verified via sys.modules).
3. Lines ~1146-1182 `@app.route("/api/ocr") def api_ocr()` -> comment out whole function incl. decorator. (Note: it uses `numpy`/`PIL` top-level imports `import numpy as np`, `from PIL import Image` at ~line 75; leave these active; `np` may become unused, harmless. Check `np` usage elsewhere with grep; only comment if solely used by api_ocr AND numpy is already needed nowhere else – safer: leave active.)
4. Lines ~1657-1698 `/api/ocr-only` `api_ocr_only()` -> comment out (decorator + function).
5. Lines ~1786-1887 `/api/solve` `api_solve()` plus its section header comment at ~1566 ("Solve: image -> OCR -> OpenAI") -> comment out function; adjust section header to tagged note. Check that nothing between 1566-1578 helper code (`_resolve_image_for_record`, `_save_inline_capture`, `_decode_data_url_image`, `_downscale_png`, `_save_vision_batch`) is OCR-only: `_resolve_image_for_record` is used by api_solve; grep other users (api_record_image uses `_record_image_path`). If only api_solve uses it, leave it active (harmless, non-OCR) – do NOT comment helpers still potentially used.
6. GALLERY_TEMPLATE (triple-quoted string, ~lines 300-700; use HTML/JS/CSS comments, never `#`):
   - CSS `.ocr-container`, `.ocr-header`, `.ocr-version-select`, `.ocr-body`, `.ocr-preview(+ img)`, `.ocr-result(+ textarea)` (~381-445) -> wrap in one `/* [OCR-DISABLED] ... */` (verify no nested `*/` inside).
   - Line ~506 hover button `<button class="action-btn" onclick="openSolution(...)">⚡ Solution</button>` -> `<!-- [OCR-DISABLED] ... -->`. NOTE: this is inside a Jinja `{% for %}`; the comment must keep `{{ date }}`/`{{ f }}` harmless (Jinja still renders it inside the HTML comment; fine, but safest to also wrap in `{# ... #}` is NOT used – HTML comment is spec-required).
   - Modal markup `<!-- Solution/OCR Modal --> <div id="ocr-modal"...>` (~528-550) -> single HTML comment. Inner markup contains `<!-- ... -->`? Check; the existing label comment on line 528 must be neutralised (change to `Solution/OCR Modal` outside nested comment) so no `-->` appears inside the block. Also inline `onclick="closeModal('ocr-modal')"` etc. is inside the comment so inert.
   - JS (~581-655): `currentOcrDate/currentOcrFile`, `openSolution`, `switchOcrVersion`, `runOcr` (fetches `/api/ocr`), `copyOcrText` -> `// [OCR-DISABLED]` per line (JS in the template; `closeModal` generic helper stays if used by the edit modal – check).
   - Header docstring line 10 ("Solution (OCR), Edit...") and banner print at ~2412 ("& OCR"): reword to tagged-comment/plain text (print is cosmetic; edit it to drop "& OCR" with an `# [OCR-DISABLED]` comment of old text).
   - Comment at ~49 and ~113 mention OCR: cosmetic, reword.
7. DO NOT touch: `/api/ask`, `/api/vision-ask`, `/api/cancel`, `/api/save-edit`, `/api/records*`, `/api/resume/parse`, interview routes, `_save_inline_capture`.
8. New endpoint `POST /api/register-capture` (place right after `_save_vision_batch`, where `/api/ocr-only` used to be; add tagged note referencing old endpoint):
   - Request JSON: `{ "image": "data:image/png;base64,...", "source_type": "screenshot-full" }`.
   - Logic: `if db_layer is None` -> 503 `{success:false,error}`; `data = request.get_json(silent=True)`; if not dict -> 400 "Invalid JSON body."; `image` must be non-empty str else 400 "Missing 'image'."; `source_type` default `"screenshot-full"`, must be str; whitelist? use same allowed set as existing (just str, length-capped e.g. 40, fallback to default if not str). Validate image: reuse `_decode_data_url_image(image, 1)` (raises `_VisionInputError` with status 400 on invalid base64/data URL/oversize/not-an-image – verify its checks by reading lines 1610-1625; if it does not verify it is a decodable image, additionally `Image.open(io.BytesIO(raw)).verify()`), then call `_save_inline_capture(image, source_type)`; if `rec is None` -> 400 `{success:false,error:<msg>}`. Success -> `jsonify({"success": True, "record_id": rec["id"]})` (200). Wrap in try/except Exception -> log via `logging` and return generic 500 `{success:false,error:"Could not register capture."}`; never include traceback or str(path).
   - Keep decorators/style consistent with `api_vision_ask` (error mapping with `_VisionInputError`).
   - Record has empty `extracted_text` (create_record default); Gallery renders thumbnail.
9. Pre-edit sanity: confirm `db.create_record` default `extracted_text` is empty/None-safe (read db.py).

## B3. daemon.py (`_register_with_backend`, lines ~166-215)
- Change URL `f"{_BACKEND_URL}/api/ocr-only"` -> `f"{_BACKEND_URL}/api/register-capture"`; add `# [OCR-DISABLED] was: /api/ocr-only (OCR'd the capture)` comment; keep body JSON (`image`, `source_type: "screenshot-full"`), fail-soft except blocks, `urllib` only.
- Timeout: reduce 60 -> keep same handling (spec: same timeout handling). Leave `timeout=60`; update comment/docstring (no OCR text; record appears immediately). Update the comment at ~166 "OCR'd like..." and the long comment at ~201-207.
- No other change; `py_compile daemon.py`.

## B4. ai.py
- Only a docstring mention ("gallery/OCR") at line 13: reword to avoid "OCR" claim (optional, cosmetic). No functional OCR code. `ask_with_images`, vision flow unchanged.

## B5. Docs (optional, low risk)
- README.md (lines 48, 261, 325 `OCR_ENGINE`), features.md, requirements.md, phases.md mention OCR. Do not edit `requirements.txt`. Optionally add one-line "[OCR-DISABLED]" note to README; not required. `run.bat`/`run.sh`: grep for ocr before finishing (nothing found in the initial grep except README/features).

## B6. Tests (tests/)
- Findings: no existing test imports `ocr_engine`, calls `/api/ocr`, `/api/ocr-only`, `/api/solve` or patches easyocr/paddle (grep of tests found only `extracted_text` data in test_cancel.py, `resume_parser.extract_text` in test_resume.py, and the vision label assertion in test_vision_ask.py – all NON-OCR; leave unchanged). Therefore: expected skipped count = 0. Re-grep `ocr|easyocr|paddle|api/solve` in tests/ at execution time; if anything is found, `pytest.mark.skip(reason='[OCR-DISABLED] ...')`.
- Add `tests/test_register_capture.py` (offline, copy the `client` fixture pattern from `tests/test_vision_ask.py`: monkeypatch `db._conn`, `db.DB_PATH`, `server.SHOTS_DIR`, `server.ROOT` to `tmp_path`; `make_data_url` helper). Cases:
  1. success: POST valid PNG data URL with `source_type:"screenshot-full"` -> 200, `success True`, `record_id`; `db.list_records`/get shows exactly 1 record with `source_type == "screenshot-full"`, `input_ref` file exists on disk under tmp shots dir, `extracted_text` empty.
  2. default source_type when omitted.
  3. missing image -> 400, no record created.
  4. invalid base64 / not a data URL / non-image bytes -> 400, no record, no file left over.
  5. bad JSON body (`data="not json", content_type="application/json"`) -> 400.
  6. response body never contains "Traceback".
  7. Optional: removed routes return 404: `/api/ocr`, `/api/ocr-only`, `/api/solve`.
  8. Optional: subprocess check that `import server` leaves `easyocr`,`torch`,`paddleocr`,`paddle` out of `sys.modules` (use `subprocess.run([sys.executable,"-c",...], env without OPENAI_API_KEY)`), skipped never.

## B7. Backend verification commands (cwd = screen_shot)
- `.venv/bin/python -m py_compile server.py daemon.py ai.py ocr_engine.py OCR.py tests/test_register_capture.py`
- `env -u OPENAI_API_KEY .venv/bin/python -c "import sys, server; print([m for m in ('easyocr','torch','paddleocr','paddle') if m in sys.modules])"` -> `[]`
- `.venv/bin/python -m pytest tests/ -q` -> report passed/skipped (expected 0 skipped).
- `python -c` Jinja render check: `server.app.test_client().get('/')` returns 200 and body lacks `openSolution(`/`ocr-modal` outside comments (also confirms template still parses).

---------------------------------------------------------------------------
# FRONTEND  (/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app)
---------------------------------------------------------------------------

## F1. main.js
- Lines 31-32: replace `let captureMode = 'ocr';` with `const captureMode = 'vision';` and tagged comment `// [OCR-DISABLED] was: let captureMode = 'ocr';` (also tagged old comment on line 31).
- Lines ~235-242 `routeCapture`: keep function, make it always `return deliverVisionCapture(dataUrl, sourceType);`; tag-comment the `if` and `sendToSolve` fallback lines. (Callers of `routeCapture` in captureFullScreen/captureRegion unchanged – grep to confirm the names.)
- Lines ~250-294: `let ocrAbort`, `async function sendToSolve`, `ipcMain.on('cancel-ocr', ...)` -> comment out (per line `// [OCR-DISABLED] `). Also fix the stale section header comment at ~234 ("Send capture to backend /api/solve").
- Lines ~432-435: `ipcMain.on('set-capture-mode', ...)` -> comment out.
- KEEP: `sendToOverlay('solve-error', ...)` calls at ~222 and ~450 (used by non-OCR capture failures; `onSolveError` stays in preload/index). Keep `deliverVisionCapture`, `'vision-capture'` channel, cancel registry code.
- Update comment ~445-446 (mentions local OCR) to reflect vision popup.
- Check `captureMode` is not reassigned elsewhere (grep) – const would throw.
- `node --check main.js`.

## F2. preload.js (sandboxed; only `require('electron')` – no new requires)
- Comment out: line 77 `setCaptureMode`; lines 89 `onSolveStatus` (its only emitter was sendToSolve; confirm no other `solve-status` sender in main.js after F1 – grep showed only 263/283); lines ~96-98 `onOcrReady`; lines ~127-128 `cancelOcr` (+ its comment); lines ~166-175+ `ocrImage` (full arrow function incl. its trackedFetch call; read the whole block first to get the exact end line and trailing comma handling).
- KEEP `onSolveError`, `trackedFetch`, `askText`, vision APIs. Comment at line 24 mentions OCR; reword.
- `node --check preload.js`; confirm `grep -n "require(" preload.js` shows only `electron`.

## F3. index.html (inline `<script>` + CSS + markup)
Element ids affected: `btn-settings` (gear), `settings-pop`, `cm-ocr`, `cm-vision`, `cm-note`, `edit-ocr`, `edit-ver-badge`, `edit-text`, `edit-text-label`, `edit-get-answer`; `ocr-input` is KEPT (generic Answer-tab question box; only its placeholder/label text changes).

1. Settings (capture-mode removal):
   - Markup ~674-682 `#settings-pop` block -> HTML comment (tagged). Find and comment the gear button `#btn-settings` in the header (grep `btn-settings`; it is outside the viewed range). Keep `vision-popup` and its `vision-mode` radios.
   - CSS: `#settings-pop` rules (~343-352, 380) and `#btn-settings` rules -> `/* [OCR-DISABLED] */` but KEEP the `#vision-popup ...` selectors (lines 350-352 and 380-381 are combined selectors; split: comment out the old combined rule and add active copies containing only `#vision-popup` selectors, each tagged). Check for `*/` nesting.
   - JS in `initVisionCapture` (~2455-2500): comment `settingsBtn`, `settingsPop`, `cmRadios`, localStorage `captureMode` read/write, `api.setCaptureMode` calls, `setSettingsOpen` and the gear/document click/Escape handlers that reference them (read through to the end of the IIFE to find all uses: `settingsBtn`, `settingsPop`, `setSettingsOpen`). Keep `VB`, popup, strip, add/send/cancel, `vmRadios`. Keep `VB.normalizeCaptureMode` helper in vision-batch.js untouched.
   - Vision popup note (`#cm-note` text said "only in this mode") is inside the removed popover; reword vision popup text (find "Send to OpenAI" popup and any helper note in `#vision-popup`) to say images are sent to OpenAI only when the user presses Send. Add such a note line inside `#vp-card` if none exists.
2. Capture lifecycle handlers ~1137-1160: comment out `api.onSolveStatus(...)` ('Reading screen…' loader + `cancelOcr`, plus the 'cancelled' branch, which only served this flow) and `api.onOcrReady(...)`. KEEP `api.onSolveError` (~1162).
3. Answer tab: label ~446 "Extracted text (edit, then Ask)" -> "Question (type, then Ask)"; textarea placeholder ~448 -> "Type your question, then press Ask. Use the Capture buttons (or ⌘⇧1 / ⌘⇧2) to send a screenshot to OpenAI." Comment ~444 and ~1099-1101 (capture button comment) update. Lines ~1376 / ~1157 messages "Review the extracted text above" in `loadRecordIntoAnswer` (history record loader, ~1364-1376): keep logic, reword text to "Edit the question above, then press ➤ Ask." (this path is for text/old records; keep working). Line ~1852 `ocrInput.value = p.withContext ? sel : sel` is non-OCR; leave.
4. Edit modal (`initEditModal`, ~1380-1700):
   - Markup: comment `#edit-ocr` button row (~634-636 `<div class="actions">` wrapper + button); keep `#edit-vision-box`.
   - Image records: hide `#edit-text-label`, `#edit-text`, and `#edit-get-answer` (and its `.actions` row's spacer is fine; the status span `#edit-status` lives in the same row, so do NOT hide the row; hide only the button). Implement with a class/`style.display` toggle in `openEditModal`: image branch sets `display='none'` on label/textarea/getAnswer; text branch (manual/audio) restores `''`. Reset them at top of `openEditModal` so reopening works. `btnGetAnswer` remains referenced by `setBusy` and its click handler (works for text records unchanged).
   - Comment out JS: `const btnOcr` (1399); remove `btnOcr` from `setBusy` array (1425) with tagged old line; `deriveVersionLabel` (1527-1542); the whole `btnOcr.addEventListener('click', ...)` block (~1544-1573); `verBadge` const (1388) and its two usages (~1562-1563 inside the OCR handler, ~1666-1667 reset in open). `#edit-ver-badge` span (617) and its CSS (306): comment out markup + CSS (all active refs removed). `sourceExtractedText` still set at ~1680 for text; keep (used by text flow) or leave harmlessly.
   - Messages: ~1515 "Cropped. Run OCR to save this as a new version." -> "Cropped. Press Get solution from image to send it."; ~1689 `textLabel.textContent = 'Extracted text (run OCR, then Get Answer)'` -> comment (hidden for images); ~1693 `'Draw or crop, then Perform OCR.'` -> "Draw or crop, then press Get solution from image."; ~1580 'Enter or OCR some text first.' -> 'Enter some text first.'; header comments at 611 and 1380 and the `#edit-answer` placeholder "after you press Get Answer" -> for image records set via JS to "after you press Get solution from image" (optional cosmetic).
   - Placeholder ~656: "Text appears here after OCR, or edit the question text." -> "Edit the question text."
   - Image-record detection: reuse existing `isImageType(sourceType)`.
5. Unforeseen OCR-dependent references to handle:
   - `loadRecordIntoAnswer`/gallery open path (~1364) loads `rec.record.extracted_text` into `ocrInput` (for vision records it is a label like `[Vision · coding · 3 images]`, which would then be sent as a question via Ask). Decision: for records with an image source_type, do not copy `extracted_text` into `ocrInput` (leave blank) and show the stored answer; otherwise unchanged. Verify exact condition when editing.
   - `ux-helpers.js`, `solution-format.js`, `interview.js`, `audio.js`, `selection.html`, `vision-batch.js`: grep showed no OCR code (only `normalizeCaptureMode` default `'ocr'` in vision-batch.js – leave, tests cover it).
   - `features.md` (overlay) lists OCR/`/api/solve` – optional doc note.
   - Backend `question_ocr_output.json` / `OCR.py` leftover output files: leave untouched.
   - `Get Answer` in edit modal relied on OCR text for image records; after this change image records only use the vision button (as spec'd).
   - Error text in the server comment referencing nonexistent `/api/extract` disappears with `api_ocr`.
6. Tests (`npm test` = `node test/interview.test.js`): test file only references `VisionBatch.normalizeCaptureMode` (lines ~303-305) and no OCR flow; leave unchanged. Optionally add a scripted audit rather than a new test.

## F4. Frontend verification
- `node --check main.js && node --check preload.js`
- Script (temp file in /tmp, delete after): extract every inline `<script>` (no `src`) from index.html, `new vm.Script()` each; collect ids from `getElementById('x')`, `$('x')`, `querySelector('#x')` in ACTIVE (non-commented) JS and confirm exactly one match for `id="x"` in ACTIVE markup (strip HTML comments first); also confirm no active reference to removed ids (`btn-settings`, `settings-pop`, `cm-ocr`, `edit-ocr`, `edit-ver-badge`).
- `npm test` -> pass.
- Active-reference audit table for both repos using a grep that excludes lines containing `[OCR-DISABLED]` and comment lines, for: `ocr_engine|easyocr|paddleocr|SmartQuestionOCR|/api/ocr|ocr-only|/api/solve|ocrImage|onOcrReady|onSolveStatus|cancelOcr|cancel-ocr|setCaptureMode|set-capture-mode`. Caveat: multi-line `/* */` and HTML `<!-- -->` blocks need the audit to strip comments first (use a small script, not plain grep).

---------------------------------------------------------------------------
# INVENTORY + RESTORE (deliverable file)
---------------------------------------------------------------------------
Write `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app/.agents/tasks/ocr-disable-vision-only/inventory.md` listing each disabled block (file:line range, reason) generated from `grep -rn "OCR-DISABLED"` in both repos plus restore commands:
- list: `grep -rn "OCR-DISABLED" --include='*.py' --include='*.js' --include='*.html' /Users/pranay/Desktop/Pranay/Projects/In-Queue/{screen_shot,overlay_app} --exclude-dir=node_modules --exclude-dir=.venv`
- whole files: `sed -i '' 's/^# \[OCR-DISABLED\] //' ocr_engine.py OCR.py` then delete the 3-line header.
- other blocks: manual per inventory (also `sed -i '' 's#^\(\s*\)// \[OCR-DISABLED\] #\1#'` for per-line JS prefixes).

# User must verify live (not verifiable from shell)
Hotkey and on-screen button capture open the vision popup; edit modal for image records shows only draw/crop + vision section + answer + Pop out; C x4 daemon screenshot appears in the Gallery; web gallery http://localhost:3000/ loads without Solution button; no startup delay from torch/paddle. Restart steps: restart backend (`server.py`), restart `daemon.py`, fully quit and relaunch the Electron overlay.

# Order of work
1. B1, B2, B3, B4, B6 (+B7 checks). 2. F1, F2, F3 (+F4). 3. Inventory + audit table + final summary (files changed, endpoint contract, behavior changes, test counts, unverifiable items).
