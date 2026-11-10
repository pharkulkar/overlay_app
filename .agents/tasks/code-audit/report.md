# Code audit: additional / unwanted code (read-only)

Scope: `overlay_app/` (Electron) and `screen_shot/` (Flask), current working tree. Nothing was edited. Scratch tools (eslint 8, pyflakes, vulture) live in `/tmp/aud` and were not installed into either project. Line numbers are from the working tree on the audit date.

## (a) Executive summary

The active code is mostly clean. Eslint (`no-unused-vars`, `no-undef`) on `main.js`, `preload.js`, `interview.js`, `audio.js`, the helper files and both inline scripts of `index.html` gave only 9 hits, and 4 of them are real. The bulk of the "extra" weight is deliberately commented-out code, not live dead code.

| Category | Count (real findings) |
|---|---|
| 1 Dead JS | 7 (3 `main.js` vars, `VAD_PREROLL_MS`, `editSourceType`, `showBusy`, unused `$` helper) |
| 2 Bridge/IPC | 5 exposed-but-unused or orphan items (`saveTranscript`+`save-transcript`, `onSolveAnswer`, `onSolveError` handler, `setTone`+`set-tone`+`currentTone`, `onAskNow`) |
| 3 CSS/markup | 2 dead CSS classes (`.g-audio`, `.g-del`); ~91 lines of tagged commented CSS/HTML |
| 4 Dead Python | 5 unused imports, 3 unused symbols, 1 dead wrapper alias; 9 routes with no real client |
| 5 Commented-out code | ~1,880 lines tagged (see table below) |
| 6 Diagnostics | 8 debug-style logs worth reviewing, plus 1 IPC channel (`capture-log`) |
| 7 Files/artifacts | 58 tracked screenshots (32 MB), tracked `logs/daemon.log`, 4 stale doc files, `question_ocr_output.json`, 6 `.agents/tasks/*` dirs |
| 8 Duplicates | 4 (`esc`/`esc2`, `_language_instruction` alias, `transcribe` wrapper, 2 size-limit constants on each side) |
| 9 Scope creep | 10 items evaluated, none clearly unwired |
| 10 Tests | 2 tests assert on disabled-code markers; 0 skipped tests except conditional skips |
| 11 Risky | 4 (bind `0.0.0.0` default, screenshots tracked in git, stale Windows installer file list, `requirements.txt` still pins OCR packages) |

Commented-out vs active code (tag counts via `grep -c`; contiguous-run analysis for blocks):

| File | Total lines | `[OCR-DISABLED]` lines | `[VISION-POPUP-DISABLED]` lines | Other commented-out code |
|---|---|---|---|---|
| `screen_shot/OCR.py` | 1599 | 1150 (+1 header `[OCR-FILE-DISABLED]`, 448 blank) | 0 | none, whole file is dead |
| `screen_shot/ocr_engine.py` | 260 | 213 (+1 header, 45 blank) | 0 | none, whole file is dead |
| `screen_shot/server.py` | 2522 | 248 (48 blocks, largest 20 lines at 606-625) | 0 | 0 |
| `overlay_app/index.html` | 3526 | 123 | 109 | ~91 lines of untagged inner lines inside tagged `/* */` and `<!-- -->` blocks (so ~300 commented lines, about 8.5%) |
| `overlay_app/main.js` | 656 | 52 (largest 44 lines, 285-328) | 0 | 0 |
| `overlay_app/preload.js` | 208 | 20 | 0 | 0 |
| `screen_shot/ai.py`, `daemon.py` | 847 / 382 | 1 / 2 (one-line "was:" notes) | 0 | 0 |

So about 1,360 of the 1,859 Python OCR lines are two whole dead files, and about 770 further lines are commented in the live files. Every one of these is tagged and intentional (KEEP-INTENTIONAL until the owner decides to delete). Untagged commented-out code is nearly absent (`main.js:12` hardware-acceleration hint is an intentional note).

