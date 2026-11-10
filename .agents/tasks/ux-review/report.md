# UX / Design Review: Overlay App

Scope: read-only review of `index.html` (all markup, CSS, inline JS), `main.js`, `selection.html`, `ux-helpers.js`, `features.md`. No `.env` was read. No source file was edited.

**Not verified:** I did not launch Electron. Nothing below was observed on screen. Contrast, density and focus claims come from reading CSS and JS. Items that depend on OS behaviour (window focus, flicker) are marked "unverified at runtime".

---

## 1. Summary answer

The app already has a strong stealth foundation: in-window tooltips, selects, confirm dialogs, context menu and resize grip, plus a forced arrow cursor. The product is feature-rich, but the design has five main weaknesses:

1. **The primary screen is wrong for the main use case.** The app opens on the Answer tab (typed question plus screenshot), but the live interview flow is the high-stakes one. It sits behind a tab, and its controls are a 14-item wrapping toolbar mixing setup with run controls.
2. **Keyboard shortcuts inside the overlay probably do not work after a hotkey capture.** The window is shown with `showInactive()`, so OS focus stays in the meeting app. Cmd/Ctrl+Enter and Escape in the editor only work after a click, and that click steals focus. Unverified at runtime, but follows from the code.
3. **Feedback is weak and in the wrong place.** There are no toasts. Status goes to a 10px grey uppercase label on the Answer tab, which can be hidden while the user is elsewhere. Copy gives no confirmation.
4. **Hotkey hints are macOS-only and scattered.** The `⌘⇧` glyphs are hardcoded (`index.html:542,544,545,658,1757`), but the user has been running this on Windows. There is no hotkey cheat sheet, and ⌘⇧H (the only way to hide/show now that the dot is gone) is never mentioned in the UI.
5. **Density and accessibility are inconsistent.** Many controls are 10–11px with low-contrast greys (`#6a6f78`, `#7a7f88`). Gallery items and their hover actions are mouse-only. There are no responsive rules.

Recommended direction: keep the four tabs, but make Interview the first-class live screen. Add a persistent hotkey strip, an in-overlay toast/status line, and a proper first-run hint. Do this without adding new features, mostly by moving and re-styling what exists.

---

## 2. Screen / feature inventory (as it exists today)

Window: frameless, transparent, always-on-top, `resizable:false`, resized via the in-window grip. Default size is **1200×850** when no saved state exists (`main.js:88-89`). That is large, not "small". Size and position are saved to `overlay-window.json` (`main.js:35-55`). I could not see the user's actual saved size.

Card shell: `rgba(18,18,26,0.78)` with `blur(14px)`, 12px padding, 14px radius (`index.html:35-42`).

