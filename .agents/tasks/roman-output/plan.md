# Implementation Plan: Roman (English-letters) output

Paths: BE = /Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot, FE = /Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app.
Rules: edit in place, no commits/branch switches, never read or modify .env, keep all `[OCR-DISABLED]` blocks commented, preload.js stays untouched (sandboxed). Run backend tests from BE with `.venv/bin/python -m pytest tests/ -q`; frontend from FE with `npm test`.

## Design decisions

- D1. Helpers live in a new pure module `BE/script_guard.py` (stdlib only, no openai/flask imports). The STT guard decision logic lives there too as `transcribe_with_guard(...)`, taking the transcribe callable so tests need no network. `server.py` ws_audio stays thin and calls it.
- D2. `romanize_text` and the Roman steering prompts live in `ai.py` (they need the OpenAI client).
- D3. Wire contract is additive. When `roman` is absent or false, every code path and reply shape is byte-identical to today.
- D4. `roman` is sent to the session only when true. The existing test stubs (`FakeAI`, `ContextAI` in `tests/test_interview_session.py`) have no `roman` kwarg, so `_generate` adds `roman=True` to the call kwargs only when the session's roman flag is true. This keeps the stubs working.
- D5. Language tag comes from the ORIGINAL text, before the plausibility guard's final result is converted. Romanized Hindi therefore stays tagged `hi`, `ur` or `hing` (never `en`), and `QuestionDetector.detect(text, language)` still routes it to the LLM classifier. No change to `question_detector.py`.
- D6. Hindi family = {hi, ur, hing}. In Roman mode `language_instruction` gives all three the existing `hing` directive.
- D7. Retry hint rule: the single non-English language of the set if there is exactly one, else the first selected language. If that code is `hing` (or any pseudo-code), pass no hard code. The Roman prompt does the steering. Never loop more than once.
- D8. The extra OpenAI calls are bounded. `romanize_text` runs only when non-Latin text remains. The retry runs at most once per utterance. Put this in code comments.

## Wire contract

- `/ws/interview` start frame: `{type:'start', session_id, candidate_profile, language, languages, roman: <bool>}`. SESSION_STARTED additionally echoes `roman`.
- `/ws/audio` envelope: `{speaker:'them', audio, filename, languages, roman: <bool>}`.
- Transcript reply when roman is true: `{type:'transcript', speaker, text:<roman text>, language, speech_locale, roman:true, converted:<bool>}`.
- Transcript reply when roman is absent or false: exactly the old shape (`type, speaker, text`, plus `language` and `speech_locale` when `languages` was sent).
- Dropped utterances send no reply. The original text is never persisted or logged.
- `roman` parsing: `roman = msg.get("roman") is True`. `server.py` uses a small `_truthy(v)` helper accepting True, "true", "1" and 1.

## BACKEND

- [ ] 1. Extend the language registry with Kannada, Malayalam and Urdu.
      In `BE/interview_config.py` `SUPPORTED_LANGUAGES`, add `kn` (Kannada, ಕನ್ನಡ, kn-IN), `ml` (Malayalam, മലയാളം, ml-IN) and `ur` (Urdu, اردو, ur-IN). Reorder so Indian languages are grouped: en, hi, hing, ur, mr, bn, gu, pa, ta, te, kn, ml, then the non-Indian languages (zh, es, fr, de, ja, ko, ar, pt, ru, it, nl, tr). Dict order drives `/api/health` order, so `server.py` api_health needs no change; confirm it iterates `SUPPORTED_LANGUAGES.items()`.
      Update `EXPECTED_CODES` in `BE/tests/test_language_registry.py` with kn, ml, ur. Check the other assertions in that file for anything position-based or count-based.
      Files: BE/interview_config.py, BE/tests/test_language_registry.py
      Verify: `.venv/bin/python -m pytest tests/test_language_registry.py tests/test_language_default.py -q` passes.

