// test/interview.test.js — unit tests for the Interview event protocol logic.
// Runs under plain Node (no Electron, no browser). We load interview.js into a
// minimal fake `window` and drive InterviewMode._handleIvEvent directly,
// asserting the ordering / stale-answer / state-machine behavior against the
// REAL backend contract (UPPERCASE events from interview_session.py).
//
//   Run:  node test/interview.test.js   (or: npm test)

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const VisionBatch = require('../vision-batch.js');
const CaptureFlow = require('../capture-flow.js');
const UxHelpers = require('../ux-helpers.js');

function loadInterviewModule() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'interview.js'), 'utf8');
  const win = {};
  const WebSocketStub = function () {};
  WebSocketStub.OPEN = 1;  // so ivSend/sttSend readyState guard can match a seeded ws
  const sandbox = {
    window: win,
    navigator: { mediaDevices: {} },
    WebSocket: WebSocketStub,
    MediaRecorder: function () {},
    AudioContext: function () {},
    FileReader: function () {},
    fetch: function () { return Promise.reject(new Error('no network in tests')); },
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'interview.js' });
  return win.InterviewMode;
}

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  \u2713 ' + name); }
  catch (e) { failed++; failures.push({ name, e }); console.log('  \u2717 ' + name + '\n      ' + e.message); }
}

// Fresh module + a recorder of emitted UI callbacks, with session primed.
function freshSession(sessionId) {
  const IV = loadInterviewModule();
  const events = [];
  const names = [
    'onPhase', 'onLevel', 'onTranscript', 'onQuestionDetected', 'onAnswerStarted',
    'onAnswerChunk', 'onAnswerCompleted', 'onQuestionCancelled', 'onError',
    'onConnection', 'onSessionStarted', 'onDevicesChanged',
  ];
  const cb = {};
  names.forEach((n) => { cb[n] = (payload) => events.push({ type: n, payload }); });

  const st = IV._state;
  st.sessionId = sessionId || 'sess_test';
  st.running = true;
  st.paused = false;
  st.questionOrder = [];
  st.answers = new Map();
  st.cb = cb;

  const send = (msg) => IV._handleIvEvent(msg);
  const withSid = (msg) => IV._handleIvEvent(Object.assign({ session_id: st.sessionId }, msg));
  const of = (type) => events.filter((e) => e.type === type);
  const last = (type) => { const a = of(type); return a.length ? a[a.length - 1].payload : null; };
  return { IV, st, events, send, withSid, of, last };
}

console.log('\ninterview.js protocol tests (real /ws/interview contract)\n');

// 1) SESSION_STARTED adopts the backend's session id + locale.
test('SESSION_STARTED adopts backend session id and locale', () => {
  const s = freshSession('local_tmp');
  s.send({ type: 'SESSION_STARTED', session_id: 'backend_abc', language: 'en', speech_locale: 'en-IN', ts: 1 });
  assert.strictEqual(s.st.sessionId, 'backend_abc');
  assert.strictEqual(s.last('onSessionStarted').speechLocale, 'en-IN');
});

// 1b) SESSION_STARTED adopts the backend's language SET.
test('SESSION_STARTED adopts backend language set', () => {
  const s = freshSession('local_tmp');
  s.send({ type: 'SESSION_STARTED', session_id: 'backend_abc', language: 'hi', languages: ['hi', 'en'], speech_locale: 'hi-IN', ts: 1 });
  assert.deepStrictEqual(Array.from(s.st.languages), ['hi', 'en']);
  assert.deepStrictEqual(Array.from(s.last('onSessionStarted').languages), ['hi', 'en']);
});

// 2) Full flow: detect -> started -> chunk(delta) -> chunk -> completed.
test('full question/answer flow reaches ANSWER READY (chunks are deltas)', () => {
  const s = freshSession();
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'What is a closure?', category: 'technical', confidence: 0.9 });
  s.withSid({ type: 'ANSWER_GENERATION_STARTED', question_id: 'q1' });
  s.withSid({ type: 'ANSWER_CHUNK', question_id: 'q1', text: 'A closure ' });
  s.withSid({ type: 'ANSWER_CHUNK', question_id: 'q1', text: 'is a function.' });
  s.withSid({ type: 'ANSWER_COMPLETED', question_id: 'q1', answer: 'A closure is a function.' });

  assert.strictEqual(s.last('onQuestionDetected').text, 'What is a closure?');
  assert.strictEqual(s.last('onQuestionDetected').category, 'technical');
  assert.strictEqual(s.last('onAnswerChunk').text, 'A closure is a function.'); // appended deltas
  assert.strictEqual(s.last('onAnswerCompleted').text, 'A closure is a function.');
  assert.strictEqual(s.last('onPhase').phase, 'ANSWER READY');
});

