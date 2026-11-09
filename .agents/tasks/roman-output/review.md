# Roman output mode (English letters) for interviewer speech

Adds a "Show everything in English letters" option, default ON, across both repos. The backend gains a script-plausibility guard (one STT retry, then drop), a transliteration step for non-Latin transcripts, and Roman answer directives for every Indian language. The frontend adds the checkbox, plumbs `roman` through the start frame and the `/ws/audio` envelope, and mirrors the three new languages. The frontend diff exists and matches the spec (index.html +23, interview.js +28/-8, tests +43).

Watch for: (1) the retry can force a wrong hard language hint on code-mixed audio (possible, author-noted residual risk); (2) one extra chat call per non-Latin utterance adds latency before the transcript is emitted (confirmed, by design).

**Verdict**: APPROVED

## High-level view

The guard lives in a stdlib-only `script_guard.py`. `ws_audio` wraps transcription with it only when `roman` is truthy and `languages` were sent. Anything else takes the old path, so the Audio tab and old clients are unchanged. An implausible script triggers exactly one retry with a firmer language hint, and is silently dropped (logged without text) if it is still wrong.

The language tag is derived from the original text before transliteration. Romanized Hindi therefore keeps `hi`/`ur`/`hing` and still routes to the non-English question classifier. `romanize_text` returns the original on any failure and rejects replies that are still mostly non-Latin.

Answers: `roman=True` is forwarded to the answer functions only when set, so old test stubs keep working. The Hindi family maps to the Hinglish directive, and other languages get a "written entirely in Roman letters" directive.

Frontend: the checkbox uses `data-tip`, with no `title=`, no cursor rules and no native dialogs. It defaults to checked, is read and written through localStorage (`iv.roman`), and applies on the next Stop then Start. `preload.js`, `main.js` and `.env` are untouched, and no `[OCR-DISABLED]` line is changed. Pre-existing uncommitted work is not reverted.

<details>
<summary>Issues (3)</summary>

1. **Hard hint on retry** (possible) — `romanize_hint_language` forces one language on the retry, which can mis-transcribe code-mixed audio. Acceptable; consider logging retry counts.
2. **Added latency** (confirmed) — the romanize chat call runs inline before the transcript is sent. Acceptable; consider emitting the raw text first if latency complaints appear.
3. **No end-to-end test of the frontend checkbox wiring** (confirmed) — the new tests cover `setRoman`/`parseStoredRoman` and the frame shape. The DOM handler is covered only by the stealth/compile audit. Low risk.

</details>

<details>
<summary>Details</summary>

### Evidence and spec checks

Evidence reviewed, not re-run: backend 225 passed (was about 157), frontend interview 37 and stealth audit 37 passed.

- **Frontend diff exists:** confirmed in the working tree. The checkbox is `#iv-roman`, `checked`, with `data-tip`. `readStoredRoman`/`writeStoredRoman` use localStorage. `startOpts` passes `roman: el.roman ? el.roman.checked : true`. `buildStartFrame` and the `/ws/audio` envelope both carry `roman`. `setRoman`, `getRoman` and `parseStoredRoman` are present. `ur`, `kn` and `ml` are in the mirror registry.
- **Backward compatibility:** confirmed. With `roman` absent, `_truthy(None)` is false, the reply shape is unchanged, and the session passes no extra kwargs.
- **Retry once then drop:** confirmed in `transcribe_with_guard` (a single second call). The caller `continue`s without a reply or error.
- **Language tag from pre-romanization text:** confirmed in `ws_audio`, where the tag is computed before `romanize_text`.
- **romanize never raises:** confirmed. It has a broad except and returns the original.
- **Registry sync:** `interview_config.py` and `interview.js` match, and the test expectation was updated.

### Hint on retry for mixed audio

On the retry, a single non-English language in the set becomes a hard Whisper `language` hint. With English plus one Indian language and genuinely mixed speech, the hint can bias toward that language. It only fires after an implausible first pass, so the blast radius is small.

</details>

<details>
<summary>File map</summary>

- screen_shot/script_guard.py (new): script detection, plausibility guard, retry-or-drop
- screen_shot/ai.py: Roman steering prompts, `romanize_text`, Roman answer directives, `roman` kwargs
- screen_shot/server.py: `_truthy`, guarded STT, romanize and reply fields, start frames and REST
- screen_shot/interview_session.py: `roman` on session and manager
- screen_shot/interview_config.py: ur/kn/ml added, registry reordered
- screen_shot/tests/*: new roman and script_guard tests, registry test updated
- overlay_app/index.html: checkbox, storage, startOpts
- overlay_app/interview.js: state.roman, frames, API, registry mirror
- overlay_app/test/interview.test.js: 5 new tests

Full diff: `git diff` in each repo.

</details>