- [ ] 2. Create `BE/script_guard.py` (pure helpers).
      Contents:
      - Script name constants: LATIN, DEVANAGARI, BENGALI, GURMUKHI, GUJARATI, TAMIL, TELUGU, KANNADA, MALAYALAM, ARABIC, HAN, KANA, HANGUL, CYRILLIC, GREEK, HEBREW, THAI, OTHER, plus UNKNOWN for empty or symbol-only text.
      - `_script_for_char(ch)`: Unicode range table.
        - Latin: basic letters, Latin-1 letters, Latin Extended-A/B and Latin Extended Additional.
        - Devanagari: 0900-097F.
        - Bengali: 0980-09FF.
        - Gurmukhi: 0A00-0A7F.
        - Gujarati: 0A80-0AFF.
        - Tamil: 0B80-0BFF.
        - Telugu: 0C00-0C7F.
        - Kannada: 0C80-0CFF.
        - Malayalam: 0D00-0D7F.
        - Arabic: 0600-06FF, 0750-077F, FB50-FDFF, FE70-FEFF.
        - Han: 4E00-9FFF, 3400-4DBF.
        - Kana: 3040-30FF.
        - Hangul: AC00-D7AF, 1100-11FF.
        - Cyrillic: 0400-04FF.
        - Greek: 0370-03FF.
        - Hebrew: 0590-05FF.
        - Thai: 0E00-0E7F.
        - Anything else that `str.isalpha()` is OTHER. Non-letters return None.
      - `script_counts(text) -> dict`.
      - `script_of(text) -> str`: the dominant script among letters only, ignoring digits, punctuation and whitespace. Returns UNKNOWN for empty or symbol-only text. Ties are deterministic (higher count wins, then fixed script-name order).
      - `has_non_latin(text) -> bool`: True if any letter is not Latin.
      - `_SCRIPTS_BY_LANG` map: en->{LATIN}; hi, mr->{DEVANAGARI, LATIN}; hing->{LATIN}; ur, ar->{ARABIC}; bn->{BENGALI}; pa->{GURMUKHI}; gu->{GUJARATI}; ta->{TAMIL}; te->{TELUGU}; kn->{KANNADA}; ml->{MALAYALAM}; zh->{HAN}; ja->{HAN, KANA}; ko->{HANGUL}; ru->{CYRILLIC}; es, fr, de, pt, it, nl, tr->{LATIN}. Unknown codes map to {LATIN}.
      - `HINDI_FAMILY = frozenset({"hi", "ur", "hing"})`.
      - `allowed_scripts(selected, roman) -> set`: union over the selected languages. If roman, always add LATIN. If roman and any selected code is in HINDI_FAMILY, add ARABIC. If not roman, behave as the plain union, and Latin stays allowed because English and Latin loanwords are normal in every Indic transcript.
      - `is_plausible(text, selected, roman) -> bool`:
        - Empty or symbol-only text returns True (nothing to reject).
        - Otherwise True only if every script that holds at least ~10% of the letters is allowed. Mixed Hinglish passes. Pure Han with selected en+hi+mr fails.
      - `romanize_hint_language(selected) -> str | None` (D7): the single non-English code if exactly one, else `selected[0]`. Return None for pseudo-codes such as `hing`.
      - `transcribe_with_guard(transcribe, selected, roman, hint) -> tuple[str, str | None] | None`:
        - `transcribe(language_hint, roman)` is a callable returning `(text, detected)`.
        - First call uses the original hint. If the text is empty, return `("", detected)`.
        - If `is_plausible` is true, return `(text, detected)`.
        - Otherwise make exactly ONE retry with the D7 firm hint. If the retry text is plausible, return it. If still implausible, return None (drop).
        - If `roman` is false, never guard. Return the first result unchanged, which preserves old behavior.
        - A retry exception propagates to the caller, which handles it fail-soft.
      - `derive_language_tag(text, detected, selected, detect_fn) -> str`: pure form of today's logic. Use `detected` if it is in `selected`. Else if there is a single selected language, use `detected or selected[0]`. Else `detected or detect_fn(text, selected)`.
      File: BE/script_guard.py
      Verify: `.venv/bin/python -c "import script_guard"` succeeds. Tests come in item 8.