Verification run: `npm test` in `overlay_app` passes (37 stealth-audit tests, plus the interview suite). I did NOT run pytest (see Unverified).

## (b) Findings by category

### 1. Dead JS

Method: eslint with `no-unused-vars` / `no-undef` on each file and each inline `<script>` (extracted to `/tmp`). Then hand-verified.

| Item | Location | Evidence | Class | Why | Break if removed |
|---|---|---|---|---|---|
| `currentTone` (assigned, never read) | `main.js:31`, set at `main.js:502-504` | eslint no-unused-vars; only reader was the removed OCR solve path | REMOVE-SAFE | Tone is now sent by the renderer on each request, not by main | Nothing, but see IPC `set-tone` below |
| `captureMode` const | `main.js:35` | eslint; used only inside `[OCR-DISABLED]` lines `main.js:263-264` | REMOVE-SAFE | Constant for a branch that no longer exists | Nothing |
| `BACKEND_URL` / `BACKEND_HOST`/`PORT` in main | `main.js:17-19` | eslint; only use is commented `main.js:299` | REMOVE-WITH-CARE | Comment at `main.js:17` says env override; if OCR code is ever restored it is needed | Nothing today |
| `VAD_PREROLL_MS` | `interview.js:270` | eslint; grep shows a single occurrence | REMOVE-SAFE | Declared, never used | Nothing |
| `editSourceType` | `index.html` inline script 2, ~`:1986` (eslint line 739 in the extracted script, offset 1247) | eslint | REMOVE-SAFE | Assigned, never read | Nothing |
| `showBusy()` | `index.html` ~`:1998` (extracted line 751); only caller is commented `index.html:2149` | eslint + grep | REMOVE-SAFE | Orphaned by OCR removal | Nothing |
| `const $ = (id) => ...` in `initVisionCapture` | `index.html:3339` | eslint (`$` assigned never used; its users are all `[VISION-POPUP-DISABLED]`) | REMOVE-SAFE | Leftover | Nothing |
| `window.VisionBatch` normalize fns used only by commented code (`normalizeCaptureMode`, `buildVisionRequest`, `batchLabel` partly) | `vision-batch.js` | `index.html:3349` is commented; `batchLabel` is still used at `index.html:2416` | DECIDE | Only check which exports remain unused before trimming; `normalizeMode` is used by `capture-flow.js:90` | Tests in `test/interview.test.js` may import them |

### 2. Bridge / IPC surface

Method: listed every key in `contextBridge.exposeInMainWorld('electronAPI', ...)` and grepped the renderer files; listed every `ipcMain.on` and `webContents.send` in `main.js`.

| Item | Location | Evidence | Class | Why | Break if removed |
|---|---|---|---|---|---|
| `saveTranscript` bridge + `save-transcript` handler (appends to `conversation.txt`) | `preload.js:57`, `main.js:337-344` | No renderer call (grep over `index.html`, `interview.js`, `audio.js`: zero hits). The opt-in save uses `saveTranscriptToDisk` → `/api/transcript/save` instead | REMOVE-WITH-CARE | Orphan channel; also writes a file next to the app if ever called | Nothing wired |
| `onSolveAnswer` | `preload.js:94` | No renderer use; nothing sends `solve-answer` (grep: only the bridge line) | REMOVE-SAFE | Orphan since OCR removal | Nothing |
| `onSolveError` + handler | `preload.js:95`, handler `index.html:1723` | Only senders of `solve-error` are `[OCR-DISABLED]` lines `main.js:313,320` | REMOVE-SAFE | Handler can never fire | Nothing |
| `setTone` bridge + `set-tone` IPC + `currentTone` | `preload.js:~66`, `main.js:502`, callers `index.html:1508,1511,2815,3224`, `interview.js:715`, `audio.js:305` | Main stores the value but nothing reads it (see category 1) | REMOVE-WITH-CARE | Whole round trip is a no-op now; renderer calls are guarded but numerous | Removing only the main side is harmless; removing callers touches 6 sites |
| `onAskNow` + `ask-now` (hotkey `HOTKEY_ASK_NOW`) | `preload.js:~108`, `main.js:576`, `index.html:2757` | Wired and exercised | KEEP-INTENTIONAL | Not orphan | n/a |
| `health` bridge | `preload.js:61` | Used at `index.html:2980,3321` | KEEP | | |
| `logCapture` + `capture-log` | `preload.js:99`, `main.js:540-543`, `index.html:3484` | Wired; debug-only (category 6) | DECIDE | | |
| `toggleOverlayMode`, drag, resize, compact, `triggerCapture`, region, `onCaptureError`, `onVisionCapture`, `onAppWillQuit`, `get-vad-config` | all | Every one has both a sender and a handler (verified by grep above) | KEEP | | |
| `solve-status`, `ocr-ready`, `set-capture-mode`, `cancel-ocr`, `setCaptureMode`, `cancelOcr`, `ocrImage`, `solveRecord`, `onOcrReady`, `onSolveStatus` | commented in `preload.js` / `main.js` | All `[OCR-DISABLED]` | KEEP-INTENTIONAL | | |

