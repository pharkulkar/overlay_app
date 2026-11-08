# Gallery silent refresh, shared loaders and Stop for cancellable requests (pass 2)

Pass 2 confirms the three pass-1 findings are resolved. The vision popup Send now uses the shared loader with a Stop button and a request id. Failed poll reloads are retried. The signature question was checked against the grid render.

Watch for: nothing blocking. Documented limits remain (upstream OpenAI call cannot be aborted; `solveRecord` cancel only stops waiting; cancel registry is in-memory).

**Verdict**: APPROVED

## High-level view
The vision popup Send (index.html ~2565-2600) mints a `vis` id, shows the loader with Stop, and passes the id to `visionAsk`. On a cancelled result it shows "Cancelled.", keeps the staged batch, leaves the popup open, and restores `sending` in `finally`. Because the preload wrapper resolves `{cancelled:true}` once aborted, a late response cannot touch the UI.

`pollGallery` no longer advances `lastNewestSig` itself. `loadGallery` sets it only after a successful render, so a swallowed failure is retried on the next tick. The in-flight flag is cleared in `finally`, and the timer is stopped when leaving Gallery.

The verification record shows pytest 145 passed, npm test 32 passed, and `node --check` clean. Electron was not run, so the live checklist is still the user's. The drag, `scheduleSaveWindowState` and `overlay-drag-*` hunks in main.js and preload.js are earlier uncommitted work, not part of this task, and showed no sign of being reverted by it.

<details>
<summary>Issues (0)</summary>

</details>