- [ ] 3. ai.py: Roman steering prompts, `romanize_text`, `language_instruction(roman)` and answer plumbing.
      a. Add `_ROMAN_STEER_PROMPTS` beside `_SCRIPT_STEER_PROMPTS`. Each is one short Roman-letters sample sentence for hi, ur, hing, mr, ta, te, bn, gu, pa, kn and ml. Examples: hi/ur/hing "Yeh function kaise optimize karein aur iska time complexity kya hai"; mr "Hya problem la apan kasa solve karu shakto"; ta "Indha function ah eppadi optimize pannalam". English-only sets get no steering.
      b. Add `_steer_prompt_for(sem_lang, roman)`. It returns the Roman prompt when roman is true and the language has one, else the old `_SCRIPT_STEER_PROMPTS.get(sem_lang)`.
      c. Extend `transcribe_detailed(..., roman: bool = False)`. The only change is how `steer_prompt` is chosen.
         - In roman mode with no single `sem_lang`, derive it from the candidate set. Use `hing` if it is present. Else use the first Indic code in the set, with Hindi-family codes winning. English-only sets get None.
         - `hint` rules stay as today: `hing` and unknown codes pass no hard code, and only genuine ISO codes (including the new kn, ml and ur) are passed.
         - Add `roman` as a keyword with a default so the old callers and tests are unaffected.
      d. Add `romanize_text(text, language=None, model=None) -> tuple[str, bool]`.
         - It never raises.
         - Return `(text, False)` immediately, without a client call, if the text is empty, `has_non_latin(text)` is false, or `is_configured()` is false.
         - Cap the input at 2000 chars. Use a temperature-0 chat completion on `CHAT_MODEL`.
         - System prompt: "Transliterate the user's text into Roman/Latin letters the way Indians type in chat (Hinglish style). Do NOT translate. Do NOT correct grammar. Keep English words, technical terms, code, numbers and punctuation unchanged. Output ONLY the converted text."
         - Optionally add "The speech language is <name>" when `language` is known.
         - On any exception, an empty reply, or a reply that is still mostly non-Latin (use `script_guard.has_non_latin` plus a dominant-script check), return `(original, False)`.
         - On success return `(roman, True)`.
         - Comment on cost and latency (D8).
      e. Extend `language_instruction(language, roman=False)`.
         - If roman is false, behave exactly as today.
         - If roman is true and the code is English or unknown, return the existing English text.
         - If roman is true and the code is in the Hindi family, return the existing `_ANSWER_LANGUAGE_DIRECTIVES["hing"]` text.
         - If roman is true and the code is any other non-English language, return "- Respond in <Name> written ENTIRELY in Roman/Latin letters, the way people type it in chat, never in native script. Keep technical terms and code in English. Match the language of the interviewer's question." Keep the shared rules in the base prompt untouched (resume rule, etc.).
         - Keep the `_language_instruction` alias working. Update it as a plain alias or a wrapper that accepts `roman`.
      f. Thread `roman: bool = False` through `_build_interview_prompt`, `answer_interview_question` and `answer_interview_question_stream`. Place it as the last keyword.
      Files: BE/ai.py
      Verify: `.venv/bin/python -m pytest tests/test_ai_language.py tests/test_interview_session.py -q` still passes.

- [ ] 4. Interview session `roman` plumbing in `BE/interview_session.py`.
      - Add `roman: bool = False` to `InterviewSession.__init__`, stored as `self.roman = bool(roman)`.
      - Add `roman: bool = False` to `SessionManager.start_session` and pass it to the session.
      - In `_generate`, build `extra = {"roman": True} if self.roman else {}` and pass `**extra` to both `answer_interview_question_stream` and `answer_interview_question` (D4).
      - Do not change `_finalize_utterance`. It already uses the tagged language for detection and the coerced in-set language for the answer. Add a code comment saying romanized Hindi keeps its `hi`, `ur` or `hing` tag (D5).
      File: BE/interview_session.py
      Verify: `.venv/bin/python -m pytest tests/test_interview_session.py tests/test_interview_api.py -q` passes.