// 3) ANSWER_COMPLETED.answer overrides streamed chunks if they differ.
test('ANSWER_COMPLETED answer wins over streamed deltas', () => {
  const s = freshSession();
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'Q' });
  s.withSid({ type: 'ANSWER_CHUNK', question_id: 'q1', text: 'partial' });
  s.withSid({ type: 'ANSWER_COMPLETED', question_id: 'q1', answer: 'FINAL FULL ANSWER' });
  assert.strictEqual(s.last('onAnswerCompleted').text, 'FINAL FULL ANSWER');
});

// 4) Duplicate ANSWER_COMPLETED is ignored.
test('duplicate ANSWER_COMPLETED is ignored', () => {
  const s = freshSession();
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'Q' });
  s.withSid({ type: 'ANSWER_COMPLETED', question_id: 'q1', answer: 'first' });
  s.withSid({ type: 'ANSWER_COMPLETED', question_id: 'q1', answer: 'second' });
  assert.strictEqual(s.of('onAnswerCompleted').length, 1);
  assert.strictEqual(s.last('onAnswerCompleted').text, 'first');
});

// 5) A late answer for an OLD question must not become the headline phase
//    once a newer question has been detected.
test('stale answer for old question does not override newest phase', () => {
  const s = freshSession();
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'First?' });
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q2', text: 'Second?' });
  s.withSid({ type: 'ANSWER_COMPLETED', question_id: 'q1', answer: 'answer to first' });
  // Phase stays at the newest question (q2 => QUESTION DETECTED), NOT ANSWER READY.
  assert.strictEqual(s.last('onPhase').phase, 'QUESTION DETECTED');
  const hist = s.IV.getHistory().find((h) => h.questionId === 'q1');
  assert.strictEqual(hist.answer, 'answer to first');
  assert.strictEqual(hist.done, true);
});

// 6) Multiple consecutive questions kept in detection order.
test('multiple consecutive questions kept in order', () => {
  const s = freshSession();
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'A?' });
  s.withSid({ type: 'ANSWER_COMPLETED', question_id: 'q1', answer: 'a' });
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q2', text: 'B?' });
  s.withSid({ type: 'ANSWER_COMPLETED', question_id: 'q2', answer: 'b' });
  const hist = s.IV.getHistory();
  assert.deepStrictEqual(hist.map((h) => h.questionId), ['q1', 'q2']);
  assert.deepStrictEqual(hist.map((h) => h.answer), ['a', 'b']);
});

// 7) Events for a foreign session id are ignored (once ours is known).
test('events for a different session are ignored', () => {
  const s = freshSession('mine');
  s.IV._handleIvEvent({ type: 'QUESTION_DETECTED', session_id: 'OTHER', question_id: 'x', text: 'nope' });
  assert.strictEqual(s.of('onQuestionDetected').length, 0);
});

// 8) ERROR with a question_id surfaces to that question with recoverable flag.
test('ERROR carries question id + recoverable flag', () => {
  const s = freshSession();
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'Q' });
  s.withSid({ type: 'ERROR', question_id: 'q1', error: 'answer timed out', recoverable: true });
  const err = s.last('onError');
  assert.strictEqual(err.questionId, 'q1');
  assert.strictEqual(err.message, 'answer timed out');
  assert.strictEqual(err.recoverable, true);
});

// 9) QUESTION_CANCELLED surfaces (backend replaces a pending question).
test('QUESTION_CANCELLED is surfaced', () => {
  const s = freshSession();
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'Q1' });
  s.withSid({ type: 'QUESTION_CANCELLED', question_id: 'q1', reason: 'replaced by newer question' });
  const c = s.last('onQuestionCancelled');
  assert.strictEqual(c.questionId, 'q1');
  assert.ok(/replaced/.test(c.reason));
});

// 10) TRANSCRIPT_PARTIAL vs TRANSCRIPT_FINAL distinguished.
test('partial vs final transcript flag', () => {
  const s = freshSession();
  s.withSid({ type: 'TRANSCRIPT_PARTIAL', speaker: 'them', text: 'Tell me a' });
  s.withSid({ type: 'TRANSCRIPT_FINAL', speaker: 'them', text: 'Tell me about yourself.' });
  const parts = s.of('onTranscript');
  assert.strictEqual(parts[0].payload.final, false);
  assert.strictEqual(parts[1].payload.final, true);
  assert.strictEqual(parts[1].payload.text, 'Tell me about yourself.');
});