### 3. Unused CSS and markup

Method: parsed each `<style>` block, looked up every class/id outside CSS; then looked at every `id=` that appears once.

| Item | Location | Evidence | Class | Why | Break if removed |
|---|---|---|---|---|---|
| `.g-audio` rule | `index.html:128` | Zero mentions in markup/JS | REMOVE-SAFE | Audio gallery tile style from an older design | None; check `test/stealth-audit.test.js` first (it lists some selectors) |
| `.g-del` rule | `index.html:27, 134-` | Zero mentions in markup/JS (delete is done another way) | REMOVE-WITH-CARE | `:27` is inside a selector list used for the no-pointer rule | Remove only the `.g-del` token from the list |
| Commented CSS blocks (settings popover, vision popup) | `index.html:349-394` | Tagged `/* */` blocks ~45 lines | KEEP-INTENTIONAL | | |
| Commented markup (settings pop, vision popup) | `index.html:~802-832` | Tagged `<!-- -->`, 30 lines | KEEP-INTENTIONAL | `cm-note`, `vp-note` flagged by the id scan are inside HTML comments: false positives | |
| `#floating-dot`, `#ctx-menu` | `index.html:150-172`, `:721`, `:847`, `:1370`, `:2634-2662` | Both fully wired (dot = `toggleOverlayMode`, ctx-menu = transcript "Ask" menu) | KEEP | NOT dead | |
| `selection.html` | 107 lines | No unused selectors or ids | KEEP | | |
| Duplicate-looking pre-existing id check | n/a | Stealth test `every id referenced by active JS exists exactly once` passes | KEEP | | |

### 4. Dead Python

Tools: `pyflakes`, `vulture --min-confidence 60`, excluding `OCR.py`/`ocr_engine.py`.

| Item | Location | Evidence | Class | Why | Break if removed |
|---|---|---|---|---|---|
| `import numpy as np` | `server.py:89` | pyflakes + vulture 90%; only uses are inside `[OCR-DISABLED]` blocks | REMOVE-SAFE | Heavy import now unused | `run.bat:38` still imports numpy in its check; keep that or update it |
| `import sys` | `server.py:28` | pyflakes | REMOVE-SAFE | | |
| `from dataclasses import field` | `question_detector.py:27` | pyflakes | REMOVE-SAFE | | |
| `import pytest` / `question_detector as qd` unused in tests | `tests/test_interview_session.py:10`, `tests/test_language_default.py:6` | pyflakes | REMOVE-SAFE | | |
| `_openai_pkg` | `ai.py:29,32` | vulture; no later reference | REMOVE-WITH-CARE | Part of a defensive import pattern; harmless | |
| `OPENAI_API_KEY` module var | `server.py:46` | Never read; `ai.py:185` reads env itself | REMOVE-SAFE | | |
| `LANGUAGE_NAMES` | `ai.py:704` | Only defined; `_language_names()` is called elsewhere | DECIDE | Possibly public constant | |
| `derive_language_tag` | `script_guard.py:188` | Only used by `tests/test_script_guard.py:184-204`, never by server | DECIDE | Production code calls other functions; this one is tested but unused | Tests would need removal |
| `db.delete_older_than` | `db.py:241` | No caller anywhere | DECIDE | Possible retention feature never wired | |
| Unused locals `header` | `server.py:2482` | vulture 60% | REMOVE-SAFE | | |
| `maybe_err` | `server.py:1745` | vulture 60%; inspect before changing (tuple unpack) | DECIDE | | |
| `frame` | `daemon.py:358` | vulture 100% but it is a signal-handler argument | KEEP | False positive | |