| Screen | Where | Controls | States present |
|---|---|---|---|
| Header | `:512-523` | status dot, "Assistant" title, 4 tab buttons. Settings gear is commented out (`:520`). | Dot: idle/thinking/ok/error (`:51-56`). Colour only. |
| Consent banner | `:525-536`, JS `:1405-1413` | "Got it" | One-time, stored in localStorage. |
| **Answer tab** | `:538-583` | Question textarea (collapsible via caret label), Capture screen, Capture region, Ask, Clear, Tone select, answer box, Regenerate, Copy answer, Pop out, History (collapsed) | Empty placeholder `:558`. Loading uses spinner plus Stop (`createLoader` `:1421-1447`). Cancelled, error (raw text, may include `backendUrl=` debug at `:1516`), success. Backend offline and no-API-key states at `:~3270-3285`. |
| **Interview tab** | `:586-651` | Start, Pause, Resume, Stop, Languages `<details>`, "Show everything in English letters" checkbox, Upload Resume, Paste text instead, resume label, ✕ clear, Clear all; status strip (state pill, level meter, source, locale, connection); transcript; error line; Q&A cards (Copy, Expand/Collapse, Retry) | Pill states STOPPED/PAUSED/LISTENING/QUESTION DETECTED/GENERATING/ANSWER READY (`:195-205`). Connection Connected/Reconnecting/Disconnected (`:3068-3074`). Per-card generating, error, "Superseded" (`:3111-3131`). Empty placeholders. |
| **Gallery tab** | `:653-660` | Refresh, Clear, grid of thumbs (hover Edit ✏️ and Delete ×), day headers | "Loading…", empty text (`:1757`), 3s poll of newest record (`ux-helpers.js:6`, `:1849`). Badge ✓/!/○. |
| **Audio tab** | `:662-702` | Start, Transcribe, two meters, device ⚙ (Me/Them selects, Rescan), Ask latest, Save 💾, Clear, live transcript, Suggestions with "Auto on pause" | Placeholders. Reconnecting text (`:2762`). Right-click menu (Ask / Ask with context / Copy). |
| **Edit / image modal** | `:719-791` | Close ✕; staged strip (count, Add another, per-thumb ✕); Draw, Crop, Apply Crop, Reset; canvas; radios (Coding/Scenario); "Get solution from image"; text editor (record mode); Get Answer; Answer; Pop out | `edit-status` line (11px, `#7a7f88`). Loading, cancelled, failure all go through `setStatus` at `:1967`. Batch cap 6. Escape closes (`:2019`). Ctrl/Cmd+Enter sends (`:2434`). |
| Compact solution panel | `:828-834` | "⤢ Full overlay", code blocks | Window shrinks to 460×380 top-right (`main.js:456-480`). |
| Dialogs / dropdowns / tooltip | `:~850-1215` | Custom confirm/notice, custom select, tooltip | Focus trap and Escape handled. |
| Region selector | `selection.html:47` | "Drag to select a region · Esc to cancel" | Separate transparent window. |

Dead UI is still in the file: commented `#settings-pop`, `#vision-popup` and OCR blocks, roughly 150+ lines in markup, CSS and JS (e.g. `:441-479`, `:777-826`, `:3352-3425`). They have no UX effect but add noise.

---

## 3. Layout and information architecture

### 3.1 Primary screen
Default tab is Answer (`:515`). The strongest product value, hands-free interview answering, is the second tab. Audio and Interview overlap: both capture system audio, transcribe and answer. Audio is the older "select text, right-click, Ask" path. The Interview tab's own footer even sends manual questions back to the Answer tab (`:647-649`).

**Recommendation:** make Interview the default tab and rename the tabs by job. Keep Audio, but move it behind the Interview setup (an "Advanced / manual" area) or last in the tab order. Do not delete it without asking the user, since that removes a feature.

### 3.2 Click counts for the top 5 flows (from the code)

| Flow | Today | Notes |
|---|---|---|
| Live interview answer | Tab Interview (1) → Start Listening (1) = **2 clicks** plus language and resume setup. Language: open `<details>` (1) + tick (1). Resume: Upload (1) + native picker. The Interview tab loads health only on first open (`:3248`). | Answers then appear automatically, which is good. But Start sits in a wrapping toolbar, one of ~14 items (`:586-598`). |
| Screenshot → answer | Hotkey ⌘⇧1 → editor opens (0 clicks) → click "Get solution from image" (1) = **1 click**, or Ctrl/Cmd+Enter if the window has OS focus | The "Get solution" button is below canvas and fieldset inside a scrolling body (`:754-768`), so on smaller windows it can be off-screen. |
| Ask typed question | Click textarea, type, Ctrl/Cmd+Enter or Ask = **1 click + keys** | Fine. Textarea is first. |
| Review past record | Gallery (1) → click item (1) = **2 clicks** (opens in the Answer tab, `openRecord` `:1869`) | Hover-only Edit and Delete. No search or filter. |
| Change language / tone / resume | Language: Interview tab, `<details>`, tick (**3**). Tone: it is on the **Answer** tab only (`:551`) but also drives Interview (`:3139`). That is a hidden coupling. Resume: Interview tab, Upload or Paste (**2+**). Roman-letters: checkbox in the same toolbar (changes apply only after Stop/Start, `:3190`). | Settings are scattered across three areas. There is no settings screen since the gear was disabled. |

