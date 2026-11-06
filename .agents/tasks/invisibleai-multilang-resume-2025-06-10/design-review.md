# Design review — Multi-language detection + session-only resume (round 3)

Reviewed document: `.agents/tasks/invisibleai-multilang-resume-2025-06-10/design.md`
Scope: frontend `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app` + backend `/Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot`.
Method: read the design fresh, then verified every load-bearing claim against the real source in both repos (signatures, line numbers, wire shapes, tests). This is the third review round; the design claims to have resolved rounds 1 and 2. I re-verified those resolutions against source rather than trusting the design's word.

Verdict: **CHANGES_REQUESTED** (1 HIGH, 2 MEDIUM, 4 NIT).

The design is unusually thorough and almost all of its self-verification claims are accurate (see Verified Assumptions). The blocking findings are a small number of genuine, concrete gaps — chiefly a scoring/threshold arithmetic gap that would cause the core feature (non-Latin question detection) to silently drop questions, and two under-specified numeric/ordering details.

---

## Findings

### 1. HIGH — Non-Latin `？`/`؟`/`।` terminal-mark score (0.55) does not clear the detection threshold (0.6); the "core non-Latin fix" under-detects by arithmetic

Where: Feature 1d and the `question_detector.py` file-by-file entry — the fix is "extend `if norm.endswith("?"): score += 0.55` to also match `？`/`؟`/`।`" plus the "lenient non-English fallback at moderate confidence."

Verified against source:
- `question_detector.heuristic_detect` adds exactly `0.55` for a terminal `?` and nothing else for a bare question with no English-lexicon tokens (a non-English question cannot match `_WH_WORDS`, `_REQUEST_OPENERS`, etc. — those are English strings).
- `interview_session._finalize_utterance` keeps a detected question only if `result.is_question AND result.confidence >= self.config.detectionConfidenceThreshold`.
- `interview_config._DEFAULTS["detectionConfidenceThreshold"] == 0.6`.

Consequence: a plain non-Latin question such as `क्लोज़र क्या है।` or `クロージャとは？` scores `0.55` from the terminal mark alone. `heuristic_detect` sets `is_question = score >= 0.5` → `True`, but `_finalize_utterance` then requires `confidence >= 0.6` → the question is **dropped**. The feature's headline promise ("a Hindi question yields a Hindi answer") fails for exactly the simplest case the design targets, whenever the LLM classifier path is not taken. This also undermines the "never silently drop a non-English question" rule, which the design asserts but the arithmetic contradicts.

It is masked only when `useLlmClassifier=True` AND `ai.is_configured()` AND the heuristic confidence lands in the ambiguous band `[0.35, 0.75]` (0.55 does), so the LLM is consulted. But the design's own offline test plan stubs/skips the LLM and the "LLM unavailable → lenient fallback" path is explicitly a required behavior — and that path has no concrete confidence value, only the word "moderate."

Concrete fix (pick one, state it in the design):
- Preferred: in the non-`en` path of `QuestionDetector.detect(text, language=...)`, when the heuristic says the utterance is complete and ends in a terminal mark (`? ？ ؟ । ! .`) OR meets `minTranscriptChars`, return a `DetectionResult` with `confidence = max(heuristic, 0.6)` (i.e. at least `self.config.detectionConfidenceThreshold`) so it survives finalization. Pin the exact value, e.g. `0.6`.
- Alternatively, bump the non-Latin terminal-mark score in `heuristic_detect` for the non-`en` path from `0.55` to a value `>= detectionConfidenceThreshold` (e.g. `0.65`), but note this only helps when `detect` passes `language` down into `heuristic_detect`, which the current design does not wire (`heuristic_detect` takes no `language`). If you choose this, also specify threading `language` into `heuristic_detect`.
- Whichever you choose, replace "moderate confidence" in the lenient-fallback bullet with the concrete number and state explicitly that it must be `>= detectionConfidenceThreshold (0.6)`.

### 2. MEDIUM — `detect(text, language=None)` forces the LLM path for non-`en` "when available," but the existing `use_llm` gate also requires the ambiguous confidence band and `base.complete`; the interaction is unspecified

