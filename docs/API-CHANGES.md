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

## 2026-11-03 — update check

- `updateCheck(): Promise<{ available, version?, url?, notes? }>` asks GitHub for the latest published release (not a draft or prerelease) and compares it with the running version. Any failure (offline, rate limit, no release yet) returns `{ available: false }`.
- Call it once a few seconds after start and show a quiet "Forge 0.2.0 is available" with the release notes and a button that calls `openExternal(url)`. Forge never downloads or installs by itself.

## 2026-11-03 — team mode (Claude Code + Codex as one team), backend only

No screens yet. Design and findings: `docs/TEAM.md`. All hooks are additive. Types: `RunSummary` (src/main/team/service.ts), `Run`, `Task`, `RunEvent`, `TeamConfig` (src/main/team/types.ts).

**Hooks** (`window.forge.*`)

| Hook | Does |
|---|---|
| `teamHealth()` | `{ agents: [{agent, ok, detail, fix?, version?}], codexModels }`. Show `fix` verbatim when an agent is not ready |
| `teamStart(goal, config?)` | Starts a run in the current project folder; returns a `RunSummary` at once, then follow `onTeamEvent`. Refuses a second active run in the same project, and a non-git folder that has files |
| `teamList()` / `teamGet(id)` | Summaries / the full `Run` (tasks, messages, decisions, approvals, usage, final report) |
| `teamEvents(id, limit?)` | `[{t, ev}]` everything the live screen showed, to rebuild it after a restart |
| `teamDiff(id, taskId?)` | Unified diff of one task, or of everything merged so far |
| `teamPause(id, hard?)` / `teamResume(id)` / `teamCancel(id)` | Soft pause finishes what is running; `hard` kills the agents (they resume their sessions later). Cancel removes the worktrees |
| `teamAnswer(id, approvalId, allow, note?)` | Answers an approval card (agent asked, risky command, review override, budget). Returns false if the agent is no longer waiting |
| `teamSteer(id, text, to?)` | Tells the team something mid-run; each agent reads it at the start of its next turn |
| `teamRetryTask` / `teamSkipTask` / `teamExtendBudget` | Recovery controls |
| `teamApply(id)` / `teamReject(id)` | The final gate. Apply puts the result in the user's folder as uncommitted changes and returns a checkpoint id, so the normal Undo works |
| `onTeamEvent(cb)` | Live `RunEvent`s |

**`RunEvent`**: `run {status, reason?}`, `plan {summary, tasks}`, `task {task}` (status, phase work/review/fix/merge/conflict), `agent {taskId, phase, ev}` (`ev` is the normalised agent event: `text`, `tool`, `tool_result`, `usage`, `note`, `error`, `done`), `message` (agent-to-agent, review verdicts, handoffs, user steering), `approval`, `verify`, `usage`, `final {report, files, verifyOk}`.

**Run status**: `planning → running ⇄ paused → verifying → awaiting_approval → done`, or `failed` / `cancelled` / `interrupted` (found half-done after a restart; the user presses resume).

**Things the screen must do**
- Approval cards (`run.approvals` with `status: 'pending'`) block an agent until answered. Show them prominently; `kind` is `action`, `permission`, `review_override`, `budget` or `final`.
- A `paused` run with a `pausedReason` is waiting for the user (an agent is not signed in, a task failed, a budget was hit). Show the reason and the matching control.
- The final report is Markdown (`run.final.report`).
- Nothing touches the user's folder until `teamApply`.

**Added to team mode (same day)**
- `TeamConfig.codexMode`: `'app-server'` (default) or `'exec'`. `TeamConfig.maxLimitPercent` (default 80, 0 = off): pause when a subscription's short-window allowance is that used.
- `agent` events can carry `ev.type === 'limits'` (`primaryPct`, `primaryResetsAt`, `secondaryPct`, `secondaryResetsAt`); the latest per agent is kept on `run.limits`. Show it as "ChatGPT plan: 27% of this window used". Claude Code does not report this.
- `teamSteer` reaches a running Codex task immediately; other agents read it at their next turn.
- `run.pausedReason` can now be a plan-allowance message; `teamExtendBudget` (or answering the `budget` approval) raises the limit by 5 points and continues.

