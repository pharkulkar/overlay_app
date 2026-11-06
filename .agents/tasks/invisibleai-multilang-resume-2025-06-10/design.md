# Design — Multi-language interviewer detection + session-only resume context

> **Finalization applied (round 3 — closes the final 4 reviewer findings; no other changes).** This pass applies ONLY the four concrete fixes the round-3 review left outstanding; the architecture is unchanged:
> 1. **HIGH #1 — non-Latin detection confidence floor.** In the non-`en` LLM-unavailable path, `QuestionDetector.detect(text, language=...)` now pins `confidence = max(heuristic, detectionConfidenceThreshold)` (≥ **0.6**, the `_DEFAULTS` value) for a complete utterance that ends in a terminal mark (`? ？ ؟ । ! .`) OR meets `minTranscriptChars`, so a bare non-Latin question (which otherwise scores only 0.55) survives `_finalize_utterance`'s `>= 0.6` gate instead of being silently dropped. The vague "moderate confidence" wording is replaced with the concrete `>= 0.6`.
> 2. **MEDIUM #2 — non-`en` `use_llm` gate pinned.** `use_llm = self.config.useLlmClassifier and self.ai_module is not None and base.complete and (lang != 'en' or AMBIGUOUS_LOW <= base.confidence <= AMBIGUOUS_HIGH)` — non-`en` drops ONLY the confidence-band condition; it still honors `useLlmClassifier` and `base.complete`.
> 3. **MEDIUM #3 — concrete frontend send seam.** Chose to **expose a thin test seam on `InterviewMode`**: extract the start-frame builder into `buildStartFrame()` and expose `InterviewMode._sendStartFrame()`, `_ivSend`, `_sttSend` (alongside the existing `_handleIvEvent`/`_state` testing hooks). The test seeds `state.ivWs`/`state.sttWs` with a `readyState:1` capturing stub, defines `WebSocket.OPEN = 1`, then calls `IV._sendStartFrame()` and asserts the captured frame — no socket opened, no `fetch`.
> 4. **NITs #4–#7.** (#4) added one sentence that multi-language correctness rests on the classifier fallback whenever STT returns no in-set language, not on STT auto-detect. (#5) pinned the distill char budgets as named constants `RESUME_DISTILL_INPUT_BUDGET = 6000` / `RESUME_RAW_PROFILE_BUDGET = 8000`, with response `chars` = pre-truncation extracted length and a `truncated: true` flag when the source was truncated. (#6) pinned `distill = request.form.get('distill', 'true').lower() != 'false'`. (#7) promoted `ai._language_instruction` to a public `ai.language_instruction(...)` and call that from `server.py` `api_ask` (the private name remains as a thin alias for internal callers).

Task directory: `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app/.agents/tasks/invisibleai-multilang-resume-2025-06-10/`
Status: **revision pass (round 2)** — resolves the 8 findings in the current `design-review.json` / `design-review.md` (verdict CHANGES_REQUESTED: 1 HIGH, 3 MEDIUM, 4 NIT). The prior round's 12 findings remain resolved; this round's resolutions are applied inline and summarized in the final "Responses to design review findings (round 2)" section. Every load-bearing claim flagged by the review was re-checked against the real source in both repos during this revision (`question_detector.py` `_looks_incomplete`/`heuristic_detect`, `ai.ask`/`ai._language_instruction`, `server.py` `ws_interview`, `preload.js` `electronAPI`, `interview.js` `start`/`connectIvWs`).

## Overview

This change adds two features to the two existing, tightly-coupled apps — the Electron overlay at `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app` and the Flask backend at `/Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot` — without creating new projects, swapping frameworks, or restructuring. We modify in place and keep every existing tab (Answer, Interview, Gallery, Audio) working and the `/ws/audio` + `/ws/interview` + REST contract in sync.

Feature 1 makes the interviewer's voice transcribe and get answered in its own language. The user picks a set of expected languages in the Interview tab (multi-select). That set is threaded to the backend and used two ways: as a hint/constraint to speech-to-text, and as the allowed set for a per-utterance language-detection step. The detected language tags each transcript turn, drives the question detector down the right path, and pins the answer to that same language. Transcripts and detected questions stay in the original language (no translation to English).

Feature 2 lets the user upload a resume (PDF, DOCX, or plain text) in the Interview tab. The backend parses it to clean text, optionally distills it with the LLM into a concise candidate profile, and returns that text. The renderer sends it on the `/ws/interview` start frame as `candidate_profile`. It lives only in memory for the current session: no DB row, no file persisted beyond a transient temp that is deleted in a `finally` block.

The guiding constraint for both features is backward compatibility: every new wire field is optional, and both apps default to exactly today's behavior (English, en-IN, no resume) when a field is absent. The language the frontend sends becomes the *selected set / default*, not a hard single lock — a session can answer a Hindi question in Hindi and a later English question in English.

## Technology stack (locked once approved)

No change to the stack. Backend stays Python 3 + Flask + flask-sock + OpenAI SDK `1.68.2`. Frontend stays Electron `44.7.0` with a sandboxed renderer (contextIsolation on, no Node), plain `<script>` loading, and `fetch`/`WebSocket` to the backend. Two new backend runtime deps are added for resume parsing: `pypdf` (PDF) and `python-docx` (DOCX). Plain text is read directly; no new dep. Detection reuses the existing OpenAI layer (`ai.py`) — no new STT or NLP library. Tests stay on `pytest` (backend) and the existing plain-Node `vm` harness (frontend `npm test`).

Version pins (added to `requirements.txt`, exact pins per project convention):
- `pypdf==5.1.0` — pure-Python, no system deps, actively maintained, standard choice for PDF text extraction.
- `python-docx==1.1.2` — standard DOCX reader, pure-Python.

Rationale for choosing these over alternatives: `pdfplumber`/`PyMuPDF` pull heavier/native deps (the project already fights native-dep weight with paddle/torch — see `requirements.txt` comments), and `pypdf` is sufficient for text extraction from text-based resumes. We explicitly accept that scanned/image-only PDFs will yield little/no text; that is handled as a validation error (see Feature 2 error handling), not by adding OCR.

---

## Canonical language registry (shared contract, front and back)

This is the single source of truth both apps agree on. Base code (ISO 639-1) is what flows across the wire and into answer generation; `locale` is the STT hint; `name` is the English display name; `native` is the dropdown label.

| code | name | native | stt locale |
|------|------|--------|-----------|
| en | English | English | en-IN |
| hi | Hindi | हिन्दी | hi-IN |
| mr | Marathi | मराठी | mr-IN |
| zh | Chinese | 中文 | zh-CN |
| es | Spanish | Español | es-ES |
| fr | French | Français | fr-FR |
| de | German | Deutsch | de-DE |
| ja | Japanese | 日本語 | ja-JP |
| ko | Korean | 한국어 | ko-KR |
| ar | Arabic | العربية | ar-SA |
| pt | Portuguese | Português | pt-BR |
| ru | Russian | Русский | ru-RU |
| it | Italian | Italiano | it-IT |
| nl | Dutch | Nederlands | nl-NL |
| tr | Turkish | Türkçe | tr-TR |
| ta | Tamil | தமிழ் | ta-IN |
| te | Telugu | తెలుగు | te-IN |
| bn | Bengali | বাংলা | bn-IN |
| gu | Gujarati | ગુજરાતી | gu-IN |
| pa | Punjabi | ਪੰਜਾਬੀ | pa-IN |

**Backward-compatibility reality (resolves review Finding 1).** Expanding `SUPPORTED_LANGUAGES` is a BREAKING change to the *current* tests, which encode an "English is the only supported language" invariant that this feature deliberately removes. I read `screen_shot/tests/test_language_default.py`; the following assertions change meaning once `fr`, `zh`, etc. are supported and MUST be updated (this file is listed as a required change in the file-by-file section):
- `test_normalize_language` is parametrized with `("fr", "en")` and `("zh-CN", "en")` (unsupported → English). After expansion `normalize_language("fr") == "fr"` and `normalize_language("zh-CN") == "zh"`. Re-point these to a code that stays unsupported as the fallback probe: `("xx", "en")`, and add `("fr", "fr")`, `("zh-CN", "zh")`.
- `test_speech_locale_default` asserts `speech_locale_for("fr") == "en-IN"`. After expansion it is `fr-FR`. Change to `speech_locale_for("xx") == "en-IN"` (unknown falls back) and add `speech_locale_for("fr") == "fr-FR"`.
- `test_prompt_unknown_language_falls_back_to_english` asserts `"respond in English" in ai._build_interview_prompt("general", "fr")`. After the `_language_instruction` rewrite, `"fr"` resolves to French. Change the probe to an unsupported code: assert `"respond in English" in ai._build_interview_prompt("general", "xx")`, and add `assert "French" in ai._build_interview_prompt("general", "fr")`.
- `test_api_health_and_start_report_english_default` posts `{"language": "fr"}` to `/api/interview/start` and asserts the started session comes back `language == "en"` (fr was unsupported → fell back). After expansion `fr` is supported, so this returns `"fr"`. Change the unsupported-fallback probe to `{"language": "xx"}` → `"en"`; keep the bare-`{}` → `"en"` / `en-IN` assertions unchanged.

The genuinely-unchanged assertions (the ones that must still pass as regression coverage) are the English-default ones: `cfg.language == "en"`, `defaultSpeechLocale == "en-IN"`, bare `normalize_language(None/""/"en"/"EN"/"en-IN") == "en"`, `speech_locale_for(None) == "en-IN"`, the bare `_build_interview_prompt("general", None)` pins English, and `/api/interview/start` with `{}` returns English.

English stays the default (code `en`, locale `en-IN`) so the no-selection path is byte-for-byte today's behavior. The backend owns this table in `interview_config.py` as the authoritative `SUPPORTED_LANGUAGES`. The frontend has a mirrored constant (a small JS array in `interview.js`) for the dropdown; `GET /api/health` returns `supported_languages` so the frontend can verify/reconcile at runtime (the health probe already returns this field — we just widen it).

**Health entry contract (pinned — resolves review Finding 2).** I read `api_health` in `server.py`: each language entry is built as `{"code": code, "name": meta.get("name", code), "locale": meta.get("default_locale")}`. The STT locale is exposed under the key **`locale`**, NOT `default_locale`. `default_locale` is the *internal config-dict* key inside `SUPPORTED_LANGUAGES[code]`; the *wire* key on the health response is `locale`. The revised health entry shape is exactly:
```json
{ "code": "en", "name": "English", "native": "English", "locale": "en-IN" }
```
`native` is the ONLY added key. The frontend reconciler keys off `code` and reads `locale` (never `default_locale`). The existing `init()` probe in `interview.js` continues to read top-level `h.default_language` / `h.default_speech_locale` unchanged.

