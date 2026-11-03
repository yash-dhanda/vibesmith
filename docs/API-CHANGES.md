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

## 2026-11-03 — roadmap #5: edit and retry

- **`forge.chatsRewind(chatId, userIndex, restoreFiles): Promise<{ text, files, transcript }>`** takes the chat back to just before the user's Nth message (0-based, counting only the user's own messages, the `type: 'user'` items in the transcript). Both what the screen replays and what the model remembers are cut. Returns that message's original `text`, the files put back (when `restoreFiles` is true and the run(s) from that message on changed files and had undo), and the new `transcript` to re-render (same shape as `chatsOpen().transcript`). Rejects while the chat is running.
- **Edit and resend** = `chatsRewind(id, n, restore)` then `agentSend({ chatId, text: editedText, ... })`. **Try again** = rewind to the last user message with its own `text` returned, then `agentSend` with it. There is no separate retry call: you already hold model/mode/limits.
- `restoreFiles: true` is "undo the files too" (ask the user: "Also undo the file changes from that attempt?"). With false, the files keep whatever the earlier attempt wrote, and the model is told to re-read before editing.
- The plan resets to whatever plan was in the kept part of the chat.

## 2026-11-03 — roadmap #6: attachments

- **`forge.attachmentsAdd(chatId, files: { name: string; data: Uint8Array }[]): Promise<{ id, name, kind: 'image'|'text', size }[]>`**. Read each dropped/pasted `File` with `new Uint8Array(await file.arrayBuffer())`. Pictures: png, jpg, jpeg, gif, webp up to 15 MB. Text: any text or code file up to 1 MB (detected by content, not extension). Up to 8 per call. A refused file rejects the whole call with a message fit to show ("tool.exe is not a picture or a text file…"); nothing is stored then. For a pasted screenshot, name it `screenshot.png`. Files are kept in the app's data folder per chat, never in the user's project.
- **`forge.attachmentsPreview(chatId, id): Promise<string | null>`** returns a `data:` URL for an image (for thumbnails; CSP already allows `img-src data:`), null for text files.
- **`agentSend({ ..., attachments?: string[] })`** takes the attachment ids to put on this message. Text files are pasted into the message for the model; pictures are sent as pictures. `agentSend` rejects with "This model can't look at pictures…" when a picture is attached and the model is a local one without vision (cloud models are assumed to see). Show that message and offer the model picker.
- **Transcript `user` items now may carry `attachments?: { id, name, kind, size }[]`** (use `attachmentsPreview` for thumbnails). Reopened chats replay them. Deleting the chat deletes its attachments.
- Only the newest message with pictures re-sends them on later model calls (older ones keep their text), to keep long chats fast.

## 2026-11-03 — roadmap #7: project rules (folded into the brief)

- **No new calls.** The brief from roadmap #2 gains **`rules: string`** (standing instructions in the user's own words, up to 3000 chars, line breaks kept). Read it with `projectBriefGet`, save it with `projectBriefSet({ revision, rules })`; leaving `rules` out keeps it. Forge adds the project's description and rules to the agent's prompt on every message, so a change applies from the next message.
- UI idea: a plain "How should Forge work on this project?" box in the brief with a few tap-to-add suggestions ("Keep it simple", "Use plain HTML, CSS and JavaScript", "Explain changes in plain language"). Rules sit in the app's data folder, not in the project, so a cloned repo cannot slip instructions in.

## 2026-11-03 — roadmap #9: pinned chats, content search

- **`forge.chatsPin(chatId, pinned: boolean): Promise<void>`**. Pinned chats keep their place in time (pinning is not activity). Fires `onChatsChanged`.
- **`ChatListItem` (from `chatsList`, `appInit`) now has `pinned?: true`.** Grouping by project is a screen concern: every item already has `project` (the folder path, or null). Suggested sections: Pinned, then by project, newest first.
- **`forge.chatsSearch(query): Promise<(ChatListItem & { snippets: { where: 'title'|'user'|'assistant'; text: string }[] })[]>`** — full-text over title, the user's messages and the assistant's replies. Every word of the query must appear (words under 2 letters are ignored); case-insensitive; newest first, up to 30 chats, up to 3 snippets each (about 120 chars around the match, with … where cut). Under 2 usable letters returns `[]`. It reads every chat file, so debounce typing by about 200 ms.
- Fixed: deleting a running chat no longer wipes its attachments before refusing.