- [ ] 5. Wire `roman` into `server.py` ws_audio and the interview start paths.
      - Add `_truthy(v)` near the `_normalize_language*` helpers, and import `script_guard` defensively like the other optional modules.
      - ws_audio: `roman = _truthy(msg.get("roman")) and has_langs` (Roman mode only applies on the language-aware path). Inside the `has_langs` branch:
        1. Define `def _stt(lang_hint, is_retry=False): return ai_helper.transcribe_detailed(audio_bytes, filename=filename, language=lang_hint, candidate_languages=selected, roman=roman)`. When roman is false, call without the `roman` kwarg so old stubs and behavior are unchanged.
        2. If roman, `result = script_guard.transcribe_with_guard(_stt, selected, roman, hint)`. If the result is None, log at warning without the text, `continue` (drop, no reply), and do not touch `convo`.
        3. Compute `true_lang` with `script_guard.derive_language_tag(original_text, detected, selected, ai_helper.detect_language)` BEFORE conversion (D5). Keep `speech_locale = _speech_locale_for(true_lang)`.
        4. If roman and `has_non_latin(text)`: `text, converted = ai_helper.romanize_text(text, language=true_lang)`. Otherwise `converted = False`.
      - Reply: add `roman: True` and `converted: converted` only when roman is on. `convo.add_turn` receives the Roman text. The existing `except ai_helper.AIError` and `except Exception` handlers stay in place, so failures remain fail-soft and never crash the socket.
      - ws_interview: pass `roman=_truthy(msg.get("roman"))` to `interview_manager.start_session(...)`, and add `"roman": session.roman` to the SESSION_STARTED payload. Update the docstring to list `roman`.
      - `api_interview_start` (REST): read `data.get("roman")`, pass it, and echo `"roman"` in the response.
      - `api_health`: unchanged apart from the larger registry.
      File: BE/server.py
      Verify: `env -u OPENAI_API_KEY .venv/bin/python -c "import server"` exits 0 and does not import easyocr, torch or paddle (also check `python -X importtime` or `sys.modules` for those names). Then `.venv/bin/python -m pytest tests/ -q` passes.

- [ ] 6. Backend tests (no network).
      - NEW `BE/tests/test_script_guard.py`:
        - `script_of` for English, Hindi, Marathi, Bengali, Gurmukhi, Gujarati, Tamil, Telugu, Kannada, Malayalam, Urdu, Chinese, Japanese kana, Korean, Russian, mixed Hinglish with Devanagari words, empty text and symbol-only text.
        - `has_non_latin`.
        - `allowed_scripts` and `is_plausible`: Chinese rejected for en+hi+mr in both modes; Arabic accepted only when a Hindi-family language is selected in roman mode; Devanagari accepted for hi and mr; Latin always accepted in roman mode; Tamil rejected for en+hi.
        - `transcribe_with_guard` with stub callables: plausible first result means 1 call; implausible then plausible means 2 calls with the firm hint passed; implausible twice means None after exactly 2 calls; roman false never retries; empty text returns without retry; retry-hint selection (single non-English, else first, `hing` gives None).
        - `derive_language_tag` computed from the pre-romanization text (detect_fn stub sees the original).
      - NEW `BE/tests/test_roman.py`:
        - `romanize_text` with a stub client via monkeypatching `ai._get_client` and `ai.is_configured`: no client call for Latin or empty text; converted True on a good reply; `(original, False)` on stub exception, empty reply and still-non-Latin reply; input cap at 2000 chars; the system prompt contains "do not translate" semantics.
        - `language_instruction` roman directives for hi, ur, hing (Roman Hinglish text, "Roman"), mr and ta (names plus "ENTIRELY" and "Roman/Latin"), en (unchanged). Non-roman output is byte-identical to the previous strings for hi, hing, mr and en.
        - `_steer_prompt_for` roman versus non-roman.
        - Session test using the same FakeAI pattern as `tests/test_interview_session.py`: a session with `roman=True` passes `roman=True` and the right coerced language (a `ur` tag answers with the hing directive path, a `mr` tag with `mr`) to the stub. A session with `roman=False` never passes the kwarg, and old stubs still work. Detection routing: a romanized Hindi turn tagged `hi` reaches `detector.detect` with `language='hi'`.
        - ws_audio-level: first check whether the project's flask-sock test client works (inspect `tests/conftest.py`, `tests/test_vision_ask.py`, `tests/test_interview_api.py` for the existing app-client pattern). If feasible, add a test driving `ws_audio` with a fake `ai_helper` (monkeypatch `server.ai_helper`) for: roman reply shape with `roman`/`converted`, the old reply shape without `roman`, and the drop case. If a websocket test client is not feasible, say so in the final report. The extracted functions (`transcribe_with_guard`, `derive_language_tag`, `romanize_text`) are covered directly.
        - `/api/health` lists kn, ml and ur; `api_interview_start` echoes `roman`.
      Files: BE/tests/test_script_guard.py, BE/tests/test_roman.py (and BE/tests/test_language_registry.py from item 1)
      Verify: `.venv/bin/python -m pytest tests/ -q` — everything passes. Record the new total (baseline is about 157).

