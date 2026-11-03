# Forge: a room for building

The conversation is the way in. The project is the thing that stays. Forge puts a warm, quiet build brief next to the conversation so someone who cannot read code can still understand what is being made, what changed, and what needs a decision.

## Principles

- **Tell the truth about progress.** Step stories use the backend’s friendly labels. Tool details are expandable, approvals stay visible, and a failed check never becomes “success.” The brief’s plan is replayed from actual plan events. User priorities are separate, explicitly included in the next message, and never presented as an agent commitment.
- **Show the thing, not the machinery.** The brief holds the original goal, project folder name, plan, and changed-file cards. Code and the terminal remain behind Workspace. Files use understandable categories (page structure, appearance, behavior) and before/now facts rather than invented semantic claims.
- **Keep a way back.** Per-file Undo uses the backend checkpoint hook and refreshes remaining changes. Whole-run Undo is still reachable. Actions are serialized within a changes card; delayed results do not modify another chat’s brief.
- **Make capability legible.** Model fit stays in the library. The composer distinguishes cloud, local, remote, GPU, CPU and partially GPU execution. Measured throughput and memory use remain visible. Cloud pricing is not guessed.

## Tokens

Geist and Geist Mono are bundled locally. No remote fonts, assets, or renderer dependencies were added.

| Token | Dark | Light | Purpose |
| --- | --- | --- | --- |
| Background | `#161513` | `#faf7f2` | Main canvas |
| Panel | `#1c1b18` | `#f1ece4` | Quiet object surfaces |
| Raised panel | `#24221e` | `#e8e0d5` | Controls and user messages |
| Text | `#ece8e0` | `#211e19` | Primary information |
| Secondary | `#b0a79a` | `#6d6256` | Supporting information |
| Ember | `#e79a73` | `#a84420` | Intent, focus and action |

The CSS foundation retains the existing tokens; the build-studio section refines contrast and component composition. Corners range from 5px to 18px. Thin warm borders establish hierarchy; shadows are reserved for floating surfaces and the composer.

## Components and behavior

- **Build brief:** persistent above 1200px; accessible toggle and close controls below that. The agent checklist is observational. User priorities can be added, reordered earlier, unchecked, removed, and retained per chat in local storage. Up to 12 priorities, 240 characters each.
- **Run story:** collapsed phase summary with plain-language step labels. Approvals expand their containing group, explain the proposed effect, and offer “Allow this change/command” and “Skip this step.” Exact text changes stay behind the step’s disclosure.
- **Changes:** file categories, before/now facts, line counts, individual and checkpoint Undo. Semantic change descriptions need backend support; the renderer does not infer intent from code.
- **Command palette:** Ctrl/Cmd K searches commands, chats, and models. Arrow keys select, Enter executes, Escape closes and returns focus. Available actions include autonomy modes, Workspace, build brief, project folder, library and settings.
- **Preview:** live web preview opens in the browser using `previewStart`. The renderer CSP is unchanged. Embedded preview is intentionally deferred until an isolated scheme/origin can be allowed without broadening the existing policy.
- **Responsive layout:** full studio at 1440px, brief behind a toggle at 1200px and below, history collapsible at 1000px and below. At 900px all chat controls remain reachable. Long words wrap and code scrolls inside its own surface.
- **Accessibility:** native buttons and dialogs, named fields, visible focus, disclosure state, selected command state, status announcements, distinct history open/delete controls, and no hidden-by-opacity actions required for navigation.

## Motion and performance

Arrivals move only 7px over 260ms. Disclosures fade in over 180ms, controls respond in 120–180ms, and starting-point cards rise 2px on hover. Reduced-motion disables all animations and transitions. Motion indicates arrival or interaction, never fictional progress.

Chat’s entry bundle is about 89 kB unminified after build, compared with roughly 7.7 MB before the redesign. Monaco and xterm load only when Workspace is requested; no hidden terminal starts with chat. Long threads use `content-visibility: auto` with remembered intrinsic sizes, keeping all messages available to search, selection, and accessibility tools. Streaming and export continue to use the existing escaping Markdown renderer.

## Verification (2026-11-03)