Flask routes and their real clients (grep over `overlay_app/*.js|html`, `daemon.py`, the HTML templates in `server.py`, `tests/`):

| Route | Client |
|---|---|
| `/`, `/img/..`, `/thumb/..`, `/api/delete/..`, `/api/save-edit`, `/typings`, `/typings/update`, `/typings/stream` | Flask web gallery templates inside `server.py` (`:608-675`, `:796`, `:953-974`) |
| `/api/versions/<date>/<file>` | No active client. Only caller is `[OCR-DISABLED]` `server.py:608`. Candidate: REMOVE-WITH-CARE |
| `/api/health`, `/api/ask`, `/api/cancel`, `/api/resume/parse`, `/api/records*` (6 routes), `/api/vision-ask`, `/api/transcript`, `/api/transcript/clear`, `/api/transcript/save`, `/ws/audio`, `/ws/interview` | overlay (`preload.js`, `interview.js`, `index.html`) |
| `/api/register-capture` | `daemon.py:198` (C x4 daemon) and `tests/test_register_capture.py` |
| `/api/transcript` GET | Overlay `Audio` tab only via `index.html` (2 hits); verify before removal |
| `/api/suggest` (`server.py:2002`) | **No client** in overlay, daemon, templates or tests (grep). Candidate: DECIDE. Backed by `ai.suggest` and `convo` |
| `/api/interview/start`, `/<id>/transcript`, `/events`, `/history`, `/cancel`, `/stop` | **Tests only** (`tests/test_interview_api.py`). The overlay uses `/ws/interview`. Possibly external-client API; DECIDE |
| `/api/ocr`, `/api/ocr-only`, `/api/solve` | Commented (`[OCR-DISABLED]`) |

### 5. Commented-out code

Largest blocks first (all tagged, all intentional): `OCR.py` 1,599 lines (whole file), `ocr_engine.py` 260 (whole file), `index.html:2123-2175` 53 lines, `main.js:285-328` 44 lines, `index.html:3447-3481` 35, `index.html:3384-3413` 30, `index.html:3346-3372` 27, `index.html:1698-1722` 25, `server.py:606-625` 20, `server.py:644-661` 18, `preload.js:175-188` 14. Per-file totals are in the summary table.

Untagged / stale markers: no TODO/FIXME/HACK/XXX anywhere in active code (grep). Stale comments that describe removed behavior:

| Item | Location | Evidence | Class |
|---|---|---|---|
| "send image ... via the popup" | `main.js:33-35`, `main.js:268-270` ("renderer ... shows the send popup") | Popup retired (`[VISION-POPUP-DISABLED]`), editor opens now | REMOVE-SAFE (comment edit) |
| "Vision send popup" section header above commented CSS | `index.html:348` | Section is empty of active rules | REMOVE-SAFE |
| `preload.js:107-108` comment "a capture is ready for the vision send popup" | stale | REMOVE-SAFE |
| `README.md` (3), `features.md` (14), `memory.md` (40), `phases.md` (12), `requirements.md` (24), `overlay_app/features.md` (5) still describe OCR as a live feature | `grep -ci ocr` | DECIDE (docs) |

### 6. Leftover diagnostics

