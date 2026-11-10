# Implementation Plan: capture opens the edit screen directly

Scope: `index.html`, new `capture-flow.js`, `test/interview.test.js`, `package.json` only (optionally 1 line in `vision-batch.js` is NOT needed). No backend, no main.js/preload.js change (confirmed: main.js `deliverVisionCapture` sends `'vision-capture' {dataUrl, sourceType}`; preload exposes `onVisionCapture`). No commits, no branch switching, do not touch other uncommitted work. Do not read/modify any `.env`.

## Findings from reading the code
- `initVisionCapture` (index.html ~L3050-3199) is a separate IIFE from `initEditModal` (~L1919-2251). Cross-IIFE bridge is needed: `initEditModal` exposes `window.openFreshCapture(payload)`; `initVisionCapture` becomes a thin dispatcher.
- Shared helpers in the outer script scope (usable by both IIFEs): `createLoader`, `showLoader`, `genRequestId`, `isCancelledResult`, `stopRequest`, `expandOverlay`, `floatingDot`, `toneSelect`, `loadGallery({silent:true})`, `api`.
- Modal-local helpers inside `initEditModal`: `setStatus`, `showBusy`, `setBusy`, `closeModal`, `resetEditor`, `setMode`, `applyCrop`, `canvasToVisionDataUrl`, `restoreNodes`, `originalImage`, `ctx`, `btnVision`.
- `closeSolutionPanel` (= `restore` in compact IIFE ~L1545-1610): `open()` removes the `open` class from `#edit-modal` (state is NOT cleared, `reopenEditModal` remembers it); `restore()` re-adds `open`. This works for both modes as long as the fresh/record state lives in the `initEditModal` closure and is NOT cleared when the panel hides the modal. Do not change the compact IIFE.
- `setBusy` currently toggles `[btnGetAnswer, btnVision]`; extend it to also toggle the new add-shot button and strip remove buttons.
- The popup keydown Escape handler (capture phase) and the edit-modal Escape handler would both fire; the popup one gets disabled so only the modal one remains.
- Stealth audit (`test/stealth-audit.test.js`) statically scans index.html: no `title=`, no native select/confirm/alert/prompt, no `cursor:` rules other than global, no `-webkit-app-region` problems. New CSS must not add `cursor`. Commented-out blocks: verify the audit strips comments or at least still passes (it does today with `[OCR-DISABLED]` blocks, which include `cursor: pointer` inside a CSS comment on L361, so comments are tolerated; confirm by running the test).

## Design decisions
1. New helper `capture-flow.js` (UMD like vision-batch.js; in node `require('./vision-batch.js')`, in browser `window.VisionBatch`) holds ALL pure decisions; index.html only does DOM/IPC. Reason: testable under plain Node.
2. Closing while a fresh request is in flight is ignored (Close/Escape/backdrop show "Press Stop first" in status). Reason: avoids a response landing on a discarded session; matches the old popup (`cancel` was disabled while sending). Record mode keeps today's behavior (closable while busy).
3. A capture that arrives while fresh mode is busy is NOT dropped: one deferred slot `pendingCapture` (latest wins; status shows "Capture queued - will open when the request finishes"). Applied in the send `finally` through the same `onCapture` decision.
4. After a successful send the state gets `sent: true`. The next capture then REPLACES the current (already answered) image instead of staging it, and clears the answer. "Add another screenshot" is disabled while `sent` (tooltip via data-tip). Reason: do not stage/resend an image that was already answered.
5. Staged cap: staged.length + 1(current) <= MAX_BATCH, so staged max is 5. "Add another" allowed only when `staged.length + 2 <= MAX`.
6. Late responses are guarded with a session generation counter `gen` (incremented on every open/close); a response whose `gen` differs only runs `loadGallery({silent:true})`, never touches the UI.
7. sourceType of the current image = payload.sourceType (`screenshot-full`/`screenshot-region`), retained even after crop/draw. Record-mode send keeps its existing `['screenshot-region']`.