// 11) ANSWER_CHUNK before ANSWER_GENERATION_STARTED still accumulates (out of
//     order safety) and never throws.
test('answer chunk tolerated even if started event is missing', () => {
  const s = freshSession();
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'Q' });
  s.withSid({ type: 'ANSWER_CHUNK', question_id: 'q1', text: 'Hello ' });
  s.withSid({ type: 'ANSWER_CHUNK', question_id: 'q1', text: 'world' });
  assert.strictEqual(s.last('onAnswerChunk').text, 'Hello world');
});

// 12) TRANSCRIPT_FINAL / QUESTION_DETECTED surface the per-turn language.
test('language is surfaced on TRANSCRIPT_FINAL and QUESTION_DETECTED', () => {
  const s = freshSession();
  s.withSid({ type: 'TRANSCRIPT_FINAL', speaker: 'them', text: 'क्लोज़र क्या है।', language: 'hi' });
  s.withSid({ type: 'QUESTION_DETECTED', question_id: 'q1', text: 'क्लोज़र क्या है।', category: 'technical', confidence: 0.8, language: 'hi' });
  assert.strictEqual(s.last('onTranscript').language, 'hi');
  assert.strictEqual(s.last('onQuestionDetected').language, 'hi');
});

// 13) start() normalizes an empty/omitted language set to ['en'].
test('start() normalizes empty languages to [en]', () => {
  const IV = loadInterviewModule();
  // start() awaits getDisplayMedia; we only assert the normalization that runs
  // synchronously before capture by invoking the normalization indirectly via
  // setLanguages which shares the same rule.
  IV.setLanguages([]);
  assert.deepStrictEqual(Array.from(IV.getLanguages()), ['en']);
  IV.setLanguages(['hi', 'mr']);
  assert.deepStrictEqual(Array.from(IV.getLanguages()), ['hi', 'mr']);
});

// 14) setLanguages/getLanguages + setCandidateProfile/getCandidateProfile.
test('language set and candidate-profile accessors round-trip', () => {
  const IV = loadInterviewModule();
  IV.setLanguages(['en', 'hi', 'zh']);
  assert.deepStrictEqual(Array.from(IV.getLanguages()), ['en', 'hi', 'zh']);
  IV.setCandidateProfile('Senior backend engineer, 8y.');
  assert.strictEqual(IV.getCandidateProfile(), 'Senior backend engineer, 8y.');
});

// 15) Start-frame seam: _sendStartFrame builds + sends the frame with no socket.
test('_sendStartFrame emits a start frame with the selected language set', () => {
  const IV = loadInterviewModule();
  const st = IV._state;
  const captured = [];
  st.sessionId = 'sess_seam';
  st.languages = ['hi', 'en'];
  st.language = 'hi';
  st.candidateProfile = 'profile text';
  st.ivWs = { readyState: 1, send: (s) => captured.push(JSON.parse(s)) };

  IV._sendStartFrame();
  assert.strictEqual(captured.length, 1);
  const frame = captured[0];
  assert.strictEqual(frame.type, 'start');
  assert.deepStrictEqual(frame.languages, ['hi', 'en']);
  assert.strictEqual(frame.language, frame.languages[0]);
  assert.strictEqual(frame.candidate_profile, 'profile text');
});


