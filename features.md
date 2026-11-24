# Overlay App — Feature List

An Electron desktop **overlay assistant** that floats on top of everything, stays
visible in screen sharing and recording, and helps answer on-screen questions and live
interview/meeting questions. The Electron app is the frontend; it talks to a
separate Python backend (expected at `http://localhost:3000`) for OCR, OpenAI
answers, and speech-to-text.

---

## 1. Overlay window & stealth

- **Frameless, transparent, always-on-top window** — a translucent "glass" card
  that floats over all other apps.
- **Visible in screen sharing / recording** — no content protection is applied;
  the overlay is hidden only while the app grabs a screenshot.
- **Pinned across all desktops / spaces** — visible on every virtual desktop and
  even over full-screen apps (`screen-saver` always-on-top level).
- **Draggable** anywhere on screen; interactive controls opt out of dragging so
  clicks and scrolling still work.
- **Resizable**, with **position and size remembered** between launches (saved to
  a JSON file in the app's userData folder).
- **Show/hide toggle** via global hotkey.
- **In-overlay right-click menu** instead of a native OS menu, so the menu itself
  stays inside the overlay window.

## 2. Global hotkeys (configurable via env vars)

- **Capture full screen** — `Cmd/Ctrl+Shift+1`
- **Capture region** — `Cmd/Ctrl+Shift+2`
- **Toggle overlay visibility** — `Cmd/Ctrl+Shift+H`
- **Ask now** — `Cmd/Ctrl+Shift+A` (request a suggestion about the latest audio)

## 3. Screen capture → OCR → Ask (the "Answer" tab)

- **Full-screen capture** of the display under the cursor, at physical/Retina
  resolution (no downscaling).
- **Region capture** — a dim veil overlays the screen with a crosshair; drag a
  rectangle (live size readout, `Esc` to cancel) and only that region is grabbed.
- **Multi-monitor aware** — captures the correct display based on cursor position
  and matches the capture source to that display.
- **OCR-only pipeline** — captures are sent to the backend for text extraction;
  the extracted text lands in an **editable textarea** for review before asking.
- **Manual question entry** — type your own question directly instead of capturing.
- **Ask / Regenerate** — send the (edited) text to the backend/OpenAI for an answer.
- **Answer tones** — choose Concise, Detailed, Professional, or Casual; the tone
  applies to captures and asks.
- **Copy answer** to clipboard.
- **Collapsible input box** to give the answer more room.
- **Keyboard submit** — `Cmd/Ctrl+Enter` in the textarea asks immediately.
- **Per-record answer history** — shows previous answers for the same capture
  (newest first), collapsed when there's only one.
- **Status indicator** — a colored dot (idle / thinking / ok / error) reflects the
  current state.

## 4. Gallery / history (the "Gallery" tab)

- **Grid of past captures** grouped by day.
- **Mixed record types** — image thumbnails, manual-question text snippets (💬),
  and audio records (🎙), each with a status badge (answered ✓ / error ! / pending ○).
- **Open a record** to reload its extracted text and show the cached answer
  instantly (no re-call to OpenAI if already answered).
- **Delete** individual records, **Clear** all history, and **Refresh** the list.

## 5. Automatic Interview Mode (the "Interview" tab)

Hands-free: listens to the **interviewer** (system audio, i.e. the remote voice
coming out of your speakers), detects questions, and auto-answers — you never
press Ask.

- **Start / Pause / Resume / Stop** listening controls.
- **System-audio capture** of the interviewer via loopback — no virtual-cable
  driver (BlackHole / VB-CABLE / Stereo Mix) required; works on macOS 13+ and
  Windows.
- **Voice-activity detection (VAD)** segmentation — buffers while the interviewer
  speaks and flushes one complete utterance when they go silent (end-of-question),
  with a hard cap so a non-stop talker still gets processed.
- **Gapless chunked recording** — each flushed utterance is an independently
  decodable audio file for Whisper transcription.
- **Live interviewer transcript** with partial (in-progress) and final lines.
- **Automatic question detection + streaming answers** — the backend decides what
  is a question and streams a professional answer back token-by-token.
- **One Q/A card per question** (newest on top), each with live "Generating…"
  spinner, streamed answer, category badge, Expand/Collapse, and Copy.
- **Manual retry per card** — a failed auto-answer can be re-asked via the REST
  `/api/ask` path.
- **Stale-answer guarding** — only the newest question drives the headline status,
  so a late answer for an older question can't masquerade as the current one.
- **Live state pill** — Stopped / Listening / Paused / Question Detected /
  Generating Answer / Answer Ready, with an audio-level meter.
- **Connection status** — Connected / Reconnecting / Disconnected, with automatic
  WebSocket reconnect (exponential backoff) for both the STT and interview sockets.
- **Clear** wipes the transcript and Q/A cards without stopping the session.
- **Speech-locale display** — shows the backend's configured interviewer language.
- **OpenAI-key warning** — if the backend reports no key, it warns that answers
  will fail.

## 6. Audio Copilot (the "Audio" tab)

A dual-stream meeting copilot focused on a live transcript you can act on.

- **Dual capture** — "Me" (your microphone) and "Them" (system/output audio),
  with speaker identity coming from the capture source (not AI diarization).
- **Live level meters** for both streams.
- **Device selection** — pick specific input devices for Me/Them, rescan devices;
  "Them" defaults to native system loopback (leave it on "(none)").
- **Transcribe toggle** — streams ~4-second audio chunks to the backend over a
  WebSocket and renders a **live, color-coded transcript** (Me vs Them).
- **Resilient transcription** — auto-reconnecting WebSocket with backoff; a failed
  "Them" capture won't tear down the "Me" stream.
- **Transcript interactions** — select text and right-click for an in-overlay menu:
  **Ask**, **Ask with context** (prepends recent conversation), or **Copy**.
- **Smart auto-scroll** — stops auto-scrolling while you're selecting or hovering
  the transcript.
- **Suggestions** — on-demand "Ask latest" (also the Ask-now hotkey) or optional
  **auto-suggest on pause**; suggestions are click-to-copy.
- **Clear transcript** and **opt-in Save transcript to disk**.

## 7. Privacy & consent

- **One-time consent notice** explaining that the app can listen to mic/system
  audio; dismissal remembered in `localStorage`.
- **Transcript kept in memory by default** — only written to disk if you explicitly
  choose Save.
- **Overlay visible** in shared/recorded screens (no content protection).
- **Sandboxed renderer** — `contextIsolation` on, `nodeIntegration` off; the
  renderer reaches the backend only through a narrow `preload.js` bridge.

## 8. Backend integration (via `preload.js` bridge)

Exposes a safe `electronAPI` to the UI for:

- Health check (`/api/health`) and backend-reachability checks.
- OCR-only capture, Ask (`/api/ask`), and Solve (`/api/solve`, with force + tone).
- Record management — list, get, delete, clear (`/api/records…`).
- Transcript clear and opt-in save to disk.
- WebSockets `/ws/audio` (Whisper STT) and `/ws/interview` (detection + answering).
- Configurable backend host/port and hotkeys through environment variables.

## 9. App lifecycle & platform

- **Media permissions** auto-granted to the renderer (OS still prompts on first use).
- **System-audio loopback** wired through Electron's display-media handler.
- **Graceful shutdown** — the renderer is told before quit so it can stop capture,
  close sockets, and release audio tracks.
- **Cross-platform** — macOS and Windows (a `run.bat` launches it hidden on
  Windows; on macOS use `npm start`).
- **Transcript file logging** helper (`conversation.txt`) via IPC.

---

## Running

```bash
npm start      # launches the Electron overlay (electron .)
npm test       # runs test/interview.test.js
```

> Note: OCR, answers, transcription, and interview answering require the separate
> Python backend running at `http://localhost:3000` (not included in this repo).