**More team hooks (same day)**
- `teamDelete(id)`: removes a finished run (done, failed, cancelled, or waiting for approval) with its branches, worktrees and log. Returns false for a run still in progress: cancel it first. Leftovers of crashed runs are also swept at startup.
- `teamSettingsGet()` / `teamSettingsSet(cfg)`: team defaults remembered per project (verify command, budgets, planner, review on/off...). A run's own `config` wins over them.
- `teamExportReport(id)`: opens the system save dialog and writes the final report (Markdown); returns the path or null if cancelled.
- `TeamConfig.claudeEffort` (`low` to `max`) and `claudeModel` are passed to Claude Code.

**Live view of every agent (team mode)**

New `agent` events (`ev.type`), all inside the existing `onTeamEvent` stream:
- `delta {agent, channel: 'text'|'thinking'|'output', id?, text}`: text as it is generated. `thinking` is the agent's reasoning summary, `output` is a command's output while it runs. Deltas arrive merged every ~100 ms. The finished message follows as a `text` event: replace the deltas with it. Claude and Codex (app-server mode) stream; `codexMode: 'exec'` does not.
- `code {agent, id, path, text, kind: 'content'|'diff', done}`: a file being written, as it grows. `text` is the whole content (Claude: file text; Codex: the unified diff) so far, so replace what you showed for the same `id`. `done: true` marks the final version. Paths are relative to the agent's folder.
- `prompt {agent, text}`: exactly what this agent was handed at the start of the run (goal, task, acceptance checks, handoffs from finished tasks, unread messages, your rules, relevant notes and past problems). This is the "shared context" each agent actually received. Persisted in the log.
- New run event `live {taskId, files}`: every ~1.5 s while an agent works, the files that differ from where its task started, whatever wrote them (patch, shell command, editor tool). Not persisted.

New hooks:
- `teamLiveDiff(id, taskId, path?)`: the unified diff of the agent's working folder right now (uncommitted), or one file of it. Call it when a `live` event names a file you are showing. After the task has merged it returns the team branch's change.
- `teamMemory(id)`: the shared memory right now: `decisions`, `messages` (all, including steering), `handoffs` per task, `errors`, and `project` (decisions and problems remembered from earlier runs, plus which agent has done which job well). Refresh it on `message` and `task` events.

Typing and growing files are not written to the log; finished text, tool results, prompts and the task diff are. To rebuild a run after a restart use `teamEvents`.

**teamUndo (team mode)**
- `teamUndo(id): Promise<{ ok, paths, message }>`: takes an applied team result back out of the project (every file the apply changed goes back as it was just before). Works only on a run whose `run.applied` is true and `run.appliedCheckpoint` is set, once (`run.undone` becomes true). Hand-made edits after the apply are undone too, like the chat Undo, so confirm first. Satisfies the UI request "Offer Undo after applying a team run".

**Desktop notifications for team runs**
- While the window is not focused (and notifications are on in settings), Forge shows a system notification when a team run needs an answer (a pending approval other than the final one), is ready to review, fails, or stops for a reason other than the user's own pause. Clicking it focuses the window and sends `onTeamFocus(runId)`: open that run.

**Config change:** `TeamConfig.finalReview` is now `true | false | 'auto'` (default `'auto'`: only runs of 3 or more build tasks get the final whole-result review, to save plan usage). A UI toggle can keep writing booleans; offer "Automatic" as a third state.

**Review the plan before any agent works (optional)**
- `TeamConfig.reviewPlan: true` (default off) makes a run stop after planning: status `paused` with `pausedReason` "Review the plan...", and one pending approval of `kind: 'plan'`. Nothing has started yet.
- `teamUpdatePlan(id, edits)` with `edits: [{ id, title?, goal?, agent?, acceptance?, deps?, skip? }]` changes tasks of an unstarted plan (reword, reassign, change checks or dependencies, skip with `skip: true`, un-skip with `false`). Returns `{ ok, message }`; refused if it would create a dependency circle, leave no task, use an unavailable agent, or if work has started. Each success emits a new `plan` event.
- Answer the `plan` approval with `teamAnswer(id, approvalId, true)` to start, or `false` to cancel the run. This saves plan usage when the plan is wrong: the agents have only planned so far.