// Roman (English-letters) option.
test('start frame includes roman, default true', () => {
  const IV = loadInterviewModule();
  const captured = [];
  IV._state.ivWs = { readyState: 1, send: (x) => captured.push(JSON.parse(x)) };
  IV._sendStartFrame();
  assert.strictEqual(captured[0].roman, true);
});
test('setRoman/getRoman round-trip and reflected in the start frame', () => {
  const IV = loadInterviewModule();
  assert.strictEqual(IV.getRoman(), true);
  IV.setRoman(false);
  assert.strictEqual(IV.getRoman(), false);
  assert.strictEqual(IV._buildStartFrame().roman, false);
  IV.setRoman(undefined);
  assert.strictEqual(IV.getRoman(), true);
});
test('parseStoredRoman defaults ON', () => {
  const IV = loadInterviewModule();
  assert.strictEqual(IV.parseStoredRoman(null), true);
  assert.strictEqual(IV.parseStoredRoman(undefined), true);
  assert.strictEqual(IV.parseStoredRoman('true'), true);
  assert.strictEqual(IV.parseStoredRoman('false'), false);
  assert.strictEqual(IV.parseStoredRoman('0'), false);
  assert.strictEqual(IV.parseStoredRoman('garbage'), true);
});
test('registry mirror has ur/kn/ml with unique codes', () => {
  const IV = loadInterviewModule();
  const codes = Array.from(IV.SUPPORTED_LANGUAGES).map((l) => l.code);
  for (const c of ['ur', 'kn', 'ml']) assert.ok(codes.includes(c), c);
  assert.strictEqual(new Set(codes).size, codes.length);
  assert.strictEqual(codes[0], 'en');
});
test('audio envelope carries roman and index.html has one #iv-roman with data-tip', () => {
  const fs = require('fs'), path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '..', 'interview.js'), 'utf8');
  assert.ok(js.includes('languages: state.languages, roman: state.roman'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.strictEqual((html.match(/id="iv-roman"/g) || []).length, 1);
  const tag = html.match(/<label class="iv-roman"[^>]*>/)[0];
  assert.ok(tag.includes('data-tip='));
  assert.ok(!/title=/.test(tag));
});
// ── Vision batch helper ──
const mkItem = (n, t) => ({ dataUrl: 'data:image/png;base64,' + n, sourceType: t });
test('vision: add appends with unique ids', () => {
  let r = VisionBatch.addImage(VisionBatch.createBatch(), mkItem('a'));
  r = VisionBatch.addImage(r.batch, mkItem('b'));
  assert.strictEqual(r.batch.length, 2);
  assert.notStrictEqual(r.batch[0].id, r.batch[1].id);
  assert.strictEqual(r.added, true);
});
test('vision: add does not mutate input', () => {
  const b = VisionBatch.createBatch();
  VisionBatch.addImage(b, mkItem('a'));
  assert.strictEqual(b.length, 0);
});
test('vision: cap at MAX_BATCH and custom max', () => {
  let b = [];
  for (let i = 0; i < VisionBatch.MAX_BATCH; i++) b = VisionBatch.addImage(b, mkItem('x' + i)).batch;
  const r = VisionBatch.addImage(b, mkItem('over'));
  assert.strictEqual(r.added, false);
  assert.strictEqual(r.capped, true);
  assert.strictEqual(r.batch.length, VisionBatch.MAX_BATCH);
  const r2 = VisionBatch.addImage(VisionBatch.addImage([], mkItem('1'), 1).batch, mkItem('2'), 1);
  assert.strictEqual(r2.capped, true);
});
test('vision: remove by id and unknown id no-op', () => {
  let b = VisionBatch.addImage(VisionBatch.addImage([], mkItem('a')).batch, mkItem('b')).batch;
  assert.strictEqual(VisionBatch.removeImage(b, b[0].id).length, 1);
  assert.strictEqual(VisionBatch.removeImage(b, 'nope').length, 2);
});
test('vision: invalid items rejected', () => {
  for (const bad of [null, {}, { dataUrl: '' }, { dataUrl: 5 }]) {
    const r = VisionBatch.addImage([], bad);
    assert.strictEqual(r.added, false);
    assert.strictEqual(r.batch.length, 0);
  }
});
test('vision: buildVisionRequest keeps order, mode and source types', () => {
  let b = VisionBatch.addImage([], mkItem('a', 'screenshot-region')).batch;
  b = VisionBatch.addImage(b, mkItem('b', 'screenshot-full')).batch;
  const req = VisionBatch.buildVisionRequest(b, 'scenario');
  assert.deepStrictEqual(req.images, [b[0].dataUrl, b[1].dataUrl]);
  assert.deepStrictEqual(req.source_types, ['screenshot-region', 'screenshot-full']);
  assert.strictEqual(req.mode, 'scenario');
});
test('vision: mode normalizers default safely', () => {
  assert.strictEqual(VisionBatch.normalizeMode(undefined), 'coding');
  assert.strictEqual(VisionBatch.normalizeMode('bogus'), 'coding');
  assert.strictEqual(VisionBatch.normalizeMode('scenario'), 'scenario');
  assert.strictEqual(VisionBatch.normalizeCaptureMode(undefined), 'ocr');
  assert.strictEqual(VisionBatch.normalizeCaptureMode('bogus'), 'ocr');
  assert.strictEqual(VisionBatch.normalizeCaptureMode('vision'), 'vision');
});
test('vision: batchLabel singular/plural', () => {
  assert.strictEqual(VisionBatch.batchLabel(1), '1 image');
  assert.strictEqual(VisionBatch.batchLabel(3), '3 images');
});

