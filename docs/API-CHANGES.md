# API changes

Claude appends every new `window.forge` call or event here. Additive only.

## 2026-11-03 — plan events, friendly labels, per-file undo

- **Event `{ type: 'plan', items: { text: string; status: 'todo' | 'doing' | 'done' }[] }`** on `onAgentEvent`. The agent calls a new `update_plan` tool for work with 3+ steps; each call sends the whole checklist again (replace, do not merge). It is stored in the transcript, so a reopened chat replays it. `update_plan` never produces a `tool`/`tool_result` event.
- **`tool` event now has `label?: string`**: plain-language wording ("Reading a.txt", "Running the tests", "Installing packages"). Use it instead of the raw tool name. `name` and `args` are unchanged.
- **`forge.agentUndoFile(chatId, checkpointId, path): Promise<Change[]>`** puts back one file from a `changes` card and returns what is still changed (same shape as `changes.files`). `agentUndo` (all files) is unchanged. Both reject if the run is active.

## 2026-11-03 — live preview of web projects

- **`forge.previewStart(chatId): Promise<{ url: string }>`** starts (or reuses) a local static server for the chat's project and returns `http://127.0.0.1:<port>/`. Rejects with "Nothing to preview yet: this project has no index.html." when there is none; show that text. Only web file types are served; dotfiles, `.env`, other sources and anything outside the folder return 404.
- **`forge.previewStop(chatId)`** stops it. It also stops when the chat is deleted or the app quits.
- The served pages **reload themselves** whenever the agent finishes a successful file tool (edits are debounced to one reload), so the preview stays live while the agent works.
- **Renderer needs (Codex):** the CSP in `index.html` must allow `frame-src http://127.0.0.1:*`. Embed with `<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups">` (no `allow-same-origin` unless a real need appears). To open it in the user's browser use `forge.openExternal(url)`.

## 2026-11-03 — AI engine on another computer (e.g. the 3090 Ti desktop)

- **`forge.engineHostGet(): Promise<{ host: string; vramGB: number }>`** — `host` is `''` when Forge uses this computer. `vramGB` is what the user said the remote card has (default 24).
- **`forge.engineHostTest(host): Promise<{ ok; host; models }>`** — checks an address without saving it. `host` comes back cleaned (`192.168.1.20` becomes `http://192.168.1.20:11434`). Rejects with a user-fit message on a bad address.
- **`forge.engineHostSet(host, vramGB?): Promise<void>`** — saves it (`''` goes back to this computer). Fires `onEngineChanged` and `onModelsChanged`. Rejects on a bad address.
- **`engineStatus()` now also returns `remote: boolean`, `host: string`**, and a new `state: 'remote-down'` when a remote address is set but does not answer. In `remote-down` never offer "Install the engine"; offer "Check the address" / "Use this computer".
- While remote: install/start reject; the model library's fit ratings use `vramGB`; chats run on the remote engine; downloads and deletes happen on the remote machine.
- UI to build: Settings > Models > "Where models run": This computer / Another computer (address field, "Test connection", GPU memory field).

## 2026-11-03 — undo prompt

- No API change. Behaviour: a chat in an empty folder gets undo (git) set up silently. A folder with files asks once, in plain words ("Turn on undo for this folder?"), and a "no" is remembered per folder.

## 2026-11-03 — roadmap #1: steerable plan

- **`plan` event is now `{ type: 'plan', revision: number, items: { id: string; text: string; status: 'todo'|'doing'|'done'; skipped: boolean; userAdded?: boolean }[] }`.** Still the whole checklist each time (replace). `revision` goes up on every change by the agent or the user. Old transcripts replay without `id`/`revision`: treat missing `skipped` as false, and do not edit a plan you did not get an `id` for (the next `planUpdate` reply gives ids).
- **`forge.planUpdate(chatId, { revision, items }): Promise<{ revision, items, conflict }>`**. Send the full list the user wants, in order. Keep each step's `id`; omit `id` for a new step. `skipped: true` skips a step; leaving a step out removes it. `conflict: true` means your `revision` was stale: nothing changed, and `items` is the current plan to show. A successful edit also arrives as a `plan` event.
- The agent is told about every user edit before its next step ("skipped X (do not do it)", new order, added steps) and keeps user-added steps and skips when it rewrites its own plan. Edits made while the chat is idle are delivered with the next message.

## 2026-11-03 — roadmap #2: durable project brief

- **`forge.projectBriefGet(chatId): Promise<{ name, description, priorities: { id, text, included }[], revision }>`**. Per project folder (shared by every chat in it), stored in the app's data folder, not in the project. A fresh project returns the folder name, an empty description and `revision: 0`.
- **`forge.projectBriefSet(chatId, { revision, name?, description?, priorities? }): Promise<brief & { conflict: boolean }>`**. Pass the `revision` you last saw. A field you leave out keeps its value (`priorities` too: pass the full list to change it; keep each `id`, omit it for a new one). An empty `name` goes back to the folder name. `conflict: true` = stale revision, nothing saved, the returned fields are the current brief.
- **`forge.onProjectBriefChanged(cb({ project, brief }))`** fires after every successful save (so a second window or chat in the same folder updates). Match on the chat's project folder.
- Limits: name 60 chars, description 400, 20 priorities of 120 chars. Priorities are not sent to the model by Forge: the renderer still adds the included ones to the next message (as today).

## 2026-11-03 — roadmap #3: change descriptions, before/after, restored events

- **`changes.files[].previewable?: boolean`** (not deleted and an openable type: page, image, document). `beforeLabel/afterLabel` were not added: derive them from `status` as you do now.
- **New event `{ type: 'summaries', checkpoint, items: Record<path, string>, by: 'model' }`.** One plain sentence per changed file, written by the model after the run. It arrives AFTER `changes` (seconds later, sometimes never: only when the run changed 1-12 files and the model answers within 45 s), so show the card straight away and fill sentences in when this lands. Always label it as model-written. It is stored in the transcript.
- **`forge.changeDetail(chatId, checkpoint, path): Promise<{ before, after, existedBefore, existsNow, binary, truncated }>`** — file text as it was before the run and as it is now (each capped at 120k chars; `binary` files return empty strings). Rejects if the checkpoint is gone (after "Undo this run").
- **New event `{ type: 'restored', checkpoint, paths, remaining }`** after either Undo. `remaining` has the same shape as `changes.files` (empty after Undo-all). Stored in the transcript: when you replay history, apply `restored` to the earlier `changes` card for that checkpoint (drop the paths no longer in `remaining`).
- `agentUndoFile` now returns files with `previewable` too.

## 2026-11-03 — roadmap #4: runtime event

- **New event `{ type: 'runtime', location: 'local'|'remote'|'cloud', model, modelLoaded: boolean, gpuPercent?: number, queueSeconds?: number }`.** Sent when a run starts (`modelLoaded` is false if the model still has to be loaded into memory: show "Loading the model…") and again after the first reply (`modelLoaded: true`, `gpuPercent` 0-100 for Ollama models, `queueSeconds` = how long the user waited before the model began answering). Stored in the transcript; the latest one wins.
- `location` is `remote` when the engine address is another computer (see engineHostGet), `cloud` for Anthropic/OpenAI/OpenRouter.
- **No cost fields.** Forge has no verified prices for the cloud models, so nothing is invented. Show tokens, and cost only when a price source exists (a Settings field for the user's own price per million tokens is the likely next step; ask in UI-REQUESTS.md if you want it).
