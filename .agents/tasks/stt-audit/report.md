# STT / audio-capture audit and verdict

Note: the brief's `{{report_path}}` was never filled in, so this report is written here, next to the existing `.agents/tasks/code-audit/report.md`. No source files were edited. No `.env` file was read. No audio was played and no OpenAI calls were made.

Paths used below: `FE` = `overlay_app/interview.js`, `AI` = `screen_shot/ai.py`, `SRV` = `screen_shot/server.py`, `SG` = `screen_shot/script_guard.py`, `IS` = `screen_shot/interview_session.py`.

## 1. Summary answer

The pipeline is sound in shape (client-side VAD, one finished utterance per request). Its accuracy is held back by seven things, in order of impact.

1. **A recurring bug.** `AI:421-426` asks for `response_format="verbose_json"`. OpenAI says `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` accept only `json` or `text`. So every utterance probably makes a failing call and then a second, plain call (`AI:441-452`).
   - The detected language is therefore always `None`.
   - Multi-language sessions then pay for an extra LLM `detect_language` call (`SRV:2179`).
   - This was not seen live. It is inferred from OpenAI/Azure docs and GitHub issues (§4).
2. **Deprecated models, and a better one exists.** The default is `gpt-4o-mini-transcribe` (`AI:65`). OpenAI's docs now recommend `gpt-transcribe`, and mark `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` as deprecated, shutting down 2027-02-26.
   - `gpt-transcribe` takes `languages` (a list), `keywords` and `prompt`.
   - The multi-select language set is a direct fit for `languages`. Today a set of 2 or more passes no hint at all (`SRV:2140`).
3. **No vocabulary or context reaches the STT.** The only prompt is a fixed steering sentence. Resume skills, job domain and the previous utterance are never sent.
4. **The steering prompt is itself a hazard.** It is an example interview question ("…time complexity kya hai", `AI:309-321`). On near-silent or very short audio, Whisper-family models can echo or leak the prompt. A phantom "question" would then go straight to the question detector and trigger an answer. There is no phantom-text filter anywhere.
5. **The script guard can silently drop valid speech.** `SG:121` allows only Latin for `hing`. If the model returns Devanagari (community reports say the mini model ignores romanization prompts), the guard retries once and then drops the utterance (`SG:173-176`, `SRV:2198`). The user sees nothing.
6. **No pre-roll or trimming exists.** The `VAD_PREROLL_MS` constant is dead (`FE:269`). Lead-in audio is kept only as a side effect of how the recorder cycles, and so is unbounded (§2.3). The hard flush at 15 s can cut mid-word with no overlap.
7. **Audio is lossy opus/webm with fixed-threshold VAD.** The VAD has no noise floor and no stated AGC/noise-suppression/echo constraints on the loopback stream.

**Recommended first batch (all small):**
- Use plain `json` and drop the verbose_json attempt.
- A/B `gpt-transcribe` against `gpt-4o-transcribe`, passing `languages` and `keywords`.
- Remove the example-question steering text and add an echo/phantom filter.
- Stop silent drops in the script guard.

## 2. End-to-end pipeline as implemented

### 2.1 Capture
- Only the interviewer's system audio is captured in Interview mode. The mic is not used.
  - `openInterviewerStream` calls `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })` (`FE:177`). The video track is dropped.
  - Constraints are bare `audio: true`: no sample rate, no echoCancellation / noiseSuppression / autoGainControl settings. Chromium defaults for display capture were not verified.
- `main.js:595-603`: `setDisplayMediaRequestHandler` answers with `{ video: sources[0], audio: 'loopback' }`.
- Media permissions are auto-granted at `main.js:571-577`.
- The older Audio tab path (`audio.js:54-69`) uses `getUserMedia` with `echoCancellation: false, noiseSuppression: false` and the same webm/opus `MediaRecorder` (`audio.js:188-207`). The tab is commented out in `index.html:579`. Only the `/ws/audio` backend route is shared.
- Silence watchdog: `SILENCE_WARN_MS = 12000`, `FE:~199-235`. It warns once if no level above 0.02 is ever heard.

### 2.2 VAD and utterance cutting
- `startMetering` (`FE:199`) runs an `AnalyserNode` (fftSize 512) on `requestAnimationFrame`. Level = `min(1, RMS*2.2)`. The 0.055 threshold is therefore about RMS 0.025.
  - rAF throttling when the overlay is hidden or occluded was not verified.