## State machine (lives in `initEditModal` closure; mirrors helper state)
State object (`flow`): `{ mode: 'closed'|'fresh'|'record', staged: [{id,dataUrl,sourceType}], current: null|{dataUrl,sourceType}, busy: boolean, sent: boolean }`.
- closed -> fresh: capture (`open-fresh`): staged kept as is (may be non-empty after "Add another"), current = new capture.
- fresh -> fresh: capture while idle (`stage-and-replace`): current edited canvas is downscaled (`canvasToVisionDataUrl`) and appended to staged; new capture loaded. If `sent` -> `replace-sent` (no staging, answer cleared).
- fresh + busy: capture -> `defer` (pendingCapture). Full batch -> `full` (message "Batch limit reached (6 images). Send or remove one."; capture rejected visibly, nothing else changes).
- record -> fresh: capture (`replace-record`): staged must be [] (record mode always resets it), record UI reset, fresh capture loaded.
- fresh -> closed: Close/Escape/backdrop (`discard`): staged=[], current=null, sent=false, pendingCapture=null, canvas/originalImage released.
- fresh -> closed (keep staged): "Add another screenshot" (`stageCurrent` then close without discard): staged retained, current=null.
- fresh send success: staged=[], sent=true, mode stays fresh (modal stays open). Failure/cancel: everything kept.
- record mode open (`openEditModal`) -> calls `resetFreshUi()` and sets `flow = {mode:'record', staged:[], current:null, busy:false, sent:false}`; closing sets closed.
- Compact panel hiding the modal never changes `flow`.

## Helper API: `capture-flow.js` (new, repo root)
Header comment in the style of vision-batch.js. Exports (all pure, immutable, no DOM):
- `STORAGE_KEY = 'visionMode'`
- `createState()` -> `{ mode:'closed', staged:[], current:null, busy:false, sent:false }`
- `onCapture(state, payload, max?)` -> `{ action, state, message }`. `payload = {dataUrl, sourceType}`. Invalid payload (no string dataUrl) -> `{action:'ignore', state, message:''}`. Actions:
  - `'open-fresh'` (mode closed): fits if `staged.length + 1 <= max`; new state `{mode:'fresh', current:{dataUrl, sourceType||'screenshot-full'}, staged same}`; else `'full'`.
  - `'stage-and-replace'` (fresh, !busy, !sent): needs `staged.length + 2 <= max`, else `'full'`. The staged entry is NOT created here (needs the edited canvas); result includes `needsStage: true` and the new `state.current` is the new payload; caller must first call `stageCurrent` with the canvas data URL. (Decide: implement as two-step in the helper: `onCapture` returns `{action, state, message, stageCurrent: true}` where `state` is unchanged and `pendingCurrent` = normalized new image; caller does `stageCurrent(state, editedDataUrl, sourceType, max)` and then `loadCurrent(state, pendingCurrent)`.) Keep this exact contract so both steps are testable.
  - `'replace-sent'` (fresh, sent): state.current = new, sent=false, no staging.
  - `'replace-record'` (record): state `{mode:'fresh', staged:[], current:new, busy:false, sent:false}`.
  - `'defer'` (fresh, busy): state unchanged.
  - `'full'`: state unchanged, `message = 'Batch limit reached (' + max + ' images). Send or remove one.'` (same text as the old popup).
- `canStage(state, max?)` -> boolean: mode fresh, !busy, !sent, current != null, `staged.length + 2 <= max`.
- `stageCurrent(state, editedDataUrl, sourceType, max?)` -> `{ state, added, capped }` using `VisionBatch.addImage` (keeps unique ids); does not change `current`.
- `loadCurrent(state, item)` -> state with `mode:'fresh'`, `current` normalized `{dataUrl, sourceType}`, `sent:false`.
- `removeStaged(state, id)` -> state (unknown id no-op).
- `closeKeepStaged(state)` -> `{mode:'closed', staged same, current:null, busy:false, sent:false}`.
- `discard(state)` -> `createState()`.
- `markSent(state)` -> `{...state, staged:[], sent:true, busy:false}`.
- `setBusy(state, on)` -> state.
- `imagesToSend(state, currentDataUrl, max?)` -> `{ ok, images, source_types, count, error }`: `[...staged.dataUrl, currentDataUrl]`, `source_types` parallel (current uses `state.current.sourceType`); `ok:false` with error when `currentDataUrl` is empty or total > max (never truncates silently).
- `normalizeLastMode(v)` -> `'scenario'|'coding'` (delegates to `VisionBatch.normalizeMode`; garbage/null -> coding).
- `sendLabel(count)` -> `count <= 1 ? 'Get solution from image' : 'Get solution (' + count + ' images)'` (plain text; the emoji prefix is added in index.html if wanted, keep the existing "🧠 " prefix by concatenation).
- `countLabel(state)` -> e.g. `'2 staged + current (3 of 6)'` via `VisionBatch.batchLabel`.
- Export with `module.exports = api` else `window.CaptureFlow = api`.