**Reconciliation rule (pinned fully — resolves review Findings 2 and 9).** The frontend hardcodes the mirror list for instant render, but on Interview-tab open it calls `/api/health` and reconciles by `code`:
- The rendered dropdown is the **union** keyed by `code`, with the following precedence:
  - codes present in BOTH: label (`name`/`native`) and `locale` come from the **backend** entry (backend is authoritative, so `native` stays authoritative);
  - codes the **backend has but the frontend mirror lacks** (backend deployed ahead): **added** to the dropdown using the backend's `name`/`native`/`locale`;
  - codes the **frontend mirror has but the backend lacks** (frontend deployed ahead): **dropped** from the dropdown, because the backend cannot transcribe/answer them and must never be asked to.
- Net effect: the dropdown can only ever offer codes the backend actually supports, and it adopts backend labels when they disagree. If `/api/health` is unreachable, the frontend falls back to its hardcoded mirror (degraded, but functional) and logs a console warning.
- **Persisted-selection reconciliation (resolves review Finding 7).** On restore, the persisted `localStorage` selection (`iv.languages`) may contain a code the reconciler just dropped (e.g. the backend was downgraded). Rule: intersect the restored `iv.languages` with the reconciled dropdown codes; if the intersection is empty, default to `['en']`. Only reconciled-available codes are ever checked in the UI and ever sent on the `/ws/interview` start frame — so the "Languages: …" summary count always matches visible checkboxes, and the backend never receives a code it cannot serve (it would drop it anyway via `normalize_language_set`, which guarantees `['en']`, but we keep the UI honest).

`DEFAULT_ANSWER_LANGUAGE` is removed as a *hard pin* but `en` remains the fallback when detection is impossible.

---

## Feature 1 — multi-language detection

### 1a. Wire format (backward compatible)

Three envelopes change. In all three the new fields are optional and absent-equals-today.

**Interview tab UI → `InterviewMode.start(opts)`** — `opts` gains `languages: string[]` (array of base codes, e.g. `['en','hi','mr']`). Empty/omitted ⇒ treated as `['en']`.

**`/ws/interview` start frame (frontend → backend).** Today: `{ type:'start', session_id, candidate_profile, language }`. We keep `language` (now interpreted as the *default/primary* = first selected) and add `languages`:
```json
{ "type": "start", "session_id": "...", "candidate_profile": "...",
  "language": "en", "languages": ["en", "hi", "mr"] }
```
Backend precedence (pinned — resolves review Finding 3):
- if `languages` is a non-empty array, it IS the selected set; the session default is `default_language = normalize_language_set(languages)[0]` (the first surviving code after normalize/dedupe/drop-unknowns). The start-frame `language` field is **ignored for default resolution** when `languages` is present (so a stale `language:'en'` sent alongside `languages:['hi']` cannot pin the session to English). We do not error on a mismatch; `languages[0]` always wins.
- if only `language` is present (old client), the set is `[normalize_language(language)]` and the default is that code.
- if neither is present, the set is `[config.defaultLanguage]` (English today).

Only the bare-`{}` start (neither field) reproduces today's English behavior; that is the invariant the (updated) regression tests assert. **The existing `test_language_default.py` is NOT untouched** — expanding the registry necessarily changes the behavior it currently pins (see the "Backward-compatibility reality" note under the registry section and the file-by-file entry for `test_language_default.py`).

**`SESSION_STARTED` event (backend → frontend)** gains `languages` (the resolved set) alongside the existing `language` and `speech_locale`:
```json
{ "type": "SESSION_STARTED", "session_id": "...",
  "language": "en", "speech_locale": "en-IN",
  "languages": ["en","hi","mr"], "ts": 1234567890.0 }
```

**`/ws/audio` send envelope (frontend → backend).** Today the interview STT path sends `{ speaker:'them', audio:<dataURL>, filename:'them.webm' }` and the Audio tab sends `{ speaker, audio, filename, auto_suggest, tone }`. We add one optional field, `languages` (array of base codes), used only to hint STT:
```json
{ "speaker": "them", "audio": "data:...", "filename": "them.webm",
  "languages": ["en","hi","mr"] }
```
When `languages` has exactly one entry, the backend passes it to STT as a hard language hint. When it has 2+, the backend passes no single hard hint (the OpenAI transcription `language` param is a single ISO code or omitted, so omission is the only option for a multi-language set) and relies on the per-utterance detection step. When it is absent (the Audio tab, or an old client) behavior is identical to today. **Multi-language correctness does NOT rely on STT auto-detect (resolves review Finding 4):** STT auto-detection quality across an un-hinted multi-language set is model-dependent and unverifiable offline, so the coder must not treat it as a guarantee — correctness rests on the set-constrained classifier fallback (`ai.detect_language`), which runs whenever STT returns no in-set language and always returns an in-set code. The Audio tab is **not** modified and never sends `languages`, so its `/ws/audio` usage is untouched.

**`/ws/audio` transcript reply (backend → frontend)** gains an optional `language` field (detected base code) and `speech_locale`:
```json
{ "type": "transcript", "speaker": "them", "text": "क्लोज़र क्या है?",
  "language": "hi", "speech_locale": "hi-IN" }
```
Old consumers (audio.js) ignore unknown fields — verified: `audio.js` reads only `msg.speaker` and `msg.text`. The interview renderer reads `language` and forwards it on the `/ws/interview` transcript frame.

