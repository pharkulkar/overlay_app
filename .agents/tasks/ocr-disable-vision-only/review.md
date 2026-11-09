# OCR disabled across Electron overlay and Flask backend (vision-only)

Local OCR is commented out in both trees with `[OCR-DISABLED]` tags and no deletions. Captures always route to the vision popup, and the capture-mode setting is gone. The daemon now registers screenshots through a new non-OCR endpoint, `POST /api/register-capture`. Verification and inventory docs are present and consistent with the diff.

Watch for: stale hint text in the edit modal for image records (confirmed, minor, non-blocking).

**Verdict**: APPROVED

## High-level view

The frontend forces `captureMode` to a `'vision'` constant. The old default is kept in a tagged comment, and the `set-capture-mode` IPC, the preload bridges, the settings popover and its CSS/JS are commented out. preload.js still requires only `electron`.

On the backend, `ocr_engine.py` and `OCR.py` are fully prefixed with `# [OCR-DISABLED]`, and OCR routes, the easyocr import and the web-gallery OCR pieces are disabled in server.py. The recorded import check shows no easyocr/torch/paddle in `sys.modules`.

`/api/register-capture` validates JSON, image presence and decodability, reuses `_save_inline_capture`, returns 400/500 JSON without a traceback, and is covered by 7 tests that need no network. The daemon points at it and stays fail-soft with stdlib urllib. No `.env` change appears, and `.env` is gitignored.

<details>
<summary>Issues (1)</summary>

1. **Stale edit-answer hint** (confirmed, minor) — `#edit-answer` still says "after you press Get Answer", which is hidden for image records. Reword it to point at "Get solution from image".

</details>

<details>
<summary>Details</summary>

Spot-checks on the diff: index.html disables the edit-ocr button and the settings popover as HTML comments with no inner `-->`. main.js line 239 disables the old branch. An active-reference grep for OCR symbols shows hits only in comments, docstrings and CSS class names (`#ocr-input` is the question textbox id, kept deliberately). The recorded evidence is 157 backend tests passed with 0 skipped, 32 frontend tests passed, and `py_compile`, `node --check` and the inline-script id check all clean. I did not re-run any of them.

Uncommitted-work preservation: the working-tree diff touches only the OCR-related areas. The drag, compact panel, vision popup, loaders and cancel code are present in HEAD or unchanged. I could not fully verify that nothing was reverted, since no pre-change snapshot exists.

Not verifiable here: the Electron UI, the live daemon-to-Gallery path, and the web gallery in a browser.

</details>

<details>
<summary>File map</summary>

- main.js, preload.js, index.html: OCR flow, settings and edit-modal OCR commented out
- server.py: OCR routes, easyocr and gallery OCR commented out; `/api/register-capture` added
- daemon.py: posts to `/api/register-capture`
- ai.py: comment only
- ocr_engine.py, OCR.py: whole file commented out
- tests/test_register_capture.py: new
- Full diff: `git diff` in each repo

</details>