## index.html changes (apply in this order)

### A. Markup (edit modal) - add, do not remove OCR comments
Inside `#edit-image-tools`, ABOVE the actions row (`edit-mode-draw`...), add:
```
<div id="edit-stage" class="hidden" role="group" aria-label="Staged screenshots">
  <div class="actions">
    <span id="edit-stage-count" class="zone-label" role="status" aria-live="polite"></span>
    <span class="spacer"></span>
    <button class="act-btn" id="edit-add-shot" type="button" data-tip="Keep this screenshot, then capture another to send together">＋ Add another screenshot</button>
  </div>
  <div id="edit-stage-strip" class="fs-strip" aria-label="Staged screenshots"></div>
</div>
```
New ids to add: `edit-stage`, `edit-stage-count`, `edit-add-shot`, `edit-stage-strip`. Add `id="edit-vision-hint"` to the existing muted "The image leaves your machine..." div only if needed (not required). Keep existing ids `edit-vm-coding`, `edit-vm-scenario`, `edit-vision-send`, `edit-answer`, `edit-popout`, `edit-title`, `edit-status`.
Add `<script src="capture-flow.js"></script>` right after `<script src="vision-batch.js"></script>` (L822).

### B. CSS (add near the edit modal CSS, ~L330; no `cursor:` rules)
`.fs-strip { display:flex; gap:6px; overflow-x:auto; padding:6px 2px 8px; }`, `.fs-thumb { position:relative; flex:0 0 auto; width:84px; height:56px; }`, `.fs-thumb img { width:100%; height:100%; object-fit:cover; border-radius:6px; border:1px solid rgba(255,255,255,0.2); display:block; -webkit-user-drag:none; user-select:none; }`, `.fs-rm { position:absolute; top:-5px; right:-5px; width:18px; height:18px; padding:0; border-radius:50%; border:0; background:rgba(163,21,21,0.95); color:#fff; font-size:10px; line-height:18px; -webkit-app-region:no-drag; }`, `.fs-rm:disabled { opacity:.45 }`, `#edit-add-shot:disabled, #edit-vision-send:disabled { opacity:.45 }`, focus-visible outline `2px solid rgba(76,154,255,0.9)` for `#edit-stage button`. Check `.hidden` utility exists (it is used on `edit-image-tools`).

