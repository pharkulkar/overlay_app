// interview.js — Automatic Interview Mode (listen to the INTERVIEWER → detect
// questions → auto-answer professionally)
// ============================================================================
// This module listens ONLY to the interviewer ("them" = system/output audio,
// i.e. the remote voice coming through the speakers), transcribes it, and lets
// the Python backend decide whether each utterance is a question and stream a
// professional answer back. The user never has to press Ask.
//
// It matches the REAL backend contract (see server.py):
//
//   STT path (reuses the existing /ws/audio Whisper transcriber):
//     We capture the system-audio loopback as self-contained ~CHUNK_MS webm
//     segments and send each as:
//       { speaker:'them', audio:<dataURL>, filename:'them.webm' }
//     and receive back:
//       { type:'transcript', speaker:'them', text:'...' }
//     (No whole-recording accumulation: each chunk is independent + discarded.)
//
//   Interview path (/ws/interview — backend owns detection + answering):
//     We forward each recognized line into the interview session:
//       { type:'start', session_id, language }
//       { type:'transcript', text, is_final:true, speaker:'them', timestamp }
//       { type:'cancel' } | { type:'stop' }
//     and render the UPPERCASE events the backend emits:
//       SESSION_STARTED | TRANSCRIPT_PARTIAL | TRANSCRIPT_FINAL |
//       QUESTION_DETECTED | ANSWER_GENERATION_STARTED | ANSWER_CHUNK |
//       ANSWER_COMPLETED | QUESTION_CANCELLED | ERROR
//     Every envelope carries session_id + ts; Q/A events carry question_id.
//     ANSWER_CHUNK.text is a DELTA (append), ANSWER_COMPLETED.answer is final.
//
// The interviewer speaks English (any accent); Whisper + the backend's en-IN
// locale handle accents, so there is a single fixed English pipeline — no
// language switching.
//
// Loaded as a plain <script> in index.html; exposes window.InterviewMode.
// Security: runs in the sandboxed renderer (contextIsolation on, no Node);
// talks to the backend only via the WebSocket URLs derived from backendUrl.