**`/ws/interview` transcript frame (frontend → backend)** gains optional `language`:
```json
{ "type": "transcript", "text": "क्लोज़र क्या है?", "is_final": true,
  "speaker": "them", "timestamp": 1234567890.0, "language": "hi" }
```
Absent ⇒ session falls back to its default language (today's behavior). `TRANSCRIPT_FINAL` and `QUESTION_DETECTED` events echo back the per-turn `language` so the UI can show/label it, but the text itself is never translated.

### 1b. Detection mechanism and latency budget

**Decision: STT language field first, tiny LLM classifier as fallback — both, in that order.**

Primary signal comes from STT itself. The current `ai.transcribe()` calls `client.audio.transcriptions.create(model=..., file=...)` and returns only `.text`. We extend `transcribe()` to:
- accept `language: str | None` (single hard hint) and `candidate_languages: list[str] | None` (the selected set, for post-hoc constraining);
- request `response_format="verbose_json"` when the model supports it, so the response carries a `language` field; return a 2-tuple `(text: str, detected_language: str | None)` via a new function `transcribe_detailed()` — this is the single, unambiguous contract (not an object), matching the file-by-file signature and `ws_audio`'s unpacking `text, detected = ai.transcribe_detailed(...)` (resolves review Finding 8). The old `transcribe()` stays, returning just text, for the Audio tab and the existing tests — **no breaking signature change**.

`gpt-4o-mini-transcribe` does not reliably emit `verbose_json` with a language field across SDK versions. **Decision:** `transcribe_detailed()` attempts `verbose_json`; if the response has no usable `language` (or the model rejects the format), it falls back to plain transcription for the text and derives the language from the LLM classifier. This keeps us correct regardless of which transcribe model is configured.

Secondary signal is a tiny LLM classification call, used **only** when (a) STT gave no language, or (b) STT's language is not in the selected set (see the out-of-set rule below), or (c) there are 2+ selected languages and we want to disambiguate. The classifier is a single short chat call: system prompt "Return ONLY the ISO 639-1 code of the language of this text, restricted to this set: [...]. If unsure, return the first." Parsed to a base code. **The classifier is constrained to the selected set, so by construction it always returns an in-set code** (its prompt forbids anything else and "if unsure, return the first"); if the raw reply is somehow unparseable or off-set, `detect_language` coerces to the set default. New function `ai.detect_language(text, candidate_languages, model=None) -> str`. It never raises (mirrors `question_detector.llm_detect`): on any error it returns the default.

**Out-of-set STT language rule (pinned — resolves review Finding 3).** There is exactly one genuinely ambiguous case: STT *confidently* detects a language that is correct but **outside** the selected set (e.g. the user selected hi+mr but the interviewer actually spoke English). Because the classifier is set-constrained it cannot "rescue" an out-of-set language — it can only map into the set. We therefore pin the following split so the coder never has to choose:
- **Answer-generation language** is coerced to the set default (`languages[0]`): we never generate an answer in a language the user did not select. This is the product rule "only answer in selected languages."
- **Transcript reply `language` field carries the TRUE detected code** (the out-of-set code STT reported), NOT the coerced in-set default. Rationale: the transcript text is shown in its original language with no translation, so labelling a visibly-English line as `hi` would mislead the UI badge. The badge must be honest about what was actually said; only the *answer* is coerced.
- Concretely in `ws_audio`: `true_lang = detected_from_stt_or_classifier`; the `transcript` reply sets `language = true_lang` (honest); the value threaded onward for answer generation is `answer_lang = true_lang if true_lang in selected_set else selected_set[0]`. The frontend forwards `true_lang` on the `/ws/interview` transcript frame, and `InterviewSession._finalize_utterance` applies `normalize_language_in_set` (which performs the answer-side coercion) when tagging the `Question` — so the honest transcript label and the coerced answer language are owned by two clearly separate layers.

**Where detection runs.** In the `/ws/audio` handler (`ws_audio`), after transcription, for the interview path only (i.e. when the incoming envelope carried `languages`). The resolved `language` is attached to the `transcript` reply. This keeps detection on the STT thread the utterance already occupies — no extra hop. The classifier call only fires when needed (single-language selection skips it entirely → zero added latency for the common case).

**Single-language tagging invariant (pinned — resolves review Finding 3).** When exactly one language is selected, the classifier is skipped AND `transcribe_detailed` may return `detected_language=None` (if `verbose_json` is unsupported). In that case `ws_audio` MUST still set `language` on the `transcript` reply to that single selected code — never omit it. Concretely: `resolved_lang = detected_in_set or (languages[0] if len(languages) == 1 else session/default)`. So a Hindi-only session always emits `language:"hi"` on every interview-path transcript reply even when STT/classifier return nothing, the frontend forwards `language:"hi"` on the `/ws/interview` transcript frame, and the answer is Hindi. This closes the only path by which a single-language non-English session could silently answer in English. (For 2+ selected languages, an untagged reply falls back to the session default, which by the Finding-3 default-resolution rule is `languages[0]`, still a selected language — never a stale `en`.)

**Latency budget.** Single selected language: 0 ms added (STT gets a hard hint, no classifier). Multi-language, STT returns a usable in-set language: 0 ms added. Multi-language, classifier needed: one `gpt-4o-mini` call on ~1 sentence, target < 400 ms, bounded by the existing `REQUEST_TIMEOUT` (30 s hard cap). Because the classifier runs after STT and before emitting the transcript, worst case adds one short LLM round-trip per utterance only in the ambiguous multi-language case. This is acceptable for turn-by-turn interview Q&A (utterances are seconds apart). We do **not** add the classifier to the Audio tab's copilot path (latency-sensitive, English-only today).

### 1c. Carrying language through to the answer

The session must not be locked to one language. Today `InterviewSession.language` is resolved once in `__init__` and passed to every `_generate()`. We change this to:
- `InterviewSession` keeps `self.languages: list[str]` (the selected set) and `self.default_language` (first/primary) resolved once at start.
- `add_transcript(text, is_final, speaker, timestamp, language=None)` gains an optional `language` — this is the **true detected code** (may be out-of-set per the Finding-3 rule). It is stored on the pending buffer and carried onto the finalized turn.
- `Question` gains a `language` attribute = the **answer-generation** code: `normalize_language_in_set(turn_language, self.languages, fallback=self.default_language)`. This is where the out-of-set→default *answer coercion* happens (Finding 3): an out-of-set true language maps to `self.default_language` for the answer, while the turn/transcript keeps the true code.
- `_finalize_utterance` computes the turn's true language and the coerced `Question.language` as above, then calls `self.detector.detect(text, language=turn_language)` with the **true** code (so a non-English detector path is chosen correctly even when the answer will be coerced).
- `_generate()` passes `question.language` (the coerced answer code, not `self.language`) to `ai.answer_interview_question[_stream](..., language=question.language)`.
- `TRANSCRIPT_FINAL` echoes the **true** per-turn `language` (honest label, matches the original-language text). `QUESTION_DETECTED` includes the `Question.language` (the coerced answer code). In the common in-set case the two are identical; they differ only in the rare out-of-set case, which is intentional and documented on both events.

So a Hindi utterance → `question.language='hi'` → answer generated in Hindi; a later English utterance in the same session → `question.language='en'` → English answer. The `SESSION_STARTED` event still reports the default `language`/`speech_locale` for the status strip.

`ai._language_instruction(language)` is rewritten to map any code in the new registry to its name and emit "Always respond in {Name}. Match the language of the interviewer's question exactly." `LANGUAGE_NAMES` is replaced by a lookup into the registry (imported from `interview_config`, with a tiny local fallback map so `ai.py` degrades gracefully if the config import fails — mirrors existing defensive imports). `DEFAULT_ANSWER_LANGUAGE` stays as the `en` fallback only.

### 1d. Non-English question detection

`question_detector.py` heuristics are English lexicon-based and will under-detect non-English questions. **Decision:** route non-English (and non-Latin-script) utterances preferentially through the LLM classifier instead of trusting the English heuristic.

Concretely, `QuestionDetector.detect(text, language=None)` gains an optional `language` (the real signature today is `detect(self, text)` with no language param — verified in `question_detector.py`; we add the keyword). When `language` is set and is not `en`:
- run the heuristic — but note the real terminal-mark handling lives in **two** places in `question_detector.py` that are ASCII-only today and both must be widened to recognize the full-width `？`, Arabic `؟`, and Devanagari danda `।` (verified against the real module — there is **no** `_looks_complete` in this module; see the pinned file-by-file entry):
  - `_looks_incomplete(text, min_chars)` computes `ends_terminal = norm.endswith(("?", ".", "!"))` — extend this tuple to include `？`/`؟`/`।` so a complete non-Latin question is not misjudged "incomplete".
  - `heuristic_detect(text, min_chars=6)` scores `if norm.endswith("?"): score += 0.55` — this ASCII-only rule is the gate that lets a `?`-terminated question clear the 0.5 threshold; extend it to also match `？`/`؟`/`।` so a non-Latin `？`-terminated question earns the same terminal-mark score. **This scoring-rule change is the core non-Latin detection fix** and must not be skipped.
- force the LLM classifier path when available and configured, regardless of heuristic confidence band, because the English lexicon can't score foreign tokens. **The non-`en` gate drops ONLY the confidence-band condition; it still honors `useLlmClassifier` and `base.complete` (resolves review Finding 2).** The pinned expression is:
  ```python
  use_llm = (
      self.config.useLlmClassifier
      and self.ai_module is not None
      and base.complete                       # never spend tokens on half-spoken fragments
      and (lang != "en"                        # non-en: bypass ONLY the band, still require complete + enabled
           or self.AMBIGUOUS_LOW <= base.confidence <= self.AMBIGUOUS_HIGH)
  )
  ```
  So a non-`en` complete utterance always consults the LLM when the classifier is enabled and configured; a half-spoken non-`en` fragment does not (honoring `base.complete`), and an operator `useLlmClassifier=False` is always honored. The classifier system prompt already asks only "is this a genuine question" and returns a category — language-agnostic. We pass the raw text; the model handles any language.
- if the LLM is unavailable/unconfigured (the `use_llm` gate above is False), fall back to a *lenient* heuristic for non-English that **guarantees the question clears finalization** — this is the explicit anti-"silent drop" rule (resolves review Finding 1). The arithmetic gap it closes: a bare non-Latin question earns only `0.55` from the terminal-mark score in `heuristic_detect` (no English-lexicon token can match), but `interview_session._finalize_utterance` keeps a question only when `confidence >= detectionConfidenceThreshold`, and `interview_config._DEFAULTS["detectionConfidenceThreshold"] == 0.6` — so `0.55 < 0.6` would drop it. **Fix (pinned):** in the non-`en` path of `QuestionDetector.detect(text, language=...)`, when `base.complete` is True AND the utterance ends in a terminal mark (`? ？ ؟ । ! .`) OR meets `self.config.minTranscriptChars`, return a `DetectionResult(is_question=True, ...)` with `confidence = max(base.confidence, self.config.detectionConfidenceThreshold)` — i.e. pinned to **at least 0.6** so it survives `_finalize_utterance`. The confidence floor must be `>= detectionConfidenceThreshold (0.6)`; "moderate confidence" is no longer acceptable wording. (When the LLM path *is* taken, the LLM's own confidence governs, unchanged.)

For `en`, behavior is unchanged (existing tests keep passing).

`interview_session._finalize_utterance` passes the turn's language into `self.detector.detect(text, language=turn_language)`.

**Terminal-mark handling lives in three distinct places (resolves prior Finding 11; corrected per review Finding 4).** The two repos have three separate ASCII-only terminal-mark checks, each in a differently-named function — do not conflate them:
1. `question_detector._looks_incomplete(text, min_chars)` → `ends_terminal = norm.endswith(("?", ".", "!"))` (gates "still being spoken").
2. `question_detector.heuristic_detect(...)` → `if norm.endswith("?"): score += 0.55` (the scoring gate for ASCII `?`).
3. `interview_session.InterviewSession._looks_complete` (a static method that genuinely exists under that name in `interview_session.py`) → checks `("?", ".", "!")` and gates the *short EOU grace window* (how fast a complete utterance finalizes), not question correctness.

All three get `？`/`؟`/`।` added. (1) and (2) are the non-Latin *detection* fix (Finding 4); (3) is the non-Latin *latency* fix so a complete non-Latin question finalizes on the same short grace window as an English one instead of waiting the full EOU window. Each is a one-line extension with no correctness impact on the English path. Note there is **no** `_looks_complete` in `question_detector.py` — only `_looks_incomplete` (inverted polarity); the `_looks_complete` name belongs solely to the session-layer static method.

### 1e. Config / health changes

`interview_config.py`:
- `SUPPORTED_LANGUAGES` expands to the full registry above (code → `{name, native, default_locale}`).
- `normalize_language(value, fallback)` unchanged in contract but now recognizes the full set.
- add `normalize_language_in_set(value, allowed: list[str], fallback) -> str`: normalize, and if the result isn't in `allowed`, return `fallback` (or `allowed[0]`). Used by the session to keep per-utterance language inside the selected set.
- add `normalize_language_set(values, fallback='en') -> list[str]`: dedupe + normalize a client list, drop unknowns, guarantee at least `[fallback]`.
- `speech_locale_for` unchanged (now covers all codes).
- `config.json` `interview` block keeps `defaultLanguage`/`defaultSpeechLocale` (`en`/`en-IN`); optionally add `defaultLanguages: ["en"]` (read via a new `_DEFAULTS` key + env `INTERVIEW_DEFAULT_LANGUAGES` comma-split). Keeps single-language default identical to today.

`GET /api/health` already returns `supported_languages`, `default_language`, `default_speech_locale`; it now returns the full list automatically (it iterates `SUPPORTED_LANGUAGES`). We add one key per entry, `native`, so each entry becomes `{"code", "name", "native", "locale"}` (the STT locale stays under the existing wire key **`locale`** — see the Health entry contract under the registry section; `default_locale` is only the internal config-dict key). The `any(l["code"]=="en" ...)` health assertion in `test_language_default.py` still holds, but note that `test_api_health_and_start_report_english_default` in that same file still changes because of its `{"language":"fr"}`→`"en"` fallback probe (now `fr` is supported); see Finding 1 above — switch that probe to an unsupported code (`"xx"`).

---

## Feature 2 — resume upload drives session context

### 2a. Endpoint shape

**Decision: `POST /api/resume/parse`, multipart/form-data, field name `file`.** Multipart over base64 because (a) PDFs/DOCX are binary and base64 inflates payload 33% and is awkward to size-limit, (b) Flask's `request.files` gives a clean stream + filename + size, and (c) the renderer can build a `FormData` with a `File`/`Blob` from an `<input type=file>` and `fetch` it directly — no Node, fits the sandboxed renderer. The existing `preload.js` pattern wraps `fetch` calls, so we add one more.

Request: `multipart/form-data` with `file=<the upload>`. Optional form field `distill=true|false` (default `true`).

Response (JSON):
```json
{ "success": true,
  "profile": "<clean candidate profile text>",
  "chars": 1234,
  "truncated": false,
  "distilled": true,
  "filename": "resume.pdf" }
```
`chars` reflects the **pre-truncation extracted length** (`len(extracted_text)`), NOT the length of the possibly-truncated profile, so the UI can tell the user how much of the resume was read. `truncated` is `true` when the profile was built from a source longer than the applicable char budget (`RESUME_DISTILL_INPUT_BUDGET`/`RESUME_RAW_PROFILE_BUDGET`); the UI can note that later resume content may not be reflected (resolves review Finding 5).
On failure: `{ "success": false, "error": "<user-safe message>" }` with an appropriate HTTP status (see error handling).

Max upload size (pinned — resolves review Finding 7): **route-level manual check, `MAX_CONTENT_LENGTH` left unset.** In `api_resume_parse`, reject early when `request.content_length and request.content_length > 8 * 1024 * 1024` → `413 {success:false, error:"File too large (max 8 MB)."}`. We deliberately do NOT set an app-wide `app.config['MAX_CONTENT_LENGTH']`, because an app-wide limit would also bound large base64 image/audio bodies on `/api/ask` and `/api/solve` and could cause silent `413`s there. The route-level check scopes the limit to exactly the resume endpoint. (Note: `/ws/audio` audio arrives over the WebSocket, not as `request.content_length`, so it is unaffected either way — but `/api/ask`/`/api/solve` HTTP bodies would be, which is why the global limit is avoided.)

### 2b. Parsing + distillation

Backend new module `resume_parser.py` (keeps `server.py` small, mirrors the existing one-module-per-concern layout like `ocr_engine.py`, `question_detector.py`):
- `extract_text(file_stream, filename, content_type) -> str`: dispatch by extension/content-type.
  - `.pdf` → `pypdf.PdfReader`, concatenate `page.extract_text()`.
  - `.docx` → `python-docx`, join paragraph texts (and table cell texts).
  - `.txt`/`text/plain` → decode UTF-8 (fallback latin-1).
  - unknown → raise `ResumeParseError` ("Unsupported file type; upload PDF, DOCX, or TXT.").
- Any transient temp file (python-docx wants a path or file-like; pypdf accepts a stream) is created under `tempfile.NamedTemporaryFile(delete=False)` only if a path is strictly required, and deleted in a `finally`. **Decision:** both libs accept file-like objects/`BytesIO`, so **no temp file is written to disk at all** in the normal path; `BytesIO` is used throughout. The `finally`-cleanup rule applies only if a future format forces a temp path.
- `distill(text, ai_module) -> (profile: str, distilled: bool, truncated: bool)`: called **only on non-empty text** (the route runs the empty-extraction 422 guard first — see the pinned route order below). **Char budgets are pinned as named module constants (resolves review Finding 5):** `RESUME_DISTILL_INPUT_BUDGET = 6000` (max chars fed to the LLM) and `RESUME_RAW_PROFILE_BUDGET = 8000` (max chars of the raw-text fallback profile). `truncated = len(text) > RESUME_DISTILL_INPUT_BUDGET` (for the distill path) or `len(text) > RESUME_RAW_PROFILE_BUDGET` (for the raw path) — i.e. True whenever the returned profile was built from a source longer than the budget it was capped to. If `distill` requested and AI configured, makes exactly one call: `ai_module.ask(text[:RESUME_DISTILL_INPUT_BUDGET], system_prompt=RESUME_DISTILL_PROMPT)` where `RESUME_DISTILL_PROMPT` = "Summarize this resume into a concise candidate profile: role, years, key skills, notable projects/achievements. Use ONLY facts present; do not invent." → returns `(profile, distilled=True, truncated)`. On `AIError` or not-configured, return `(text[:RESUME_RAW_PROFILE_BUDGET], distilled=False, truncated)`. Distillation is best-effort; raw text is always a valid profile. **Because `distill` only ever receives non-empty text, `ai.ask`'s empty-input `AIError("No text provided to answer.")` (raised in `_build_messages`, verified) is unreachable here** (resolves review Finding 6).

`server.py` route `api_resume_parse()` — **pinned execution order (resolves review Finding 6):**
1. validate presence of `file` (missing → 400); size (`request.content_length > 8 MB` → 413); extension/content-type whitelist (`.pdf/.docx/.txt`, else → 415);
2. `text = resume_parser.extract_text(...)`;
3. **empty check BEFORE distill:** if `text` is empty/whitespace-only → `success:false`, 422 ("No extractable text — the file may be scanned/image-only. Paste the text or upload a text-based resume.") and return immediately;
4. only now, if `distill` requested → `profile, distilled, truncated = resume_parser.distill(text, ai_helper)` (which internally calls `ai.ask(text[:RESUME_DISTILL_INPUT_BUDGET], system_prompt=RESUME_DISTILL_PROMPT)`); else `profile = text[:RESUME_RAW_PROFILE_BUDGET]`, `distilled = False`, `truncated = len(text) > RESUME_RAW_PROFILE_BUDGET`. The empty-text guard in step 3 provably precedes any `ai.ask`, so `ai.ask`'s empty-input `AIError` cannot fire on this path;
5. return `{success:true, profile, chars: len(text), truncated, distilled, filename}` where `chars` is the **pre-truncation** extracted length. **The server does NOT store the profile.** It is stateless — parse-and-return only. No DB write (`app.db` untouched), no file saved.

### 2c. Session-only lifecycle

The parsed profile text is held in the renderer (in a JS variable + `localStorage`? — **Decision: in a JS variable only, NOT localStorage**, because "session only" and "do not persist across restarts" means it must not survive relaunch; language selection *does* persist, resume does not). When the user starts/continues listening, the renderer sends the profile as `candidate_profile` on the `/ws/interview` start frame — the field already exists end-to-end (`ws_interview` → `start_session(candidate_profile=...)` → `InterviewSession.candidate_profile` → `ai.answer_interview_question(candidate_profile=...)`). No backend session-state change is needed beyond what already exists; the profile lives in `InterviewSession.candidate_profile` in memory and dies when the session is stopped/GC'd. No new persistence.

The existing interview prompt rule "NEVER invent resume details" (`INTERVIEW_BASE_PROMPT`) is preserved verbatim; the distillation prompt adds its own "use only facts present" guard.

If the renderer already has a running session when a resume is loaded/cleared, **Decision (prior Finding 8): do NOT add a mid-session `{type:'profile'}` control frame.** The profile is applied on the *next* (re)start only, via the already-shipped `candidate_profile` start-frame path. The UI shows a clear note when a resume is loaded/cleared while a session is live: "Resume will apply when you (re)start listening." Rationale: (1) it matches the task's "session only" intent and the existing start-frame mechanism with zero new protocol surface; (2) it avoids a concurrency/ordering hazard — I read `ws_interview` and its loop has a `if mtype in (None, "transcript"):` catch-all (server.py line 1964), so a `profile` frame would have to be inserted as an explicit branch *before* that catch-all or it would be ingested as an empty transcript; (3) strings are immutable and `_generate` already captures `self.candidate_profile` by value at call time. No `InterviewSession.set_candidate_profile` setter and no `ws_interview` `profile` branch are added.

**"(re)start" means a full Stop→Start cycle, NOT a bare WS reconnect — pinned invariant (resolves review Finding 2).** I verified the exact mechanism in both repos:
- `ws_interview` (server.py 1941–1947) calls `interview_manager.start_session(...)` **only `if session is None`**; when a `start` frame arrives on a socket that already has a live session, the new `candidate_profile`/`languages` are **ignored** (`if mtype == "start": continue`). `SessionManager.start_session` also returns an existing live session unchanged for a reused `session_id`.
- `interview.js` `start()` (line 516) mints a **new** `session_id` via `genId('sess')` and opens a **new** socket, so a true Stop→Start is the only path that reaches the `session is None` branch and applies a changed profile/language set.
- `connectIvWs()` (lines 338–350) is also used on a **bare reconnect**, where it re-sends `{type:'start', session_id: state.sessionId, candidate_profile: state.candidateProfile, ...}` with the **same** `session_id`. The backend intentionally ignores the `candidate_profile`/`languages` on that reconnect `start` frame (session already exists). This is the correct, deliberate behavior: a mere network blip must not silently rebuild the session.

**Consequence the coder must honor:** a changed resume or language set applies **only** via a full `stop()` → `start()` cycle (which allocates a new `session_id`). A bare reconnect reuses the `session_id` and the new profile/languages do NOT take effect. The UI's "Resume will apply when you (re)start listening" note is therefore wired to the **Stop/Start** buttons (`IV.stop()`/`IV.start()`), **not** to reconnect. We intentionally do **not** add any live-mutation or reconnect-carries-profile path (consistent with the no-live-mutation stance above); the start-frame path on a fresh `session_id` is the single mechanism.

### 2d. Frontend wiring

`index.html` Interview tab gains, in the controls row: a multi-select language control and a resume control (see UI section). **Bridge naming (resolves review Finding 5):** the real bridge is `contextBridge.exposeInMainWorld('electronAPI', { ... })` (verified in `preload.js`) and `index.html` aliases it once at the top with `const api = window.electronAPI || {}` (verified, line 436). So `parseResume` MUST be added **inside** the `exposeInMainWorld('electronAPI', { ... })` object, and the renderer calls it as `api.parseResume(...)` via that existing local alias (same alias already used for `api.askText`). `preload.js` gains, inside the `electronAPI` object:
```js
parseResume: async (file, distill = true) => {
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('distill', String(distill));
  const res = await fetch(`${BACKEND_URL}/api/resume/parse`, { method: 'POST', body: fd });
  return res.json();
}
```
The renderer holds `state.candidateProfile` (JS var). "Clear" resets it to `''`. Neither load nor clear sends anything to a live session (per the Finding-8 decision); if a session is running, the UI shows "Resume will apply when you (re)start listening" and the new value is picked up on the next start-frame `candidate_profile`. A small label shows "Resume loaded (N chars)" where N is the response `chars` (pre-truncation extracted length) / "No resume"; when the response `truncated` flag is `true`, the label appends "(truncated)" so the user knows later resume content may not be reflected (resolves review Finding 5).

---

## UI design (Interview tab, `index.html` + `interview.js`)

The multi-select language dropdown and resume control go in the existing `.actions` row of `#view-interview` (it already has `flex-wrap:wrap`). To honor "multiselect with drop-down" without adding a dependency, **Decision:** use a native `<select multiple>` is clumsy in a compact overlay; instead use a **button that opens a small checkbox popover** (a `<details>`/`<summary>` disclosure containing a scrollable checkbox list), which gives a dropdown feel with true multi-selection and needs no library. Each checkbox is a language from the registry; selected codes are read on `start`. A summary label shows "Languages: EN, HI (+1)".

- New elements: `#iv-langs` (the `<details>` dropdown with checkboxes), `#iv-lang-summary` (label), and the résumé-DOCUMENT controls under an unambiguous `iv-cv-*` prefix (resolves review Finding 4): `#iv-cv-input` (`<input type=file accept=".pdf,.docx,.txt">` hidden), `#iv-cv-btn` (triggers the input), `#iv-cv-label` (status), `#iv-cv-clear`. **The `iv-cv-*` prefix is deliberate:** `#iv-resume` ALREADY EXISTS in `index.html` as the "▶ Resume" (resume *listening*) playback control, wired in `initInterviewUI()` as `resume: document.getElementById('iv-resume')` → `IV.resume()`. Naming the document controls `#iv-resume-*` would be one hyphen apart from the playback control and is a maintainability landmine, so we use `iv-cv-*` instead.
- Persistence: selected language codes saved to `localStorage` under key `iv.languages` on change; restored in `initInterviewUI()`. Default when nothing stored: `['en']`. On restore, the stored codes are **intersected with the reconciled dropdown codes** (Finding 7); an empty intersection defaults to `['en']`, so a persisted-but-now-unavailable code never yields a selected count with no visible checkbox and is never sent on the start frame. Resume is **not** persisted.
- `startOpts()` adds `languages: getSelectedLanguages()` and `candidateProfile: state.candidateProfile`.
- `InterviewMode.start(opts)` stores `opts.languages` (normalized to `['en']` if empty), sends them on the `/ws/interview` start frame and includes them on every `/ws/audio` send envelope (via `sttSend`).
- `handleIvEvent` reads `msg.language` on `TRANSCRIPT_FINAL`/`QUESTION_DETECTED` and the UI labels the transcript line / Q card with the language code (small badge). The `/ws/audio` `transcript` handler reads `msg.language` and forwards it on the `/ws/interview` transcript frame.
- Status strip: `#iv-locale` now shows the default locale plus the selected set count; the manual-retry path (`window.electronAPI.askText`) is extended to pass the detected language so a retried answer also matches. We extend `askText(text, tone, recordId, language)` and `/api/ask` to accept `language` (optional, backward compatible).
- **`/api/ask` + `ai.ask` language threading — pinned mechanism (resolves review Finding 1 (round 2) and Finding 7 (round 3)).** `ai.ask(text, system_prompt=None, model=None, tone=None)` has **no** language parameter (verified); it builds its system prompt from `ANSWER_SYSTEM_PROMPT` (+ tone suffix) inside `_build_messages`. We must NOT replace `system_prompt`, because the Answer tab relies on the default answer-mode prompt. **Decision:** in `api_ask`, when a `language` key is present AND `normalize_language(language)` is a supported **non-default** (non-`en`) code, build `system_prompt = (data.get("system_prompt") or ai_helper.ANSWER_SYSTEM_PROMPT) + "\n" + ai_helper.language_instruction(normalize_language(language))` and pass it as `system_prompt=` to `ask`/`ask_stream`. This **appends** a one-line directive to the existing prompt rather than overriding it, reusing the same directive string the interview path uses. **`server.py` calls the PUBLIC `ai.language_instruction(...)`, not the leading-underscore private (resolves review Finding 7):** `_language_instruction` is promoted to a public `ai.language_instruction(language)` (documented as the shared source of the directive string); the old `_language_instruction` name stays as a thin alias (`_language_instruction = language_instruction`) so `ai.py`'s internal callers are untouched. This removes the cross-module private reach that would break `/api/ask` at request time on a future rename. When `language` is absent or normalizes to `en`, **no directive is appended and the request body is byte-for-byte today's** — so the Answer tab is provably unaffected.
- **Existing-caller check (prior Finding 12, still valid):** `preload.js` exposes `askText(text, tone, recordId)` (verified 3-arg); the Answer tab calls it with three positional args, so the trailing optional `language` is `undefined` and is omitted from the POST body; `/api/ask` reads JSON keys, so an absent `language` is a no-op — Answer tab unaffected.

---

## File-by-file change list

### Backend — `/Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot`

- `interview_config.py`
  - Expand `SUPPORTED_LANGUAGES` to the full registry (code → name/native/default_locale).
  - Add `normalize_language_set()` and `normalize_language_in_set()`.
  - Add optional `defaultLanguages` default + `INTERVIEW_DEFAULT_LANGUAGES` env (comma-split), reflected in `_DEFAULTS`, `_ENV_MAP`, dataclass, and a `languages` property.
- `ai.py`
  - Replace `LANGUAGE_NAMES` single-entry map with a lookup into the registry (defensive import of `interview_config`, local fallback `{'en':'English'}`).
  - Promote `_language_instruction()` to a **public** `language_instruction(language)` (documented as the shared source of the answer-language directive string) and keep `_language_instruction = language_instruction` as a thin backward-compat alias for `ai.py`'s internal callers (resolves review Finding 7 — `server.py` calls the public name, never the private). Rewrite its body to pin + "match the interviewer's language exactly"; keep `en` fallback. Keep `DEFAULT_ANSWER_LANGUAGE` only as fallback.
  - Add `transcribe_detailed(audio_bytes, filename, model=None, language=None, candidate_languages=None) -> (text, detected_lang|None)` using `verbose_json` when possible; keep `transcribe()` unchanged (text-only, for Audio tab + tests), implemented to call the detailed one and drop the language.
  - Add `detect_language(text, candidate_languages, model=None) -> str` (never raises; default = first candidate).
  - `answer_interview_question[_stream]` signatures unchanged (already take `language`); only `_build_interview_prompt`/`_language_instruction` behavior changes.
- `question_detector.py` (edit targets verified against the real module — resolves review Finding 4; there is **no** `_looks_complete` here)
  - In `_looks_incomplete(text, min_chars)`: extend `ends_terminal = norm.endswith(("?", ".", "!"))` to include the full-width `？`, Arabic `؟`, and Devanagari danda `।`.
  - In `heuristic_detect(text, min_chars=6)`: change the `if norm.endswith("?"): score += 0.55` scoring rule to also match `？`/`؟`/`।` (and the full-width marks) — **this is the gate that lets a non-Latin `？`-terminated question clear the 0.5 threshold; it is the core non-Latin detection fix and must not be skipped.**
  - `QuestionDetector.detect(text, language=None)` (real signature today is `detect(self, text)` — add the keyword):
    - Pin the `use_llm` gate to `use_llm = self.config.useLlmClassifier and self.ai_module is not None and base.complete and (lang != "en" or self.AMBIGUOUS_LOW <= base.confidence <= self.AMBIGUOUS_HIGH)` — non-`en` drops ONLY the confidence band, still honoring `useLlmClassifier` and `base.complete` (resolves review Finding 2).
    - When `use_llm` is False and `lang != "en"`: if `base.complete` and (text ends in a terminal mark `? ？ ؟ । ! .` OR `len(normalized) >= self.config.minTranscriptChars`), return `DetectionResult(is_question=True, confidence=max(base.confidence, self.config.detectionConfidenceThreshold), category=base.category, complete=True, source="heuristic")` — the confidence floor is pinned to `>= detectionConfidenceThreshold` (0.6) so a bare non-Latin question survives `_finalize_utterance` (resolves review Finding 1). This is the concrete anti-silent-drop value; never return the bare 0.55.
    - `en` path unchanged.
- `interview_session.py`
  - `InterviewSession.__init__`: resolve `self.languages` (set) + `self.default_language`; keep `self.language`/`self.speech_locale` as the default for status.
  - `add_transcript(..., language=None)`: carry per-utterance language on pending buffer.
  - `Question`: add `language` attr + in `to_dict()`.
  - `_finalize_utterance`: normalize turn language into the set; tag turn + `Question`; call `detector.detect(text, language=turn_lang)`; include `language` in `QUESTION_DETECTED`; `TRANSCRIPT_FINAL` includes `language`.
  - `_generate`: pass `question.language` to `ai.answer_interview_question[_stream]`.
  - `InterviewSession._looks_complete` (static): add `？`/`؟`/`।` to its terminal-mark tuple so complete non-Latin questions finalize on the short EOU grace window (Finding 11). No `set_candidate_profile` setter is added (profile applies on next start — Finding 8).
  - `SessionManager.start_session(..., languages=None)`: thread set to the session.
- `server.py`
  - `api_health`: include `native` per language (automatic from registry).
  - `ws_audio`: when the envelope carries `languages`, resolve the set, call `ai.transcribe_detailed(...)` with single-hint vs multi-detect logic, run `ai.detect_language` fallback as specified, and include `language`/`speech_locale` in the `transcript` reply. **When `languages` is absent, call the existing `ai.transcribe()` path exactly as today** (Audio tab untouched).
  - `ws_interview`: parse `languages` on `start`; pass to `start_session`; echo `languages` in `SESSION_STARTED`; parse optional `language` on transcript frames and pass to `add_transcript`. **No `{type:'profile'}` control frame** (dropped per Finding 8); the transcript catch-all `if mtype in (None, "transcript"):` is left as-is with no new preceding branch.
  - `api_interview_start` (REST): accept `languages`, pass through.
  - New route `api_resume_parse()` → `POST /api/resume/parse` (multipart), route-level size check, calls `resume_parser`, returns profile; no DB write.
  - `api_ask`: accept optional `language`. When present and `normalize_language(language)` is a supported non-`en` code, set `system_prompt = (data.get("system_prompt") or ai_helper.ANSWER_SYSTEM_PROMPT) + "\n" + ai_helper.language_instruction(normalize_language(language))` (the **public** helper, resolves review Finding 7) and pass it to `ask`/`ask_stream` (append, never replace). Absent/`en` ⇒ no directive appended, request byte-for-byte today's (Answer tab unaffected). Resolves review Finding 1.
- `resume_parser.py` (new): `extract_text`, `distill` (returns `(profile, distilled, truncated)`), `ResumeParseError`, and the pinned char-budget constants `RESUME_DISTILL_INPUT_BUDGET = 6000` / `RESUME_RAW_PROFILE_BUDGET = 8000` (resolves review Finding 5).
- `requirements.txt`: add ONLY `pypdf==5.1.0` and `python-docx==1.1.2`. Leave `pytest==8.3.3` commented out (it is dev-only in the current file; the offline plan installs it separately with an explicit `pip install pytest`). Resolves review Finding 6 — no self-contradiction: pytest stays commented, tests install it by hand.
- `config.json`: optional `interview.defaultLanguages: ["en"]` (non-breaking).
- `tests/test_language_default.py` **(MUST change — resolves review Finding 1):** re-point the now-supported probes as detailed in the "Backward-compatibility reality" note: `normalize_language` params `("fr","fr")`, `("zh-CN","zh")`, and a still-unsupported `("xx","en")`; `speech_locale_for("fr")=="fr-FR"`, `speech_locale_for("xx")=="en-IN"`; prompt test `"French" in _build_interview_prompt("general","fr")` and `"respond in English" in _build_interview_prompt("general","xx")`; `/api/interview/start` unsupported-fallback probe switched from `{"language":"fr"}` to `{"language":"xx"}`→`"en"`. Keep all bare-`{}`/`None` English-default assertions unchanged.

### Frontend — `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app`

- `interview.js`
  - Add `SUPPORTED_LANGUAGES` mirror constant.
  - `start(opts)`: store `opts.languages` (default `['en']`); include on `/ws/interview` start frame (`languages` + `language`=first) and on every `/ws/audio` send (`languages`).
  - `/ws/audio` `onmessage`: read `msg.language`, forward on `/ws/interview` transcript frame (`language`), surface on `onTranscript`.
  - `handleIvEvent`: read `language` on `SESSION_STARTED` (set), `TRANSCRIPT_FINAL`, `QUESTION_DETECTED`; pass through to callbacks.
  - Add `setLanguages(codes)` and expose current set via `getLanguages()`.
  - Add `setCandidateProfile(text)` / `getCandidateProfile()` (pure state accessors). The stored profile is read into the `/ws/interview` start frame's `candidate_profile` on `start()`. **No `sendProfile()` / no `{type:'profile'}` frame** (dropped per Finding 8).
  - **Extract the start-frame builder (test seam — resolves review Finding 3).** Pull the object currently inlined in `connectIvWs().ws.onopen` into `buildStartFrame()` (returns `{ type:'start', session_id, candidate_profile, language: state.language || undefined, languages: state.languages }`) and `_sendStartFrame()` (`ivSend(buildStartFrame())`); `connectIvWs().ws.onopen` calls `_sendStartFrame()` (production behavior unchanged). Expose `_sendStartFrame`, `_ivSend: ivSend`, `_sttSend: sttSend` in the existing `InterviewMode` "Testing hooks" block (next to `_handleIvEvent`/`_state`) so the offline test can seed a capturing `state.ivWs`/`state.sttWs` and assert the captured frame without opening a socket.
- `preload.js` (the bridge object is `exposeInMainWorld('electronAPI', { ... })`; `index.html` aliases it as `const api = window.electronAPI` at line 436 — Finding 5)
  - Add `parseResume(file, distill)` (multipart `fetch`) **inside the `electronAPI` object** so it surfaces as `window.electronAPI.parseResume` / `api.parseResume`.
  - Extend the existing `askText(text, tone, recordId)` in the `electronAPI` object to `askText(text, tone, recordId, language)` and include `language` in the POST body only when defined.
- `index.html`
  - Interview tab markup: language checkbox dropdown (`#iv-langs`, `#iv-lang-summary`), résumé file controls under the `iv-cv-*` prefix (`#iv-cv-input`, `#iv-cv-btn`, `#iv-cv-label`, `#iv-cv-clear`) — NOT `#iv-resume-*`, which collides with the existing `#iv-resume` playback control (Finding 4).
  - `initInterviewUI()`: build dropdown from registry, load/save selection in `localStorage` (`iv.languages`), wire resume upload (`api.parseResume`), hold `candidateProfile` in a JS var (no persistence), label it, clear it; add `languages`/`candidateProfile` to `startOpts()`; render per-turn language badges; pass question language to the retry `askText` call.
  - No changes to Answer/Gallery/Audio controllers.
- `main.js`: no change (loopback/getDisplayMedia handler already correct). Confirmed read.
- `audio.js`: **no change** (stays English copilot; never sends `languages`).

---

## Error handling (per fallible operation)

- **STT transcription (`transcribe_detailed`)**: on `verbose_json` unsupported/parse-miss → recoverable, fall back to plain text + `None` language (then classifier). On `AIError` (auth/rate/timeout/connection) → the existing `ws_audio` handler already catches `ai_helper.AIError` and emits `{type:'error', error}`; unchanged. Caller (frontend) shows it on the transcript error line. Logged at debug on fallback, not on hard AIError (surfaced to user).
- **Language classifier (`detect_language`)**: never raises; any failure → returns the set default. Logged at debug. Not surfaced to the user (detection degradation is invisible; answer still generates in the default language).
- **Question detection LLM path**: already non-raising (`llm_detect` returns `None` → heuristic). For non-English with no LLM, lenient heuristic avoids silent drop. Not surfaced.
- **Answer generation**: unchanged — `_generate` already emits `ERROR` (recoverable for timeout/AIError, fatal for not-configured) with `question_id`; frontend offers retry.
- **Resume parse route**:
  - missing `file` → 400 `{success:false,error:"No file uploaded."}` (fatal for this request, user re-picks).
  - too large → 413 `{success:false,error:"File too large (max 8 MB)."}`.
  - unsupported type → 415 `{success:false,error:"Unsupported file type; upload PDF, DOCX, or TXT."}`.
  - parse exception (corrupt file) → 422 `{success:false,error:"Could not read the file."}`; logged at warning (no secret content logged — never log file bytes or extracted text).
  - empty extraction (scanned PDF) → 422 `{success:false,error:"No extractable text — the file may be scanned/image-only."}`.
  - distillation AIError → **recoverable**: fall back to raw text, still `success:true` (with `distilled:false`); logged at debug.
  - All are recoverable at the UX level (user re-picks or proceeds with raw text). Caller shows the error near the resume control.

## External input validation

- **`languages` (both WS)**: must be a JSON array of strings; each normalized via `normalize_language` and filtered to the registry; unknown codes dropped; empty result → `['en']`. Non-array → ignored (treated as absent). Owner: `interview_config.normalize_language_set`, called in `ws_audio`/`ws_interview`/`start_session`.
- **`language` (per transcript frame)**: optional string; normalized into the session's set via `normalize_language_in_set`; invalid → session default. Owner: `InterviewSession._finalize_utterance`.
- **`candidate_profile` / resume text**: string; capped (distilled ≤ model budget; raw ≤ 8000 chars) before use; no execution, only prompt text. Owner: `resume_parser`/session.
- **resume file**: required, size-limited (≤ 8 MB, route-level), extension/content-type whitelist (`.pdf/.docx/.txt`). Owner: `api_resume_parse`.
- **`distill` form field**: parsed with the exact rule `distill = request.form.get("distill", "true").lower() != "false"` (absent ⇒ true; explicit `"false"` ⇒ false; any other string ⇒ true), so route and test agree (resolves review Finding 6). The frontend `preload.js` sends `String(distill)` → `"true"`/`"false"`, so the realistic inputs are exactly those two. Owner: route.

## Invariant ownership

- **Selected-set membership of any per-utterance language** is owned by the backend session layer (`normalize_language_in_set` in `interview_session`), because the backend is the authority that drives answer generation and must never answer in a non-selected/unknown language. The frontend is advisory.
- **Answer language = question language** is owned by `interview_session._generate` (passes `question.language`) + `ai._language_instruction` (prompt enforcement). Two layers because one sets intent and the other enforces it in the model prompt.
- **No-translation of transcript/question** is owned by the data flow: STT returns original-language text, nothing translates it; the only language *code* flows, never a translated string. Enforced by not introducing any translation call.
- **Backward compatibility (absent field ⇒ today's behavior)** is owned by each parse site defaulting to English/no-resume.
- **Session-only resume (no persistence)** is owned by `server.py` (route never writes DB/disk) + the renderer (JS var, not localStorage).

## Edge cases

- Old frontend + new backend: no `languages` → single English set; works.
- New frontend + old backend: old backend ignores `languages`/`language`/`profile` → English pipeline; the new UI still functions (degrades to English). Since both ship together this is only a transient-deploy concern, but it stays safe.
- STT returns a language not in the selected set (e.g. user selected hi+mr, interviewer slips into English): per the pinned out-of-set rule (Feature 1b, Finding 3), the **answer** is coerced to the set default (`languages[0]`) — we never answer in a language the user didn't select — while the **transcript reply `language` carries the true detected code** so the UI badge honestly labels the original-language line. The set-constrained classifier cannot itself emit an out-of-set code; coercion happens only on the answer side.
- Mixed-language single utterance: tagged by the dominant language STT/classifier reports; acceptable.
- Code-switching across turns: handled by design (per-utterance language).
- Resume loaded mid-session: stored in the renderer JS var; the UI notes it will apply on next **Stop→Start** (a full restart that mints a new `session_id`), NOT on a bare WS reconnect (which reuses the `session_id` and is ignored by the backend — Finding 2); the currently-running session keeps its existing `candidate_profile` until restarted (no live mutation).
- Resume cleared mid-session: cleared in the renderer; takes effect (empty `candidate_profile`) on the next **Stop→Start**; answers then revert to no-profile grounding.
- WS drops and reconnects mid-session (no user restart): `connectIvWs` re-sends `start` with the same `session_id`; the backend ignores the re-sent `candidate_profile`/`languages`, so the session continues with its original profile/language set — a changed resume/language set loaded just before the blip does NOT apply until a full Stop→Start (Finding 2).
- Audio tab running concurrently with Interview: separate sockets/sessions; Audio tab never sends `languages`, so its transcripts are unaffected.
- Non-Latin `?` marks (`？`, `؟`, `।`): handled in detector completeness heuristics.

## Testability

**Backend (pytest, stubbed AI — fully offline):**
- `test_language_registry.py` (new): `normalize_language_set`/`normalize_language_in_set` for valid/invalid/empty/mixed; registry has all 20 codes with locales.
- Extend `test_language_default.py`: English-only path still passes (regression); add multi-language resolution (`languages=['hi','en']` → set, default `hi`); unsupported entries dropped.
- `test_interview_session.py` (extend `FakeAI`): `add_transcript(..., language='hi')` → `Question.language=='hi'` → `FakeAI.last_language=='hi'`; a later `en` turn in the same session → `'en'` (proves no lock). (No `set_candidate_profile` test — the setter was dropped per Finding 8; mid-session profile is covered by the start-frame path only.)
- `test_question_detector.py` (extend): non-English string with LLM stub → detected as question; terminal `？`/`؟`/`।`; non-English with LLM disabled → lenient fallback doesn't drop.
- `ai.detect_language` unit test: **monkeypatch `ai.ask` (or use a dedicated fake) to return a language code**, kept SEPARATE from the answer-path `FakeAI` (resolves review Finding 10). The shared `FakeAI.ask` returns one canned string regardless of prompt, so both `detect_language` and `question_detector.llm_detect` (which also call `ai.ask`) would get the same canned reply and a detector test could pass/fail by accident. The `detect_language` test's stub returns a code (e.g. `"hi"`); verify an out-of-set reply → the set default.
- `test_resume.py` (new): `resume_parser.extract_text` on a tiny in-repo `.txt` and a generated minimal `.docx`/PDF (build in-test with the libs, or skip PDF/docx if lib import fails via `importorskip`); empty text → error; `distill` with stub AI vs AI-off (raw fallback) asserting the `(profile, distilled, truncated)` tuple; a > `RESUME_DISTILL_INPUT_BUDGET` input → `truncated is True`; the `distill` boolean rule (`distill=absent`→true, `"false"`→false, `"1"`→true per the pinned `!= "false"` rule); route `POST /api/resume/parse` via Flask test client with a multipart `.txt` → `success:true`, `profile`, `chars == len(extracted)` (pre-truncation), `truncated` flag present; oversize/bad-type → proper status.
- `test_interview_api.py` (extend): `/api/health` returns full list incl. `native`; `/api/interview/start` with `languages` echoes the set; `/ws` not needed (REST path covers session wiring).
- All AI calls stubbed (`FakeAI`/monkeypatched `ai`), so tests run without `OPENAI_API_KEY` and never touch `.env` or the network.

**Frontend (`npm test`, existing Node `vm` harness):**
- Extend `test/interview.test.js`: `SESSION_STARTED` with `languages` adopted; `TRANSCRIPT_FINAL`/`QUESTION_DETECTED` with `language` surfaced to callbacks; `start()` normalizes empty `languages` → `['en']`; `setLanguages`/`getLanguages`; `setCandidateProfile`/`getCandidateProfile` store/return the profile; and — via the new `_sendStartFrame` seam (Finding 3) — the captured start frame carries `type:'start'`, `languages`, `language === languages[0]`, and the stored `candidate_profile`.
- **Harness fix for frame capture (resolves review Findings 5 (round 1) and 3 (round 3)).** I read `test/interview.test.js`: the sandbox stubs `WebSocket` as `function () {}` (no `send`, no `readyState`) and `WebSocket.OPEN` is `undefined`; `interview.js` `ivSend`/`sttSend` guard on `state.<ws>.readyState === WebSocket.OPEN` (confirmed at interview.js lines 292 and 332), and the start frame is **built and sent inside `connectIvWs().ws.onopen`** (which opens a real socket) via the module-private `ivSend` — so seeding `state.ivWs` alone is necessary but NOT sufficient: a test still has no exposed entry point to trigger the send without opening a socket and calling `fetch`. **Chosen seam (pinned so the coder builds it): expose a thin testable seam on `InterviewMode`.** Extract the start-frame builder currently inlined in `connectIvWs().ws.onopen` into a pure helper `buildStartFrame()` that returns `{ type:'start', session_id: state.sessionId, candidate_profile: state.candidateProfile, language: state.language || undefined, languages: state.languages }`, and a `_sendStartFrame()` that calls `ivSend(buildStartFrame())`. `connectIvWs().ws.onopen` calls `_sendStartFrame()` (behavior unchanged in production). Add to the existing "Testing hooks" block on `InterviewMode` (which already exports `_handleIvEvent` and `_state`): `_sendStartFrame`, `_ivSend: ivSend`, and `_sttSend: sttSend`. The test then: (a) defines `WebSocket.OPEN = 1` in the sandbox, (b) seeds `state.ivWs = { readyState: 1, send: (s) => captured.push(JSON.parse(s)) }` (and `state.sttWs` likewise for the `/ws/audio` envelope test via `_sttSend`), (c) sets `state.languages`/`state.candidateProfile`, then (d) calls `IV._sendStartFrame()` and asserts the captured frame carries `type:'start'`, `languages`, `language===languages[0]`, and `candidate_profile`. No socket is opened and `fetch` is never called. The harness already stubs `fetch`; we also continue to drive `_handleIvEvent` and the pure helpers directly. No Electron/browser needed.

**Integration vs unit boundary:** detection accuracy, real STT, and real OpenAI answers are *integration* concerns that cannot be unit-tested offline — noted as manual verification (run both apps, speak Hindi/English, confirm answer language matches). Everything else (wire parsing, session language carry-through, resume parse/route, detector routing, UI event handling) is unit/offline-testable as above.

## Offline verification plan

1. Backend: from `/Users/pranay/Desktop/Pranay/Projects/In-Queue/screen_shot`, create/activate a venv, `pip install -r requirements.txt` (adds pypdf/python-docx) and `pip install pytest`, then run `python -m pytest tests/ -q`. All existing + new tests pass; no network, AI stubbed, `.env` untouched.
2. Backend import smoke: `python -c "import server"` to confirm the app still boots with the new routes/modules and no `OPENAI_API_KEY`.
3. Frontend: from `/Users/pranay/Desktop/Pranay/Projects/In-Queue/overlay_app`, run `npm test` (the extended `test/interview.test.js`) — all pass under plain Node.
4. Lint/sanity: `node --check interview.js preload.js` (and the inline script is exercised by the module test where feasible).
5. Clean up any temp files created by resume tests (tests use `tempfile`/`BytesIO`; assert nothing is left in the repo).
6. Confirm no `.env` read/write and no changes to `app.db`, `screenshots/`, `logs/`. Do not create commits; leave changes in the working tree. If staging, add named files only.

## What is explicitly out of scope / deferred

- Real STT/LLM accuracy tuning and live multi-language verification (integration, needs a key + audio).
- OCR for scanned/image PDFs (rejected with a clear error).
- Persisting the resume beyond the session (explicitly forbidden by the task).
- Translating transcripts/questions (explicitly forbidden).
- Rewriting/restructuring either codebase or changing frameworks (forbidden).
- Mid-session live resume/profile updates via a control frame (dropped in this revision — Finding 8; profile applies on next start).

---

## Responses to design review findings (round 1 — prior review, kept resolved)

This earlier revision addressed the prior review (verdict CHANGES_REQUESTED: 3 HIGH, 5 MEDIUM, 4 NIT). Every finding is **addressed** (none backlogged or ignored); each choice aligns with the original task requirements (two features, both apps working, backward-compatible contract, session-only resume, no translation, no framework change). These remain resolved in the current document.

**Finding 1 (HIGH) — false "test_language_default.py keeps passing" claim.** Addressed. Re-verified against the real `tests/test_language_default.py`. Added a "Backward-compatibility reality" note under the registry section enumerating every assertion that changes meaning once the registry expands (`fr`/`zh-CN` normalize probes, `speech_locale_for("fr")`, the `fr` prompt-fallback test, and the `{"language":"fr"}` health/start fallback probe — the review named the first three; I also caught the fourth in `test_api_health_and_start_report_english_default`). Listed `tests/test_language_default.py` as a MUST-change file with the exact re-pointed expectations (`("xx","en")` as the fallback probe, `("fr","fr")`, `("zh-CN","zh")`, `speech_locale_for("fr")=="fr-FR"`, `"French" in prompt("fr")`, `"respond in English" in prompt("xx")`). The English-default (bare `{}`/`None`) assertions stay unchanged as genuine regression coverage.

**Finding 2 (HIGH) — health schema key mismatch and unspecified reconciliation.** Addressed. Pinned the health entry contract to `{code, name, native, locale}` matching the real `api_health` code (locale under key `locale`, not `default_locale`; `native` is the only added key; `default_locale` is only the internal config-dict key). Stated the frontend reconciler keys off `code` and reads `locale`.

**Finding 3 (HIGH) — single-language transcript may carry no language tag.** Addressed on both halves: (a) pinned start-frame default resolution — when `languages` is non-empty, `default_language = normalize_language_set(languages)[0]` and the start-frame `language` is ignored for default resolution, so a stale `en` cannot override; (b) pinned that for a single selected language the backend tags every interview-path transcript reply with that code even when STT/classifier return nothing.

**Finding 4 (MEDIUM) — resume element id collision with existing `#iv-resume`.** Addressed. Renamed the résumé-document controls to the `iv-cv-*` prefix (`#iv-cv-input/#iv-cv-btn/#iv-cv-label/#iv-cv-clear`) in the UI section and the file-by-file list, with an explicit note that `#iv-resume` is the pre-existing "Resume listening" playback control.

**Finding 5 (MEDIUM) — frontend test plan not achievable with current harness.** Addressed. Specified the harness addition: define `WebSocket.OPEN = 1` in the sandbox and seed `state.ivWs`/`state.sttWs` with a capturing stub whose `readyState === 1`, then assert the captured start frame. Cited the real `ivSend`/`sttSend` guards (interview.js lines 292, 332).

**Finding 6 (MEDIUM) — self-contradictory pytest instruction.** Addressed. requirements.txt entry now adds ONLY `pypdf` and `python-docx`; `pytest` stays commented (dev-only) and the offline plan installs it separately with `pip install pytest`.

**Finding 7 (MEDIUM) — MAX_CONTENT_LENGTH deferred.** Addressed. Committed to a route-level manual `request.content_length > 8 MB → 413` check in `api_resume_parse`; `app.config['MAX_CONTENT_LENGTH']` left unset so `/api/ask`/`/api/solve` bodies are not silently bounded. Removed the "verify during implementation" hedge.

**Finding 8 (MEDIUM) — mid-session `{type:'profile'}` frame scope/ordering.** Addressed by taking the review's recommended option (a): dropped the control frame entirely. Profile applies on next (re)start via the already-shipped start-frame `candidate_profile`. Removed `set_candidate_profile`, the `ws_interview` `profile` branch, `sendProfile()`, and the "snapshot" claim from the UI, file-by-file, edge-case, and test sections. This also matches the task's "session only" intent with zero new protocol surface.

**Finding 9 (NIT) — reconciliation underspecified for backend-only codes.** Addressed. Stated the full union rule: dropdown = union by `code`; labels/locale from the backend entry when present; backend-only codes added; frontend-only codes dropped; health-unreachable falls back to the hardcoded mirror.

**Finding 10 (NIT) — shared FakeAI returns one canned value.** Addressed. The `detect_language` test plan now monkeypatches `ai.ask` with a dedicated stub returning a language code, kept separate from the answer-path `FakeAI`.

**Finding 11 (NIT) — two `_looks_complete` implementations.** Addressed (not scoped out): added `？`/`؟`/`।` to `InterviewSession._looks_complete` too (one-line tuple extension) so non-Latin complete questions finalize on the same short EOU grace window — symmetric latency, no correctness impact. Noted in Feature 1d and the file-by-file list.

**Finding 12 (NIT) — askText caller compatibility unconfirmed.** Addressed. Added a line confirming the Answer-tab `askText(text, tone, recordId)` 3-arg calls are unaffected by the trailing optional `language` (undefined → omitted from body → `/api/ask` no-op).

---

## Responses to design review findings (round 2 — current review)

This revision resolves the current `design-review.json` (verdict CHANGES_REQUESTED: 1 HIGH, 3 MEDIUM, 4 NIT). Every finding is **addressed** (none backlogged or ignored); each resolution aligns with the original task requirements (two features, both apps working, backward-compatible contract, session-only resume, no translation, no framework change). Each load-bearing claim was re-verified against the real source before editing.

**Finding 4 (HIGH) — detector edit mis-named; non-Latin scoring rule in `heuristic_detect` not called out.** Addressed. Re-read `question_detector.py` and confirmed there is **no** `_looks_complete` there — the real functions are `_looks_incomplete(text, min_chars)` (with `ends_terminal = norm.endswith(("?", ".", "!"))`) and `heuristic_detect` (with the `if norm.endswith("?"): score += 0.55` scoring gate). Corrected both Feature 1d and the file-by-file `question_detector.py` entry to name the real targets and to call out the `heuristic_detect` scoring-rule change explicitly as the core non-Latin detection fix (adding `？`/`؟`/`।` to that rule and to `_looks_incomplete`'s `ends_terminal`). Reworked the former "two `_looks_complete` copies" note into a "three distinct terminal-mark sites" note that names each function correctly, keeping the (correctly named) `InterviewSession._looks_complete` edit in `interview_session.py`. `detect(self, text)` → `detect(self, text, language=None)` is noted as adding the keyword to the real signature.

**Finding 1 (MEDIUM) — `/api/ask` → `ai.ask` language threading unspecified; `ai.ask` has no language channel.** Addressed. Pinned the mechanism: `ai.ask` keeps its signature; in `api_ask` we **append** `ai_helper._language_instruction(normalize_language(language))` to `(data.get("system_prompt") or ANSWER_SYSTEM_PROMPT)` and pass it as `system_prompt=`, only when `language` is a supported non-`en` code. Absent/`en` ⇒ byte-for-byte today's body (Answer tab provably unaffected). Noted `_language_instruction` is the shared module-private source of the directive string. Updated both the UI-design retry paragraph and the file-by-file `server.py` `api_ask` entry.

**Finding 2 (MEDIUM) — "applies on next (re)start" depends on an unstated socket-recycle assumption; reconnect ignores changed profile.** Addressed. Verified in both repos that `ws_interview` only calls `start_session` when `session is None` and that `interview.js start()` mints a new `session_id` while `connectIvWs()` reuses it on a bare reconnect. Added an explicit pinned invariant in 2c: a changed resume/language set applies **only** via a full `stop()`→`start()` cycle (new `session_id`); a bare reconnect reuses the `session_id` and the backend intentionally ignores its `candidate_profile`/`languages`. Confirmed the "Resume will apply when you (re)start listening" note is wired to Stop/Start, not reconnect, and added a dedicated reconnect edge case.

**Finding 3 (MEDIUM) — out-of-set STT language handling split across sections; transcript tag ambiguous.** Addressed. Pinned one rule: the set-constrained classifier can only return in-set codes (so the "classifier returns out-of-set" branch was unreachable and is reworded to the real STT-out-of-set case). When STT confidently detects a correct out-of-set language, only the **answer-generation** language is coerced to the set default (`languages[0]`); the **transcript reply `language` carries the true detected code** so the no-translation transcript badge is honest. Split ownership: `ws_audio` emits the honest label; `InterviewSession._finalize_utterance` performs the answer-side coercion via `normalize_language_in_set` when tagging `Question.language`. Updated Feature 1b, Feature 1c, and the edge-case bullet so `TRANSCRIPT_FINAL` (true code) and `QUESTION_DETECTED` (coerced answer code) are consistent everywhere.

**Finding 5 (NIT) — preload bridge is `electronAPI`, not `api`.** Addressed. Verified `contextBridge.exposeInMainWorld('electronAPI', {...})` in `preload.js` and the `const api = window.electronAPI || {}` alias at `index.html` line 436. Clarified that `parseResume` is added **inside** the `electronAPI` object and is reached via that existing `api` alias (the same alias already used for `api.askText`). Updated the 2d snippet intro and the `preload.js` file-by-file entry.

**Finding 6 (NIT) — resume distill `ai.ask` call shape and empty-text ordering not shown.** Addressed. Showed the route order explicitly: `extract_text` → empty check (422, returns immediately) → `distill` (which calls `ai.ask(truncated_text, system_prompt=RESUME_DISTILL_PROMPT)`). Stated `distill` only runs on non-empty text, so `ai.ask`'s empty-input `AIError` is unreachable on this path.

**Finding 7 (NIT) — persisted `localStorage` selection may contain a reconciliation-dropped code.** Addressed. Added the restore rule: intersect persisted `iv.languages` with the reconciled dropdown codes; empty intersection → `['en']`; only reconciled-available codes are checked in the UI and sent on the start frame. Updated both the registry reconciliation rule and the UI persistence bullet.

**Finding 8 (NIT) — `transcribe_detailed` return type described as both tuple and object.** Addressed. Fixed Feature 1b to a single 2-tuple contract `(text: str, detected_language: str | None)`, matching the file-by-file signature and `ws_audio`'s `text, detected = ai.transcribe_detailed(...)` unpacking. Removed the "object/" wording.

---

## Responses to design review findings (round 3 — current review, finalization pass)

This finalization pass resolves the 4 outstanding findings in the round-3 `design-review.json`/`.md` (verdict CHANGES_REQUESTED: 1 HIGH, 2 MEDIUM, 4 NIT — the two round-2 duplicates were already carried). No architecture changed; these are the complete remaining design delta. Each fix was re-verified against the real source in both repos before editing (`question_detector.heuristic_detect`/`_looks_incomplete`/`QuestionDetector.detect` use_llm gate, `interview_config._DEFAULTS.detectionConfidenceThreshold == 0.6`, `test/interview.test.js` `freshSession` + sandbox `WebSocket` stub, `interview.js` `connectIvWs`/`ivSend`/`sttSend` + the `InterviewMode` testing-hooks block, `ai._language_instruction`/`LANGUAGE_NAMES`).

**Finding 1 (HIGH) — non-Latin terminal-mark score (0.55) below the 0.6 finalization threshold.** Addressed. In the non-`en` LLM-unavailable path of `QuestionDetector.detect(text, language=...)`, for a complete utterance ending in a terminal mark (`? ？ ؟ । ! .`) OR meeting `minTranscriptChars`, the design now pins `confidence = max(base.confidence, self.config.detectionConfidenceThreshold)` (≥ 0.6) so it survives `_finalize_utterance`'s `>= detectionConfidenceThreshold` gate. The "moderate confidence" wording is replaced with the concrete `>= 0.6` in Feature 1d and the `question_detector.py` file-by-file entry.

**Finding 2 (MEDIUM) — non-`en` `use_llm` gate interaction unspecified.** Addressed. Pinned `use_llm = self.config.useLlmClassifier and self.ai_module is not None and base.complete and (lang != "en" or AMBIGUOUS_LOW <= base.confidence <= AMBIGUOUS_HIGH)` in both Feature 1d and the file-by-file entry — non-`en` drops only the confidence-band condition, still honoring `useLlmClassifier` and `base.complete`.

**Finding 3 (MEDIUM) — frontend start-frame test has no exposed send seam.** Addressed by choosing and naming the seam: extract `buildStartFrame()`/`_sendStartFrame()` from `connectIvWs().ws.onopen` and expose `_sendStartFrame`, `_ivSend`, `_sttSend` on `InterviewMode` (next to the existing `_handleIvEvent`/`_state` hooks). The test defines `WebSocket.OPEN = 1`, seeds a `readyState:1` capturing `state.ivWs`/`state.sttWs`, and calls `IV._sendStartFrame()` to assert the captured frame — no socket, no `fetch`. Updated the Testability harness paragraph, the `interview.js` file-by-file entry, and the `test/interview.test.js` test list.

**Finding 4 (NIT) — multi-language STT auto-detect over-claimed.** Addressed. Added a sentence in Feature 1b: multi-language correctness does not rely on STT auto-detect (model-dependent/unverifiable offline) but on the set-constrained classifier fallback (`ai.detect_language`) whenever STT returns no in-set language.

**Finding 5 (NIT) — distill truncation silent; budgets approximate.** Addressed. Pinned `RESUME_DISTILL_INPUT_BUDGET = 6000` / `RESUME_RAW_PROFILE_BUDGET = 8000` as named constants; `distill` now returns `(profile, distilled, truncated)`; the response `chars` reflects the pre-truncation extracted length and a `truncated:true` flag is returned (and surfaced in the UI label) when the source exceeded its budget. Updated Feature 2a/2b, the route order, the UI label, the `resume_parser.py` file-by-file entry, and the resume test plan.

**Finding 6 (NIT) — `distill` boolean parsing contradictory.** Addressed. Pinned `distill = request.form.get("distill", "true").lower() != "false"` (absent→true; `"false"`→false; anything else→true) in the External input validation section, and added a matching test case.

**Finding 7 (NIT) — `api_ask` reaches into module-private `_language_instruction`.** Addressed. Promoted it to a public `ai.language_instruction(...)` (with `_language_instruction` kept as a backward-compat alias for internal callers) and pinned `server.py` `api_ask` to call the public name. Updated the UI-design retry paragraph and the `ai.py` + `server.py` file-by-file entries.