`npm run typecheck`, `npm test`, and `npm run build` pass. CDP screenshots cover both themes, empty and populated chats, approvals, settings, library, command palette, 900px layout, and a 500-message transcript with an extremely long code line. Screenshot fixture content is synthetic; model fit and hardware information come from the running app.

Electron was launched with `FORGE_PROJECT=/tmp/p npx electron . --remote-debugging-port=9224 --user-data-dir=/tmp/forge-ui-review --ozone-platform=x11`. Port 9223 was occupied by an existing llama-server and was left alone. Screenshots use CDP `Page.captureScreenshot`, not desktop captures. The functional CDP pass verified per-file Undo preserves other files, whole-run Undo, priority persistence/order/skip/send, keyboard palette actions, Workspace HTML editing, remote settings controls, and reduced-motion behavior with zero renderer errors. Additional bridge checks confirmed Allow/Skip answers, escaped HTML in streamed output (no injected image/script elements), and a successful response from the real live-preview server. Fresh-profile process launch to an editable composer with model options measured 734 ms (122 ms to DOMContentLoaded), including CDP connection overhead, on this laptop with warm OS caches. A warm file reload measured 38 ms to DOMContentLoaded. These are single-host measurements, not a cross-hardware guarantee.

Functional review uses the real bridge and temporary checkpoint files; synthetic live approval events are delivered from the main-process inspector without changing main/preload sources.

The checked-in screenshots are a visual review record, not startup assets. See [the screenshot directory](screenshots/).

## Team Mode

Team Mode is a control room, not a second chat screen. It opens from the composer or the persistent “Team runs” entry and keeps the user’s goal, the shared plan, both agents, approvals, checks, and final decision in one continuous surface.

- **Start with confidence.** Readiness cards show Claude Code and Codex separately, including the backend’s exact recovery command when one is unavailable. A run can start with either available agent. Advanced setup exposes planner, concurrency, cross-review, verification, agent models, Claude effort, budgets, and the usage threshold without crowding the default path. Team defaults round-trip through `teamSettingsGet/Set`.
- **Follow the work as a story.** Task cards lead with plain-language outcomes and dependencies. Claude and Codex have distinct live lanes, while the team feed is reserved for handoffs, reviews, decisions, and user steering. Raw tool output remains inside disclosures. Usage is factual: tokens, backend cost when non-zero, and reported ChatGPT plan-window usage.
- **Intervene without losing context.** Soft pause waits for the current step; holding Pause performs the hard stop. Resume, cancel, retry, skip, budget extension, targeted steering, and blocking approval answers remain on the run. Interrupted runs explain that saved sessions can be resumed.
- **Review before touching the project.** Unified diffs open on demand in a read-only Monaco diff editor and load its worker locally. The final report names changed files and verification status, then makes “Apply to my project” and “Don’t apply” explicit. Export uses `teamExportReport`; applying retains the backend checkpoint for Undo.
- **Return after a restart.** `teamList`, `teamGet`, and `teamEvents` rebuild the board and activity lanes. `onTeamEvent` applies live updates through the same renderer reducer, so replayed and live runs do not have separate visual semantics. Completed runs can be removed through `teamDelete`.
- **Capability gating.** Team entry points stay hidden unless `window.forge.teamStart` exists. Optional settings, deletion, event subscription, and export controls are individually gated by hook presence.

### Team replay harness and verification

The renderer includes a deterministic, quota-free replay fixture for planning, running, approval, paused, interrupted, unavailable-agent, and final states. Setting `forge.teamReplay` to `open` and `forge.teamReplayState` to a state before reload opens the fixture; the harness never calls `teamStart` or an agent CLI. It also exercises restart replay through the previous-runs list.

On 2026-11-03 the built Electron app was run with `FORGE_PROJECT=/tmp/forge-team-ui npx electron . --remote-debugging-port=9331 --user-data-dir=/tmp/forge-team-ui-profile --ozone-platform=x11`. CDP verified the task board, both agent lanes, feed, verification output, steering, controls, lazy diff, final apply decision, composer entry, and interrupted-run replay with zero renderer exceptions. Light, dark, 1440px, and 760px captures are checked in; every PNG is below 500 KB. `npm run typecheck`, all 283 tests, and `npm run build` pass.