// ── Solution panel formatting (solution-format.js) ───────────────────────────
const SolutionFormat = require('../solution-format.js');
test('solution: splits prose and fenced code, dropping the ``` markers', () => {
  const segs = SolutionFormat.splitSolution(
    'Approach: use a hashmap.\n```python\ndef f(x):\n    return x\n```\nComplexity: O(n).');
  assert.deepStrictEqual(segs.map((s) => s.type), ['text', 'code', 'text']);
  assert.strictEqual(segs[0].content, 'Approach: use a hashmap.');
  assert.strictEqual(segs[1].lang, 'python');
  assert.strictEqual(segs[1].content, 'def f(x):\n    return x');   // indentation kept
  assert.strictEqual(segs[2].content, 'Complexity: O(n).');
});
test('solution: an unclosed code fence is still shown as code', () => {
  const segs = SolutionFormat.splitSolution('Here:\n```js\nconst a = 1;\nconst b = 2;');
  assert.deepStrictEqual(segs.map((s) => s.type), ['text', 'code']);
  assert.strictEqual(segs[1].content, 'const a = 1;\nconst b = 2;');
});
test('solution: plain text, multiple blocks, CRLF and empty input', () => {
  assert.deepStrictEqual(SolutionFormat.splitSolution('just text'),
    [{ type: 'text', content: 'just text' }]);
  const two = SolutionFormat.splitSolution('```\na\n```\n```sql\nSELECT 1\n```');
  assert.deepStrictEqual(two.map((s) => s.type), ['code', 'code']);
  assert.strictEqual(two[0].lang, '');
  assert.strictEqual(two[1].lang, 'sql');
  assert.strictEqual(SolutionFormat.splitSolution('a\r\n```\r\nb\r\n```')[1].content, 'b');
  assert.deepStrictEqual(SolutionFormat.splitSolution(''), []);
  assert.deepStrictEqual(SolutionFormat.splitSolution(null), []);
  assert.strictEqual(SolutionFormat.hasSolution('  '), false);
  assert.strictEqual(SolutionFormat.hasSolution('x'), true);
});
test('UxHelpers: gallery signature stable and sensitive to id/status/answer', () => {
  const a = [{ id: 'r2', status: 'captured', answer: '' }, { id: 'r1', status: 'answered', answer: 'x' }];
  const same = JSON.parse(JSON.stringify(a));
  assert.strictEqual(UxHelpers.recordsSignature(a), UxHelpers.recordsSignature(same));
  assert.notStrictEqual(UxHelpers.recordsSignature(a), UxHelpers.recordsSignature([{ id: 'r3', status: 'captured' }].concat(a)));
  const st = JSON.parse(JSON.stringify(a)); st[0].status = 'error';
  assert.notStrictEqual(UxHelpers.recordsSignature(a), UxHelpers.recordsSignature(st));
  const an = JSON.parse(JSON.stringify(a)); an[0].answer = 'now';
  assert.notStrictEqual(UxHelpers.recordsSignature(a), UxHelpers.recordsSignature(an));
  assert.strictEqual(UxHelpers.recordsSignature([]), '');
  assert.strictEqual(UxHelpers.newestSignature([]), '');
  assert.strictEqual(UxHelpers.newestSignature(a), 'r2|captured|0');
});
test('UxHelpers: formatAccelerator is platform-aware', () => {
  assert.strictEqual(UxHelpers.formatAccelerator('CommandOrControl+Shift+1', true), '⌘⇧1');
  assert.strictEqual(UxHelpers.formatAccelerator('CommandOrControl+Shift+H', false), 'Ctrl+Shift+H');
});
test('UxHelpers: friendlyError hides technical detail', () => {
  assert.strictEqual(UxHelpers.friendlyError(new TypeError('Failed to fetch'), 'http://localhost:3000'), "Can't reach the backend. Is it running on port 3000?");
  assert.strictEqual(UxHelpers.friendlyError(new Error('boom backendUrl=x')), 'Something went wrong. Please try again.');
});
test('UxHelpers: galleryChanged', () => {
  assert.strictEqual(UxHelpers.galleryChanged('a', 'a'), false);
  assert.strictEqual(UxHelpers.galleryChanged('a', 'b'), true);
});
test('UxHelpers: shouldPoll truth table', () => {
  const ok = { view: 'gallery', visible: 'visible', inFlight: false, hasBridge: true };
  assert.strictEqual(UxHelpers.shouldPoll(ok), true);
  assert.strictEqual(UxHelpers.shouldPoll(Object.assign({}, ok, { view: 'answer' })), false);
  assert.strictEqual(UxHelpers.shouldPoll(Object.assign({}, ok, { visible: 'hidden' })), false);
  assert.strictEqual(UxHelpers.shouldPoll(Object.assign({}, ok, { inFlight: true })), false);
  assert.strictEqual(UxHelpers.shouldPoll(Object.assign({}, ok, { hasBridge: false })), false);
});
test('UxHelpers: newRequestId unique and short', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const id = UxHelpers.newRequestId('ask');
    assert.strictEqual(typeof id, 'string');
    assert.ok(id.length <= 128);
    seen.add(id);
  }
  assert.strictEqual(seen.size, 200);
});
test('UxHelpers: isCancelled', () => {
  assert.strictEqual(UxHelpers.isCancelled(null), false);
  assert.strictEqual(UxHelpers.isCancelled({}), false);
  assert.strictEqual(UxHelpers.isCancelled({ cancelled: true }), true);
});

