# Frontend inventory ([OCR-DISABLED]) — overlay_app

Line ranges are approximate to the tagged lines (HTML/CSS multi-line comments start at the tag line).

| File | Lines | Reason |
|---|---|---|
| main.js | 32-33 | Old `let captureMode = 'ocr'` default; now `const captureMode = 'vision'` |
| main.js | 239-240 | routeCapture local-OCR branch / sendToSolve call (now always vision popup) |
| main.js | 251-294 | `ocrAbort`, `sendToSolve()` (POST /api/ocr-only, solve-status/ocr-ready), `cancel-ocr` IPC |
| main.js | 432-435 | `set-capture-mode` IPC (setting removed) |
| preload.js | 76 | `setCaptureMode` |
| preload.js | 88 | `onSolveStatus` (only emitter was sendToSolve) |
| preload.js | 95, 98 | `onOcrReady` (+ misplaced comment; vision comment re-added) |
| preload.js | 127-128 | `cancelOcr` |
| preload.js | 166-179 | `ocrImage` (/api/ocr-only) and `solveRecord` (/api/solve; unused in index.html) |
| index.html | 306 | CSS `#edit-ver-badge` (block comment starts here) |
| index.html | 345 | CSS `#settings-pop` rules (block comment); `#vision-popup` rules re-added active |
| index.html | 387 | `#btn-settings`/`#settings-pop` focus selectors removed |
| index.html | 434 | Settings gear button `#btn-settings` |
| index.html | 627 | `#edit-ver-badge` span |
| index.html | 644 | `#edit-ocr` "Perform OCR" button |
| index.html | 686 | `#settings-pop` capture-mode popover (cm-ocr / cm-vision / cm-note) |
| index.html | 1033, 1074 | `settingsPop` reference in solution panel |
| index.html | 1150-1174 | `api.onSolveStatus` ("Reading screen…" loader + Stop) and `api.onOcrReady` handlers |
| index.html | 1377 | openRecord copied extracted_text into question box (now blank for image records) |
| index.html | 1406, 1417 | `verBadge`, `btnOcr` constants |
| index.html | 1442 | setBusy list including btnOcr |
| index.html | 1541-1593 | `deriveVersionLabel` and the `btnOcr` click handler (api.ocrImage) |
| index.html | 1683-1684 | verBadge reset in openEditModal |
| index.html | 1713 | "Extracted text (run OCR…)" label |
| index.html | 2492-2493, 2496-2522 | Capture-mode settings JS in initVisionCapture (localStorage, setCaptureMode, settings popover handlers) |

Non-tagged behavior/text changes (not disabled code): Answer-tab label/placeholder reworded; edit modal hides `#edit-text-label`, `#edit-text`, `#edit-get-answer` for image records (text/voice unchanged); vision popup gets note "Images are sent to OpenAI only when you press Send."; OCR wording removed from status messages.

Kept as-is: `VisionBatch` (incl. `normalizeCaptureMode`), `onSolveError`, `solve-error` sends in main.js, `#ocr-input` id (now just the question box), `/api/cancel` plumbing.

## Restore
List: `grep -rn "OCR-DISABLED" main.js preload.js index.html`
Per-line JS/HTML-script prefixes: `sed -i '' 's#\(^[[:space:]]*\)// \[OCR-DISABLED\] #\1#' main.js preload.js index.html` then manually fix lines tagged `was:`, and unwrap the `<!-- [OCR-DISABLED] ... -->` / `/* [OCR-DISABLED] ... */` blocks, set `let captureMode = 'ocr'` and delete the `const captureMode = 'vision'` / active replacement lines.