- `vadStep` (`FE:282`) uses fixed defaults (`FE:257`), mirrored in `overlay.config.json` and read through the `get-vad-config` IPC (`main.js:348`):

| Setting | Value |
|---|---|
| `speechLevel` | 0.055 |
| `silenceMs` | 450 |
| `minSpeechMs` | 350 |
| `maxUtterMs` | 15000 |

- Flush rules:
  - The utterance flushes when speech has lasted at least `minSpeechMs` and quiet has lasted `silenceMs`.
  - A hard flush happens at `maxUtterMs` regardless of position in a word.

### 2.3 Pre-roll (answer to the brief's question)
- `VAD_PREROLL_MS = 300` (`FE:269`) is declared and never referenced. There is no ring buffer.
- A de facto lead-in exists. `startRecorderCycle` (`FE:328`) starts a fresh `MediaRecorder` immediately after each flush, and that recorder records continuously, so the blob holds everything since the previous flush.
  - Speech onset is therefore normally not clipped.
  - The blob also carries all silence or noise before speech, however long (seconds to minutes). That inflates cost and raises phantom-text risk. The only guard is `blob.size < 800` (`FE:344`), which is not a reliable silence test for opus.
- There is a small unprotected gap. `stop()` then async `onstop` then a new recorder (`FE:337-340`) loses a few ms. It matters mainly after a max-length flush, when a new word may start inside the gap.
- Post-roll is the 450 ms of trailing silence, which is adequate.

### 2.4 Encode and transport
- Format: `audio/webm;codecs=opus` via `MediaRecorder` at default bitrate (`FE:~316`). This is lossy compression of loopback audio that is often already compressed (Meet / Zoom / Teams).
- The blob is base64-encoded into a data URL (`FE:~39`) and sent as JSON over `/ws/audio`: `{speaker:'them', audio, filename:'them.webm', languages, roman}` (`FE:347`).
- There is no resampling, no WAV/PCM path and no client-side trimming.

### 2.5 Backend (`SRV:2022-2215`)
- `ws_audio` base64-decodes the audio. There is no minimum-duration filter, no energy check and no phantom-phrase filter.
- With a language set (`SRV:2124-2196`):
  - A single selected language becomes a hard `language` hint. A set of 2 or more passes no hint (`SRV:2140`).
  - With `roman` on, which is the default, it goes through `script_guard.transcribe_with_guard` (`SRV:2152`).
  - If STT reports no language, `detect_language` (an LLM chat call) runs for multi-language sets (`SRV:2179`).
  - Non-Latin output is romanized by a further chat call (`SRV:2186`, `AI:557`).
- The transcript goes back to the client (`SRV:2202`). The client forwards it as `is_final` to `/ws/interview` (`FE:~262`).

### 2.6 Model call (`AI:356-460`)
- Model: `OPENAI_TRANSCRIBE_MODEL`, default `gpt-4o-mini-transcribe` (`AI:65`). Timeout is 30 s (`AI:68`). There are no custom retries beyond SDK defaults. Temperature is not set. `logprobs` is not used.
- The attempt sequence:
  1. `verbose_json` plus the optional `language` and `prompt`. This probably fails (§1).
  2. A bare `except Exception` swallows the failure (`AI:441`), including timeouts, then repeats the call without `response_format`.
- Steering prompts:
  - `_SCRIPT_STEER_PROMPTS` (`AI:294`): Devanagari sentences for `hi` and `mr`, and an English instruction plus an example for `hing`.
  - `_ROMAN_STEER_PROMPTS` (`AI:309`): one fixed Roman sentence per Indic language.
  - `hing` passes no `language` hint (`AI:~405`).

### 2.7 Post-filters, language handling, output
- Script guard (`SG`): `is_plausible` rejects any script holding at least 10% of letters that is not allowed. One retry with `romanize_hint_language`, then `None`, which is dropped.
- `IS:224-291` (`add_transcript`): merges finals inside the end-of-utterance window. `endOfUtteranceMs` is 400 in `config.json`, with a shorter grace window if the text ends in terminal punctuation.
  - It de-duplicates repeated finals and repeated questions within 120 s (`duplicateWindowS`).
  - `minTranscriptChars` is 6 (`interview_config.py:34`), applied by the question detector (`question_detector.py:356`).