### C. `initEditModal` changes
Add DOM refs: `stageBox`, `stageCount`, `stageStrip`, `btnAddShot`; the vision radios `document.querySelectorAll('input[name="edit-vision-mode"]')`; `const CF = window.CaptureFlow`. Note `btnVision` is declared later with `const` (after the click handlers section) - the new fresh functions must be defined AFTER that declaration or use hoisted function declarations only called post-init.
New state vars: `let flow = CF.createState(); let gen = 0; let pendingCapture = null; let freshBusy = false` (flow.busy is the source of truth; `setBusy` also sets `flow = CF.setBusy(flow,on)`).
New functions:
- `readLastMode()` / `saveLastMode(m)`: `localStorage` `visionMode` in try/catch; `CF.normalizeLastMode`. Radios `change` listener saves (only when `flow.mode==='fresh'`... save always; harmless for record mode too, but only PRESELECT in fresh mode; record mode keeps default checked coding as today - reset to coding in `openEditModal` to keep "exactly as today").
- `selectedMode()` -> checked radio value normalized.
- `renderStage()`: empties `stageStrip` via `textContent=''`, rebuilds thumbs: `div.fs-thumb` > `img` (`src=item.dataUrl`, `alt='Staged screenshot N'`, `draggable=false`) + `button.fs-rm` (`type=button`, `textContent='✕'`, `aria-label='Remove staged screenshot N'`, `disabled = flow.busy`, click -> `flow=CF.removeStaged(flow,item.id); renderStage(); updateSendUi();`). `stageBox` hidden when `flow.mode!=='fresh'` or (staged empty and ... ) -> show whenever mode is fresh (the Add button lives there); count label via `CF.countLabel(flow)`.
- `updateSendUi()`: sets `btnVision.textContent = '🧠 ' + CF.sendLabel(stagedCount+1)` in fresh mode (restore the original text `'🧠 Get solution from image'` in record mode), `btnAddShot.disabled = !CF.canStage(flow) `, data-tip on add button when full: `'Batch limit reached (6 images)'`, when sent: `'Capture a new screenshot first'`.
- `openFresh(newState, item)`: `gen++`; hide text widgets (`textLabel/textArea/btnGetAnswer` display none), show `imageTools`, title `'New screenshot'`, `answerEl` placeholder (`<span class="muted">` created via DOM, text "The answer will appear here after you press Get solution from image."), preselect last mode radio, `modal.classList.add('open')`, load image: `ctx = canvas.getContext('2d'); originalImage = new Image(); onload -> resetEditor(); setStatus('Draw or crop, then press Get solution from image. (Ctrl/Cmd+Enter)'); onerror -> setStatus('Could not load the captured screenshot.')`; `originalImage.src = item.dataUrl` (NO crossOrigin needed for data URLs). Then `renderStage(); updateSendUi(); btnVision.focus()` (if focus fails use `card.setAttribute('tabindex','-1'); card.focus()`). `setBusy(false)`.
- `window.openFreshCapture = function (payload)`: runs the decision: `const r = CF.onCapture(flow, payload)`; switch on `r.action`:
  - `ignore` -> return. `full` -> `setStatus(r.message)` if modal open else `setStatus` of main (`window` outer `setStatus(r.message,'error')` is not accessible in this IIFE if shadowed - the outer one is shadowed by the local `setStatus`; so for closed+full show it on the main status via a small exported callback or by briefly opening nothing: in closed mode `full` can only occur when staged is already 6, which `canStage` prevents, so just `setStatus` locally and, if closed, re-open the editor is NOT done. Edge case acceptable; also log nothing).
  - `defer` -> `pendingCapture = payload; setStatus('Capture queued - it opens when the current request finishes.')`.
  - `open-fresh` / `replace-sent` / `replace-record` -> `flow = r.state; openFresh(...)`.
  - `stage-and-replace` -> `const dataUrl = canvasToVisionDataUrl(); const s = CF.stageCurrent(flow, dataUrl, flow.current.sourceType); if (!s.added) { setStatus(cap message); return; } flow = CF.loadCurrent(s.state, r.pendingCurrent); openFresh(...)` (modal already open: skip re-showing, just reload image, reset answer, re-render strip).