| Item | Location | Class | Why |
|---|---|---|---|
| `[openRecord]` logs, including `console.log('[openRecord] getRecord ->', rec)` which dumps the whole record (answer text) into devtools | `index.html:1893,1911` | REMOVE-SAFE | Debug leftover; also prints data |
| `[ask]` `console.error(... Object.keys(api))` | `index.html:1532` | REMOVE-SAFE | Debug-only (guard stays) |
| `[gallery] ... Object.keys(api)` | `index.html:1757` | REMOVE-SAFE | Debug-only |
| `[capture] full-screen hotkey pressed` / `region hotkey pressed` / `delivering ... KB` | `main.js:282,563,564` | DECIDE | Added during the "editor does not open" fix; harmless but noisy |
| `capture-log` channel + `[capture][overlay]` printing + `clog()` | `main.js:538-543`, `preload.js:98-99`, `index.html:3484` | DECIDE | Whole channel exists only for diagnosing capture; keep until capture flow is confirmed stable |
| `[hotkey] could not register` / `registered` | `main.js:555-557` | KEEP | Useful failure signal (also pairs with the `capture-error` feature) |
| `console.error` on capture/permission failures | `main.js:247,272,523,614,620` | KEEP | Real error paths |
| Server banner prints | `server.py:2509-2518` | KEEP | Startup info (contains "Network (iPhone/etc)" LAN line, see risky) |
| `logLevel: "debug"` in `config.json` | `config.json` | DECIDE | Daemon logs at debug by default, so `logs/daemon.log` grows |

### 7. Unused files and artifacts

| Item | Size | Tracked? | Evidence | Class |
|---|---|---|---|---|
| `screen_shot/screenshots/` (58 tracked PNGs; dir is 32 MB) | 32 MB | **Tracked** (not in `.gitignore`) | `git ls-files screenshots | wc -l` = 58 | DECIDE (privacy: real screen captures in history) |
| `screen_shot/logs/daemon.log` | 200 KB | **Tracked**, although `.gitignore` has `logs/*.log` | `git ls-files logs` | REMOVE-WITH-CARE (`git rm --cached`) |
| `question_ocr_output.json` | 4.9 KB | Tracked | Only reference is commented `OCR.py:1481` | REMOVE-SAFE |
| `OCR.py`, `ocr_engine.py` | 56 KB / 14 KB | Tracked | Entirely commented; no importers (grep) | DECIDE (kept on purpose for re-enable) |
| `memory.md`, `phases.md`, `requirements.md`, `features.md` (backend) | 34 / 12.5 / 19 / 11.7 KB | Tracked | No code references; planning docs that still describe OCR | DECIDE |
| `overlay_app/features.md` | 163 lines | Tracked | Same | DECIDE |
| `overlay_app/.agents/tasks/*` (6 tracked dirs + untracked `capture-direct-editor/`, this audit) | 528 KB | Mixed | Agent working artifacts | DECIDE (consider `.gitignore`) |
| `install/` (macOS, Linux, Windows) | small | Tracked | Referenced by README; **stale**: `install-windows.ps1:54` and `install-macos.sh:29` only check/copy `daemon.py`, `server.py`, `config.json` while `server.py` now imports `ai.py`, `db.py`, `conversation.py`, `interview_*.py`, `question_detector.py`, `script_guard.py`, `resume_parser.py` | KEEP but fix (unverified: I did not read the full copy logic) |
| `run.sh` vs `run.bat` | 48 / 143 lines | Tracked | `run.sh` checks only `pynput flask` and tells user to `pip install -r requirements.txt`, which still pulls OCR packages; `run.bat:120` says not to use requirements.txt | DECIDE |
| `__pycache__/`, `tests/__pycache__`, `.pytest_cache/`, `.venv/`, `app.db*` (320K+32K+132K), `daemon.pid`, `.env` | – | Ignored (`git status --ignored`) | | KEEP (ignored) |
| `.DS_Store` | 6 KB | **Tracked** in `screen_shot/` | `git ls-files` | REMOVE-SAFE |
| `overlay.config.json` keys | 17 lines | Tracked | All four `vad.*` keys read by `main.js:373-` (`get-vad-config`); `_comment`/`_help` are documentation only | KEEP |
| `screen_shot/config.json` `interview.*` keys | – | Tracked | Read by `interview_config.py`; not individually checked | Unverified |
| `*.bak` / `*.orig` | – | – | None found | – |