### 3.3 What is buried or redundant
- **Tone** is on Answer but affects Interview; move it to a shared place (header or Interview strip).
- **Interview setup** (languages, English-letters, resume, paste, resume label, clear) is mixed with run controls (Start/Pause/Resume/Stop) in one wrapping row (`:586-598`). Setup is used once per session, run controls are used live.
- Pause and Resume are separate buttons with one always disabled. One toggle button would halve the visual weight.
- Start/Stop appear twice in the app (Interview and Audio) with different labels (▶ Start Listening vs ● Start).
- The 3-second Gallery poll and the Refresh button overlap; Refresh is rarely needed.
- A privacy tip about the file picker is a permanent line (`:600`). It should only show at the moment of clicking Upload.
- `features.md` still describes OCR as the Answer flow. It is stale.

---

## 4. Visual design

**Hierarchy.** The best part is the Answer hero: 15px/1.55 on a darker panel (`:79-87`). The weakest is the chrome around it: everything else is 10–12px.

**Typography.** The scale is 9, 10, 11, 12, 13, 14, 15px. Most buttons are 11px (`.act-btn` `:107`), Q&A badges are 9px, and `.cv-lang` is 9px. This is small for use under stress in a call. Suggest a floor of 12px for anything actionable, 11px for meta only.

**Contrast over arbitrary backgrounds.**
- Card opacity 0.78 plus blur is decent over bright backgrounds (white doc, light IDE). Text `#e8e8ea` on this is fine.
- Muted text `#6a6f78` (`.muted`, `:84`, placeholder `:100`) on roughly `rgba(0,0,0,0.28)` over the 0.78 card likely falls below 4.5:1 once the backdrop is bright. These are the empty-state and instruction texts, the things a first-time user must read. Unverified by measurement.
- `#7a7f88` is used for zone labels (10px uppercase, `:73`) and `edit-status`.
- Blue-on-dark pill text `#4c9aff` at 10px is borderline.
- No user control for opacity. A single opacity or "solid" toggle is high value for a transparent overlay.

**Spacing and consistency.**
- Buttons are consistent (`.act-btn`), but there are three more button-like patterns: `.nav-btn`, `.icon-btn`, `.g-act` spans.
- Heavy use of inline `style=""` (e.g. `:524-535`, `:631-635`, `:664-688`) makes spacing drift. This is a maintainability issue, not a visual one yet.
- Gallery thumbnails are 84px min width and 58px tall (`:152-157`). Image is small and text thumbs show only 4 lines at 10px.
- Emoji icons (🖥 ✂ 🧠 🗗 💡 💾 🎙) render differently per OS. On Windows they colour inconsistently against a dark UI.

**Dark/light.** Dark only. That suits an overlay, but there is no `prefers-color-scheme` handling and no need for one; just be explicit that this is a deliberate choice.

**Animation.** Pulse on the status dot (`:51`), spinner, `ivpulse` on the pill. Only `.loader-spinner` respects `prefers-reduced-motion` (`:263-265`). `pulse`, `ivpulse` and `ivspin` do not.

**Density at small size.** There is **no `@media` or container query** other than reduced-motion (grep). The card is a column of flex rows with `flex-wrap`, so narrow widths cause the Interview toolbar to wrap into 3–4 rows and push the Q&A panel down. In the Answer tab the question box, two button rows, tone, answer, and history compete for height. The compact panel (460×380) is the only small-size design, and it only shows the solution.

---

## 5. Interaction and feedback

**Loading and cancel.** Good: shared loader with Stop for Ask, Vision and Retry (`:1421-1447`). Missing: no Stop for Interview answer generation (only Pause/Stop of the whole session), and none for Gallery loading.

**Errors.**
- Raw technical strings are shown to the user: `Internal: askText bridge unavailable ... backendUrl=...` (`:1473-1475`) and `Ask request threw: ... (backendUrl=...)` (`:1516`). Useful for the developer, confusing mid-interview. Keep a short human line plus a detail that is only on demand.
- Capture errors force-switch to the Answer tab and replace the answer text (`showCaptureError` `:3441-3449`). That can overwrite an answer the user was reading.
- Hotkey registration failures are reported only through the same capture error path (`main.js:606-614`).

