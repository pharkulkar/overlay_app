# Backend verification (cwd: screen_shot, venv .venv/bin/python)

## py_compile
```
.venv/bin/python -m py_compile server.py daemon.py ai.py ocr_engine.py OCR.py tests/test_register_capture.py
```
Output: `COMPILED` (no errors).

## Import check (no OCR libs loaded)
```
env -u OPENAI_API_KEY .venv/bin/python -c "import sys, server; print([m for m in ('easyocr','torch','paddleocr','paddle') if m in sys.modules])"
```
Output: `[]`. Also enforced by `test_import_server_does_not_load_ocr_libs` (subprocess).

## Full suite
```
.venv/bin/python -m pytest tests/ -q -rs
```
Output tail: `157 passed in 7.57s` (0 failed, 0 skipped; no OCR tests existed in tests/, so no `[OCR-DISABLED]` skips were needed). New file tests/test_register_capture.py adds: success (1 record, file saved, source_type as sent, empty extracted_text), default source_type, missing image (4 bodies), invalid data URL/base64/non-image bytes (4 cases, no traceback, no record/file left), bad JSON (3 cases), removed routes `/api/ocr`, `/api/ocr-only`, `/api/solve` return 404, import-server check. All offline.

## Gallery template render
`GET /` via Flask test client: status 200; after stripping HTML/CSS/JS comments, `openSolution(`, `ocr-modal` and `/api/ocr` are absent.

## Active-reference audit (server.py daemon.py ai.py db.py interview_*.py question_detector.py resume_parser.py conversation.py)
```
grep -nE "ocr_engine|easyocr|paddleocr|SmartQuestionOCR|/api/ocr|ocr-only|/api/solve" <files> | grep -v OCR-DISABLED
```
Output (comment text only, no code):
```
server.py:1379:# /api/ask and /api/solve. Scoping the limit to this route keeps those intact.
resume_parser.py:4:``ocr_engine.py`` / ``question_detector.py``) so ``server.py``'s resume route
```

## Not verified
- Live server run / real daemon screenshot -> Gallery (needs restart of backend and daemon; daemon posts to `/api/register-capture`, covered only by endpoint tests).
- Web gallery in a browser at http://localhost:3000/ (template render checked server-side only).