### 8. Duplicate / redundant logic

| Item | Location | Evidence | Class | Why |
|---|---|---|---|---|
| `esc` vs `esc2` HTML escapers | `index.html:1381`, `:2997` | Two copies in different scopes | REMOVE-WITH-CARE | Lift one to a shared helper; `esc2` differs (no quote escaping) |
| `ai._language_instruction` alias | `ai.py:749`, used at `:759`, tested at `tests/test_ai_language.py:80` | Alias of `language_instruction` | REMOVE-WITH-CARE | Only a compatibility shim; one test asserts the alias |
| `ai.transcribe` wrapper | `ai.py:489-503`, used by `/ws/audio` at `server.py:2196` | Text-only wrapper over `transcribe_detailed` | KEEP-INTENTIONAL | Documented as the Audio tab entry point |
| Language registry mirrors | backend `interview_config.py`, `ai._FALLBACK_LANGUAGE_NAMES` (`ai.py:689`), `interview.js:~53`, `index.html:~2920` "hardcoded mirror reconciled with /api/health" | Mirrors exist on purpose so the dropdown renders before health returns | KEEP-INTENTIONAL | Risk is drift, not dead code |
| `_normalize_language_set_local` | `ai.py:342` | Local copy of a registry helper (defensive against import failure, `ai.py:686-688`) | DECIDE | |
| Image size constants | backend `VISION_MAX_IMAGES=6`, `VISION_MAX_SIDE=2000` (`server.py:1616-1617`) vs `MAX_BATCH = 6` (`vision-batch.js:6`) and `VISION_MAX_SIDE = 2000` (`index.html:2213`) | Duplicate on purpose (client pre-checks); comment at `index.html:2210` says it matches | KEEP-INTENTIONAL | Must be changed together |
| Transcript pipelines | `/api/transcript*` + `conversation.py` (Audio tab) and `/ws/interview` + `interview_session.py` | Two separate pipelines | DECIDE | Both wired; larger consolidation, not a cleanup |

### 9. Scope creep / extras (neutral)

| Feature | Size and location | Wired? | Note |
|---|---|---|---|
| Navigation lock (`will-navigate`, `setWindowOpenHandler`) | 2 lines, `main.js:70-71` | Yes | Security + stealth; keep |
| Hotkey failure reporting | ~10 lines, `main.js:550-570` | Yes (logs; sends `capture-error`) | Reasonable keep |
| Cancel registry `/api/cancel` + `trackedFetch` + `requestId` plumbing | route `server.py:1267-1281`, `preload.js:21-47,125-134`, `tests/test_cancel.py` 170 lines | Yes: `stopRequest` at `index.html:1475,2034` | Larger feature; keep or drop as a unit. Cannot stop the upstream OpenAI call (comment at `preload.js:19`) |
| Silent gallery polling | `index.html:1855-1883`, `ux-helpers.js` 39 lines | Yes (`POLL_INTERVAL_MS`) | Candidate if you do not want background `/api/records` requests |
| Tooltips `MutationObserver` converter | `index.html:1088, 1233`, in the stealth layer | Yes | Part of "no native tooltip"; keep |
| `overlayConfirm` | `index.html:1203-1206`, used `:1733,:1835` | Yes | Replaces native `confirm`; keep |
| Resize grip | `main.js:437-470`, `stealth-ui.js`, `index.html:1338-1362` | Yes | Needed because window is non-resizable (cursor leak) |
| Compact solution panel | `main.js:475-500`, `index.html:1615-1634` | Yes | Feature beyond the original ask; keep or drop |
| VAD config file | `overlay.config.json` + `main.js:373-405` | Yes | Convenience; candidate if env-only is enough |
| Solution formatter | `solution-format.js` 53 lines, used `index.html:1582` | Yes | |
| Interview/Audio/Resume machinery | `interview.js` 753, `audio.js` 314, `interview_session.py` 647, `question_detector.py` 407, `script_guard.py` 197, `resume_parser.py` 155 | Yes | These are the project's own features; not part of this cleanup |