**Toasts / confirmation.** There are none. Copy (`:1663`, `:3017`, `:2636`, `:2710`) gives no feedback. "Click to copy" on suggestion rows (`:2709`) is a hidden affordance only visible after a 400ms hover tooltip. Status updates for staged screenshots go through `notifyMain` → `setStatus` on the Answer tab label (`:3463`), invisible if the user is on another tab, and invisible behind the modal because the modal covers the card (`#edit-modal` is `position:fixed; inset:0`, `:343-347`). So "2 screenshots staged - capture another" can be missed.

**Keyboard.**
- Good: custom select has full arrow/Home/End/type-ahead/Escape handling (`:1091-1121`). Dialog traps Tab and handles Escape (`:1197-1211`). Cmd/Ctrl+Enter submits in the question box and editor.
- Gaps: Gallery items are `div`s (`:1785`) and the Edit/Delete actions are `span`s (`:1786-1787`) with no `tabindex`, role or keyboard handler. Delete and Edit are unreachable without a mouse. Transcript "Ask" works only via right-click (`:2597`), with no keyboard equivalent. Nav tabs are buttons but have no `role="tablist"` / `aria-selected`.
- No tab-switching shortcut and no documented in-window shortcuts.

**Focus handling (stealth-critical).**
- Captured screenshots use `showInactive()` + `moveTop()` (`main.js:274-281`). Good: the meeting app keeps OS focus.
- The renderer then calls `btnVision.focus()` (`:2328`). That sets DOM focus only; the OS window is still inactive. So Ctrl/Cmd+Enter and Escape in the editor will not fire until the user clicks the overlay. Clicking steals OS focus, which some browser-based interview/proctoring pages can detect as blur. **Unverified at runtime.**
- Hotkey toggle uses `show()` (`main.js:545`) and Ask-now uses `show()` (`:551`), both of which activate the window and steal focus, unlike capture. That is inconsistent.
- Region selector calls `focus()` after `showInactive()` (`:229-230`) so Escape works. Reasonable and necessary, but it is a focus change the user should expect.
- Clicking any control in the overlay activates it. A `focusable:false` window (Windows) or a non-activating panel (macOS) would avoid focus theft, but that changes input behaviour (typing into the textarea would not work). That is a deliberate trade-off to discuss, not a quick fix.

**Hotkey discoverability.** Hints exist only in tooltips (400ms hover delay) and the Answer textarea placeholder, which disappears as soon as the user types. **Show/hide (⌘⇧H) is never mentioned in the UI**, and the dot was removed. If the overlay is hidden and the user forgets the key, there is no visible recovery path. Glyphs are macOS-only.

**First-run onboarding.** Only the consent banner (`:525`). No hint about hotkeys, no check of "backend running / mic or screen-recording permission / system audio device" before the first Start. The macOS Screen Recording hint exists only after an empty capture (`:3453`).

**Empty states.** Present everywhere, reasonably written. They are in italic `#6a6f78` (hard to read), and the Interview empty text is a 25-word sentence (`:631`).

---

## 6. Accessibility within the stealth constraints

**Must stay avoided:** native `title` tooltips (already converted via `convertTitle`), native `<select>` popups (already replaced), native `alert/confirm`, OS context menus, non-arrow cursors (forced at `:9-12`), `<input type=file>` picker (still used for resume at `:594`; the permanent tip at `:600` acknowledges the risk, and "Paste text instead" is the stealth-safe path), native date/colour pickers, `window.print`, drag-and-drop of files (navigation is locked in `main.js:57-62`).

**Current good practice:** `aria-label` on icon buttons, `role=dialog/alertdialog`, `aria-live` on loader text and stage count, `:focus-visible` outlines on custom select, dialog and staged-strip buttons, `aria-selected` on options, reduced-motion on the spinner.

