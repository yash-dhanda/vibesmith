# Team mode: quick start

Claude Code, Codex and a local Ollama model working on one goal, inside Forge, on your two subscriptions (no API keys, no per-token billing).

## Before the first run
1. Sign in once in a terminal, with your accounts (not API keys):
   - `claude auth login` (your Claude plan)
   - `codex login` -> "Sign in with ChatGPT"
2. The folder you work in must be a git repository (an empty folder gets one automatically).
3. Open Forge, switch the composer to **Team**. The health check shows what is ready and the exact command to fix anything that is not. One agent is enough: the team then plans, works and reviews with that one.

## A run
Describe the goal -> a planner splits it into tasks -> tasks run in their own git branches, in parallel where they can -> the other agent reviews each one -> everything merges on a team branch -> your test command runs -> you read the report and press **Apply**. Nothing touches your folder before Apply, and **Undo** takes it back out.

Watch it live: each agent's text and code as it is typed, the files changing, what each agent was told, and the shared notes. Use the message box at the bottom to steer; after the run finishes, the same box starts more work in the same run. Pause, resume or cancel any time. Approval cards block an agent until you answer (anything destructive, deploy-like, secret-touching or outside the folder).

## Plan usage
- Everything runs on your plan allowance. Forge reads your ChatGPT allowance (free) and leaves Codex out at 80% of the 5-hour or weekly window; a Claude or Codex plan limit pauses the run, and you resume when it resets.
- A small two-task run with reviews costs roughly 5-15% of a ChatGPT Plus 5-hour window. Bigger runs more. To save usage: switch reviews off for throwaway work, turn on "review the plan first" so a wrong plan is caught before any work, set a budget (tokens, agent runs, minutes).
- The dollar figures shown for Claude are what the work would cost at API rates. Nothing is billed.

## When something is wrong
- **"not signed in" / "bills per use":** run the command the health check shows.
- **Run paused:** read the reason at the top; it says what to do (sign in, wait for a limit to reset, retry a task, allow more budget).
- **Closed Forge mid-run:** the run shows as interrupted; press resume.
- **Bug report:** `teamDiagnostics()` gives a paste-ready summary (versions, sign-ins, allowance, recent runs).

More: `docs/TEAM.md` (design and behaviour), `docs/API-CHANGES.md` (every hook and event).