## FRONTEND

- [ ] 7. interview.js: registry mirror, roman state, start frame and audio envelope.
      File: FE/interview.js
      - Mirror registry (`SUPPORTED_LANGUAGES`, ~line 55): same order as backend item 1; add `{code:'ur', name:'Urdu', native:'اردو', locale:'ur-IN'}`, `{code:'kn', name:'Kannada', native:'ಕನ್ನಡ', locale:'kn-IN'}` and `{code:'ml', name:'Malayalam', native:'മലയാളം', locale:'ml-IN'}`.
      - `state` (~line 109): add `roman: true`.
      - `start(opts)` (~line 622): `state.roman = opts.roman !== false` (default true). Update the opts doc comment.
      - `buildStartFrame()` (~line 429): add `roman: state.roman`.
      - The `/ws/audio` utterance envelope (~line 344): `sttSend({ speaker:'them', audio:dataUrl, filename:'them.webm', languages: state.languages, roman: state.roman })`.
      - STT transcript handler (~line 394): pass `roman`/`converted` through to `emit('onTranscript', {..., converted: !!msg.converted})`. The `ivSend` transcript frame is unchanged apart from carrying the Roman text.
      - Accessors beside `setLanguages`: `setRoman(v)` sets `state.roman = v !== false && !!v` (keep it boolean; non-boolean falsy values other than `undefined` mean false, `undefined` means true), and `getRoman()`.
      - Add a pure helper `parseStoredRoman(raw)`: null or undefined -> true (default ON); 'false' or '0' -> false; anything else -> true. Expose it as `InterviewMode.parseStoredRoman` so the test and index.html share it.
      Verify: `node --check interview.js`, then `npm test` — existing 32 interview tests pass.

- [ ] 8. index.html: the "Show everything in English letters" option (depends on 7).
      File: FE/index.html
      - Markup in the Interview action row, right after the `#iv-langs` `<details>` (~line 575): `<label class="iv-roman" data-tip="Transcripts and answers use English letters for every language"><input type="checkbox" id="iv-roman" checked><span>Show everything in English letters</span></label>`. Style it with a small CSS rule next to `.iv-langs` (reuse the checkbox label look from `.iv-langs-list label`). No `title=`, no native select, no cursor rules, no `window.open`.
      - JS next to `readStoredLanguages` (~line 2573): `const ROMAN_STORAGE_KEY = 'iv.roman'`; `readStoredRoman()` returning `IV.parseStoredRoman(localStorage.getItem(...))` (try/catch, default true); `writeStoredRoman(bool)` storing `'true'` or `'false'`.
      - `el` map: `roman: document.getElementById('iv-roman')`.
      - Init (near `buildLangDropdown(readStoredLanguages() || ['en'])`, ~line 2994): set `el.roman.checked = readStoredRoman()` and `IV.setRoman(el.roman.checked)`. Add a `change` listener that calls `writeStoredRoman`, `IV.setRoman`, and, if `IV.isRunning()`, `showError('Language change applies when you Stop then Start listening.')`. Use a roman-specific message such as 'English-letters change applies when you Stop then Start listening.'
      - `startOpts()` (~line 2878): add `roman: el.roman ? el.roman.checked : true`.
      - Optional: when `onTranscript` receives `converted:true`, add a subtle marker. Skip it if it needs more than a couple of lines or any non-audit-safe markup.
      - Confirm every id used by the JS exists exactly once (`iv-roman` included).
      Verify: compile every inline `<script>` block of index.html and selection.html with `node -e` using `vm.Script`; `npm test` — the 37 stealth-audit tests still pass.

