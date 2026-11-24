# STT Phase 1 review: APPROVED

Evidence (diffs read in both repos; suites run by reviewer):
- screen_shot: `.venv/bin/python -m pytest -q` -> 232 passed. `import server` loads no easyocr/torch/paddle.
- overlay_app: `node --check interview.js main.js preload.js` OK; `npm test` -> 38 passed, 0 failed.

Items:
- 1.1 ai.py transcribe_detailed: single plain call, no response_format, no blanket retry, errors via _wrap_openai_errors; (text, lang|None) kept; detect_language path in server untouched. Test covers one call and no retry on timeout.
- 1.2 all steer prompts (script + roman tables) neutral, no question-shaped example; Hinglish Roman / Hindi Devanagari intent kept.
- 1.3 is_phantom_transcript in script_guard.py (empty/punct, fixed phrases whole-transcript, steering echo); applied in /ws/audio, the only source of transcripts forwarded to /ws/interview (interview.js forwards only from that handler). Debug log, silent drop. Tests include "What is a closure?", "Yes", Hinglish, Devanagari.
- 1.4 hing/ur now accept Devanagari (and Arabic for hi/ur via existing sets); existing romanize_text path converts; Han still rejected for en+hing. Dropped utterance sends {"type":"error","error":"Couldn't transcribe that last part"}; interview.js already renders msg.type 'error' via onError, so no JS change needed (overlay tracked files unchanged).
- 1.5 and status board: improvement_memory.md documents OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe with restart; board row 1 "Done pending user verification". Default model unchanged.

Minor note (not blocking): the 3+-word steering-substring echo check could in theory drop an utterance that is itself a contiguous fragment of a steering prompt; negligible in practice.

No blockers.