**Gaps and fixes that keep stealth:**
- Gallery items/actions are not focusable (see §5). Make them `button` elements, show actions on `:focus-within` as well as `:hover` (`:225`).
- `.nav-btn`, `.act-btn`, `.icon-btn` have no explicit `:focus-visible` style, relying on the Chromium default ring, which is thin on dark glass. Add one shared outline rule.
- Textareas use `outline:none` and rely on a border colour change (`:98`, `:386`). That is a low-contrast indicator.
- The status dot and pill colours (green/blue/red) carry state, though the pill has text. Add a text or shape cue for the dot (the header dot has no label of its own).
- The tab bar should have `role="tablist"`/`tab`/`aria-selected`, and views `role="tabpanel"`.
- Native `<details>` language list and checkboxes are rendered in-page, so they stay in the protected surface, but they are not styled and small (`:219-236`).
- `aria-hidden` on the resize grip is right; a keyboard resize alternative (e.g. fixed size presets) does not exist.
- Reduced motion: extend the media query to cover `pulse`, `ivpulse`, `ivspin`.
- Contrast: raise the muted greys (see §4).
- Full WCAG validation needs manual testing with assistive technology and expert review; this is a code read only.

---

## 7. Stealth-aware UX pitfalls

| # | Pitfall | Evidence | Who notices |
|---|---|---|---|
| 1 | Clicking into the overlay steals OS focus from the meeting app. Browser interview tools can see window blur. | `show()` at `main.js:545,551`; no `focusable:false` | Viewer / proctor, indirectly |
| 2 | Hotkey capture uses `showInactive()` but later keyboard shortcuts need focus, so the user must click and breaks flow. | `main.js:279`, `index.html:2328,2434` | User |
| 3 | Show/hide by `hide()`/`show()` on a transparent always-on-top window. Possible flicker or focus flash. `hasShadow:false` helps. Unverified. | `main.js:93-96, 543-546` | User; viewer unlikely (content-protected) |
| 4 | Native file picker for resume is outside content protection. | `index.html:594`, tip `:600` | Viewer |
| 5 | Region selector transparent full-screen window: protected, but the mouse cursor itself is OS-drawn and forced to arrow. Good. | `selection.html:8-11` | Viewer |
| 6 | Audio: system audio is captured, and the app has no audible UI sounds. No beeps found. Good. Mic permission prompt on first use is an OS dialog (`main.js:~560`) and would appear on screen if shared. | `main.js` `configureMediaPermissions` | Viewer, once |
| 7 | The overlay window is pinned to all Spaces and over full-screen apps (`'screen-saver'` level). On macOS this can show on top of a full-screen share-selection UI for the user, harmless to viewers. | `main.js:108-110` | User |
| 8 | Hotkeys: Cmd/Ctrl+Shift+1/2/H/A may conflict with browser or meeting-app shortcuts, and `HOTKEY_TOGGLE_OVERLAY` / `HOTKEY_ASK_NOW` registrations are not checked (only capture hotkeys use `registerHotkey`, `main.js:539-540` vs `:542,549`). If they fail the user gets no message. | `main.js:538-553` | User |
| 9 | Raw error strings including `backendUrl` are shown inside the overlay only, so not a leak, but unhelpful mid-call. | `index.html:1516` | User |

---

## 8. Prioritised recommendations

Effort: S = under about 1 hour, M = a few hours, L = a day or more. Risk is regression risk to existing flows.

### Quick wins