## 2026-11-03 — roadmap #10: Run it

- **`forge.runDetect(chatId): Promise<{ kind: 'static'|'server'|'none', command: string|null, label: string }>`** says what Run would do, in words to put on the button: `server` (`npm run dev` / `npm start`, installing packages first when `node_modules` is missing; `python3 app.py`; `node server.js`), `static` (a plain `index.html`: use `previewStart` and the preview, no process), or `none` ("Nothing to run yet"). Show `command` somewhere the user can see it: it comes from the project.
- **`forge.runStart(chatId): Promise<RunState>`** starts it as a managed process in the project folder. Rejects with a message for `static` and `none`. One process per chat; the same command blocklist as the agent applies (no sudo etc.). `BROWSER=none` is set so dev servers do not open their own window.
- **`forge.runStop(chatId)`** stops the whole process group. It also stops when the chat is deleted or the app quits.
- **`forge.runStatus(chatId): Promise<RunState & { logs: string }>`** for when the screen opens (last ~40k chars of log). `RunState = { state: 'stopped'|'starting'|'running'|'exited', command, port, url, exitCode }`.
- **Events:** `forge.onRunLog(cb({ chatId, text }))` for each chunk of output; `forge.onRunState(cb({ chatId, ...RunState }))` on every change. `state: 'running'` with a `url` means a web server is up (port read from its output): show "Open at localhost:5173" and use `openExternal(url)`. `running` without a `url` is a script or bot. `exited` has `exitCode`.

## 2026-11-03 — roadmap #8: isolated in-app preview

A sandboxed native view (Electron `WebContentsView`) laid over the window: no Forge preload, its own throwaway session, permissions denied, downloads blocked, links to other sites open in the user's browser, only `localhost`/`127.0.0.1` pages load. Verified live: it loads the project's page and a `Run it` server, and shows up as its own page target.

- **`forge.previewAttach(chatId, { bounds, source? }): Promise<{ url }>`**. `bounds` = the pane's rectangle in **window coordinates, CSS pixels** (`el.getBoundingClientRect()`; the native view cannot live inside the DOM). `source: 'page'` (default) shows the project's `index.html` through the live-reloading preview server (rejects "Nothing to preview yet: this project has no index.html."); `source: 'run'` shows the web server started by `runStart` (rejects "Nothing is running yet. Press Run first." until it has a `url`). Calling it again for the same chat and address just moves the view.
- **`forge.previewBounds(chatId, bounds)`**: call on pane resize, sidebar toggle, window resize (use a `ResizeObserver` plus `window.resize`). For device sizes, send smaller bounds (centered) yourself.
- **`forge.previewVisible(chatId, visible)`**: **the native view draws above all page content**, so hide it (`false`) while a dialog, menu, toast stack over it, the command palette or Settings is open, and show it again after. Forgetting this makes menus appear behind the preview.
- **`forge.previewReload(chatId)`**, **`forge.previewDetach(chatId)`** (when the pane closes or the chat switches: detach, or the view stays on screen over the new chat). It is detached when a chat is deleted and at quit.
- **`forge.onPreviewStatus(cb({ chatId, state: 'loading'|'ready'|'error'|'closed', url, title, error? }))`** for the pane's header and loading state.
- Pages from `source:'page'` reload themselves when the agent edits files (debounced); `source:'run'` servers use their own hot reload.

## 2026-11-03 — cloud cost estimates

- `usage` events gain `costUsd?: number`: the estimated dollar cost of that one model call. Absent for local models and for cloud models without a known price. Sum it across a run for a total.
- `runtime` events for cloud models gain `price?: { input, output, currency: 'USD', asOf }` (dollars per million tokens, as of a date). Show it as an estimate ("about", "~"), never as a bill.
- Only the three Claude models Forge lists are priced. OpenAI and OpenRouter models show no cost.
