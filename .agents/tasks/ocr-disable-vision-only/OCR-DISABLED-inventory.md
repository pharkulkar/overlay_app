# OCR-DISABLED inventory (merged; line numbers refreshed against the current trees)

FRONTEND = /Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app, BACKEND = /Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot.
Tagged-line counts (`grep -c OCR-DISABLED`): main.js 52, preload.js 20, index.html 123, server.py 248, daemon.py 2, ai.py 1, ocr_engine.py 214, OCR.py 1151.

## Frontend (overlay_app)
| File | Lines | Reason |
|---|---|---|
| main.js | 32-33 | Old `let captureMode = 'ocr'` default; now `const captureMode = 'vision'` |
| main.js | 239-240 | routeCapture local-OCR branch / sendToSolve call (always vision popup now) |
| main.js | 251-294 | `ocrAbort`, `sendToSolve()` (POST /api/ocr-only, solve-status/ocr-ready), `cancel-ocr` IPC |
| main.js | 432-435 | `set-capture-mode` IPC (setting removed) |
| preload.js | 76 | `setCaptureMode` |
| preload.js | 88 | `onSolveStatus` (only emitter was sendToSolve) |
| preload.js | 95, 98 | `onOcrReady` (+ misplaced comment) |
| preload.js | 127-128 | `cancelOcr` |
| preload.js | 166-179 | `ocrImage` (/api/ocr-only) and `solveRecord` (/api/solve, unused) |
| index.html | 306 | CSS `#edit-ver-badge` |
| index.html | 345 | CSS `#settings-pop` rules |
| index.html | 387 | `#btn-settings`/`#settings-pop` focus selectors |
| index.html | 434 | Settings gear button `#btn-settings` |
| index.html | 627 | `#edit-ver-badge` span |
| index.html | 644 | `#edit-ocr` "Perform OCR" button |
| index.html | 686 | `#settings-pop` capture-mode popover |
| index.html | 1033, 1074 | `settingsPop` references in solution panel |
| index.html | 1150-1174 | `api.onSolveStatus` ("Reading screen…" loader + Stop) and `api.onOcrReady` handlers |
| index.html | 1377 | openRecord copied extracted_text into question box |
| index.html | 1406, 1417 | `verBadge`, `btnOcr` constants |
| index.html | 1442 | setBusy list including btnOcr |
| index.html | 1541-1593 | `deriveVersionLabel` and `btnOcr` click handler (api.ocrImage) |
| index.html | 1683-1684 | verBadge reset in openEditModal |
| index.html | 1713 | "Extracted text (run OCR…)" label |
| index.html | 2492-2493, 2496-2522 | Capture-mode settings JS (localStorage, setCaptureMode, popover handlers) |

Untagged behavior/text changes: Answer-tab label/placeholder reworded; edit modal hides `#edit-text-label`, `#edit-text`, `#edit-get-answer` for image records (text/voice unchanged); vision popup note "Images are sent to OpenAI only when you press Send."; OCR wording removed from status messages.
Kept: `VisionBatch` (incl. `normalizeCaptureMode`), `onSolveError`, `solve-error` sends, `#ocr-input` id (now just the question box), `/api/cancel` plumbing.

## Backend (screen_shot)
| File | Lines | Reason |
|---|---|---|
| ocr_engine.py | 1-end (3-line `[OCR-FILE-DISABLED]` header + each non-blank line prefixed `# [OCR-DISABLED] `) | Unified OCR layer (PaddleOCR/easyocr) disabled |
| OCR.py | 1-end (same scheme) | SmartQuestionOCR / PaddleOCR script disabled |
| server.py | 10 | Module docstring old "Solution (OCR)" wording |
| server.py | 61-64 | `import ocr_engine` try/except |
| server.py | 88-106 | easyocr/torch import, `easyocr.Reader`, `set_easyocr_reader` (boot-time torch load) |
| server.py | 380 | GALLERY_TEMPLATE CSS `.ocr-*` classes (one `/* [OCR-DISABLED] ... */`, spans to ~452) |
| server.py | 507 | GALLERY_TEMPLATE hover "Solution" button (HTML comment) |
| server.py | 529 | GALLERY_TEMPLATE `#ocr-modal` markup (one HTML comment) |
| server.py | 583-658 | GALLERY_TEMPLATE JS `openSolution`/`switchOcrVersion`/`runOcr`/`copyOcrText` |
| server.py | 1148-1184 | `POST /api/ocr` |
| server.py | 1569 | Section header note (old "Solve: image -> OCR -> OpenAI") |
| server.py | 1660-1702 | `POST /api/ocr-only` |
| server.py | 1709 | Docstring note in NEW `/api/register-capture` |
| server.py | 1829-1929 | `POST /api/solve` |
| server.py | 2455 | Startup banner "& OCR" (old line kept as tagged comment) |
| daemon.py | 178, 198 | `_register_with_backend` repointed `/api/ocr-only` -> `/api/register-capture` (old noted in tagged comments) |
| ai.py | 13 | Docstring "gallery/OCR" wording |

New (not disabled): `POST /api/register-capture` (server.py:1704), `tests/test_register_capture.py`.
Comment-only mentions (not code): server.py:1379, resume_parser.py:4.
No OCR tests existed in tests/, so no skips were required.

## Restore commands
List everything:
```
cd /Users/pranay/Desktop/Pranay/Projects/In-Queue
grep -rn "OCR-DISABLED" overlay_app/main.js overlay_app/preload.js overlay_app/index.html
grep -rn "OCR-DISABLED\|OCR-FILE-DISABLED" screen_shot --include='*.py' --exclude-dir=.venv
```
Whole commented Python files (macOS sed; verified on a temp copy: both files py_compile after restore):
```
cd /Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot
sed -i '' 's/^# \[OCR-DISABLED\] //' ocr_engine.py OCR.py
sed -i '' '/^# \[OCR-FILE-DISABLED\]/d' ocr_engine.py OCR.py
```
server.py Python blocks (61-64, 88-106, 1148-1184, 1660-1702, 1829-1929):
```
sed -i '' 's/^# \[OCR-DISABLED\] //' server.py
sed -i '' 's#^// \[OCR-DISABLED\] ##' server.py      # template JS lines (583-658)
```
Unwrap by hand: GALLERY_TEMPLATE `<!-- [OCR-DISABLED] ... -->` (507, 529) and CSS `/* [OCR-DISABLED] ... */` (380). Remove `/api/register-capture` and repoint daemon.py URL to `/api/ocr-only` if full OCR is restored.
Frontend per-line JS prefixes:
```
cd /Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app
sed -i '' 's#\(^[[:space:]]*\)// \[OCR-DISABLED\] #\1#' main.js preload.js index.html
```
then fix lines tagged `was:`, unwrap `<!-- [OCR-DISABLED] ... -->` and `/* [OCR-DISABLED] ... */` blocks, set `let captureMode = 'ocr'` and delete the `const captureMode = 'vision'` replacement lines.