- `stageAndClose()` (btnAddShot click): guard `flow.busy || !CF.canStage(flow)`; `s = CF.stageCurrent(flow, canvasToVisionDataUrl(), flow.current.sourceType)`; if added -> `flow = CF.closeKeepStaged(s.state)`; `closeVisual()` (same visual cleanup as `closeModal` but DOES NOT reset flow); then outer-status message is not accessible; the local `setStatus` is hidden once closed, so set the main-window status through a new tiny export from the outer scope: before the IIFE use `window.__setMainStatus`? AVOID new globals: instead call the outer `setStatus` by capturing it BEFORE shadowing: add `const mainSetStatus = (typeof setStatus === 'function') ? setStatus : null;` is impossible because inner `const setStatus` hoists (TDZ). Implementer solution: the outer function lives in the module scope as `function setStatus(msg, kind)` (L~1400 area; verify with grep); in `initEditModal` rename nothing; instead have `initVisionCapture` (outer-scope IIFE that can see the outer `setStatus`) pass a callback: `window.openFreshCapture(payload, { notify: (m)=>setStatus(m,'idle') })` and `window.setFreshNotifier`. Chosen: `window.openFreshCapture(payload, notify)` where `notify` is the 2nd argument, stored in module var `notifyMain` in the edit IIFE, used for "N staged - capture another" and the closed+full message.
- `sendFresh()`: 
  1. `if (flow.busy || flow.mode!=='fresh') return; if (!api.visionAsk) {setStatus('Vision bridge unavailable.'); return;} if (!canvas.width) {setStatus('No image to send.'); return;}`
  2. `const cur = canvasToVisionDataUrl(); const pack = CF.imagesToSend(flow, cur); if (!pack.ok) { setStatus(pack.error); return; }`
  3. `const mode = selectedMode(); saveLastMode(mode); const rid = genRequestId('vis'); const myGen = gen; const prev = Array.from(answerEl.childNodes);` `showLoader(answerEl, 'Analyzing ' + VisionBatch.batchLabel(pack.count) + '…', () => stopRequest(rid)); setStatus('Sending ' + batchLabel + ' to OpenAI…'); flow = CF.setBusy(flow,true); setBusy(true); renderStage();`
  4. `try { data = await api.visionAsk(pack.images, mode, toneSelect.value, undefined, pack.source_types, rid);`
     - if `myGen !== gen` (discarded/replaced): `if (data && data.success) loadGallery({silent:true}); return;`
     - cancelled -> `restoreNodes(answerEl, prev); setStatus('Cancelled.')` (staged/edits/current untouched)
     - `data.success` -> `answerEl.textContent = data.answer || 'No answer returned.'; flow = CF.markSent(flow); setStatus('Solution ready - saved as ONE new Gallery entry.'); loadGallery({silent:true});`
     - `data.answer` with error -> show answer, `setStatus('Solution ready, but it could not be saved: ' + data.error)`; treat as sent (`markSent`).
     - else -> `restoreNodes(answerEl, prev)` (keep placeholder) and `setStatus('Vision request failed: ' + real error)`; keep everything.
     - catch -> same failure branch with `err.message`.
     - finally: `flow = CF.setBusy(flow,false); setBusy(false); renderStage(); updateSendUi();` then if `pendingCapture` -> `const p = pendingCapture; pendingCapture = null; window.openFreshCapture(p)`.
- In the existing `btnVision` click handler: first line `if (flow.mode === 'fresh') { sendFresh(); return; }` - rest of the record path unchanged.
- `closeModal()` rewrite: `if (flow.mode==='fresh' && flow.busy) { setStatus('Press Stop first, then close.'); return; }` then existing visual cleanup (`modal.classList.remove('open')`, null originalImage/savedCanvasState, clearRect), plus `gen++; flow = CF.discard(flow); pendingCapture = null; resetFreshUi();`. `resetFreshUi()`: hide `stageBox`, `stageStrip.textContent=''`, restore `btnVision.textContent='🧠 Get solution from image'`, `btnAddShot.disabled=false`, reset title is handled by openers. Escape/backdrop/close button all call `closeModal` already (no change).
- `openEditModal` (record mode): at the top (before any await) `gen++; flow = {...CF.createState(), mode:'record'}; pendingCapture=null; resetFreshUi(); reset radios to coding (checked) to match today's default;` also make sure `answerEl`, text widgets reset exactly as today (already done). `stageBox` stays hidden in record mode.
- Ctrl/Cmd+Enter: add a capture-phase `keydown` listener on `modal`: `if ((e.metaKey||e.ctrlKey) && e.key==='Enter' && flow.mode==='fresh' && !flow.busy && modal.classList.contains('open')) { e.preventDefault(); sendFresh(); }`.
- `btnAddShot` click -> `stageAndClose()`; show tooltip via `data-tip` only (no `title`).
- Reset Image: unchanged code (`resetEditor()` uses `originalImage`, which in fresh mode is the capture) - no change needed.
- `setBusy(on)`: extend list with `btnAddShot` and call `renderStage()` (remove buttons) when fresh; keep list compatible with the OCR-disabled comment line.

### D. `initVisionCapture` rewrite (keep the OCR-DISABLED comments as they are)
- Keep: `const VB`, `$`, `vmRadios`? -> `vmRadios` references `input[name="vision-mode"]` which will no longer exist: retire it (tag).
- New active body:
```
api.onVisionCapture && api.onVisionCapture((payload) => {
  if (!payload || typeof payload.dataUrl !== 'string') return;
  if (window.closeSolutionPanel) window.closeSolutionPanel();        // same as before
  if (!floatingDot.classList.contains('hidden')) expandOverlay();    // same as before
  if (window.openFreshCapture) window.openFreshCapture(payload, (m) => setStatus(m, 'idle'));
});
```
  (verify the outer `setStatus(msg, kind)` signature at ~L1400 before use.) The order closeSolutionPanel -> expandOverlay -> openFreshCapture is required so `restore()` re-adds `open` to the modal before the decision logic runs.
