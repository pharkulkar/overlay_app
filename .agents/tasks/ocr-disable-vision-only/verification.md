# Verification (iteration 1, integration pass)

No verdict.json existed, so this is iteration 1. Re-run on the current trees; nothing needed fixing. No commit, no .env access, no Electron/server launched.

## Backend (cwd screen_shot, .venv/bin/python)
| Command | Output |
|---|---|
| `.venv/bin/python -m py_compile server.py daemon.py ai.py ocr_engine.py OCR.py tests/test_register_capture.py` | exit 0 (`COMPILED`) |
| `env -u OPENAI_API_KEY .venv/bin/python -c "import sys, server; print([m for m in ('easyocr','torch','paddleocr','paddle') if m in sys.modules])"` | `[]` |
| `.venv/bin/python -m pytest tests/ -q -rs` | `157 passed in 7.17s` (0 failed, 0 skipped) |

## Frontend (cwd overlay_app)
| Command | Output |
|---|---|
| `node --check main.js && node --check preload.js` | exit 0 |
| `grep -n "require(" preload.js` | only `require('electron')` (line 1; other matches are comments) |
| temp script: `vm.Script` on every inline `<script>` in index.html + id check (comments stripped, ids from getElementById/querySelector('#..') vs. active markup) | `inline scripts compiled: 1`, `ids checked: 91 problems: 0` (script deleted) |
| `npm test` | `32 passed, 0 failed` |

## Active-reference audit
Pattern P = `ocr_engine|easyocr|paddleocr|SmartQuestionOCR|/api/ocr|ocr-only|/api/solve|ocrImage|onOcrReady|onSolveStatus|cancelOcr|cancel-ocr|setCaptureMode|set-capture-mode`
Command: `grep -nE "$P" <files> | grep -v OCR-DISABLED`

| Files | Hits outside `[OCR-DISABLED]` lines |
|---|---|
| main.js, preload.js, index.html, audio.js, interview.js, selection.html, solution-format.js, ux-helpers.js, vision-batch.js | none |
| server.py | `1379: # /api/ask and /api/solve. Scoping the limit...` (comment only) |
| daemon.py, ai.py, db.py, interview_*.py, question_detector.py, conversation.py | none |
| resume_parser.py | `4: ``ocr_engine.py`` / ``question_detector.py``) ...` (docstring only) |

No active code references any disabled symbol. daemon.py:198 posts to `/api/register-capture`.
Restore check: the ocr_engine.py/OCR.py sed commands were run on a temp copy; both compiled afterwards (copy removed).

## /api/register-capture contract (server.py:1704)
- Request: `POST` JSON `{ "image": "data:image/png;base64,...", "source_type": "screenshot-full" }` (source_type defaults when omitted).
- Success: 200 `{ "success": true, "record_id": <id> }`; one record created, file saved via `_save_inline_capture`, empty `extracted_text`.
- Errors: 400 JSON for missing/invalid image, invalid data URL/base64/non-image bytes, and bad JSON. No traceback is returned, and no record or file is left behind.
- Fail-soft daemon: stdlib urllib, same timeout handling.
- Removed routes `/api/ocr`, `/api/ocr-only`, `/api/solve` now return 404 (tested).

## Files changed
Frontend: main.js, preload.js, index.html. Backend: server.py, daemon.py, ai.py, ocr_engine.py, OCR.py, tests/test_register_capture.py (new). Untouched: .env, requirements.txt, docs, database.

## User-visible behavior changes
- Hotkeys and on-screen Capture buttons always open the vision popup. The popup note says images are sent to OpenAI only when you press Send.
- No settings gear or capture-mode choice.
- Image records in the edit modal have no OCR button, version badge, extracted-text box or Get Answer. They keep Draw/Crop/Reset, answer-type radios, Get solution from image, Answer area and Pop out. Text/voice records are unchanged.
- Answer-tab label/placeholder no longer promises extracted text. Typing a question and pressing Ask still works.
- Daemon screenshots appear in the Gallery as thumbnails with empty text. Existing records are unchanged.
- Web gallery has no Solution button or OCR modal. The backend no longer loads torch/easyocr at boot, so startup is faster.

## User must verify live
1. Hotkey and on-screen button capture open the vision popup with the "only when you press Send" note.
2. No gear icon. The image edit modal shows only the vision section.
3. Text/voice records still show the text box + Get Answer.
4. A C x4 daemon screenshot appears in the Gallery.
5. http://localhost:3000/ loads with no Solution button.
6. Backend startup has no torch/paddle delay.

Restart: restart the backend (`server.py`), restart `daemon.py`, fully quit and relaunch the Electron overlay.

## Not verifiable here
Electron UI, a live server run, the real daemon-to-Gallery path (covered only by endpoint tests), and the web gallery in a browser (template render checked server-side only).
