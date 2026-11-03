# Team mode (Claude Code + Codex as one team)

Backend is complete (phases 1 to 3 below); there is no screen yet. Hooks: `docs/API-CHANGES.md`. Code: `src/main/team/`. Live check: `TEAM_SPIKE=1 npx vitest run --config vitest.eval.config.ts team-spike` (uses your own signed-in subscriptions, a few thousand tokens).

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

## How a run works

1. **Plan.** A read-only agent (Claude when it is signed in, else Codex) looks at the project and returns a JSON plan: 1 to 8 tasks with goals, acceptance checks, dependencies and an agent each. The plan is validated (unknown agents, unknown dependencies, cycles).
2. **Isolate.** The project is snapshotted (uncommitted work included, secrets and `node_modules` left out) into a commit. A run branch `forge/<run>` and one worktree per task live outside the project, under the app's data folder. Your folder is not touched until you approve.
3. **Work in parallel.** Tasks whose dependencies are merged start, up to 2 per agent. Each prompt carries the goal, the task, what finished tasks handed over, unread messages, your project rules, relevant notes and problems met earlier (ranked by relevance, not the whole history).
4. **Cross-review.** The other agent reads the task's diff and ends with `VERDICT: PASS` or `FAIL`. A fail goes back to the author's own session (so it remembers) for up to 3 rounds; after that you decide whether to merge anyway.
5. **Merge.** One merge at a time into the run branch. A conflict is handed to an agent in the integration worktree; markers left behind abort the merge instead of committing it.
6. **Check.** The project's test/build command (or the one you set) runs on the merged result; failures go to an agent, up to 2 rounds. Then one final review of the whole change by the other agent.
7. **Report and approve.** A Markdown report (what each task did, files, checks, reviews, decisions, usage). You apply it, or leave it on the branch.

## How the agents talk

Each agent is started with the `forge_team` MCP server (`team-mcp.js`, run by the app's own Electron binary as plain node). It forwards every call over a private local socket to the orchestrator: `team_post`, `team_inbox`, `team_context`, `team_decision`, `team_handoff`, `team_request_approval`, `team_propose_subtask`, `team_tasks`, and `team_permission` (Claude Code's permission prompts are routed to the same policy and to you). Delivery: an agent reads its inbox when it starts a turn or calls `team_inbox`. Codex (app-server) can also be steered while it works: `steer` reaches it immediately as a `turn/steer`. Claude Code gets steering at its next turn.

## Watching the team live

Everything an agent does is visible as it happens: its text and reasoning as it is typed (`delta`), each tool call and result, a file as it is being written (`code`), the files that currently differ in its folder (`live`, polled), what a command prints while it runs, and the exact context it was handed (`prompt`). The shared memory (decisions, messages, handoffs, problems, project history) is one call away (`teamMemory`). Event shapes: `docs/API-CHANGES.md`.

## Safety

- Agents never push, and the user's folder changes only on Apply.
- `policy.ts`: `git push`, `sudo`, remote changes are denied; deploys, destructive commands, network downloads, secret files and reads outside the task folder need your approval (Claude, through the permission tool; Codex, through the sandbox: workspace-write, no network, plus `team_request_approval`).
- `.env`, keys and `node_modules` are never committed into the team branches (`.env.example` is).
- Budgets per run: tokens, agent runs, minutes, cost; hitting one pauses the run and asks before spending 50% more. Codex app-server also reports how much of the ChatGPT plan's 5-hour allowance is used (`run.limits`); at 90% (configurable) the run pauses the same way.
- A restart marks running runs `interrupted`; nothing resumes without a click.

## Status

| Part | State |
|---|---|
| Codex adapter, resume, MCP mailbox, approvals | verified live |
| Orchestrator (all of the above) | covered by tests with scripted agents on real git; one live run with Codex as the whole team (`src/eval/team-live.eval.ts`) |
| Review reject -> fix -> re-review loop | verified live with both agents (Claude fixed its own task through its resumed session, Codex fixed theirs) |
| Claude Code builds (write mode) | verified live in a team run: task built by Claude, reviewed by Codex |
| Claude Code adapter | verified live: stream parsing, MCP mailbox, permission prompts routed to Forge policy, review and planning in a full two-agent run |
| Codex `app-server` (default Codex mode) | verified live: mid-turn steering (the agent changed course), MCP mailbox, plan-allowance readout, full team run in 82 s. Its approval requests are routed to you; none appeared in the live runs because the sandbox already contains the agent. If the server cannot start, the run falls back to `codex exec` |
| Windows | the launcher for npm `.cmd` shims is unit-tested with a fake file system only; never run on Windows |
| Screens | being built by Codex from the documented hooks |
