# Frontend verification (Roman output)

Files changed: interview.js, index.html, test/interview.test.js (no commit, no branch switch; .env, preload.js, main.js untouched).

## Changes
- interview.js: state.roman (default true); `roman` in buildStartFrame() and in the /ws/audio utterance envelope; start() reads opts.roman (!== false); setRoman/getRoman/parseStoredRoman on InterviewMode; transcript `converted` passed through to onTranscript; registry mirror reordered like backend (en, hi, hing, ur, mr, bn, gu, pa, ta, te, kn, ml, then others) with new ur/kn/ml.
- index.html: `#iv-roman` checkbox (checked by default, data-tip, no title=) after the language dropdown, CSS .iv-roman, localStorage key `iv.roman` (readStoredRoman/writeStoredRoman), init + change listener (hint "English-letters change applies when you Stop then Start listening."), `roman` in startOpts().

## Ran
- `npm test`: interview suite 37 passed (32 old + 5 new), stealth audit 37 passed, 0 failed.
- `node --check main.js preload.js interview.js`: OK.
- vm.Script compile of inline scripts: index.html 2 blocks, selection.html 1 block: OK.
- Every id used via getElementById in index.html exists exactly once (101 ids, 0 bad).
- Electron not launched.

## Not verifiable from shell
Live checkbox behavior, persistence across relaunch, and end-to-end Roman transcripts/answers need Electron, backend and an OpenAI key. Restart: restart backend, fully quit and relaunch the overlay; changes apply after Stop then Start.