### 10. Tests

| Item | Location | Evidence | Class |
|---|---|---|---|
| Test asserts commented-out markers exist | `test/interview.test.js:592` (`[VISION-POPUP-DISABLED]` count ≥ 3) | Ties test to comments; will fail if the commented blocks are deleted | DECIDE (update test with any deletion) |
| Test asserts no `// [OCR-DISABLED]` in stripped main | `test/stealth-audit.test.js:424` | Same; guards comment stripping | KEEP |
| Conditional skips only | `tests/test_interview_api.py:17`, `test_language_default.py:104-106`, `test_resume.py:56,74` | `skipif`/`importorskip`, not unconditional skips | KEEP |
| Tests for helpers that production does not call | `tests/test_script_guard.py:182-204` (`derive_language_tag`), `tests/test_ai_language.py:80` (alias) | See category 4/8 | DECIDE |
| REST interview tests (`tests/test_interview_api.py`, 162 lines) | The only consumer of those routes | | KEEP while the routes exist |

### 11. Risky leftovers

| Item | Location | Evidence | Class | What could break if changed |
|---|---|---|---|---|
| Server binds `0.0.0.0` by default | `server.py:2504` | `--host` default; no auth on routes; endpoints expose captured images and records to the LAN | DECIDE (default to `127.0.0.1`) | `run.bat`/phone-gallery use case on LAN would need `--host 0.0.0.0` |
| Startup banner advertises the LAN IP and calls out to `8.8.8.8` | `server.py:2486-2514` | `get_local_ip()` opens a UDP socket to `8.8.8.8:80` (no data sent, only route lookup) | DECIDE | Banner line |
| Real screenshots committed | `screen_shot/screenshots/` (58 files) | `git ls-files` | DECIDE | Git history keeps them anyway |
| Tracked `logs/daemon.log` | `screen_shot/logs/daemon.log` | Contradicts `.gitignore` | REMOVE-WITH-CARE | |
| `.env` in `screen_shot/` | ignored by `.gitignore` | I did not open it. Not tracked (`git ls-files` shows only `.env.example`) | KEEP | |
| Debug record dump to devtools | `index.html:1911` | see category 6 | REMOVE-SAFE | |
| `requirements.txt` pins OCR packages (`easyocr`, `numpy`, `paddleocr`, `paddlepaddle`) | `requirements.txt:22-32` | `run.bat:120` warns not to use it; `run.sh` tells users to use it | DECIDE | Fresh `pip install -r` installs multiple GB for disabled code |
| Hard-coded paths | none found in tracked active code (`grep` for `/Users/`) beyond docs | | – | |
| Debug routes | None (`debug=False` at `server.py:2520`) | | – | |

## (c) Recommended cleanup order (lowest to highest risk)

