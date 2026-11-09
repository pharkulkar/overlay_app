# Backend verification (roman-output)

Repo: /Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot (no commit, no branch switch, .env untouched)

## Commands run (from the repo root)
- `.venv/bin/python -m pytest tests/ -q` -> **225 passed** (baseline ~157; +68 new/changed tests, 0 failures)
- `env -u OPENAI_API_KEY .venv/bin/python -c "import server"` -> exit 0; `sys.modules` contains none of easyocr, torch, paddle, paddleocr.
- `.venv/bin/python -m pytest tests/test_language_registry.py tests/test_language_default.py -q` -> 35 passed (after item 1)

## Files changed
- interview_config.py: registry adds ur, kn, ml; Indian languages grouped (en, hi, hing, ur, mr, bn, gu, pa, ta, te, kn, ml, then others). /api/health iterates the registry, so no change needed there.
- script_guard.py (new, stdlib only): script_of / script_counts / has_non_latin, allowed_scripts, is_plausible, romanize_hint_language, transcribe_with_guard (one retry then drop), derive_language_tag.
- ai.py: _ROMAN_STEER_PROMPTS, _steer_prompt_for, transcribe_detailed(roman=False), romanize_text (never raises, skips client for Latin/empty/unconfigured, 2000-char cap), language_instruction(language, roman=False), roman threaded through _build_interview_prompt and answer_interview_question[_stream].
- interview_session.py: roman on InterviewSession and SessionManager.start_session; `roman=True` is passed to the answer functions only when set (old stubs keep working); comment on the hi/ur/hing tag staying for detection.
- server.py: _truthy, defensive script_guard import, ws_audio Roman path (guard, tag from original text, romanize, reply adds roman/converted only when roman), ws_interview and REST start accept roman; SESSION_STARTED and REST response echo roman. Docstrings updated.
- tests/test_language_registry.py (EXPECTED_CODES), tests/test_script_guard.py (new), tests/test_roman.py (new).

## ws_audio test approach
flask-sock has no test client, but `server.app.view_functions["ws_audio"].__wrapped__` is the raw handler, so the tests call it with a fake ws object and a monkeypatched `server.ai_helper`. Covered: roman reply shape with roman/converted, language tag from the original text, Latin text skipping romanize, old reply shape without roman, Audio-tab shape (no languages) unchanged, and drop after exactly one retry with no reply and no error.

## Notes
- Pre-existing behaviour kept: with a set containing hi (and not ur), `transcribe_detailed` already derives sem_lang "hi" and passes a hard `language="hi"` hint; Roman mode only changes the steering prompt there.
- Not verified from a shell (needs live speech and an OpenAI key): real Hindi/Marathi/Tamil/English rendering in English letters, Urdu-script and Chinese outputs converted or dropped, answer language and script, added latency of the romanize call (about one short chat call per non-Latin utterance, plus at most one STT retry).
