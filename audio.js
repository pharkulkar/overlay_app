// audio.js — dual-stream audio capture foundation (Phase 4)
// =========================================================
// Captures two SEPARATE, source-labeled audio streams:
//   - "Me"   : the user's microphone
//   - "Them" : system/output audio (via a loopback input such as BlackHole)
//
// Speaker identity comes from the capture SOURCE (which input device), not
// from AI diarization. This module only captures + meters levels so we can
// confirm both streams work. Transcription is Phase 5.
//
// Loaded as a plain <script> in index.html; exposes window.AudioCapture.

(function () {
  const state = {
    me: { stream: null, ctx: null, analyser: null, raf: null, deviceId: null, rec: null, recTimer: null },
    them: { stream: null, ctx: null, analyser: null, raf: null, deviceId: null, rec: null, recTimer: null },
    running: false,
    ws: null,
    transcribe: false,
    onTranscript: null,
    onSuggestions: null,
    onStatus: null,
    autoSuggest: false,
    tone: null,
  };

  // Length of each audio segment sent for transcription (ms).
  const CHUNK_MS = 4000;

  // Heuristic: pick a likely "system audio" loopback device for Them.
  const LOOPBACK_HINTS = ['blackhole', 'loopback', 'soundflower', 'vb-audio', 'stereo mix'];

  async function listInputDevices() {
    // Labels are only populated after a getUserMedia permission grant.
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  function guessLoopbackDeviceId(devices) {
    const match = devices.find((d) =>
      LOOPBACK_HINTS.some((h) => (d.label || '').toLowerCase().includes(h)));
    return match ? match.deviceId : null;
  }

  function guessMicDeviceId(devices) {
    // Prefer a device that is clearly NOT a loopback; fall back to default.
    const nonLoop = devices.find((d) =>
      !LOOPBACK_HINTS.some((h) => (d.label || '').toLowerCase().includes(h)));
    return nonLoop ? nonLoop.deviceId : (devices[0] ? devices[0].deviceId : null);
  }

  // Request mic permission once so enumerateDevices returns labels.
  async function primePermission() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch (e) {
      return false;
    }
  }

  async function openStream(deviceId) {
    const constraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false }
        : { echoCancellation: false, noiseSuppression: false },
      video: false,
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  // Attach a Web Audio analyser to a stream and drive a 0..1 level callback.
  function startMetering(slot, stream, onLevel) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    slot.ctx = ctx;
    slot.analyser = analyser;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      // RMS around the 128 midpoint -> 0..1 level.
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      onLevel(Math.min(1, rms * 2.2)); // light gain so quiet speech is visible
      slot.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopSlot(slot) {
    if (slot.raf) cancelAnimationFrame(slot.raf);
    slot.raf = null;
    if (slot.recTimer) { clearInterval(slot.recTimer); slot.recTimer = null; }
    if (slot.rec && slot.rec.state !== 'inactive') { try { slot.rec.stop(); } catch (_) {} }
    slot.rec = null;
    if (slot.ctx) { try { slot.ctx.close(); } catch (_) {} slot.ctx = null; }
    slot.analyser = null;
    if (slot.stream) { slot.stream.getTracks().forEach((t) => t.stop()); slot.stream = null; }
  }

  // ── WebSocket to the backend for transcription (auto-reconnecting) ──────
  function openWebSocket(backendUrl) {
    const wsUrl = backendUrl.replace(/^http/, 'ws') + '/ws/audio';
    let reconnectDelay = 1000; // backoff starts at 1s, caps at 10s

    const connect = () => {
      let ws;
      try { ws = new WebSocket(wsUrl); } catch (_) { scheduleReconnect(); return; }
      state.ws = ws;

      ws.onopen = () => {
        reconnectDelay = 1000;
        if (state.onStatus) state.onStatus('connected');
      };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === 'transcript' && state.onTranscript) {
          state.onTranscript({ speaker: msg.speaker, text: msg.text });
        } else if (msg.type === 'suggestions' && state.onSuggestions) {
          state.onSuggestions({ suggestions: msg.suggestions || [], trigger: msg.trigger || 'auto' });
        } else if (msg.type === 'error') {
          if (state.onTranscript) state.onTranscript({ error: msg.error });
        }
      };
      ws.onclose = () => {
        if (state.onStatus) state.onStatus('disconnected');
        // Only auto-reconnect while a capture session is still running.
        if (state.running && state.transcribe) scheduleReconnect();
      };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    };

    const scheduleReconnect = () => {
      if (state.onStatus) state.onStatus('reconnecting');
      setTimeout(() => {
        if (state.running && state.transcribe) connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    };

    connect();
    return state.ws;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(fr.result);
      fr.readAsDataURL(blob);
    });
  }

  // Record the stream in self-contained ~CHUNK_MS segments and send each over
  // the WS. We restart the recorder each interval so every chunk is a complete,
  // independently decodable file (what the transcription API needs).
  function startChunkedRecording(slot, speaker) {
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

    const recordOnce = () => {
      if (!slot.stream) return;
      let rec;
      try { rec = mime ? new MediaRecorder(slot.stream, { mimeType: mime }) : new MediaRecorder(slot.stream); }
      catch (_) { return; }
      slot.rec = rec;
      const parts = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
      rec.onstop = async () => {
        if (!parts.length) return;
        const blob = new Blob(parts, { type: mime || 'audio/webm' });
        if (blob.size < 1200) return; // skip near-empty/silent segments
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          const dataUrl = await blobToDataUrl(blob);
          state.ws.send(JSON.stringify({
            speaker, audio: dataUrl, filename: `${speaker}.webm`,
            auto_suggest: state.autoSuggest, tone: state.tone,
          }));
        }
      };
      rec.start();
      // Stop after CHUNK_MS; the interval below starts the next segment.
      setTimeout(() => { if (rec.state !== 'inactive') { try { rec.stop(); } catch (_) {} } }, CHUNK_MS - 100);
    };

    recordOnce();
    slot.recTimer = setInterval(recordOnce, CHUNK_MS);
  }

  // ── Public API ────────────────────────────────────────────────────────
  const AudioCapture = {
    LOOPBACK_HINTS,

    async init() {
      const granted = await primePermission();
      const devices = await listInputDevices();
      return {
        granted,
        devices: devices.map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' })),
        suggestedThem: guessLoopbackDeviceId(devices),
        suggestedMe: guessMicDeviceId(devices),
      };
    },

    isRunning() { return state.running; },

    // Start both streams. meDeviceId/themDeviceId from the UI selectors.
    // onLevel(which, level) is called continuously with which = 'me' | 'them'.
    // opts: { transcribe, backendUrl, onTranscript } to also stream to backend.
    async start(meDeviceId, themDeviceId, onLevel, opts) {
      await this.stop();
      opts = opts || {};
      state.me.deviceId = meDeviceId;
      state.them.deviceId = themDeviceId;
      state.transcribe = !!opts.transcribe;
      state.onTranscript = opts.onTranscript || null;
      state.onSuggestions = opts.onSuggestions || null;
      state.onStatus = opts.onStatus || null;
      state.autoSuggest = !!opts.autoSuggest;
      state.tone = opts.tone || null;

      // Open the WS first if transcription is requested.
      if (state.transcribe && opts.backendUrl) {
        try { state.ws = openWebSocket(opts.backendUrl); } catch (_) { state.ws = null; }
      }

      // Me (microphone)
      state.me.stream = await openStream(meDeviceId);
      startMetering(state.me, state.me.stream, (lvl) => onLevel('me', lvl));
      if (state.transcribe && state.ws) startChunkedRecording(state.me, 'me');

      // Them (loopback/system). Only if a device is chosen.
      if (themDeviceId) {
        state.them.stream = await openStream(themDeviceId);
        startMetering(state.them, state.them.stream, (lvl) => onLevel('them', lvl));
        if (state.transcribe && state.ws) startChunkedRecording(state.them, 'them');
      }
      state.running = true;
    },

    async stop() {
      // Clear flags FIRST so the WS onclose handler won't auto-reconnect.
      state.transcribe = false;
      state.running = false;
      stopSlot(state.me);
      stopSlot(state.them);
      if (state.ws) { try { state.ws.close(); } catch (_) {} state.ws = null; }
    },

    // Request an on-demand suggestion over the open WS (ask-now).
    suggestNow(tone) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'suggest_now', tone: tone || state.tone }));
        return true;
      }
      return false;
    },

    setAutoSuggest(on) { state.autoSuggest = !!on; },
    setTone(tone) { state.tone = tone || null; },

    // Expose raw streams for later phases.
    getStreams() {
      return { me: state.me.stream, them: state.them.stream };
    },
  };

  window.AudioCapture = AudioCapture;
})();
