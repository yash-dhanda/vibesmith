# Renderer requests for backend integration

The redesign is based on the additive contract in `src/preload/index.ts`. No main or preload sources are changed by this branch.

## Next hooks

- **Steer the agent’s plan during a run.** `planUpdate(chatId, { revision, items: [{ id, text, status, skipped }] }): Promise<{ revision, items }>` and revisioned `plan` events. Stable IDs and conflict handling let the user reorder, add or skip tasks without a stale renderer overwriting agent updates. Today the actual plan is read-only; a separate priorities checklist is sent with the next user message.
- **Safe embedded preview without weakening the renderer CSP.** An isolated preview surface, preferably a dedicated Electron view controlled by `previewAttach(chatId, { bounds })`, `previewDetach(chatId)`, and `onPreviewStatus({ chatId, state, title })`. Untrusted project scripts must never receive the Forge bridge or same-origin access to the shell. Today `previewStart` opens the auto-reloading page in the browser; no localhost wildcard was added to the CSP.
- **Human change descriptions and before/after content.** Extend `changes.files` with `{ summary?: string, beforeLabel?: string, afterLabel?: string, previewable?: boolean }` and `changeDetail(chatId, checkpoint, path): Promise<{ before: string, after: string, truncated: boolean }>`. Summaries should describe user-visible outcomes, and be marked as model-written. Today the UI uses truthful file categories, status and line counts, with exact edit details available on the original step.
- **Project identity and durable brief.** `projectBriefGet(chatId): Promise<{ name, description, revision }>` and `projectBriefSet(chatId, { name, description, revision })`, plus `onProjectBriefChanged`. Today the brief uses the folder basename and first request; priorities persist only in renderer local storage.
- **Live execution location and cost.** An event `{ type: 'runtime', location: 'local'|'remote'|'cloud', gpuPercent?: number, queueSeconds?: number, modelLoaded: boolean, inputCost?: number, outputCost?: number, currency?: string, estimated: boolean }`. Today composer hardware status refreshes on model/engine changes; speed and context are already measured per call. No cloud prices or ETA are invented.
- **Persist checkpoint restoration in the transcript.** Emit `{ type: 'restored', checkpoint, paths, remaining }` after either Undo call, and replay it with history. Today per-file Undo refreshes the current card with the returned remaining changes, but reopening a transcript replays the original changes event.

## Now integrated after rebasing master

- `plan` events and optional `tool.label` drive the brief checklist and run stories.
- `agentUndoFile(chatId, checkpoint, path)` restores individual files; its returned remaining changes refresh the card.
- `previewStart(chatId)` powers browser-based live preview.
- Remote engine address, test connection, save and GPU-memory controls are in Settings > Models; remote-down never offers a local engine install.
- Team Mode consumes the complete team bridge, including event replay, approvals, lifecycle controls, diff/final decisions, saved settings, run deletion, report export, and `claudeEffort`. The core Team UI is wired; the recovery follow-up below would make the apply checkpoint actionable.

## Team follow-up

- **Offer Undo after applying a team run.** `teamApply` returns a checkpoint, but the existing `agentUndo(chatId, checkpoint)` only resolves checkpoints registered to a chat session. Add `teamUndo(id, checkpoint): Promise<string[]>` (or register the team checkpoint with a compatible owner) so the final Team surface can render a working Undo button. Today the UI shows the returned recovery checkpoint without claiming that it can invoke Undo.
