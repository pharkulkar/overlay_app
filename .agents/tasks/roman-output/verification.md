# Roman output: integration verification (iteration 1, no review.json)

## Seam checks (no gaps found, no edits needed)
- Start frame: interview.js buildStartFrame() sends `roman`; server.py ws_interview reads `_truthy(msg.get("roman"))` and echoes `roman` in SESSION_STARTED. REST /api/interview/start accepts and echoes `roman`.
- /ws/audio envelope: interview.js sends `{speaker:'them', audio, filename, languages, roman}`; server.py ws_audio enables the Roman path only when roman is truthy AND languages were sent.
- Transcript reply: backend sends `language`, `speech_locale`, and (Roman mode only) `roman:true`, `converted`; interview.js reads `converted` and passes it to onTranscript. Without `roman` the old reply shape is kept.
- Registry: interview_config.SUPPORTED_LANGUAGES and the interview.js mirror have identical codes and order: en, hi, hing, ur, mr, bn, gu, pa, ta, te, kn, ml, zh, es, fr, de, ja, ko, ar, pt, ru, it, nl, tr.
- Frontend diff exists: `#iv-roman` checkbox (checked, data-tip, no title=) at index.html:578, `iv.roman` localStorage read/write, change listener calling IV.setRoman, `roman` in startOpts(); interview.js state.roman, setRoman/getRoman/parseStoredRoman.
- preload.js requires only `electron`. No [OCR-DISABLED] block re-enabled. .env not touched. No commit, no branch switch.

## Commands and results
- screen_shot: `.venv/bin/python -m pytest tests/ -q` -> 225 passed
- screen_shot: `env -u OPENAI_API_KEY .venv/bin/python -c "import server"` -> boots; easyocr/torch/paddle/paddleocr not in sys.modules
- overlay_app: `npm test` -> interview suite 37 passed, stealth audit 37 passed, 0 failed (the audit includes "every inline <script> compiles" and "every id exists exactly once")
- overlay_app: `node --check main.js preload.js interview.js` -> OK
- Inline-script vm.Script compile: covered by the stealth-audit test above (index.html 2 blocks, selection.html 1 block, per the frontend report). A standalone re-run printed no output in this shell, so I rely on that test.

## Files changed and why
Backend (screen_shot): interview_config.py (ur/kn/ml, grouped Indian languages); script_guard.py (new: script_of, has_non_latin, allowed_scripts, is_plausible, retry-once-then-drop, tag derivation); ai.py (Roman steering prompts, transcribe_detailed(roman), romanize_text, language_instruction(roman)); interview_session.py (roman plumbing); server.py (ws_audio Roman path, start-frame/REST roman); tests: test_language_registry.py, new test_script_guard.py and test_roman.py.
Frontend (overlay_app): interview.js, index.html, test/interview.test.js.

## Rules
- Plausibility: text must use only scripts allowed for the selected languages. In Roman mode Latin is always allowed, and Arabic script is allowed when hi/ur/hing is selected.
- Implausible: retry transcription once with a firm language hint (the single non-English language, else the first selected) plus the Roman prompt. Still implausible: drop the utterance with no reply and no error.
- Language tag comes from the original text before conversion. Romanize only runs when non-Latin text remains, so romanized Hindi stays hi/ur/hing and not en.
- Romanize: temperature 0, transliterate in the way Indians type in chat, never translate or fix grammar, keep English/technical terms/numbers/punctuation, output only the text. Input capped at 2000 chars. Never raises: on error or empty result it returns the original text with converted=False.
- Answers: hi/ur/hing get Roman Hinglish. Other non-English languages are answered in that language written entirely in Roman letters, with code and technical terms in English. English is unchanged. Roman off or absent: old directives.

## Tests
Backend 225 passed (about 157 before). Frontend interview 37 (32 before) and stealth audit 37.

## Cannot be verified from a shell
Real Hindi/Marathi/Tamil/English speech rendered in English letters; Urdu-script and Chinese outputs being converted or dropped; answers in the question's language in English letters; latency of the romanize call; live checkbox behavior and persistence across relaunch. These need Electron, the backend, and an OpenAI key.

## Restart steps
Restart the Flask backend. Fully quit and relaunch the overlay. A changed checkbox applies after Stop then Start listening.

## Residual risks
- One extra short chat call per non-Latin utterance, plus at most one STT retry.
- The steering prompt does not guarantee Latin output, and the default transcribe model may not report a language, so the tag often relies on detect_language.
- Transliteration quality depends on the chat model.
- A hard hint on a retry can force the wrong language on code-mixed audio.
