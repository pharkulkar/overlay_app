# Review: Generic solution image mode

Verdict: APPROVED (no blockers).

Evidence
- Diffs re-read in both repos. Frontend: index.html (+3 radio), vision-batch.js normalizeMode, test/interview.test.js (+2 asserts). Backend: ai.py (VISION_GENERIC_PROMPT, VISION_SYSTEM_PROMPTS, VISION_MODES, error text), server.py (docstring + error text), tests/test_vision_ask.py (+2 tests).
- Tests run: screen_shot pytest 234 passed; node --check on all listed files OK; npm test 38 passed, 0 failed (stealth audit and "every id referenced exactly once" included).
- Radio: third, after Scenario, same inline markup, data-tip (no title), default checked stays coding. `.actions` has flex-wrap, so three radios wrap in the sticky bar.
- Whitelists: only normalizeMode gated the mode. CaptureFlow.normalizeLastMode delegates to it, so persisted/restored "generic" works (restore at index.html:2468). Send path reads the checked `edit-vision-mode` radio (index.html:2354). server.py validates through ai_helper.VISION_MODES; the record label uses the mode string. No other 'scenario' whitelist exists (the vm-scenario hit is in the VISION-POPUP-DISABLED comment, untouched).
- Prompt covers every required point and is consistent with adaptive length. Language instruction is appended by the unchanged code path in _build_vision_messages. Model/temperature/max_tokens are not set per mode (same call for all modes), so nothing is lower for generic.
- Tests cover backend accept via the stubbed client, prompt plus language, and invalid-mode message, plus frontend normalizeMode and normalizeLastMode.
- No disabled-block edits, no title tooltips, no native dialogs, preload untouched.

Non-blocking note: the user text says "give the generic answer for the N images", which is harmless.