// ── CaptureFlow (capture opens the edit screen directly) ─────────────────
const CF = CaptureFlow;
const cap = (n, t) => ({ dataUrl: 'data:image/png;base64,' + n, sourceType: t });
const FULL_MSG = 'Batch limit reached (6 images). Send or remove one.';
function freshWith(nStaged, extra) {
  const staged = [];
  for (let i = 0; i < nStaged; i++) staged.push({ id: 's' + i, dataUrl: 'd' + i, sourceType: 'screenshot-full' });
  return Object.assign({ mode: 'fresh', staged, current: { dataUrl: 'cur', sourceType: 'screenshot-region' }, busy: false, sent: false }, extra || {});
}
test('CaptureFlow: createState defaults', () => {
  assert.deepStrictEqual(CF.createState(), { mode: 'closed', staged: [], current: null, busy: false, sent: false });
});
test('CaptureFlow: closed + capture -> open-fresh, default sourceType, staged kept', () => {
  const st = Object.assign(CF.createState(), { staged: [{ id: 'a', dataUrl: 'x', sourceType: 'screenshot-full' }] });
  const r = CF.onCapture(st, { dataUrl: 'data:img' });
  assert.strictEqual(r.action, 'open-fresh');
  assert.strictEqual(r.state.mode, 'fresh');
  assert.deepStrictEqual(r.state.current, { dataUrl: 'data:img', sourceType: 'screenshot-full' });
  assert.strictEqual(r.state.staged.length, 1);
  assert.strictEqual(CF.onCapture(CF.createState(), cap('a', 'screenshot-region')).state.current.sourceType, 'screenshot-region');
});
test('CaptureFlow: closed with 5 staged opens, with 6 staged is full', () => {
  const five = Object.assign(CF.createState(), { staged: freshWith(5).staged });
  assert.strictEqual(CF.onCapture(five, cap('a')).action, 'open-fresh');
  const six = Object.assign(CF.createState(), { staged: freshWith(6).staged });
  const r = CF.onCapture(six, cap('a'));
  assert.strictEqual(r.action, 'full');
  assert.strictEqual(r.message, FULL_MSG);
  assert.strictEqual(r.state, six);
});
test('CaptureFlow: fresh idle -> stage-and-replace, then stageCurrent+loadCurrent', () => {
  const st = freshWith(1);
  const r = CF.onCapture(st, cap('new', 'screenshot-region'));
  assert.strictEqual(r.action, 'stage-and-replace');
  assert.strictEqual(r.state, st);
  assert.strictEqual(r.stageCurrent, true);
  const s = CF.stageCurrent(st, 'edited', 'screenshot-region');
  assert.strictEqual(s.added, true);
  const next = CF.loadCurrent(s.state, r.pendingCurrent);
  assert.deepStrictEqual(next.staged.map((x) => x.dataUrl), ['d0', 'edited']);
  assert.strictEqual(next.current.dataUrl, cap('new').dataUrl);
});
test('CaptureFlow: fresh idle cap: 4 staged ok, 5 staged is full (nothing dropped)', () => {
  assert.strictEqual(CF.onCapture(freshWith(4), cap('n')).action, 'stage-and-replace');
  const st = freshWith(5);
  const r = CF.onCapture(st, cap('n'));
  assert.strictEqual(r.action, 'full');
  assert.strictEqual(r.message, FULL_MSG);
  assert.strictEqual(r.state, st);
  assert.strictEqual(st.staged.length, 5);
});
test('CaptureFlow: fresh busy -> defer, state unchanged', () => {
  const st = freshWith(1, { busy: true });
  const r = CF.onCapture(st, cap('n'));
  assert.strictEqual(r.action, 'defer');
  assert.strictEqual(r.state, st);
});
test('CaptureFlow: fresh sent -> replace-sent, no staging', () => {
  const st = freshWith(0, { sent: true });
  const r = CF.onCapture(st, cap('n'));
  assert.strictEqual(r.action, 'replace-sent');
  assert.strictEqual(r.state.sent, false);
  assert.strictEqual(r.state.staged.length, 0);
  assert.strictEqual(r.state.current.dataUrl, cap('n').dataUrl);
});
test('CaptureFlow: record -> replace-record resets staged', () => {
  const st = { mode: 'record', staged: [], current: null, busy: false, sent: false };
  const r = CF.onCapture(st, cap('n', 'screenshot-region'));
  assert.strictEqual(r.action, 'replace-record');
  assert.strictEqual(r.state.mode, 'fresh');
  assert.deepStrictEqual(r.state.staged, []);
  assert.strictEqual(r.state.current.sourceType, 'screenshot-region');
});
test('CaptureFlow: invalid payloads are ignored', () => {
  [null, undefined, {}, { dataUrl: '' }, { dataUrl: 5 }].forEach((p) => {
    assert.strictEqual(CF.onCapture(CF.createState(), p).action, 'ignore');
  });
});
test('CaptureFlow: canStage conditions', () => {
  assert.strictEqual(CF.canStage(freshWith(0)), true);
  assert.strictEqual(CF.canStage(freshWith(4)), true);
  assert.strictEqual(CF.canStage(freshWith(5)), false);
  assert.strictEqual(CF.canStage(freshWith(0, { busy: true })), false);
  assert.strictEqual(CF.canStage(freshWith(0, { sent: true })), false);
  assert.strictEqual(CF.canStage(freshWith(0, { current: null })), false);
  assert.strictEqual(CF.canStage(freshWith(0, { mode: 'record' })), false);
  assert.strictEqual(CF.canStage(CF.createState()), false);
  assert.strictEqual(CF.canStage(freshWith(1), 3), true);
  assert.strictEqual(CF.canStage(freshWith(2), 3), false);
});
test('CaptureFlow: stageCurrent immutable, unique ids, capped, keeps current', () => {
  const st = freshWith(0);
  const a = CF.stageCurrent(st, 'e1', 'screenshot-full');
  const b = CF.stageCurrent(a.state, 'e2', 'screenshot-full');
  assert.strictEqual(st.staged.length, 0);
  assert.notStrictEqual(a.state.staged[0].id, b.state.staged[1].id);
  assert.strictEqual(b.state.current, st.current);
  const capped = CF.stageCurrent(freshWith(5), 'e', 'screenshot-full');
  assert.strictEqual(capped.added, false);
  assert.strictEqual(capped.capped, true);
  assert.strictEqual(capped.state.staged.length, 5);
});
test('CaptureFlow: removeStaged by id; unknown id no-op', () => {
  const st = freshWith(3);
  assert.deepStrictEqual(CF.removeStaged(st, 's1').staged.map((x) => x.id), ['s0', 's2']);
  assert.deepStrictEqual(CF.removeStaged(st, 'nope').staged.length, 3);
});
test('CaptureFlow: closeKeepStaged keeps staged; discard clears everything', () => {
  const st = freshWith(2, { sent: true });
  const k = CF.closeKeepStaged(st);
  assert.strictEqual(k.mode, 'closed');
  assert.strictEqual(k.staged.length, 2);
  assert.strictEqual(k.current, null);
  assert.strictEqual(k.sent, false);
  assert.deepStrictEqual(CF.discard(st), CF.createState());
});
test('CaptureFlow: imagesToSend order, parallel source_types, cap, empty', () => {
  const st = freshWith(2);
  st.staged[1].sourceType = 'screenshot-region';
  const r = CF.imagesToSend(st, 'EDITED');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.images, ['d0', 'd1', 'EDITED']);
  assert.deepStrictEqual(r.source_types, ['screenshot-full', 'screenshot-region', 'screenshot-region']);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(CF.imagesToSend(freshWith(0), 'E').images.length, 1);
  assert.strictEqual(CF.imagesToSend(st, '').ok, false);
  const over = CF.imagesToSend(freshWith(6), 'E');
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.images.length, 0);
});
test('CaptureFlow: markSent clears staged, keeps current and fresh mode', () => {
  const st = freshWith(2, { busy: true });
  const m = CF.markSent(st);
  assert.deepStrictEqual(m.staged, []);
  assert.strictEqual(m.sent, true);
  assert.strictEqual(m.busy, false);
  assert.strictEqual(m.mode, 'fresh');
  assert.strictEqual(m.current, st.current);
});
test('CaptureFlow: normalizeLastMode', () => {
  assert.strictEqual(CF.normalizeLastMode('scenario'), 'scenario');
  ['coding', '', null, undefined, 'x', 5].forEach((v) => assert.strictEqual(CF.normalizeLastMode(v), 'coding'));
});
test('CaptureFlow: labels', () => {
  assert.strictEqual(CF.sendLabel(1), 'Get solution from image');
  assert.strictEqual(CF.sendLabel(3), 'Get solution (3 images)');
  assert.strictEqual(CF.countLabel(freshWith(2)), '2 staged + current (3 of 6)');
});
test('index.html: capture-flow wired, popup retired', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const vb = html.indexOf('<script src="vision-batch.js"></script>');
  const cf = html.indexOf('<script src="capture-flow.js"></script>');
  assert.ok(vb > 0 && cf > vb);
  assert.strictEqual(html.split('<script src="capture-flow.js">').length - 1, 1);
  ['edit-stage', 'edit-stage-strip', 'edit-stage-count', 'edit-add-shot'].forEach((id) => {
    assert.strictEqual(html.split('id="' + id + '"').length - 1, 1, id);
  });
  const tag = html.match(/<button[^>]*id="edit-add-shot"[^>]*>/)[0];
  assert.ok(!/\btitle=/.test(tag));
  const active = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ['vision-popup', 'vp-send', '(^|[^-\\w])vm-coding', "getElementById\\('vp-", "\\$\\('vp-", 'name="vision-mode"', 'id="nav-audio"', 'id="view-audio"', 'AudioCapture'].forEach((t) => {
    assert.ok(!new RegExp(t).test(active), 'active reference remains: ' + t);
  });
  assert.ok(html.split('[VISION-POPUP-DISABLED]').length - 1 >= 3);
  assert.ok(html.split('[AUDIO-TAB-DISABLED]').length - 1 >= 3);
});

