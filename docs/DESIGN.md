# Forge: a room for building

The conversation is the way in. The project is the thing that stays. Forge puts a quiet build brief next to the conversation so someone who cannot read code can still understand what is being made, what changed, and what needs a decision.

## Principles

- **Tell the truth about progress.** Step stories use the backend’s friendly labels. Tool details are expandable, approvals stay visible, and a failed check never becomes “success.” The brief’s plan is replayed from actual plan events. User priorities are separate, explicitly included in the next message, and never presented as an agent commitment.
- **Show the thing, not the machinery.** The brief holds the original goal, project folder name, plan, and changed-file cards. Code and the terminal remain behind Workspace. Files use understandable categories (page structure, appearance, behavior) and before/now facts rather than invented semantic claims.
- **Keep a way back.** Per-file Undo uses the backend checkpoint hook and refreshes remaining changes. Whole-run Undo is still reachable. Actions are serialized within a changes card; delayed results do not modify another chat’s brief.
- **Make capability legible.** Model fit stays in the library. The composer distinguishes cloud, local, remote, GPU, CPU and partially GPU execution. Measured throughput and memory use remain visible. Cloud pricing is not guessed.

## Tokens

Geist and Geist Mono are bundled locally. No remote fonts, assets, or renderer dependencies were added.

The visual language follows a near-black, monochrome desktop style (2026-11-04): neutral greys only, quiet hairlines, and the primary action is white on black in dark and black on white in light. Values were read from a reference app's computed styles, not copied code or assets; Forge keeps its own wordmark.

| Token | Dark | Light | Purpose |
| --- | --- | --- | --- |
| `--bg` | `#101010` | `#ffffff` | Main canvas, editor-adjacent surfaces |
| `--side` | `#0c0d0e` | `#fafafa` | Sidebar and settings nav |
| `--panel` | `#181818` | `#fafafa` | Cards, dialogs, composer, toasts |
| `--panel-2` | `#242424` | `#f0f0f1` | Hover, selected rows, icon tiles |
| `--hair` / `--border` | `#252525` / `#303030` | `#e5e5e5` / `#d4d4d8` | 1px dividers / control borders |
| `--text` / `--muted` / `--faint` | `#d8d8d8` / `#a7a7a7` / `#858585` | `#18181b` / `#52525b` / `#71717a` | Text levels, all AA on the canvas |
| `--accent` / `--accent-ink` | `#e8e8e8` / `#111111` | `#18181b` / `#ffffff` | Primary buttons, send, progress |
| `--focus` | `#c8c8c8` | `#3f3f46` | Focus rings and focused field borders |

Agent colours (`--a-claude`, `--a-codex`, `--a-local`) appear only as small dots and in the live editor (carets, name tags, block rails). Semantic `--ok`, `--warn`, `--err` stay for diffs, errors and the few warnings. Radii: 8px rows and buttons, 12px dialogs, toasts and the composer. Type: 13px UI, 12.5px nav rows, 20px page titles, 15px settings section heads, 11.5px muted column heads.

Layout anatomy: a 224px sidebar (wordmark and collapse, nav rows with line icons, a muted "Chats" label with +, the chat list, then a usage avatar with Models and Settings icons); page headers with the title left and a compact control cluster right (view toggle, filter and sort selects, an expanding search, then the white primary button); boards as tables with muted column heads and hairline rows, or a card grid; centred empty states (line glyph, bold line, two muted lines, one white button). Settings is a full page with grouped nav, a search that filters rows across pages, and hairline sections of label-plus-description rows with Off | On pairs, chevron selects, outline buttons and preview cards. Dialogs have a 1px border, 12px radius, an icon + title + close header, a divider, and a footer with a muted hint left and actions right. Toasts are cards bottom-right. The Team run screen sits on a 14px dotted canvas.

**Emoji only for meaning.** Emoji mark statuses (run, task, step), approvals and agent tool steps, plus the Chat / Team mode chips; they all come from one map in `glyphs.ts`. Headings, nav rows, buttons, menus, settings, dialogs, toasts, hints, table labels and file rows use words or the SVG set in `icons.ts`. Every icon-only control keeps its words in `title` and `aria-label`. The UI font stacks end with Noto Color Emoji, Apple Color Emoji and Segoe UI Emoji.

**Team questions.** An agent's `team_ask` question is the loudest card in the Waiting-for-you tray: who asks, the question, option rows (radio or checkbox) with an "Other…" row and its own text field, keys 1-4, arrows and Enter, then Skip and a white "Send answer". The run header shows "Waiting for you" while one is pending, and answered questions stay as one-line "You answered: …" rows. A half-made answer survives live redraws.

## Components and behavior

