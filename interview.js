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
//     We capture the system-audio loopback and, using voice-activity detection,
//     send ONE complete utterance (the whole question, cut when the interviewer
//     stops talking) as a self-contained webm:
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

  // Audio segmentation is driven by voice-activity detection (VAD), NOT a fixed
  // timer: we buffer the interviewer's audio while they speak and only send it
  // to Whisper once they go quiet (end of question). This answers the WHOLE
  // question the moment they finish, instead of chasing partial fixed-length
  // chunks. See the VAD constants and the metering loop below. Each flushed
  // utterance is an independently decodable webm (no whole-recording buildup).
  const WS_RECONNECT_MIN = 1000;
  const WS_RECONNECT_MAX = 10000;

  // Mirror of the backend's canonical language registry (interview_config.py
  // SUPPORTED_LANGUAGES). Used for the Interview-tab dropdown before /api/health
  // reconciles it. { code, name, native, locale }.
  const SUPPORTED_LANGUAGES = [
    { code: 'en', name: 'English', native: 'English', locale: 'en-IN' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी', locale: 'hi-IN' },
    // Hinglish: Hindi-English code-mixing in Roman script. Not an ISO language;
    // a pseudo-code the backend handles specially. Placed beside Hindi.
    { code: 'hing', name: 'Hinglish', native: 'Hinglish', locale: 'hi-IN' },
    { code: 'mr', name: 'Marathi', native: 'मराठी', locale: 'mr-IN' },
    { code: 'zh', name: 'Chinese', native: '中文', locale: 'zh-CN' },
    { code: 'es', name: 'Spanish', native: 'Español', locale: 'es-ES' },
    { code: 'fr', name: 'French', native: 'Français', locale: 'fr-FR' },
    { code: 'de', name: 'German', native: 'Deutsch', locale: 'de-DE' },
    { code: 'ja', name: 'Japanese', native: '日本語', locale: 'ja-JP' },
    { code: 'ko', name: 'Korean', native: '한국어', locale: 'ko-KR' },
    { code: 'ar', name: 'Arabic', native: 'العربية', locale: 'ar-SA' },
    { code: 'pt', name: 'Portuguese', native: 'Português', locale: 'pt-BR' },
    { code: 'ru', name: 'Russian', native: 'Русский', locale: 'ru-RU' },
    { code: 'it', name: 'Italian', native: 'Italiano', locale: 'it-IT' },
    { code: 'nl', name: 'Dutch', native: 'Nederlands', locale: 'nl-NL' },
    { code: 'tr', name: 'Turkish', native: 'Türkçe', locale: 'tr-TR' },
    { code: 'ta', name: 'Tamil', native: 'தமிழ்', locale: 'ta-IN' },
    { code: 'te', name: 'Telugu', native: 'తెలుగు', locale: 'te-IN' },
    { code: 'bn', name: 'Bengali', native: 'বাংলা', locale: 'bn-IN' },
    { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', locale: 'gu-IN' },
    { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', locale: 'pa-IN' },
  ];

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
    languages: ['en'],    // selected language set (base codes)
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

  // The metering loop doubles as a simple voice-activity detector (VAD): it
  // computes the RMS level each animation frame, reports it for the UI meter,
  // AND decides when the interviewer has STARTED and STOPPED speaking so we can
  // segment on whole utterances (end-of-question) instead of fixed timers.
  // If capture starts but we never hear ANY sound for this long, the most
  // likely cause on macOS is that the system-audio loopback track was granted
  // but carries silence (audio-sharing not enabled in the capture prompt, or
  // the meeting audio is routed to a device the loopback can't tap). We warn
  // ONCE so the user gets feedback instead of an indefinite "Listening…".
  const SILENCE_WARN_MS = 12000;

  function startMetering(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const srcNode = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    srcNode.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    state.ctx = ctx; state.analyser = analyser;

    // Silence-watchdog bookkeeping (reset on each metering start).
    state.meterStartTs = performance.now();
    state.everHeardSound = false;
    state.silenceWarned = false;

    const tick = () => {
      if (!state.analyser) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 2.2);
      emit('onLevel', state.paused ? 0 : level);

      // Any non-trivial level means audio IS flowing — clear the watchdog.
      if (level >= 0.02) state.everHeardSound = true;

      // Fire the one-time silence warning if we've heard nothing at all.
      if (!state.everHeardSound && !state.silenceWarned && !state.paused
          && (performance.now() - state.meterStartTs) >= SILENCE_WARN_MS) {
        state.silenceWarned = true;
        emit('onError', {
          message: 'No system audio detected yet. In the macOS screen-capture '
            + 'prompt, make sure "audio" sharing is enabled, and check that the '
            + 'call audio plays through your system output (not only headphones '
            + 'the capture can\'t reach). Running the built app (not a dev run) '
            + 'is the most reliable for loopback.',
          recoverable: true,
        });
      }

      if (!state.paused) vadStep(level);
      state.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // ── VAD state machine (end-of-utterance segmentation) ──────────────────────
  // We keep ONE recorder running continuously and buffer its data. When the
  // interviewer has spoken (level above threshold) and then falls silent for
  // VAD_SILENCE_MS, we treat that as end-of-question and flush the buffered
  // audio as a single utterance to Whisper. A hard cap (VAD_MAX_UTTER_MS)
  // flushes a non-stop talker so very long answers still get processed.
  // VAD timings are DEFAULTS; they can be overridden per-session via start()
  // opts (wired from env through preload's electronAPI.vadConfig) so interview
  // responsiveness is tunable without editing source. Lowered silence (650->450)
  // cuts response lag; the backend EOU window was lowered in tandem so the two
  // "has the person finished?" guards no longer stack. Raise silence if it clips
  // very slow/pausing speakers.
  const VAD_DEFAULTS = Object.freeze({
    speechLevel: 0.055,   // RMS above this = "speaking"
    silenceMs: 450,       // quiet this long after speech = end of question
    minSpeechMs: 350,     // ignore blips shorter than this
    maxUtterMs: 15000,    // safety flush for a continuous talker
  });
  // Live, overridable copy used by the VAD loop (reset from VAD_DEFAULTS +
  // opts.vadConfig on each start()).
  let VAD_SPEECH_LEVEL = VAD_DEFAULTS.speechLevel;
  let VAD_SILENCE_MS = VAD_DEFAULTS.silenceMs;
  let VAD_MIN_SPEECH_MS = VAD_DEFAULTS.minSpeechMs;
  let VAD_MAX_UTTER_MS = VAD_DEFAULTS.maxUtterMs;
  const VAD_PREROLL_MS = 300;       // keep a little audio before speech onset

  // Apply per-session VAD overrides (only finite positive numbers win; anything
  // else keeps the default). Called from start().
  function applyVadConfig(cfg) {
    cfg = cfg || {};
    const pick = (v, def) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : def);
    VAD_SPEECH_LEVEL = pick(cfg.speechLevel, VAD_DEFAULTS.speechLevel);
    VAD_SILENCE_MS = pick(cfg.silenceMs, VAD_DEFAULTS.silenceMs);
    VAD_MIN_SPEECH_MS = pick(cfg.minSpeechMs, VAD_DEFAULTS.minSpeechMs);
    VAD_MAX_UTTER_MS = pick(cfg.maxUtterMs, VAD_DEFAULTS.maxUtterMs);
  }

  function vadStep(level) {
    const v = state.vad;
    if (!v || !v.active) return;
    const now = performance.now();
    const speaking = level >= VAD_SPEECH_LEVEL;

    if (speaking) {
      if (!v.inSpeech) { v.inSpeech = true; v.speechStart = now; }
      v.lastVoiceTs = now;
    }

    if (v.inSpeech) {
      // Hard cap: flush a continuous talker so we don't buffer forever.
      if (now - v.speechStart >= VAD_MAX_UTTER_MS) { flushUtterance(); return; }
      // End-of-utterance: enough quiet after real speech.
      if (!speaking
          && (now - v.lastVoiceTs) >= VAD_SILENCE_MS
          && (v.lastVoiceTs - v.speechStart) >= VAD_MIN_SPEECH_MS) {
        flushUtterance();
      }
    }
  }

  // Record continuously with a short timeslice so data accumulates in a bounded
  // buffer; flushUtterance() turns the current buffer into one webm and sends
  // it. We never keep a whole-conversation recording — the buffer is cleared on
  // every flush.
  function startChunkedRecording() {
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

    state.vad = {
      active: true, inSpeech: false,
      speechStart: 0, lastVoiceTs: 0,
      parts: [], mime,
    };

    startRecorderCycle();
  }

  // A MediaRecorder started with a timeslice emits a non-finalized stream of
  // blobs that are only decodable together with the initial header blob. To
  // keep every flushed utterance INDEPENDENTLY decodable, we instead run the
  // recorder in gapless cycles: start → collect → on flush we stop (which
  // finalizes a complete webm) and immediately start the next cycle.
  function startRecorderCycle() {
    const v = state.vad;
    if (!v || !v.active || !state.stream || !state.running) return;
    let rec;
    try { rec = v.mime ? new MediaRecorder(state.stream, { mimeType: v.mime }) : new MediaRecorder(state.stream); }
    catch (_) { return; }
    state.rec = rec;
    v.parts = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) v.parts.push(e.data); };
    rec.onstop = () => {
      const parts = v.parts; v.parts = [];
      // Immediately begin the next cycle so no audio is dropped in the gap.
      if (v.active && state.running && !state.paused) startRecorderCycle();
      if (!parts.length || !v.wantSend) { v.wantSend = false; return; }
      v.wantSend = false;
      const blob = new Blob(parts, { type: v.mime || 'audio/webm' });
      if (blob.size < 800) return; // guard against silence-only flushes
      if (state.sttWs && state.sttWs.readyState === WebSocket.OPEN) {
        blobToDataUrl(blob).then((dataUrl) => {
          sttSend({ speaker: 'them', audio: dataUrl, filename: 'them.webm', languages: state.languages });
          state.seq++;
        }).catch(() => {});
      }
    };
    try { rec.start(); } catch (_) { return; }
  }

  // Flush the current utterance: mark it to be sent, stop the recorder (which
  // finalizes the webm and triggers onstop → send + next cycle). Reset VAD so
  // we wait for the next speech onset.
  function flushUtterance() {
    const v = state.vad;
    if (!v) return;
    v.inSpeech = false;
    v.speechStart = 0;
    v.lastVoiceTs = 0;
    v.wantSend = true;
    if (state.rec && state.rec.state !== 'inactive') { try { state.rec.stop(); } catch (_) { v.wantSend = false; } }
  }

  function stopCapture() {
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
    if (state.vad) { state.vad.active = false; state.vad.wantSend = false; state.vad = null; }
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
        const lang = msg.language || undefined;
        // Show it locally AND forward it to the interview session as a final
        // utterance so the backend can detect + answer. Carry the detected
        // language through so the session tags the turn correctly.
        emit('onTranscript', { final: true, speaker: 'them', text, language: lang || null });
        ivSend({ type: 'transcript', text, is_final: true, speaker: 'them', timestamp: Date.now() / 1000, language: lang });
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

  // Build the /ws/interview start frame (extracted so a test seam can capture
  // it without opening a socket). The backend reuses an existing session for a
  // repeated session_id, so a changed profile/language set only applies via a
  // full Stop->Start (which mints a new session_id in start()).
  function buildStartFrame() {
    return {
      type: 'start',
      session_id: state.sessionId,
      candidate_profile: state.candidateProfile,
      language: state.language || undefined,
      languages: state.languages,
    };
  }
  function sendStartFrame() { return ivSend(buildStartFrame()); }

  function connectIvWs() {
    if (!state.backendUrl) return;
    const url = state.backendUrl.replace(/^http/, 'ws') + '/ws/interview';
    let ws; try { ws = new WebSocket(url); } catch (_) { scheduleIvReconnect(); return; }
    state.ivWs = ws;
    ws.onopen = () => {
      state.ivReconnect = WS_RECONNECT_MIN;
      reportConnection();
      // Start (or resume) the SAME session id so a reconnect doesn't fork it.
      sendStartFrame();
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
      if (Array.isArray(msg.languages) && msg.languages.length) state.languages = msg.languages.slice();
      if (msg.speech_locale) state.speechLocale = msg.speech_locale;
      emit('onSessionStarted', {
        sessionId: state.sessionId,
        language: state.language,
        languages: state.languages,
        speechLocale: state.speechLocale,
      });
      return;
    }

    // Ignore events for a different session once ours is known.
    if (msg.session_id && state.sessionId && msg.session_id !== state.sessionId) return;

    switch (type) {
      case EVT.TRANSCRIPT_PARTIAL:
        emit('onTranscript', { final: false, speaker: msg.speaker || 'them', text: msg.text || '', language: msg.language || null });
        break;
      case EVT.TRANSCRIPT_FINAL:
        emit('onTranscript', { final: true, speaker: msg.speaker || 'them', text: msg.text || '', language: msg.language || null });
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
          language: msg.language || null,
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

      // Apply any VAD timing overrides for this session (from env via preload).
      applyVadConfig(opts.vadConfig);

      state.backendUrl = opts.backendUrl || null;
      state.tone = opts.tone || null;
      state.candidateProfile = opts.candidateProfile || null;
      state.languages = (Array.isArray(opts.languages) && opts.languages.length)
        ? opts.languages.slice()
        : ['en'];
      // The start-frame primary language is the first selected code.
      state.language = opts.language || state.languages[0] || null;
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
      // Discard the in-flight utterance (don't answer half a paused question)
      // and halt the recorder cycle; onstop won't chain while paused.
      if (state.vad) { state.vad.wantSend = false; state.vad.inSpeech = false; }
      if (state.rec && state.rec.state !== 'inactive') { try { state.rec.stop(); } catch (_) {} }
      setPhase(S.PAUSED);
    },

    resume() {
      if (!state.running || !state.paused) return;
      state.paused = false;
      // Reset VAD and restart the gapless recorder cycle.
      if (state.vad) {
        state.vad.inSpeech = false; state.vad.speechStart = 0;
        state.vad.lastVoiceTs = 0; state.vad.wantSend = false;
      }
      startRecorderCycle();
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

    // Language set + candidate-profile accessors (pure state; applied on the
    // NEXT start()/start-frame — a changed set never mutates a live session).
    setLanguages(codes) {
      state.languages = (Array.isArray(codes) && codes.length) ? codes.slice() : ['en'];
    },
    getLanguages() { return state.languages.slice(); },
    setCandidateProfile(text) { state.candidateProfile = text || null; },
    getCandidateProfile() { return state.candidateProfile; },

    // The mirrored backend language registry (for the dropdown).
    SUPPORTED_LANGUAGES: SUPPORTED_LANGUAGES,

    // Snapshot of Q/A pairs for history / tests.
    getHistory() {
      return state.questionOrder.map((qid) => {
        const a = state.answers.get(qid) || { text: '', done: false };
        return { questionId: qid, answer: a.text, done: a.done };
      });
    },

    // Testing hooks (no live sockets needed).
    _handleIvEvent: handleIvEvent,
    _sendStartFrame: sendStartFrame,
    _buildStartFrame: buildStartFrame,
    _ivSend: ivSend,
    _sttSend: sttSend,
    _state: state,
  };

  window.InterviewMode = InterviewMode;
})();