1. Stale comments (`main.js:33-35`, `main.js:268-270`, `preload.js:107-108`, `index.html:348`). Verify: `cd overlay_app && npm test`.
2. Unused imports and locals: `server.py:28,46,89`, `question_detector.py:27`, test imports, `interview.js:270`, `main.js` consts, `index.html` `$`, `editSourceType`, `showBusy`. Verify: `cd overlay_app && node --check main.js preload.js interview.js && npm test`; `cd screen_shot && .venv/bin/python -m pyflakes *.py tests/*.py` (or run `python -m py_compile server.py`) then `.venv/bin/python -m pytest -q`. If `numpy` is removed from `server.py`, leave `run.bat:38` alone or change it in the same step.
3. Debug logs in `index.html` (`[openRecord]`, `[ask]`/`[gallery]` key dumps). Verify: `npm test` (this includes the compile-every-inline-script check at `test/stealth-audit.test.js`).
4. Orphan bridge items: `onSolveAnswer`, `onSolveError` + handler `index.html:1723`, `saveTranscript` + `save-transcript`. Verify: `npm test`, then launch the app once and trigger a hotkey capture and an Ask.
5. Dead CSS `.g-audio`, `.g-del`. Verify: `npm test` (stealth audit) and look at the Gallery tab.
6. Untrack generated files: `git rm --cached screen_shot/logs/daemon.log screen_shot/.DS_Store`, add `screenshots/` to `screen_shot/.gitignore` if desired, remove `question_ocr_output.json`. Verify: `git status`, then run `pytest -q` (nothing reads these).
7. `set-tone` round trip (`currentTone`, `setTone`, 6 renderer callers). Verify: `npm test`; manually switch tone and ask.
8. Unwired Python: `/api/suggest`, `/api/versions`, `db.delete_older_than`, `derive_language_tag`, `_language_instruction`. Verify: `pytest -q` after also deleting their tests.
9. Delete or keep commented blocks and the whole OCR files. Verify after each file: `npm test` (it requires ≥ 3 `[VISION-POPUP-DISABLED]` markers, `test/interview.test.js:592`, so adjust it), `pytest -q`, start `server.py` and `npm start`, take a screenshot via hotkey.
10. Deployment decisions: bind host default, `requirements.txt`, install scripts, planning docs.

## (d) Looks unused but is used (false-positive traps checked)

- `btn-capture-full` / `btn-capture-region`: ids built by string (`'btn-capture-' + kind`, `index.html:1662`).
- `cm-note`, `vp-note`: inside HTML comments only.
- `#floating-dot`, `#ctx-menu`, resize grip, compact panel: all have JS handlers.
- Vulture's "unused" `server.py` route functions: decorators register them; the real check is the client table above.
- `daemon.py` `frame` arg: signal handler signature.
- `db.py` `row_factory`: sqlite attribute assignment.
- `onAskNow`, `onVisionCapture`, `onCaptureError`, `onAppWillQuit`, `get-vad-config`: wired both ways.
- `vision-batch.js` / `capture-flow.js`: both are live (`capture-flow.js:10-13` requires `vision-batch.js` and `index.html` loads them).
- `overlayConfirm` flagged by eslint as undefined in the second inline script: it is defined in the first inline script and exported as `window.overlayConfirm` (`index.html:1206`).
- `conversation.py`: used by `server.py:71` as `convo` for `/api/transcript*` and `/api/suggest`.
- `ai.transcribe`: called by `/ws/audio` (`server.py:2196`).
- `/api/register-capture`: no overlay caller but used by the daemon (`daemon.py:198`).
- `/api/records/clear`: used by `clearRecords` (`preload.js`).

## (e) Unverified

- I did not run `pytest` (importing `server` may touch `app.db`/`__pycache__`, and the brief forbids side effects), so Python test counts and pass status are unknown. `npm test` was run and passes.
- I did not read `.env`, and did not inspect key names in it.
- Eslint line numbers for `editSourceType` and `showBusy` are from the extracted script; the file lines given are approximate (script 2 starts at `index.html:1248`, so extracted line N maps to about N+1247).
- `/api/transcript` (GET) usage is by grep count only; I did not read the Audio tab code path.
- `install/*` scripts: only the file-existence check was read, not the copy logic.
- `config.json` `interview.*` keys were not individually traced to readers.
- `main.js`/`index.html` untagged commented-out code detection is regex-based (statement-shaped comment lines); prose-style dead comments may exist.
- The 91-line figure for untagged inner lines of tagged block comments in `index.html` is computed from tag-opened `/* */` and `<!-- -->` blocks only.
