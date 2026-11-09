# Backend OCR-disable inventory (screen_shot/)

Line numbers are the current tree (server.py / daemon.py / ai.py).

| File | Lines | Reason |
|---|---|---|
| ocr_engine.py | 1-end (3-line `[OCR-FILE-DISABLED]` header + every non-blank line prefixed `# [OCR-DISABLED] `) | Unified OCR layer (PaddleOCR/easyocr) disabled; nothing can import/load it |
| OCR.py | 1-end (same scheme) | SmartQuestionOCR / PaddleOCR script disabled |
| server.py | 10 | Module docstring: old "Solution (OCR)" wording kept as tagged note |
| server.py | 61-64 | `import ocr_engine` try/except block |
| server.py | 88-106 | easyocr/torch import, `easyocr.Reader`, `set_easyocr_reader` (boot-time torch load) |
| server.py | 380-452 | GALLERY_TEMPLATE CSS `.ocr-*` classes (one `/* [OCR-DISABLED] ... */`) |
| server.py | 507 | GALLERY_TEMPLATE hover "Solution" button (HTML comment) |
| server.py | 529-~552 | GALLERY_TEMPLATE `#ocr-modal` markup (one HTML comment) |
| server.py | 583-658 | GALLERY_TEMPLATE JS `openSolution`/`switchOcrVersion`/`runOcr`/`copyOcrText` (`// [OCR-DISABLED]` per line) |
| server.py | 1148-1184 | `POST /api/ocr` (`api_ocr`) |
| server.py | 1569 | Section header note (old "Solve: image -> OCR -> OpenAI") |
| server.py | 1660-1702 | `POST /api/ocr-only` (`api_ocr_only`) |
| server.py | 1709 | Docstring note in the NEW `/api/register-capture` (references old endpoint) |
| server.py | 1829-1929 | `POST /api/solve` (`api_solve`) |
| server.py | 2455 | Startup banner "& OCR" (old line kept as tagged comment) |
| daemon.py | `_register_with_backend` docstring + URL line | Repointed `/api/ocr-only` -> `/api/register-capture` (old noted in tagged comments) |
| ai.py | 13 | Docstring "gallery/OCR" wording (tagged note) |

New (not disabled): `POST /api/register-capture` in server.py (right after `_save_vision_batch`), `tests/test_register_capture.py`.

Left active on purpose: `import numpy as np` / PIL imports (harmless), `_resolve_image_for_record` (non-OCR helper), `_save_inline_capture`, `/api/ask`, `/api/vision-ask`, `/api/cancel`. Comment-only mentions remain at server.py:1379 and resume_parser.py:4 (not code). Docs (README.md, features.md, requirements.md, phases.md) and requirements.txt untouched.

## Restore

List everything:

```
grep -rn "OCR-DISABLED\|OCR-FILE-DISABLED" /Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot --include='*.py' --exclude-dir=.venv
```

Whole files (macOS sed), then delete the 3 `[OCR-FILE-DISABLED]` header lines at the top of each:

```
cd /Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot
sed -i '' 's/^# \[OCR-DISABLED\] //' ocr_engine.py OCR.py
sed -i '' '/^# \[OCR-FILE-DISABLED\]/d' ocr_engine.py OCR.py
```

server.py Python blocks (61-64, 88-106, 1148-1184, 1660-1702, 1829-1929):

```
sed -i '' 's/^# \[OCR-DISABLED\] //' server.py
```

Caution: that also un-prefixes the template JS lines, which use `// [OCR-DISABLED] ` (restore with `sed -i '' 's#^// \[OCR-DISABLED\] ##' server.py`). The HTML-comment (`<!-- [OCR-DISABLED] ...`, plus its closing `-->` line) and CSS (`/* [OCR-DISABLED] ... */`) wrappers in GALLERY_TEMPLATE must be unwrapped by hand. Remove `/api/register-capture` and repoint daemon.py's URL back to `/api/ocr-only` if full OCR is restored.