- [ ] 9. Frontend tests (depends on 7 and 8).
      File: FE/test/interview.test.js (follow the existing `_buildStartFrame` / `_sendStartFrame` test style at ~line 235); extend FE/test/stealth-audit.test.js only if a gap exists, never weaken it.
      - Start frame includes `roman`, default true.
      - `start`-less `setRoman(false)` then `getRoman()` is false, and the start frame reflects it.
      - `parseStoredRoman`: null -> true, 'true' -> true, 'false' -> false, '0' -> false, garbage -> true.
      - Registry mirror contains ur, kn and ml, and codes stay unique.
      - Audio envelope: if the existing tests have a seam for `sttSend`, assert the envelope has `roman`. Otherwise assert via a source-text check on `interview.js` that the envelope literal contains `roman: state.roman`, and note it.
      - A static check that `index.html` contains `id="iv-roman"` exactly once with a `data-tip` and no `title=`. The stealth audit already scans the whole file, so confirm it covers the new label.
      Verify: `npm test` — all pass. Record the new counts (baseline 32 + 37).

## FINAL VERIFICATION (after items 1-9)

- `cd BE && .venv/bin/python -m pytest tests/ -q` passes. `env -u OPENAI_API_KEY .venv/bin/python -c "import server"` boots, and easyocr/torch/paddle are absent from `sys.modules`.
- `cd FE && npm test` passes. `node --check main.js preload.js interview.js`. Compile every inline script of index.html and selection.html with `vm.Script`. Every id used by the JS exists exactly once.
- Confirm `git diff --stat` shows both repos' changes without any files outside the plan (no .env, no commits, no branch switch).
- Reviewer must open the FE diff and confirm it really contains: the `#iv-roman` checkbox, localStorage persistence, `roman` in `buildStartFrame()` and the `/ws/audio` envelope, `setRoman/getRoman`, `startOpts` roman, and the ur/kn/ml registry entries.
- Report what cannot be verified from a shell and must be tried live with real speech and an OpenAI key: Hindi, Marathi, Tamil and English speech rendered in English letters; Urdu-script and Chinese outputs being converted or dropped; answers coming back in the question's language in English letters; the latency added by the romanize call (roughly one extra short chat call per non-Latin utterance, plus at most one STT retry).
- Restart steps: restart the Flask backend (`run.sh`), then fully quit and relaunch the Electron overlay. Changing the checkbox or languages applies after Stop then Start.
- Final summary lists: every changed file and why, the wire contract above, the plausibility/retry/drop rules, the romanize prompt, the answer directives, test counts, and residual risks. Known risks: `gpt-4o-mini-transcribe` may reject `verbose_json`, so language usually comes from `detect_language`; the plausibility threshold may drop short mixed utterances; romanizing adds latency; Latin-heavy output from the STT steering prompt is not guaranteed.

## Restructuring decision

The work is one coherent change across two tightly coupled codebases with a shared wire contract. Splitting it into separate FEAT coders would force an artificial boundary and risk contract drift, so the workflow tail is NOT restructured. The existing implement-and-review loop runs this plan in order (BE items 1-6, then FE items 7-9, then final verification).