| # | Element | Problem | Proposed change | Benefit | Effort | Risk |
|---|---|---|---|---|---|---|
| Q1 | Hotkey hints (`:542-545,658,1757`) | `⌘⇧` hardcoded; user is on Windows | Build the hint text from `navigator.platform` (⌘⇧ vs Ctrl+Shift+) in one small helper used by placeholders and `data-tip`s | Correct hints on both OSes | S | Low |
| Q2 | Hotkey cheat sheet | Show/hide, Ask-now not discoverable | One-line muted strip in the header or card footer: "Capture 1 · Region 2 · Hide/Show H · Ask A" | Recovery path after hiding; discoverability | S | Low |
| Q3 | Copy buttons (`:565,3017,2636,2710`) | No confirmation | Change label to "Copied ✓" for ~1.2s | Instant feedback | S | Low |
| Q4 | Status text (`edit-status` `:707`, answer-status label `:557`) | 10–11px `#7a7f88` | Raise to 12px, `#aeb4bf`; raise `.muted` to `#8d93a0` | Readability over bright backgrounds | S | Low |
| Q5 | Focus style | Default thin ring | One shared `:focus-visible` rule for `.nav-btn,.act-btn,.icon-btn,.g-act` | Keyboard users see focus | S | Low |
| Q6 | Gallery actions (`:225,1786`) | Mouse-only | Render as `<button>`; show on `:focus-within` | Keyboard access | S | Low |
| Q7 | Reduced motion (`:263`) | Only spinner covered | Add `pulse`, `ivpulse`, `ivspin` to the media query | Accessibility | S | Low |
| Q8 | Ask/vision errors (`:1473,1516`) | Debug text in user view | Short message ("Can't reach the backend. Is it running on :3000?"); keep detail in `console.error` (already logged) | Calm, actionable errors | S | Low |
| Q9 | Permanent file-picker tip (`:600`) | Always-on clutter | Show only after clicking Upload Resume, or fold into the button tooltip | Cleaner Interview tab | S | Low |
| Q10 | `hide()`/`show()` hotkey and Ask-now | `show()` steals focus | Use `showInactive()` for show-by-hotkey (`main.js:545,551`) | Consistent no-focus-steal | S | Low-Med (check it still raises above full-screen apps) |
| Q11 | Hotkey registration (`main.js:542,549`) | Failures silent | Route through `registerHotkey` so failures are reported | User knows a hotkey is dead | S | Low |

### Medium

| # | Element | Problem | Proposed change | Benefit | Effort | Risk |
|---|---|---|---|---|---|---|
| M1 | Default tab and Interview toolbar (`:515,586-598`) | Setup and run mixed; Interview is not the first screen | Default to Interview. Split into a run row (Start / Pause-Resume toggle / Stop) and a collapsible "Setup" row (Languages, English letters, Resume, Tone). Collapse Pause+Resume into one toggle | 1 click to start; less clutter | M | Med (touches `setControls` and ids used by `interview.js`) |
| M2 | Feedback line / toasts | Status hidden in a tab label | One small in-card status line under the header (not a new system), fed by `setStatus` and `notifyMain`. It must also render above the edit modal | Staged-screenshot and error messages are always seen | M | Low-Med |
| M3 | Edit modal layout (`:753-768`, `#edit-card`) | Primary action buried below canvas | Make the action bar sticky at the bottom of `#edit-card`: radios + "Get solution" + hint "Ctrl/Cmd+Enter". Put Draw/Crop in one compact row | Send always visible at any window size | M | Med |
| M4 | Keyboard shortcuts in overlay after a capture | Probably needs OS focus | Either document "click the editor first", or add a hotkey (e.g. ⌘⇧Enter) registered globally only while the editor is open, which sends the batch with no focus change. Needs the user's decision | One-key capture→answer without touching the mouse or stealing focus | M | Med (global shortcut lifecycle) |
| M5 | Opacity control | Fixed 0.78 | One slider or 3-step preset (Glass / Dim / Solid) stored in localStorage, applied via a CSS variable on `#overlay-card` | Readable over any background | M | Low |
| M6 | Responsive rules | No breakpoints | Add 2 container/media rules for widths under about 560px: stack toolbars, hide labels on icon buttons, 2-column gallery | Usable small window | M | Low |
| M7 | Tabs a11y (`:515-520`) | No roles | `role=tablist/tab/tabpanel`, `aria-selected`, Left/Right arrows | Keyboard/AT use | M | Low |
| M8 | First-run | Only consent | Fold hotkey cheat sheet and "backend OK / mic / screen-recording" checks into the existing consent banner (one message, one "Got it") | Fewer first-run failures | M | Low |
| M9 | Gallery (`:653-660`) | No search; small thumbs; polling plus Refresh | Larger thumbs (e.g. 120×80), status text, drop Refresh since polling exists | Faster review | M | Low |

