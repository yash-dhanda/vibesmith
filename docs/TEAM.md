# Team mode (Claude Code + Codex as one team)

Backend only so far. No UI, no IPC. Code: `src/main/team/`. Live check: `TEAM_SPIKE=1 npx vitest run --config vitest.eval.config.ts team-spike` (uses your own signed-in subscriptions, a few thousand tokens).

## Phase 0 findings (2026-11-03)

- Both CLIs are driven as **subprocesses of the unmodified binaries**, signed in as the user. Forge never reads or stores their tokens. Variables that would switch billing to an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or mark a nested session (`CLAUDECODE`, `CLAUDE_CODE_*`) are removed from the child environment (`cleanEnv`).
- The prompt goes in on **stdin** (`claude -p` reads it; `codex exec ... -` reads it). No shell quoting, no length limit.
- **Codex works end to end**: `codex exec --json -C <dir> -s workspace-write -m <model> -` streams `thread.started`, `item.*` (`agent_message`, `command_execution`, `file_change`), `turn.completed`. `codex exec resume <thread> ... -` continues a thread (verified).
- **Codex model must be pinned.** The default in `~/.codex/config.toml` (`gpt-6.1-sol` here) is rejected on a ChatGPT plan. `codexModels()` reads the account's catalog (`codex debug models`); `gpt-5.6-luna` and `gpt-5.6-terra` ran fine.
- **Claude Code is not verified live.** The standalone `claude` CLI on this laptop is signed out (`claude auth status` -> `loggedIn: false` once the desktop app's session variables are removed). The desktop app's own login does not count. Run `claude auth login` in a terminal once. Until then the Claude parser is covered only by fixtures built from the documented stream format and the one real result line captured.
- `node:sqlite` has FTS5 inside Electron 45 (Node 24) but not in the Node 22 that runs the tests, so the memory store will be plain JSON files with simple term scoring first.

## Files

| File | Job |
|---|---|
| `events.ts` | Vendor-neutral `TeamEvent` and `classifyError` |
| `claudeStream.ts`, `codexStream.ts` | Parse each CLI's JSON lines into `TeamEvent` |
| `process.ts` | `runCli`: spawn, stdin prompt, idle/max/abort watchdogs, process-tree kill, `cleanEnv` |
| `claude.ts`, `codex.ts` | Argument builders (`write` = edit or read-only), deny lists, `runClaude`, `runCodex` |
| `health.ts` | Installed? signed in? Which Codex models? With the exact fix text |