- Language flows forward only as a tag for detection and answer language. It is never fed back into the next STT call.
- `question_detector.py` consumes the final merged text. It does not touch STT.

## 3. Findings table

| # | Area | What we do | Best practice | Gap | Impact | Effort | Risk | Location |
|---|---|---|---|---|---|---|---|---|
| 1 | Response format | Requests `verbose_json`, then falls back | gpt-4o models accept only `json`/`text`; gpt-transcribe returns `languages` in JSON | Failed first call every time; language always `None`; extra LLM call; bare `except` doubles timeout wait | Med (latency, language tagging) | S | Low | `AI:421-452` |
| 2 | Model choice | `gpt-4o-mini-transcribe` default | `gpt-transcribe` recommended; the three older models shut down 2027-02-26 | Deprecated, weakest option; mini reportedly ignores romanization prompts | High | S (env or code) plus A/B | Low-Med: new model's Roman-output behaviour unverified | `AI:65` |
| 3 | Pre-roll / post-roll | `VAD_PREROLL_MS` is unused; recorder cycle gives accidental unbounded lead-in; 450 ms tail | Bounded pre-roll (about 200-300 ms) and trimming of long silence | Dead constant; unbounded silence; small restart gap; mid-word cut at 15 s | Low-Med | M (needs PCM ring buffer) | Med | `FE:269,328-340,357` |
| 4 | Min length / phantom text | Only `blob.size<800` and `minSpeechMs` 350; nothing server-side | Reject near-silent clips; filter known phantom and prompt-echo text | None. The steering text is an example question that can be echoed and then answered | High | S | Low | `FE:344`, `SRV:2198`, `AI:309-321` |
| 5 | Prompt / vocabulary | Fixed steering sentence only; no resume, domain or prior text | Use `keywords`/`prompt` for names, acronyms, jargon; carry prior context | Resume skills and tech terms never reach STT | High (tech terms) | S-M | Low (keywords are hints; test) | `AI:401-452`; `resume_parser.py` has no STT use |
| 6 | Language param vs auto-detect | One language gives a hard hint; 2 or more give none; `hing` gives none | `gpt-transcribe` `languages` list for multi-language and code-switching; the old single `language` is a soft hint | Multi-select set unused; Hindi/Urdu drift is handled only by post-hoc guard | High | S-M | Med | `SRV:2140`, `AI:380-407` |
| 7 | Audio format / rate / AGC / NS / EC | Opus webm, default bitrate, no constraints on loopback | Docs list webm/wav as supported. Realtime examples use 24 kHz PCM16. Avoiding heavy compression is general guidance I could not confirm in OpenAI docs | Lossy, unconstrained, no resampling | Low-Med | M-L (AudioWorklet to WAV) | Med | `FE:177,316`, `main.js:603` |
| 8 | VAD thresholds | Fixed 0.055, 450 ms, 350 ms, 15 s | Noise-floor adaptive VAD; cut long speech at a low-energy point | Constant noise or music can trigger or mask; 15 s cut mid-word; pauses over 450 ms split questions | Med | M | Low-Med | `FE:257-292`, `overlay.config.json` |
| 9 | Script guard drops | Hinglish-only allows Latin only; one retry; silent drop | Never lose a valid transcript | Devanagari output for `hing` is dropped after 2 attempts (4 calls with finding 1) | High for Hinglish | S | Low | `SG:121,173-176`, `SRV:2152-2161` |
| 10 | Temperature / retries | Defaults; no retry on empty; 30 s timeout | `temperature` is exposed on the API | No fallback if the first attempt returns empty text | Low | S | Low | `AI:65-68,425` |
| 11 | Logprobs | Not used | `logprobs` only with `json`, on the 4o models; not available on live-transcribe | No low-confidence handling | Low | M | Low | n/a |
| 12 | Streaming / realtime | Whole-utterance request | Realtime `gpt-live-transcribe` with client VAD plus `commit`; `gpt-transcribe` supports `stream=true` for files | Higher perceived latency only | Latency, not accuracy | L | Med; about 3.8x cost per minute | n/a |

## 4. External facts, with sources and verification status

