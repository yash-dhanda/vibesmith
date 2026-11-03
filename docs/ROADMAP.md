# Roadmap: 10 new things

Claude (backend) and Codex (UI) both work on `master` now. Claude builds the hook and logs it in `docs/API-CHANGES.md`; Codex builds the screen and gates it with `typeof window.forge.x === 'function'` until the hook lands. Order below is the order Claude builds them.

| # | Feature | Claude (backend) | Codex (UI) |
|---|---|---|---|
| 1 | **Steerable plan** | `planUpdate(chatId, { revision, items:[{id,text,status,skipped}] })`, stable ids, revisioned `plan` events; agent respects skipped/reordered steps | Drag to reorder, skip, add a step in the brief and the run story |
| 2 | **Durable project brief** | `projectBriefGet/Set(chatId)`, `onProjectBriefChanged`, stored per project outside the repo | Editable name + description + priorities (replace localStorage) |
| 3 | **Human change descriptions + before/after** | `changes.files[].summary/beforeLabel/afterLabel/previewable`, `changeDetail(chatId, checkpoint, path)`, `{type:'restored'}` event persisted in transcript | Visual before/after viewer per file, restored state survives reopen |
| 4 | **Live runtime and cost chip** | `{type:'runtime', location, gpuPercent, queueSeconds, modelLoaded, inputCost, outputCost, currency, estimated}` | Chip in the composer: "Running on your GPU / the desktop / cloud · est. cost" |
| 5 | **Edit and retry a message** | `chatEdit(chatId, messageIndex, text)` (rewinds transcript + model history, optionally restores that checkpoint), `chatRetry(chatId)` | Hover actions on user and assistant messages; "Try again" / "Edit and resend" |
| 6 | **Attachments** | `attachmentsAdd(chatId, files)` into the project's `.forge/attachments`, images sent to vision models (Ollama `images`, Anthropic/OpenAI image blocks), text files inlined with a size cap | Drag-and-drop, paste screenshot, attachment chips in the composer and thread |
| 7 | **Project rules** | `rulesGet/Set(chatId)`: a per-project instruction file (`FORGE.md` in the project) injected into the system prompt, edited by the user in plain words | "How Forge should work on this project" editor in the brief, with starter suggestions |
| 8 | **Isolated embedded preview** | `previewAttach(chatId, {bounds})`, `previewDetach`, `onPreviewStatus` using a sandboxed Electron view with no Forge bridge | Preview pane inside the app with device-size toggles and reload |
| 9 | **Pinned chats, project groups, content search** | `chatsPin(id, bool)`, `chatsSearch(query)` over message text, grouped listing by project | Pinned section, project folders in the sidebar, search results with snippets |
| 10 | **Run it** | `runStart(chatId)` detects `npm start/dev`, `python app.py`, etc., runs it managed (never sudo, command deny-list applies), streams logs, `runStop`, `onRunLog`, port detection feeds the preview | "Run" button, live log drawer, running badge, "Open at localhost:xxxx" |

## Working agreement

- Both on `master`. Small commits, `git pull --rebase origin master` before every push, never force-push, never rewrite pushed history.
- Claude owns `src/main/**`, `src/preload/**`, `src/eval/**`, `.github/**`. Codex owns `src/renderer/**`, `build/icon.*`, design docs. If you need a change in the other side's area, write it in `docs/UI-REQUESTS.md` (Codex) or `docs/API-CHANGES.md` (Claude) instead of editing.
- Before pushing: `npm run typecheck && npm test && npm run build`. Do not push red.
- Test the real app over CDP (`--remote-debugging-port=<port> --user-data-dir=<tmp>`), on your own port and profile, so you never disturb the other's running instance. Both share one laptop, one GPU and one Ollama: do not load a second big model while the other is mid-run; use `qwen3:0.6b` for UI checks.
- No AI attribution lines in commit messages. Never commit secrets, `.env`, `eval-results/`, or screenshots larger than 500 KB.