- Tag with `// [VISION-POPUP-DISABLED]` (every line of the block): the const declarations `popup, strip, countEl, msgEl, addBtn, sendBtn, cancelBtn`, `vmRadios`, `let batch`, `let sending`, `isOpen`, `selectedMode`, `openPopup`, `closePopup`, `renderPopup`, the old `onVisionCapture` body, `addBtn` click handler, `cancelBatch` + `cancelBtn` listener + popup Escape keydown listener, `sendBtn` click handler. Leave the `VB` check (`if (!VB) ...`) active.
- Also update the comment above the on-screen capture buttons (~L1628-1629, "both open the vision send popup") to say "open the edit screen directly" (comment-only edit).

### E. Retire the old popup (tag `[VISION-POPUP-DISABLED]` on each)
- CSS (L363-395): wrap `#vision-popup fieldset`, `#vision-popup legend`, `#vision-popup fieldset label`, `#vision-popup`, `#vision-popup.hidden`, `#vp-card`, `#vp-title`, `.vp-strip`, `.vp-thumb`, `.vp-thumb img`, `.vp-rm`, `.vp-actions`, `.vp-actions .act-btn:disabled`, `.vp-error`, and the two `#vision-popup ... :focus-visible` rules in ONE new `/* [VISION-POPUP-DISABLED] ... */` block placed after the closing `*/` at L362 (do not nest inside the existing OCR comment; the existing `[OCR-DISABLED]` comment at ~L353-362 ends at L362). Keep the `/* ── Vision send popup ──*/` header line as is or fold it (a `*/` inside a block comment would end it early: do not copy nested `/* */`; the one-line `/* [OCR-DISABLED] was: ... */` at L394 must be left OUTSIDE or rewritten as `//`-free text without `*/`).
- Markup (L785-803): wrap the whole `<div id="vision-popup"> ... </div>` in `<!-- [VISION-POPUP-DISABLED] ... -->` (contains no nested HTML comments, no `--`). Ids retired: `vision-popup, vp-card, vp-title, vp-count, vp-strip, vm-coding, vm-scenario, vp-note, vp-msg, vp-add, vp-send, vp-cancel` and input name `vision-mode`. After the change: `grep -n "vision-popup\|'vp-\|vm-coding\|vm-scenario\|name=\"vision-mode\"" index.html` must show only lines inside tagged comments.
- JS (see D).
- Also update `features.md` only if it documents the popup (optional; skip if it does not mention it).

## package.json
`"test": "node test/interview.test.js && node test/stealth-audit.test.js"` is sufficient if the new tests are appended to `test/interview.test.js` (it already `require`s helpers). Add `const CaptureFlow = require('../capture-flow.js');` next to the VisionBatch require (L14). No script change. (Do not create a new test file.)

