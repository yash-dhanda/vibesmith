# Top 20 features: build plan (2026-11-05)

Owner said "add all" after asking for the 20 most valuable additions. Built in waves of parallel agents, each owning disjoint files. UI for new features lives in NEW renderer files; hooks into the shared screens (`team.ts`, `chat.ts`) are added by the lead after each wave.

| # | Feature | Wave | Notes |
|---|---|---|---|
| 1 | Auto-switch when an agent hits its limit | 1 | orchestrator: reassign queued/blocked tasks to another ready agent, keep going |
| 2 | Visual check agent | 1 | hidden window screenshots at desktop and phone sizes, shown to the reviewer next to reference images |
| 3 | Live preview pane inside Crew | 1 | reuse the in-app preview view; follows "Run website" |
| 4 | Land part of a run | 2 | approve or reject single tasks/files before landing |
| 5 | Overnight queue | 2 | several goals one after another, morning report |
| 6 | Phone notifications | 1 | ntfy-style HTTP push (short generic text only), settings page |
| 7 | Tailscale HTTPS for the phone link | 1 | `tailscale cert`, https listener, falls back to http |
| 8 | Extra cheap agent (Gemini/Kimi/GLM) | deferred | needs a subscription and a 4th agent slot across the app; not built yet |
| 9 | Git and pull requests | 1 | branch per run, commit message, push, `gh pr create` |
| 10 | Review comments on code | 2 | click a diff line, write "fix this", becomes a task |
| 11 | Project rules editor | 2 | one place for the rules all agents follow |
| 12 | Search everything | 1 | full text over chats, runs, messages, history |
| 13 | Per-task cost and time, plan forecast | 1 (data) + 2 (UI) | |
| 14 | Reference library per project | 2 | design screenshots/links attached to UI tasks |
| 15 | Test agent task type | 1 | |
| 16 | Security review agent | 1 | final check before landing |
| 17 | Project dashboard | 2 | |
| 18 | Restore points browser | 2 | |
| 19 | Voice prompts (local speech to text) | 2 | records in the renderer, transcribes with a local `whisper` command when installed |
| 20 | Auto effort and model choice, cheap mode | 1 | |

Shared rules for every agent: edit only owned files; new UI in new files; IPC in new `register*` modules wired into `src/main/index.ts` and `src/preload/index.ts` with targeted one-line Edits; no git writes; no Electron launch except on the agent's own port/profile; never run real Claude/Codex jobs; tests next to code; typecheck + tests must pass; no AI attribution.


## Status (end of the build)

Built: 1-7, 9-20. Not built: 8 (extra agent) until the owner picks and buys a subscription. Notes: 7 needs "HTTPS Certificates" enabled in the Tailscale admin console and `sudo tailscale set --operator=$USER` once; 6 uses ntfy (generic messages only); 19 needs a local speech-to-text program (whisper.cpp or whisper) installed.