### Larger redesign

| # | Element | Problem | Proposed change | Benefit | Effort | Risk |
|---|---|---|---|---|---|---|
| L1 | Information architecture | Four tabs with overlap (Interview vs Audio) | Merge Audio's unique pieces (manual "Ask latest", device pick) into Interview > Advanced; keep a single transcript + Q&A model. Needs user sign-off since it removes a tab | One mental model for "listen & answer" | L | High |
| L2 | Non-activating window | Focus theft on click | Investigate `focusable:false` / non-activating panel with an explicit "type mode" toggle | Meeting app never loses focus | L | High (input and IME impact) |
| L3 | Settings panel | Settings spread over 3 places | One small in-overlay Settings sheet (language, tone, English letters, opacity, resume) opened from a header gear (replaces the disabled gear at `:520`) | Single place for configuration | L | Med |

### Recommended target layout (default Interview screen, about 560×640)

```
┌──────────────────────────────────────────────────────┐
│ ● Assistant  [Interview][Answer][Gallery][Audio]  ⚙   │  ← header, state dot has a text cue
│ LISTENING ▮▮▯▯  Connected · EN                        │  ← status strip
├──────────────────────────────────────────────────────┤
│ [ ▶ Start ]  [ ⏸ Pause ]  [ ■ Stop ]    Setup ▾       │  ← run row; Setup collapses
│   (Setup: Languages · English letters · Tone · Resume)│
├──────────────────────────────────────────────────────┤
│ Interviewer: "...what is the difference between..."   │  ← 1–2 line live transcript
├──────────────────────────────────────────────────────┤
│ Q  Angular vs React?                          [EN]    │
│ ┌──────────────────────────────────────────────────┐ │
│ │ Answer text at 15px, newest first, auto-expanded │ │  ← hero: gets most of the height
│ │ ...                                              │ │
│ └──────────────────────────────────────────────────┘ │
│ [⧉ Copy] [Expand] [↻ Retry]                           │
├──────────────────────────────────────────────────────┤
│ Capture Ctrl+Shift+1 · Region 2 · Hide/Show H · Ask A │  ← hotkey strip, platform aware
└──────────────────────────────────────────────────────┘
 Edit modal: image on top; sticky bottom bar
 [Coding | Scenario]  [＋ Add]  [🧠 Get solution  Ctrl+Enter]
```

---

## 9. What NOT to add (avoid bloat)

- No new tab, theme system, light mode, or animation library. The dark glass look is right for an overlay.
- No toast framework. One status line (M2) reuses `setStatus`.
- No settings page with new options. Re-home existing controls only (L3 is optional).
- No onboarding wizard or tour. Extend the existing consent banner.
- No sounds or notifications (stealth risk; they could be heard in a call).
- No native dialogs, menus, tooltips, file pickers, or custom cursors.
- No new dependencies for UI (React, icon fonts, CSS frameworks). The project is plain HTML/JS.
- No more commented-out code blocks: delete the dead `[OCR-DISABLED]` / `[VISION-POPUP-DISABLED]` blocks in a separate cleanup if the user approves, rather than keeping them.
- No auto-hide, always-on-top toggles, or extra window modes beyond the existing compact panel.

---

## 10. Limits of this review

- Electron was not launched. No screenshots, no measured contrast ratios, no frame timings.
- Focus theft and flicker (§5, §7 items 1–3) are inferred from `main.js` window calls and Electron behaviour. They need a quick manual test on both macOS and Windows.
- I did not read `interview.js`, `audio.js` or the preload bridge line by line, only what the UI exposes. The backend was out of scope.
- Default window size is from code (1200×850); the user's saved `overlay-window.json` was not inspected.