- **Verified.** `gpt-transcribe` is the recommended file-transcription model. `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` and `/v1/audio/translations` are deprecated and shut down 2027-02-26. [Speech to text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
- **Verified.** `gpt-transcribe` accepts `prompt`, `keywords` and `languages`, and returns `{text, languages:[{code}]}`.
  - `languages` replaces `language`; do not send both.
  - Keywords must be single-line and must not contain `<`, `>`, CR or LF. A bad keyword or an over-long prompt rejects the whole request.
  - The doc example sends `keywords`/`languages` via `extra_body` in Python. SDK support was not checked.
  - Source: same guide.
- **Verified.** Prompting works on `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`. `whisper-1` prompts are limited to 224 tokens. Source: same guide, "Prompting".
- **Verified.** Prices:
  - `gpt-transcribe`: $0.0045/min ([model page](https://developers.openai.com/api/docs/models/gpt-transcribe)).
  - `gpt-4o-mini-transcribe`: $1.25/M audio input tokens versus $2.5/M for `gpt-4o-transcribe` ([model page](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)). That is about 2x per token.
  - `gpt-live-transcribe`: $0.017/min ([model page](https://developers.openai.com/api/docs/models/gpt-live-transcribe)), about 3.8x `gpt-transcribe`.
  - The mini per-minute figure was not on the fetched page, so a precise mini versus `gpt-transcribe` ratio is unverified.
  - Because only speech is sent, costs are small. 15 minutes of speech in an hour is about $0.07 at `gpt-transcribe` rates.
- **Verified, with medium confidence on the mini model specifically.** `verbose_json` is rejected by the gpt-4o transcribe family.
  - [openai-dotnet issue 401](https://github.com/openai/openai-dotnet/issues/401) quotes the API error for `gpt-4o-transcribe`.
  - [Azure API reference](https://ai.azure.com/api-reference/audio/create-transcription/) says the only supported format for both 4o and 4o-mini is `json`.
  - A LiteLLM issue shows the same 400 for `gpt-transcribe`.
  - `logprobs` works only with `json` and the 4o models ([API reference](https://developers.openai.com/api/reference/python/resources/audio/subresources/transcriptions/methods/create)).
- **Verified.** Realtime transcription: [guide](https://developers.openai.com/api/docs/guides/realtime-transcription).
  - `gpt-live-transcribe` does not support `server_vad` or `semantic_vad`. The guide says to use client-side VAD, then send `input_audio_buffer.commit`.
  - The example uses 24 kHz PCM, base64.
  - It has a `delay` setting (minimal to xhigh), returns no confidence, timestamps or detected languages, and takes `prompt`, `keywords` and `languages`.
  - `gpt-transcribe` in a Realtime transcription session automatically uses earlier committed turns as context and returns detected languages.
  - Conclusion: our client-side VAD design matches OpenAI's recommendation.
- **Community reports (anecdotal, not official):**
  - [mini ignores romanization prompts, 4o works](https://community.openai.com/t/gpt-4o-mini-transcribe-ignores-romanization-prompts-while-gpt-4o-transcribe-works/1323630)
  - [prompt leakage](https://community.openai.com/t/transcription-model-gpt-4o-mini-transcribe-prompt-leakage/1371126/1)
  - [phantom text on short audio](https://community.openai.com/t/4o-mini-transcribe-not-respecting-language-option/1234061)
  - [`language` is a soft hint](https://learn.microsoft.com/en-us/answers/questions/5583062/issue-with-gpt-4o-transcribe-detecting-wrong-langu)
  - [truncation at pauses](https://community.openai.com/t/gpt-4o-transcribe-truncation-issue-after-the-diarize-api-update/1364344)
  - [whisper-1 "Thank you for watching" hallucinations](https://zenn.dev/daishiro/articles/whisper-hallucination-gpt4o-transcribe?locale=en)
- **Not verified:** the official `realtime-vad` page was not fetched. An official statement of an ideal sample rate, pre-roll length or utterance length for file transcription was not found. The guide only says to avoid splitting mid-sentence and that webm/wav are supported.

## 5. Verdict: ranked changes

Ranked by accuracy gain per unit of effort.

1. **Fix the response format (S).**
   - Call without `response_format`, or with `json`, and drop the verbose_json attempt.
   - Catch only expected errors so a timeout is not retried blindly.
   - Obtain the language from the response (`languages` on `gpt-transcribe`). Verify that the installed SDK exposes it, for example via `model_extra`.
2. **Zero-code experiment: set `OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe` (S).**
   - The env knob already exists (`AI:65`). This tests the community claim that the larger model respects Roman prompts.
   - Cost is about 2x mini per token. It is deprecated, so it is only a bridge.
3. **Migrate to `gpt-transcribe` (S-M).**
   - Pass `languages` from the selected set. Map `hing` to `["en","hi"]` and `ur` to `ur`. Drop the single `language` field.
   - Pass `keywords` and a short `prompt`.
   - Build a small A/B set of real interview clips (English, Hindi, Hinglish, one other Indic language). Check Roman-output behaviour before removing the guard's romanize fallback.
4. **Add vocabulary biasing (S-M).**
   - Pull skills, tools and employers from the parsed resume, plus job-domain terms (for example data structures, Kubernetes, system design), as `keywords`.
   - Keep each keyword to one line and filter forbidden characters.
5. **Remove the question-shaped steering text and add a phantom/echo filter (S).**
   - Replace the example sentences at `AI:309-321` and `AI:294-307` with neutral guidance, or use `keywords` instead.
   - In `ws_audio`, drop transcripts that are substrings of the steering text. Also drop known phantom phrases (for example "thank you for watching" and "transcribed audio chunk"), and transcripts from clips with very low peak energy. The client can send peak/speech duration as metadata.
6. **Stop silent drops in the script guard (S).**
   - For `hing` (and Hindi-family sets), allow Devanagari and Arabic, then route through the existing `romanize_text`.
   - If a drop still happens, emit a visible "couldn't transcribe" event rather than a log line only.
7. **Fix the VAD edge cases (M).**
   - Cap or trim the leading silence per utterance, and implement a real 200-300 ms pre-roll or delete the dead constant.
   - Make the max-length cut land at the lowest-energy point in the last 2-3 s, with about 300 ms overlap.
   - Adapt the speech threshold to a rolling noise floor.
8. **Move capture to PCM/WAV (M-L).**
   - Use an AudioWorklet with a ring buffer. This gives real pre-roll and trimming, no lossy opus step, and sets explicit constraints for echoCancellation, noiseSuppression and autoGainControl on the loopback stream.
   - A/B test before and after. Chromium defaults for these constraints were not verified.
   - Do this after steps 1-6, because it is the largest change and its benefit is uncertain.
9. **Low priority:** retry once on empty text for clips over 1.5 s; `logprobs`-based low-confidence handling (4o models only); tiny steering-language feedback loop from the last detected language.

**Recommended first batch:** items 1, 2 (as an experiment), 5 and 6. Then items 3 and 4 once there is an A/B set.

**Do not change:**
- The client-side VAD architecture. OpenAI's live model has no server VAD and recommends client VAD plus commit.
- The Roman-output feature and `romanize_text`. They are the safety net for model behaviour.
- The end-of-utterance merge window and the duplicate-question window.
- `silenceMs` below 450. It would split more questions.
- The mic is not needed for interviewer accuracy.

**Latency and cost:**
- Items 1 and 3 should cut latency (one request instead of two, and no LLM language call).
- A bigger model or the extra A/B work adds cost. `gpt-4o-transcribe` is about 2x mini per token. `gpt-transcribe` is $0.0045/min.
- Streaming with `gpt-live-transcribe` would lower perceived latency but costs about 3.8x `gpt-transcribe` and is a large change. It is not justified as an accuracy fix.

## 6. What could not be verified
- No live audio and no OpenAI calls, so every accuracy claim is inferred from code and docs. Nothing was measured on real interview audio.
- Whether `gpt-4o-mini-transcribe` actually returns a 400 on `verbose_json` in this deployment. The evidence is docs plus issues for the sibling models.
- Whether `gpt-transcribe` honours Roman-script steering, and how it handles `hing`. Whether the installed `openai` SDK exposes `languages` in the response and passes `keywords`/`languages` through `extra_body`.
- The mini per-minute price (only per-token pricing was on the fetched page).
- Chromium's default echoCancellation / noiseSuppression / autoGainControl behaviour for `getDisplayMedia` audio, and `MediaRecorder` default opus bitrate and channel count.
- rAF throttling of the VAD loop when the overlay window is hidden.
- The `realtime-vad` page and any official guidance on ideal sample rate, pre-roll length or utterance length.
- I did not read `/ws/interview` handler internals beyond confirming it receives forwarded transcripts, nor the full `question_detector.py`.