test('UxHelpers: normalizeOpacity and describePermission', () => {
  assert.strictEqual(UxHelpers.normalizeOpacity('dim'), 'dim');
  assert.strictEqual(UxHelpers.normalizeOpacity('solid'), 'solid');
  assert.strictEqual(UxHelpers.normalizeOpacity('glass'), 'glass');
  assert.strictEqual(UxHelpers.normalizeOpacity('bogus'), 'glass');
  assert.strictEqual(UxHelpers.normalizeOpacity(null), 'glass');
  assert.deepStrictEqual(UxHelpers.describePermission('microphone', 'granted'), { ok: true, text: 'Microphone: OK' });
  assert.deepStrictEqual(UxHelpers.describePermission('screen', 'not-required'), { ok: true, text: 'Screen Recording: OK (not required)' });
  assert.strictEqual(UxHelpers.describePermission('microphone', 'not-determined').ok, false);
  assert.strictEqual(UxHelpers.describePermission('screen', 'denied').text, 'Screen Recording: not allowed - System Settings > Privacy');
  assert.strictEqual(UxHelpers.describePermission('microphone', 'weird').text, 'Microphone: not allowed - System Settings > Privacy');
});
test('index.html: status line, tabs and single pause toggle contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const once = (s) => assert.strictEqual(html.split(s).length - 1, 1, s);
  ['id="status-line"', 'id="iv-pause"', 'role="tablist"'].forEach(once);
  assert.strictEqual(html.split('id="iv-resume"').length - 1, 0);
  assert.strictEqual(html.split('role="tabpanel"').length - 1, 4);
  assert.ok(/<div id="status-line"[^>]*aria-live="polite"/.test(html));
  const bar = html.slice(html.indexOf('role="tablist"'));
  assert.ok(/^[^>]*>\s*<button[^>]*id="nav-interview"[^>]*class="nav-btn active"|^[^>]*>\s*<button[^>]*class="nav-btn active"[^>]*id="nav-interview"/.test(bar));
});
console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) {
  for (const f of failures) console.log('FAILED: ' + f.name + '\n' + (f.e.stack || f.e.message) + '\n');
  process.exit(1);
}
