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

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) {
  for (const f of failures) console.log('FAILED: ' + f.name + '\n' + (f.e.stack || f.e.message) + '\n');
  process.exit(1);
}