## Tests to append to test/interview.test.js (before the final summary block)
Use `mkItem` (defined at the vision section) for items; payload helper `cap(n,t)` -> `{dataUrl:'data:image/png;base64,'+n, sourceType:t}`.
1. `createState` defaults (closed, empty staged, current null, busy/sent false).
2. `onCapture` closed -> `open-fresh`, current set, default sourceType `screenshot-full` when missing, staged preserved.
3. `onCapture` closed with 5 staged -> `open-fresh`; with 6 staged -> `full` + exact message `'Batch limit reached (6 images). Send or remove one.'`, state unchanged.
4. `onCapture` fresh idle -> `stage-and-replace` carrying the new item (state unchanged until `stageCurrent`); then `stageCurrent` + `loadCurrent` produce staged order [old..., edited] and current = new.
5. `onCapture` fresh idle with 4 staged (+current = 5, +new = 6 ok -> staged 5) allowed; with 5 staged -> `full` (nothing dropped, state unchanged).
6. `onCapture` fresh busy -> `defer`; state unchanged.
7. `onCapture` fresh sent -> `replace-sent`: staged unchanged, `sent=false`, new current, no staging.
8. `onCapture` record -> `replace-record`: staged [] , mode fresh, current = new.
9. `onCapture` invalid payloads (null, {}, dataUrl '') -> `ignore`.
10. `canStage`: false when closed/record/busy/sent/no current/full; true otherwise; custom `max`.
11. `stageCurrent` immutability (input state not mutated), unique ids, `capped` when full, keeps `current`.
12. `removeStaged` by id, unknown id no-op.
13. `closeKeepStaged` keeps staged, drops current, mode closed; `discard` clears everything (staged, current, sent).
14. `imagesToSend`: order = staged then current; `source_types` parallel (staged types then current type); `count`; empty current -> `ok:false`; staged 6 + current -> `ok:false` and no truncation; 0 staged -> single image.
15. `markSent` clears staged, sets sent, keeps current and mode `fresh`.
16. `normalizeLastMode`: 'scenario' -> 'scenario'; 'coding','',null,undefined,'x',5 -> 'coding'.
17. `sendLabel(1)` = 'Get solution from image'; `sendLabel(3)` = 'Get solution (3 images)'; `countLabel` text.
18. index.html static checks (read file with `fs`, same style as the existing "index.html has one #iv-roman" test): loads `capture-flow.js` via `<script src>` exactly once after vision-batch.js; contains ids `edit-stage`, `edit-stage-strip`, `edit-stage-count`, `edit-add-shot` once each; no `title=` on the new tag; every line mentioning `id="vision-popup"` is inside a `[VISION-POPUP-DISABLED]` comment: strip HTML comments + JS `//` comment lines and assert `vision-popup`, `vp-send`, `vm-coding`, `getElementById('vp-` do not remain in the active text; `[VISION-POPUP-DISABLED]` tag count >= 3 (markup, css, js).

## Order of work and verification (each step leaves the app buildable)
- [ ] 1. Create `capture-flow.js` (API above). Verify: `node -e "const c=require('./capture-flow.js'); console.log(Object.keys(c))"` in the repo root lists the API, no exception.
- [ ] 2. Add helper tests (cases 1-17) to `test/interview.test.js` + the `require` line. Verify: `node test/interview.test.js` -> all pass, 0 failed.
- [ ] 3. index.html markup + CSS + script tag (A, B). Verify: `npm test` (stealth audit incl. "every inline <script> compiles" still passes; no `title=`, no cursor rules).
- [ ] 4. `initEditModal` wiring (C) + `initVisionCapture` rewrite (D) + popup retirement (E). Verify: `npm test`; then add static test 18 and rerun `node test/interview.test.js`; also `node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];m.forEach(x=>new (require('vm').Script)(x[1]));console.log('inline scripts compile')"`.
- [ ] 5. Manual smoke check list (cannot be automated here; report as unverified if Electron cannot be launched): hotkey capture -> editor opens with image fit to frame; Reset Image restores capture; two quick captures -> first is staged, strip shows 1 thumb, button reads "Get solution (2 images)"; "Add another screenshot" closes editor and keeps staging; next capture reopens with strip; Close/Escape/backdrop clears staged; Stop keeps edits + staged and shows "Cancelled."; success shows answer + Pop out solution + closing panel restores editor; Gallery Edit of image/manual/audio records unchanged (no strip, original button text, OCR-disabled layout); Ctrl/Cmd+Enter sends; last-chosen mode is preselected next time.
- [ ] 6. Final: `npm test` all green; `git status --short` shows only `index.html`, `capture-flow.js`, `test/interview.test.js` (plus pre-existing uncommitted files) as touched by this task; confirm `screen_shot/`, `main.js`, `preload.js`, `.env` untouched.

## Risks / notes for the implementer
- `btnVision` is declared with `const` mid-IIFE; put new code that references it after that declaration (or inside functions only invoked later) to avoid TDZ errors.
- The local `setStatus` in `initEditModal` shadows the outer one; use the `notify` callback passed from `initVisionCapture` for messages that must be visible when the modal is closed.
- Do not call `api.visionAsk` or any record endpoint on capture; only on "Get solution".
- Downscale staged images via `canvasToVisionDataUrl()` once (at staging) and again only for the current image at send time.
- All dynamic text via `textContent`; thumbnails via `document.createElement('img')` with `img.src = dataUrl` and `img.draggable = false`.
