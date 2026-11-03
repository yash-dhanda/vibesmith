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