- **Build brief:** persistent above 1200px; accessible toggle and close controls below that. The agent checklist is observational. User priorities can be added, reordered earlier, unchecked, removed, and retained per chat in local storage. Up to 12 priorities, 240 characters each.
- **Run story:** collapsed phase summary with plain-language step labels. Approvals expand their containing group, explain the proposed effect, and offer “Allow this change/command” and “Skip this step.” Exact text changes stay behind the step’s disclosure.
- **Changes:** file categories, before/now facts, line counts, individual and checkpoint Undo. Semantic change descriptions need backend support; the renderer does not infer intent from code.
- **Command palette:** Ctrl/Cmd K searches commands, chats, and models. Arrow keys select, Enter executes, Escape closes and returns focus. Available actions include autonomy modes, Workspace, build brief, project folder, library and settings.
- **Preview:** live web preview opens in the browser using `previewStart`. The renderer CSP is unchanged. Embedded preview is intentionally deferred until an isolated scheme/origin can be allowed without broadening the existing policy.
- **Responsive layout:** full studio at 1440px, brief behind a toggle at 1200px and below, history collapsible at 1000px and below. At 900px all chat controls remain reachable. Long words wrap and code scrolls inside its own surface.
- **Accessibility:** native buttons and dialogs, named fields, visible focus, disclosure state, selected command state, status announcements, distinct history open/delete controls, and no hidden-by-opacity actions required for navigation.

## Motion and performance

Motion is transform and opacity only, 150-300ms on `cubic-bezier(.2,.8,.2,1)`. Messages, chat rows, task cards, settings groups, palette results and model rows rise 6px as they arrive, staggered a few tens of ms. Lists that redraw live (chat history, task board, run list) only animate items seen for the first time. Dialogs scale from .98 and fade in and out in 150ms (`@starting-style` plus `allow-discrete`); Settings fades in as a page and each settings page cross-fades. Toasts rise in from the bottom-right corner. The sidebar, workspace and brief slide in when shown; chat and Team screens cross-fade. Toasts slide in and out, running states pulse, progress bars fill with `scaleX` and carry a sheen, skeletons use a sliding sheen, focus rings ease in, and the token count nudges when it changes. `prefers-reduced-motion: reduce` turns every animation and transition off.

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
- **See work while it is becoming.** Text deltas appear with a restrained typing cursor; thinking summaries and command output remain collapsible. Growing files replace themselves by event id instead of creating log noise. File content is syntax-highlighted locally with Monaco, while unified diffs use added/removed line color. The exact prompt for each task and phase is available behind “What this agent was told.”
- **Keep shared context visible.** “Files changing now” comes from ephemeral `live` events and opens the exact working-tree file through `teamLiveDiff`. Shared memory groups current decisions, handoffs, messages and problems with relevant decisions, fixes and role history from earlier project runs. It refreshes on task and message events without interrupting the run.
- **Intervene without losing context.** Soft pause waits for the current step; holding Pause performs the hard stop. Resume, cancel, retry, skip, budget extension, targeted steering, and blocking approval answers remain on the run. Interrupted runs explain that saved sessions can be resumed.
- **Review before touching the project.** Unified diffs open on demand in a read-only Monaco diff editor and load its worker locally. The final report names changed files and verification status, then makes “Apply to my project” and “Don’t apply” explicit. Export uses `teamExportReport`. After Apply, a persistent Undo action warns that later hand edits to affected files will also be restored, then shows the `teamUndo` result.
- **Return after a restart.** `teamList`, `teamGet`, and `teamEvents` rebuild the board and activity lanes. `onTeamEvent` applies live updates through the same renderer reducer, so replayed and live runs do not have separate visual semantics. Completed runs can be removed through `teamDelete`.
- **Capability gating.** Team entry points stay hidden unless `window.forge.teamStart` exists. Optional settings, deletion, event subscription, and export controls are individually gated by hook presence.

### Team replay harness and verification

The renderer includes a deterministic, quota-free replay fixture for planning, running, streaming, settled text, approval, paused, interrupted, unavailable-agent, final, and applied states. Scripted prompt, delta, growing-code, live-file, shared-memory, and Undo data exercise the same reducer and components as live hooks. Setting `forge.teamReplay` to `open` and `forge.teamReplayState` to a state before reload opens the fixture; the harness never calls `teamStart` or an agent CLI. It also exercises restart replay through the previous-runs list.

On 2026-11-03 the built Electron app was run with `FORGE_PROJECT=/tmp/forge-team-ui npx electron . --remote-debugging-port=9331 --user-data-dir=/tmp/forge-team-live-final --ozone-platform=x11`. CDP verified the task board, both agent lanes, prompt disclosures, delta replacement, content and diff code, live file diff, shared memory, feed, verification output, steering, controls, final decisions, confirmed Undo, composer entry, and interrupted-run replay with zero renderer exceptions. Light, dark, 1440px, and 760px captures are checked in; every PNG is below 500 KB. `npm run typecheck`, all 284 tests, and `npm run build` pass.
