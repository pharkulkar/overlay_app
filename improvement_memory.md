# STT Improvement: Memory (current state)

Read this first in a new session. Plan is in `improvement_phases.md`. Audit evidence: `.agents/tasks/stt-audit/report.md`.
Update the "Current state", "Log" and "Open questions" sections after every phase step.

## Current state (as of Nov 5, 2026)
- Active phase: Phase 1 implemented (uncommitted, both repos), pending user live verification. Phases 2-4 not started.
- STT pipeline today: Interview mode captures interviewer system audio (`getDisplayMedia`, loopback) in `overlay_app/interview.js`; client-side VAD (speechLevel 0.055, silenceMs 450, minSpeechMs 350, maxUtterMs 15000, values in `overlay.config.json`); each utterance is recorded as opus/webm via MediaRecorder and sent base64 over `/ws/audio` to `screen_shot/server.py`; `ai.transcribe_detailed` calls `gpt-4o-mini-transcribe` (default, env `OPENAI_TRANSCRIBE_MODEL`); script guard (`script_guard.py`) then optional romanize; result goes to `/ws/interview`.
- Known issues (from the audit, not measured live): `verbose_json` is probably rejected by the 4o transcribe models so each utterance makes a failed call plus a retry and language is always None; default model is deprecated (shutdown 2027-02-26); steering prompts contain an example question that can be echoed; no phantom-text filter; script guard can silently drop Hinglish if Devanagari comes back; no vocabulary/context reaches STT; `VAD_PREROLL_MS` is unused; 15 s hard cut can split words.
- Baseline tests before this work: overlay_app `npm test` = 59 + 38 passed; screen_shot `pytest -q` = 225 passed.

## Phase 1 status: Done pending user verification (no commit made)
Backend `screen_shot/`:
- `ai.py` `transcribe_detailed`: single plain call (no `response_format`), errors go through `_wrap_openai_errors` once, no second call; returns `(text, language|None)`.
- `ai.py` `_SCRIPT_STEER_PROMPTS` / `_ROMAN_STEER_PROMPTS`: neutral text, no example question. Roman: "Transcribe exactly what is said. Write all speech in English (Roman) letters only." (all Indic keys). Native: hi/mr "Transcribe exactly what is said. Write Hindi|Marathi in Devanagari; keep English technical terms in English letters."; hing uses the Roman text.
- `script_guard.py`: new `is_phantom_transcript(text, steer_texts)` (empty/punctuation, whole-transcript match of a short English phantom list, or echo of a steering prompt: equal, or a run of 3+ of its words). `_SCRIPTS_BY_LANG`: hing and ur now also accept Devanagari (hi family already got Arabic in Roman mode); existing romanize path in `server.py` converts them.
- `server.py` `/ws/audio`: phantom/echo transcripts dropped silently (debug log); an utterance dropped by the guard after its retry now sends `{"type":"error","error":"Couldn't transcribe that last part"}`. The client already renders `type:'error'` (interview.js onError, shown as "Transcription: ..."), so no frontend change was needed.
- Tests: `tests/test_script_guard.py` (+4), `tests/test_roman.py` (+2, drop test now expects the error event, fake helper carries steering dicts). pytest: 232 passed (baseline 225). `import server` loads no easyocr/torch/paddle.
Frontend `overlay_app/`: no code change. `node --check` ok; `npm test` 59 + 38 passed.
Not verified: no live audio, no OpenAI call made. Whether the models honour the new steering text is untested.
Experiment knob (1.5, no code): to try the larger model set `OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe` in the backend env; it is read at import in `ai.py` (~line 65), so restart the server. Default stays `gpt-4o-mini-transcribe`.
Live test: in Interview mode with Roman on, speak a short English question, a Hindi question and a Hinglish question; confirm transcripts appear, no repeated steering text, no silent loss.

## Decisions
- Step by step: one phase at a time, verify, then ask before the next.
- Keep the client-side VAD design, Roman-letter feature and merge windows.
- The default model is not changed until Phase 2 A/B evidence exists.
- Docs live in `overlay_app/` and cover both repos.

## Log
- Audit completed (read-only); report at `.agents/tasks/stt-audit/report.md`.
- Plan documented (this file and `improvement_phases.md`).

## Open questions / unverified
- Does `gpt-4o-mini-transcribe` really return 400 for `verbose_json` in this deployment?
- Does `gpt-transcribe` honour Roman-script steering and handle Hinglish? Does the installed `openai` SDK expose `languages` and pass `keywords` (else `extra_body`)?
- Chromium default AGC/noise suppression/echo cancellation on loopback audio; rAF throttling of the VAD loop when the overlay is hidden.
- Nothing has been measured on real interview audio yet.