(function () {
  'use strict';

  // Self-contained audio segment length (ms). Matches audio.js so we never
  // accumulate a whole recording — each chunk is independently decodable.
  const CHUNK_MS = 4000;
  const WS_RECONNECT_MIN = 1000;
  const WS_RECONNECT_MAX = 10000;

  // Finite UI states.
  const S = Object.freeze({
    STOPPED: 'STOPPED',
    LISTENING: 'LISTENING',
    PAUSED: 'PAUSED',
    QUESTION_DETECTED: 'QUESTION DETECTED',
    GENERATING: 'GENERATING ANSWER',
    ANSWER_READY: 'ANSWER READY',
  });

  // Backend event-type constants (UPPERCASE — see interview_session.py).
  const EVT = Object.freeze({
    SESSION_STARTED: 'SESSION_STARTED',
    TRANSCRIPT_PARTIAL: 'TRANSCRIPT_PARTIAL',
    TRANSCRIPT_FINAL: 'TRANSCRIPT_FINAL',
    QUESTION_DETECTED: 'QUESTION_DETECTED',
    ANSWER_STARTED: 'ANSWER_GENERATION_STARTED',
    ANSWER_CHUNK: 'ANSWER_CHUNK',
    ANSWER_COMPLETED: 'ANSWER_COMPLETED',
    QUESTION_CANCELLED: 'QUESTION_CANCELLED',
    ERROR: 'ERROR',
  });

  const state = {
    phase: S.STOPPED,
    running: false,
    paused: false,
    sessionId: null,
    language: null,       // base code reported by backend (e.g. 'en')
    speechLocale: null,   // e.g. 'en-IN' (informational)
    tone: null,
    backendUrl: null,
    candidateProfile: null,

    // Capture (system-audio loopback = the interviewer).
    stream: null,
    ctx: null,
    analyser: null,
    raf: null,
    rec: null,
    recTimer: null,
    seq: 0,

    // /ws/audio — the Whisper STT transport.
    sttWs: null,
    sttReconnect: WS_RECONNECT_MIN,
    sttReconnectTimer: null,

    // /ws/interview — detection + answering transport.
    ivWs: null,
    ivReconnect: WS_RECONNECT_MIN,
    ivReconnectTimer: null,
    ivStarted: false,     // SESSION_STARTED received

    deviceChangeHandler: null,

    // Bookkeeping for ordering / stale-answer guards.
    questionOrder: [],              // question_ids in detection order
    answers: new Map(),             // question_id -> { text, done }
    cb: {},
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function emit(name, payload) {
    const fn = state.cb[name];
    if (typeof fn === 'function') { try { fn(payload); } catch (_) {} }
  }
  function setPhase(phase, extra) { state.phase = phase; emit('onPhase', Object.assign({ phase }, extra || {})); }
  function genId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('read failed'));
      fr.readAsDataURL(blob);
    });
  }
  function newestQuestionId() {
    return state.questionOrder.length ? state.questionOrder[state.questionOrder.length - 1] : null;
  }
  function ensureAnswer(qid) {
    let a = state.answers.get(qid);
    if (!a) { a = { text: '', done: false }; state.answers.set(qid, a); }
    return a;
  }

  // ── System-audio (interviewer) capture ─────────────────────────────────────
  // getDisplayMedia requires a video track; Electron's main process answers the
  // request with { audio:'loopback' } so we capture the system mix WITHOUT any
  // virtual-cable driver. We drop the video track and keep only audio. This is
  // only ever reached from an explicit Start Listening action — never on launch.
  async function openInterviewerStream() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No system-audio track was granted. Interview mode listens to the '
        + 'interviewer via system audio (what plays out of your speakers), not the microphone.');
    }
    stream.getVideoTracks().forEach((t) => { try { stream.removeTrack(t); t.stop(); } catch (_) {} });
    return stream;
  }

  function startMetering(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const srcNode = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    srcNode.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    state.ctx = ctx; state.analyser = analyser;
    const tick = () => {
      if (!state.analyser) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      emit('onLevel', state.paused ? 0 : Math.min(1, Math.sqrt(sum / data.length) * 2.2));
      state.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // Record the loopback in self-contained ~CHUNK_MS webm segments; send each to
  // /ws/audio for Whisper transcription. Restarting the recorder each interval
  // keeps every chunk independently decodable (and bounds memory).
  function startChunkedRecording() {
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

    const recordOnce = () => {
      if (!state.stream || !state.running || state.paused) return;
      let rec;
      try { rec = mime ? new MediaRecorder(state.stream, { mimeType: mime }) : new MediaRecorder(state.stream); }
      catch (_) { return; }
      state.rec = rec;
      const parts = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
      rec.onstop = async () => {
        if (!parts.length) return;
        const blob = new Blob(parts, { type: mime || 'audio/webm' });
        parts.length = 0;
        if (blob.size < 1200) return; // skip near-silent segments
        if (state.sttWs && state.sttWs.readyState === WebSocket.OPEN) {
          let dataUrl; try { dataUrl = await blobToDataUrl(blob); } catch (_) { return; }
          sttSend({ speaker: 'them', audio: dataUrl, filename: 'them.webm' });
          state.seq++;
        }
      };
      try { rec.start(); } catch (_) { return; }
      setTimeout(() => { if (rec.state !== 'inactive') { try { rec.stop(); } catch (_) {} } }, CHUNK_MS - 100);
    };

    recordOnce();
    state.recTimer = setInterval(recordOnce, CHUNK_MS);
  }

  function stopCapture() {
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
    if (state.recTimer) { clearInterval(state.recTimer); state.recTimer = null; }
    if (state.rec && state.rec.state !== 'inactive') { try { state.rec.stop(); } catch (_) {} }
    state.rec = null;
    state.analyser = null;
    if (state.ctx) { try { state.ctx.close(); } catch (_) {} state.ctx = null; }
    if (state.stream) { state.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} }); state.stream = null; }
  }

  // ── /ws/audio (Whisper STT) ─────────────────────────────────────────────────
  function sttSend(obj) {
    if (state.sttWs && state.sttWs.readyState === WebSocket.OPEN) {
      try { state.sttWs.send(JSON.stringify(obj)); return true; } catch (_) {}
    }
    return false;
  }

  function connectSttWs() {
    if (!state.backendUrl) return;
    const url = state.backendUrl.replace(/^http/, 'ws') + '/ws/audio';
    let ws; try { ws = new WebSocket(url); } catch (_) { scheduleSttReconnect(); return; }
    state.sttWs = ws;
    ws.onopen = () => { state.sttReconnect = WS_RECONNECT_MIN; reportConnection(); };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'transcript' && (msg.speaker || 'them') === 'them') {
        const text = (msg.text || '').trim();
        if (!text) return;
        // Show it locally AND forward it to the interview session as a final
        // utterance so the backend can detect + answer.
        emit('onTranscript', { final: true, speaker: 'them', text });
        ivSend({ type: 'transcript', text, is_final: true, speaker: 'them', timestamp: Date.now() / 1000 });
      } else if (msg.type === 'error') {
        emit('onError', { message: 'Transcription: ' + (msg.error || 'error') });
      }
      // We intentionally ignore legacy {type:'suggestions'} here — detection and
      // answering come from /ws/interview, not the old suggestions path.
    };
    ws.onclose = () => { state.sttWs = null; reportConnection(); if (state.running) scheduleSttReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  function scheduleSttReconnect() {
    if (!state.running) return;
    reportConnection(true);
    if (state.sttReconnectTimer) clearTimeout(state.sttReconnectTimer);
    state.sttReconnectTimer = setTimeout(() => { state.sttReconnectTimer = null; if (state.running) connectSttWs(); }, state.sttReconnect);
    state.sttReconnect = Math.min(state.sttReconnect * 2, WS_RECONNECT_MAX);
  }

  // ── /ws/interview (detection + answering) ───────────────────────────────────
  function ivSend(obj) {
    if (state.ivWs && state.ivWs.readyState === WebSocket.OPEN) {
      try { state.ivWs.send(JSON.stringify(obj)); return true; } catch (_) {}
    }
    return false;
  }

  function connectIvWs() {
    if (!state.backendUrl) return;
    const url = state.backendUrl.replace(/^http/, 'ws') + '/ws/interview';
    let ws; try { ws = new WebSocket(url); } catch (_) { scheduleIvReconnect(); return; }
    state.ivWs = ws;
    ws.onopen = () => {
      state.ivReconnect = WS_RECONNECT_MIN;
      reportConnection();
      // Start (or resume) the SAME session id so a reconnect doesn't fork it.
      ivSend({
        type: 'start',
        session_id: state.sessionId,
        candidate_profile: state.candidateProfile,
        language: state.language || undefined,
      });
    };
    ws.onmessage = (ev) => { let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; } handleIvEvent(msg); };
    ws.onclose = () => { state.ivWs = null; reportConnection(); if (state.running) scheduleIvReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  function scheduleIvReconnect() {
    if (!state.running) return;
    reportConnection(true);
    if (state.ivReconnectTimer) clearTimeout(state.ivReconnectTimer);
    state.ivReconnectTimer = setTimeout(() => { state.ivReconnectTimer = null; if (state.running) connectIvWs(); }, state.ivReconnect);
    state.ivReconnect = Math.min(state.ivReconnect * 2, WS_RECONNECT_MAX);
  }

  function reportConnection(reconnecting) {
    const sttOk = state.sttWs && state.sttWs.readyState === WebSocket.OPEN;
    const ivOk = state.ivWs && state.ivWs.readyState === WebSocket.OPEN;
    if (sttOk && ivOk) emit('onConnection', { connected: true });
    else if (reconnecting) emit('onConnection', { connected: false, reconnecting: true });
    else emit('onConnection', { connected: false });
  }

  // Associate the backend session id (it may differ from ours if the backend
  // reuses an existing one). We adopt the backend's authoritative id.
  function handleIvEvent(msg) {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type;

    if (type === EVT.SESSION_STARTED) {
      state.ivStarted = true;
      if (msg.session_id) state.sessionId = msg.session_id;
      if (msg.language) state.language = msg.language;
      if (msg.speech_locale) state.speechLocale = msg.speech_locale;
      emit('onSessionStarted', { sessionId: state.sessionId, language: state.language, speechLocale: state.speechLocale });
      return;
    }

    // Ignore events for a different session once ours is known.
    if (msg.session_id && state.sessionId && msg.session_id !== state.sessionId) return;

    switch (type) {
      case EVT.TRANSCRIPT_PARTIAL:
        emit('onTranscript', { final: false, speaker: msg.speaker || 'them', text: msg.text || '' });
        break;
      case EVT.TRANSCRIPT_FINAL:
        emit('onTranscript', { final: true, speaker: msg.speaker || 'them', text: msg.text || '' });
        break;

      case EVT.QUESTION_DETECTED: {
        const qid = msg.question_id || genId('q');
        if (!state.questionOrder.includes(qid)) state.questionOrder.push(qid);
        ensureAnswer(qid);
        emit('onQuestionDetected', {
          questionId: qid,
          text: (msg.text || '').trim(),
          category: msg.category || null,
          confidence: msg.confidence,
        });
        setPhase(S.QUESTION_DETECTED, { questionId: qid });
        break;
      }

      case EVT.ANSWER_STARTED: {
        const qid = msg.question_id; if (!qid) break;
        const a = ensureAnswer(qid); a.text = ''; a.done = false;
        emit('onAnswerStarted', { questionId: qid, category: msg.category || null });
        if (qid === newestQuestionId()) setPhase(S.GENERATING, { questionId: qid });
        break;
      }

      case EVT.ANSWER_CHUNK: {
        const qid = msg.question_id; if (!qid) break;
        const a = ensureAnswer(qid);
        // Backend sends deltas; append.
        a.text += (msg.text || '');
        emit('onAnswerChunk', { questionId: qid, text: a.text, delta: msg.text || '' });
        if (qid === newestQuestionId()) setPhase(S.GENERATING, { questionId: qid });
        break;
      }

      case EVT.ANSWER_COMPLETED: {
        const qid = msg.question_id; if (!qid) break;
        const a = ensureAnswer(qid);
        if (typeof msg.answer === 'string' && msg.answer.length) a.text = msg.answer;
        if (a.done) break; // ignore duplicate completion
        a.done = true;
        emit('onAnswerCompleted', { questionId: qid, text: a.text, category: msg.category || null });
        // Only the newest question drives the ANSWER_READY headline so a late
        // answer for an older question can't look like the current response.
        if (qid === newestQuestionId()) setPhase(S.ANSWER_READY, { questionId: qid });
        break;
      }

      case EVT.QUESTION_CANCELLED:
        emit('onQuestionCancelled', { questionId: msg.question_id || null, reason: msg.reason || '' });
        break;

      case EVT.ERROR:
        emit('onError', {
          message: msg.error || 'Processing error',
          questionId: msg.question_id || null,
          recoverable: msg.recoverable !== false,
        });
        break;

      default:
        break;
    }
  }

  // ── Device-change handling ──────────────────────────────────────────────────
  function attachDeviceChange() {
    detachDeviceChange();
    state.deviceChangeHandler = () => emit('onDevicesChanged', {});
    try { navigator.mediaDevices.addEventListener('devicechange', state.deviceChangeHandler); } catch (_) {}
  }
  function detachDeviceChange() {
    if (state.deviceChangeHandler) {
      try { navigator.mediaDevices.removeEventListener('devicechange', state.deviceChangeHandler); } catch (_) {}
      state.deviceChangeHandler = null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  const InterviewMode = {
    STATES: S,
    EVENTS: EVT,

    isRunning() { return state.running; },
    isPaused() { return state.paused; },
    getPhase() { return state.phase; },
    getSessionId() { return state.sessionId; },
    getSpeechLocale() { return state.speechLocale; },

    // Probe the backend for the configured speech locale / language (shown in
    // the UI). Does NOT start capture. Returns {} on failure.
    async init(backendUrl) {
      const url = backendUrl || state.backendUrl;
      if (!url) return {};
      try {
        const res = await fetch(url.replace(/\/+$/, '') + '/api/health');
        const h = await res.json();
        return {
          language: h.default_language || null,
          speechLocale: h.default_speech_locale || null,
          openaiConfigured: !!h.openai_configured,
        };
      } catch (_) { return {}; }
    },

    // Start Listening to the interviewer. opts: {
    //   backendUrl, tone, candidateProfile, language,
    //   onPhase,onLevel,onTranscript,onQuestionDetected,onAnswerStarted,
    //   onAnswerChunk,onAnswerCompleted,onQuestionCancelled,onError,
    //   onConnection,onSessionStarted,onDevicesChanged
    // }
    async start(opts) {
      opts = opts || {};
      if (state.running) await this.stop();

      state.backendUrl = opts.backendUrl || null;
      state.tone = opts.tone || null;
      state.candidateProfile = opts.candidateProfile || null;
      state.language = opts.language || null;
      state.sessionId = genId('sess');
      state.seq = 0;
      state.ivStarted = false;
      state.questionOrder = [];
      state.answers = new Map();

      state.cb = {
        onPhase: opts.onPhase, onLevel: opts.onLevel, onTranscript: opts.onTranscript,
        onQuestionDetected: opts.onQuestionDetected, onAnswerStarted: opts.onAnswerStarted,
        onAnswerChunk: opts.onAnswerChunk, onAnswerCompleted: opts.onAnswerCompleted,
        onQuestionCancelled: opts.onQuestionCancelled, onError: opts.onError,
        onConnection: opts.onConnection, onSessionStarted: opts.onSessionStarted,
        onDevicesChanged: opts.onDevicesChanged,
      };

      // Capture the interviewer (system audio). Explicit user action only.
      let stream;
      try { stream = await openInterviewerStream(); }
      catch (err) {
        emit('onError', { message: 'Could not start listening: ' + (err && err.message ? err.message : String(err)), fatal: true });
        throw err;
      }
      state.stream = stream;
      stream.getAudioTracks().forEach((t) => {
        t.onended = () => { emit('onError', { message: 'System-audio capture ended or was revoked.', fatal: true }); InterviewMode.stop(); };
      });

      state.running = true;
      state.paused = false;

      connectIvWs();     // detection + answering
      connectSttWs();    // Whisper STT transport
      startMetering(stream);
      startChunkedRecording();
      attachDeviceChange();

      setPhase(S.LISTENING);
      return { sessionId: state.sessionId };
    },

    pause() {
      if (!state.running || state.paused) return;
      state.paused = true;
      if (state.rec && state.rec.state !== 'inactive') { try { state.rec.stop(); } catch (_) {} }
      setPhase(S.PAUSED);
    },

    resume() {
      if (!state.running || !state.paused) return;
      state.paused = false;
      setPhase(S.LISTENING);
    },

    async stop() {
      if (!state.running && state.phase === S.STOPPED) return;
      ivSend({ type: 'stop' }); // best-effort graceful close on the backend
      state.running = false;
      state.paused = false;
      detachDeviceChange();
      stopCapture();
      // Close STT socket.
      if (state.sttReconnectTimer) { clearTimeout(state.sttReconnectTimer); state.sttReconnectTimer = null; }
      if (state.sttWs) { try { state.sttWs.onclose = null; state.sttWs.close(); } catch (_) {} state.sttWs = null; }
      // Close interview socket.
      if (state.ivReconnectTimer) { clearTimeout(state.ivReconnectTimer); state.ivReconnectTimer = null; }
      if (state.ivWs) { try { state.ivWs.onclose = null; state.ivWs.close(); } catch (_) {} state.ivWs = null; }
      state.ivStarted = false;
      setPhase(S.STOPPED);
    },

    // Cancel the in-flight question's generation (maps to backend 'cancel').
    cancelCurrent() { return ivSend({ type: 'cancel' }); },

    setTone(tone) { state.tone = tone || null; },

    // Snapshot of Q/A pairs for history / tests.
    getHistory() {
      return state.questionOrder.map((qid) => {
        const a = state.answers.get(qid) || { text: '', done: false };
        return { questionId: qid, answer: a.text, done: a.done };
      });
    },

    // Testing hooks (no live sockets needed).
    _handleIvEvent: handleIvEvent,
    _state: state,
  };

  window.InterviewMode = InterviewMode;
})();