Where: Feature 1d — "force LLM path for non-`en` languages ... regardless of heuristic confidence band."

Verified against source: the real `QuestionDetector.detect` computes `use_llm = self.config.useLlmClassifier and self.ai_module is not None and base.complete and AMBIGUOUS_LOW <= base.confidence <= AMBIGUOUS_HIGH`. The design says non-`en` should bypass the confidence band, but does not say whether it also bypasses `base.complete` (half-spoken fragment guard) or `self.config.useLlmClassifier` (the operator's global off-switch). Two concrete hazards:
- If non-`en` bypasses `base.complete`, the detector will spend an LLM call on every half-spoken non-English fragment — a latency/cost regression the design elsewhere says it avoids.
- If non-`en` ignores `useLlmClassifier=False`, it violates the operator's explicit "no classifier" configuration.

Concrete fix: pin the non-`en` gate precisely. Recommended: `use_llm = self.config.useLlmClassifier and self.ai_module is not None and base.complete and (lang != 'en' or AMBIGUOUS_LOW <= base.confidence <= AMBIGUOUS_HIGH)`. That is: non-`en` drops only the confidence-band condition, still honoring `useLlmClassifier` and `base.complete`. State this expression in Feature 1d and the file-by-file entry.

### 3. MEDIUM — Frontend start-frame test asserts captured frames, but `freshSession()` never opens a socket and `InterviewMode` exposes no in-test send entry point; the harness-addition is not fully achievable as written

Where: Testability → "Harness fix for frame capture (Finding 5)"; it says seed `state.ivWs`/`state.sttWs` with a capturing stub "before calling the send path."

Verified against source: `test/interview.test.js` `freshSession()` sets `IV._state` fields directly and drives `IV._handleIvEvent`, but never calls `start()` / `connectIvWs()` (both would try to open real sockets / call `fetch`, which the sandbox rejects with "no network"). `ivSend`/`sttSend` are module-private closures (interview.js lines 291/331) — they are not on the returned `InterviewMode`, so a test cannot call them directly. The design says "drive `_handleIvEvent` and the pure helpers directly," but the start-frame is built and sent inside `start()`/`connectIvWs()`, not inside any exposed helper. So seeding `state.ivWs` alone does not give the test a way to trigger the send without also invoking `start()`/`connectIvWs()`, which open sockets and call `fetch`.

Concrete fix: specify exactly how the send is triggered in-test. Either (a) expose a thin testable seam on `InterviewMode` — e.g. `InterviewMode._sendStartFrame()` / `_ivSend` / `_sttSend` — and assert on the captured frame; or (b) in `connectIvWs`, make the `new WebSocket(...)` go through an injectable factory the sandbox can stub to return the capturing object with `readyState=1`, and stub `fetch` to resolve. Name the chosen seam in the design so the coder builds it, not just the assertion.

### 4. NIT — `transcribe_detailed` multi-language "no hard hint, let STT auto-detect" is unverified against the configured model

Where: Feature 1b — "When it has 2+, the backend passes no single hard hint (lets STT auto-detect)."

The design already flags that `gpt-4o-mini-transcribe` may not emit a usable `verbose_json.language` and provides a classifier fallback, which is good. But it asserts STT "auto-detects" across 2+ languages without the `language` hint. The OpenAI transcription `language` param is a single ISO code or omitted; omitting it is the only option for multi-language, and detection quality is model-dependent and unverifiable offline. This is acceptable, but add one sentence making explicit that the multi-language correctness relies on the classifier fallback (not on STT auto-detect) whenever STT returns no in-set language, so the coder does not treat STT auto-detect as a guarantee.

### 5. NIT — Resume distill truncation ("first ~6000 chars") can silently drop later resume content with no user signal

Where: Feature 2b — `truncated_text = extracted text truncated to ~6000 chars` for distill, raw capped to ~8000.

A 3-page resume commonly exceeds 6000 chars; the tail (often recent roles/projects) is dropped before the LLM sees it, and nothing in the response tells the user. The response already returns `chars`; add that `chars` reflects the pre-truncation extracted length and, optionally, a `truncated: true` flag when the profile was built from a truncated source, so the UI can note it. State the exact char budget as a named constant rather than "~6000"/"~8000".

### 6. NIT — `distill` form field parsing rule is under-specified for non-`"true"` strings

Where: External input validation — "`distill` form field parsed as boolean (`"true"`), default true."

"Default true" plus "parsed as `"true"`" is contradictory for the common case: if the field is absent the default is true, but if present as any non-`"true"` string (e.g. `"1"`, `"yes"`, `"false"`) the rule implies false. The frontend `preload.js` snippet sends `String(distill)` → `"true"`/`"false"`, so the realistic inputs are those two. Pin it: `distill = (request.form.get("distill", "true").lower() != "false")` (absent ⇒ true; explicit `"false"` ⇒ false; anything else ⇒ true), and state that exact rule so route and test agree.

### 7. NIT — `api_ask` language append uses `ai_helper._language_instruction`, a module-private name, across a module boundary without a fallback

Where: UI design + `server.py` file-by-file — `system_prompt = (... or ANSWER_SYSTEM_PROMPT) + "\n" + ai_helper._language_instruction(normalize_language(language))`.

`_language_instruction` is a leading-underscore private helper in `ai.py`. Calling it from `server.py` is already done elsewhere? No — verified it is currently only used inside `ai.py`. Reaching into a private is a minor smell and, more concretely, the design's own "defensive import" pattern for `ai.py` (used for `interview_config`) is not applied here: if a future refactor renames `_language_instruction`, `api_ask` breaks with an `AttributeError` at request time. Concrete fix: either promote it to a public `ai.language_instruction(...)` (documented as the shared source of the directive string) and call that, or guard the call with `getattr(ai_helper, "_language_instruction", None)` and skip the append (English behavior) if absent. State which.

---

## Verified Assumptions

Every claim below was checked against the actual source during this review and found correct:

1. `question_detector.py` has `_looks_incomplete(text, min_chars)` with `ends_terminal = norm.endswith(("?", ".", "!"))` and `heuristic_detect` with `if norm.endswith("?"): score += 0.55`; `detect(self, text)` takes no `language`; there is **no** `_looks_complete` in this module. (Design Finding 4 — correct.)
2. `interview_session.InterviewSession._looks_complete` is a `@staticmethod` checking `("?", ".", "!")`. `add_transcript(text, is_final, speaker, timestamp)` has no `language` param. `Question.__init__(qid, text, category, confidence)` and `to_dict()` exist as described. `_finalize_utterance` calls `self.detector.detect(text)`. `_generate` passes `language=self.language`. `SessionManager.start_session(..., language=None)` returns an existing live session unchanged for a reused id (`if existing is not None and not existing._closed: return existing`).
3. `ai.py`: `ask(text, system_prompt=None, model=None, tone=None)` has no language channel; `_build_messages` raises `AIError("No text provided to answer.")` on empty text; `ANSWER_SYSTEM_PROMPT` exists; `_language_instruction` is module-private; `LANGUAGE_NAMES = {"en": "English"}`; `transcribe(audio_bytes, filename, model)` returns text only; `_build_interview_prompt(category, language)`; `answer_interview_question[_stream]` already accept `language`.
4. `interview_config.py`: `SUPPORTED_LANGUAGES` currently holds only `en`; `normalize_language(value, fallback)` and `speech_locale_for(language)` exist; no `normalize_language_set`/`normalize_language_in_set` yet; `detectionConfidenceThreshold` default is `0.6`.
5. `server.py` `api_health` builds each language entry as `{"code", "name", "locale": meta.get("default_locale")}` — the wire key is `locale`, `default_locale` is the internal config-dict key; `native` would be a new key. (Design Finding 2 — correct.)
6. `server.py` `ws_interview`: `if mtype == "start" or session is None:` then `if session is None:` starts the session, then `if mtype == "start": continue`; the transcript catch-all is `if mtype in (None, "transcript"):`; on `stop`/disconnect the `finally` calls `stop_session`. A re-sent `start` on a live session is ignored. (Design Finding 2/8 — correct.)
7. `server.py` `ws_audio` sends `{"type": "transcript", "speaker", "text"}` and calls `ai_helper.transcribe(audio_bytes, filename=filename)`; `api_ask` non-stream calls `ai_helper.ask(text, system_prompt=system_prompt, tone=tone)`; `api_interview_start` accepts and threads `language`.
8. `overlay_app/audio.js` reads only `msg.speaker`/`msg.text` on transcript (line 150), so it ignores added fields. (Backward-compat claim — correct.)
9. `overlay_app/preload.js`: `exposeInMainWorld('electronAPI', {...})` (line 9); `askText: async (text, tone, recordId)` (line 47) with body `{ text, tone, record_id: recordId }`; `BACKEND_URL` present. `index.html` aliases `const api = window.electronAPI || {}` (line 436) and `#iv-resume` (line 316) is the "Resume listening" playback control. (Design Findings 4/5 — correct; `iv-cv-*` prefix avoids the collision.)
10. `overlay_app/interview.js`: `genId('sess')` in `start()` (line 516) mints a new session id; `connectIvWs()` (line 338+) reuses `state.sessionId` and re-sends `candidate_profile`; `ivSend`/`sttSend` guard on `readyState === WebSocket.OPEN` (lines 292/332); `/ws/audio` send envelope is `{ speaker, audio, filename }` (line 259). (Design Finding 2/5 — correct.)
11. `screen_shot/tests/test_language_default.py` contains exactly the assertions the design says must change: `normalize_language` params `("fr","en")`/`("zh-CN","en")`; `speech_locale_for("fr") == "en-IN"`; `test_prompt_unknown_language_falls_back_to_english` on `"fr"`; and `test_api_health_and_start_report_english_default` posting `{"language":"fr"}` expecting `"en"`. The design's re-pointing plan (to `"xx"`, plus positive `fr`/`zh` cases) is accurate and complete. (Design Finding 1 — correct.)
12. `screen_shot/tests/test_interview_session.py` `FakeAI.ask(self, text, system_prompt=None, model=None)` returns one canned JSON string regardless of prompt, confirming the shared-stub hazard; a dedicated `detect_language` stub is warranted. (Design Finding 10 — correct.)
13. `requirements.txt`: `openai==1.68.2`, `flask-sock==0.7.0`, `pytest==8.3.3` commented out at line 46. New pins `pypdf==5.1.0` / `python-docx==1.1.2` are pure-Python and reasonable. (Design Finding 6 — correct.)

## Unverified / Wrong Assumptions

1. **STT multi-language auto-detection quality** (Feature 1b) — cannot be verified offline; model-dependent. The design mitigates with the classifier fallback but should state that multi-language correctness rests on the classifier, not on STT auto-detect. (See Finding 4.) Not wrong, but unverifiable and slightly over-claimed.
2. **`gpt-4o-mini-transcribe` emitting `verbose_json.language`** — the design itself marks this uncertain and provides a fallback; correctly handled, listed here only as an acknowledged unverifiable integration point.
3. **"Never silently drop a non-English question" (Feature 1d)** — WRONG as written for the LLM-unavailable path, because the `0.55` terminal-mark score is below the `0.6` finalization threshold. This is Finding 1 (HIGH). The claim is only true once the confidence floor is raised to `>= detectionConfidenceThreshold`.
4. **Frontend start-frame capture achievability** (Testability) — the seeding step is necessary but not sufficient; no exposed send seam exists, so as written the test cannot trigger the send without opening a real socket. This is Finding 3 (MEDIUM).

---

## Verdict rationale

HIGH: 1 (Finding 1). MEDIUM: 2 (Findings 2, 3). NIT: 4 (Findings 4–7). HIGH+MEDIUM = 3 > 0 ⇒ **CHANGES_REQUESTED**. All three blockers are concrete and locally fixable in the design without changing its architecture; a quick round-trip is cheaper than shipping a non-Latin detector that drops questions.
