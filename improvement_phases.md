# STT Accuracy Improvement: Phases

Plan for raising speech-to-text accuracy in the interview copilot. Source of truth for findings: `.agents/tasks/stt-audit/report.md` (read-only audit, Nov 2026).
Current state and results live in `improvement_memory.md`. Update both files as each phase finishes.

Repos: `overlay_app` (Electron, branch ObservationsAtul) and `../screen_shot` (Flask, branch Version_2.0).
Ground rules: step by step, one phase at a time; verify and get the user's go-ahead before the next phase; no extra or unwanted code; nothing is committed unless the user asks.

## Phase 1: Fix the basics (small, low risk)
Goal: stop wasted calls, stop prompt echo, stop silent drops.
- 1.1 Response format: remove the `verbose_json` first attempt in `screen_shot/ai.py` (`transcribe_detailed`). Call with default/`json`; catch only expected errors (no blanket retry of timeouts). Keep the language return value working (`None` when the model gives none).
- 1.2 Steering prompts: replace the example-question text in `_SCRIPT_STEER_PROMPTS` and `_ROMAN_STEER_PROMPTS` (`ai.py`) with neutral guidance that cannot be mistaken for a real question.
- 1.3 Phantom/echo filter: in the `/ws/audio` path (`server.py`), drop transcripts that are echoes of the steering text or known phantom phrases ("thank you for watching", "transcribed audio chunk", etc.). Pure helper plus unit tests.
- 1.4 Script guard: in `script_guard.py` stop silent drops for Hinglish/Hindi family: accept Devanagari/Arabic output and route through the existing `romanize_text`; if an utterance is still dropped, surface a visible "couldn't transcribe" event instead of only a log line.
- 1.5 Experiment knob: document that `OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe` can be tried with no code change (do NOT change the default in this phase).
Exit criteria: backend pytest green; new unit tests for the filter and guard; `npm test` green; no change to Roman-letter behaviour for normal output.

## Phase 2: Model and language hints (needs sample clips)
Goal: use the recommended model with real language and vocabulary hints.
- 2.1 Collect a small A/B set of real clips (English, Hindi, Hinglish, one more Indic language) and a script to compare models. Decide the default model from results.
- 2.2 Migrate to `gpt-transcribe` (the older 4o models are deprecated, shutdown 2027-02-26). Pass the selected language set as `languages`; map `hing` to `["en","hi"]`. Check the installed `openai` SDK passes `keywords`/`languages` (use `extra_body` if not).
- 2.3 Vocabulary biasing: send resume skills/tools/employers and a few domain terms as `keywords` (one line each, no `<`, `>`, CR/LF).
- 2.4 Use the language returned by the model; remove the extra LLM `detect_language` call when STT already reports it.
Exit criteria: A/B results recorded in `improvement_memory.md`; default model decided with evidence; fallback to the previous model via env.

## Phase 3: Audio edges and VAD (client side)
Goal: stop clipping and stop sending long silence.
- 3.1 Real pre-roll (about 200-300 ms) or remove the dead `VAD_PREROLL_MS`; trim leading silence per utterance.
- 3.2 Hard cut at max length lands on the lowest-energy point with a small overlap instead of mid-word.
- 3.3 Rolling noise floor for the speech threshold (optional, only if clips show false triggers).
- 3.4 Send peak/speech-duration metadata so the server can reject near-silent clips.
Exit criteria: VAD unit tests; manual test on a live call.

## Phase 4: Capture format (largest, optional)
- 4.1 Move capture from lossy opus/webm to PCM/WAV via an AudioWorklet with a ring buffer; set explicit echoCancellation/noiseSuppression/autoGainControl constraints on the loopback stream.
- 4.2 A/B before and after. Keep only if it clearly helps.

## Deliberately not doing
- Realtime streaming (about 3.8x cost; improves latency, not accuracy).
- Changing the client-side VAD design, lowering `silenceMs` below 450, touching the Roman-letter feature or the end-of-utterance merge window.
- Using the microphone for interviewer accuracy.

## Status board
| Phase | Status |
|---|---|
| 1 Fix the basics | Done pending user verification |
| 2 Model and language hints | Not started |
| 3 Audio edges and VAD | Not started |
| 4 Capture format | Not started |
