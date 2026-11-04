# Forge redesign implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the redesign in `docs/superpowers/specs/2026-11-04-forge-redesign-design.md`: Graphite tokens, comfortable sizes, icon-rail shell, calmer Solo and Crew layouts, refreshed Settings, and a gap-free phone link on iPhone Safari.

**Architecture:** The renderer is vanilla TypeScript building DOM with `h()` from `src/renderer/ui.ts`, styled by one stylesheet. The stylesheet is split into ordered `@import` files so screens can be restyled in parallel without editing the same file; behaviour stays in the existing modules.

**Tech Stack:** Electron 45, electron-vite (Vite CSS `@import` inlining), TypeScript, vitest, CDP screenshots (`f-cdp.mjs` helper in the scratchpad), Playwright WebKit for the iPhone pass.

## Global Constraints

- Look: Graphite, monochrome, white-on-black primary action (black-on-white in light). No new accent colours; agent colours only as dots and in the live editor.
- Tokens exactly as the spec's table: dark `--bg #141414`, `--side #111111`, `--panel #1b1b1b`, `--panel-2 #252525`, `--hair #262626`, `--border #333333`, `--text #d6d6d6`, `--muted #a3a3a3`, `--faint #808080`; light `--bg #fbfbfa`, `--side #f4f4f3`, `--panel #ffffff`, `--panel-2 #efefee`, `--hair #e6e6e4`, `--border #d6d6d3`, `--text #1c1c1e`, `--muted #56565c`, `--faint #737378`.
- Type: UI 14px, nav rows 13.5px, chat body 15px / 1.6, code 13px, page titles 20px, section heads 15px, nothing under 12px. Controls 34px tall on desktop, 44px on touch.
- Motion: keep it rich; durations `--t1 150ms`, `--t2 220ms`, `--t3 320ms` on `--ease`; `prefers-reduced-motion` turns everything off.
- Copy: sentence case, words from `src/renderer/names.ts`, emoji only for meaning (`glyphs.ts`), no new emoji.
- No new dependencies. No backend changes except the phone meta. Every feature in `docs/DESIGN.md` keeps working.
- Git: author as the existing repo config, no AI attribution lines, no `.claude/` or `.mcp.json`, **never push**. Workers do not commit; the lead commits after review.
- Checks before a task is done: `npm run typecheck`, `npx vitest run` (only the two `hub.test.ts` socket tests may fail, sandbox-only), `npx electron-vite build`.

---

### Task 1: Foundation (lead)

**Files:**
- Modify: `src/renderer/styles.css` (becomes the `@import` index)
- Create: `src/renderer/css/base.css`, `solo.css`, `chrome.css`, `settings.css`, `workspace.css`, `crew.css`, `attachments.css`, `phone.css`, `motion.css`
- Modify: `src/renderer/index.html` (sidebar rail markup, top-bar toggles), `src/renderer/chat.ts` (sidebar collapse to rail, Ctrl 1 / Ctrl 2 / Ctrl . shortcuts)

**Interfaces:**
- Produces: the CSS files above (owners in Tasks 2-5), the tokens, `#app.rail` (sidebar collapsed to the 56px rail), `#chat-head` and `.team-head` both 52px tall, shortcut map (Ctrl K, N, B, ., 1, 2, comma).

- [ ] Step 1: Split `styles.css` by its section comments, in order: `base.css` (start to `/* ---- chat column`), `solo.css` (to `/* ---- page headers`), `chrome.css` (to `/* settings: a full page`), `settings.css` (to `/* ---- workspace drawer`), `workspace.css` (to `/* ---- Team Mode`), `crew.css` (to `/* ---- attachments`, plus the tail from `/* the run's chat box` to the end), `attachments.css` (to `/* ---- phones, tablets`), `phone.css` (to `/* ---- keyframes`), `motion.css` (to `/* the run's chat box`). `styles.css` then holds only the nine `@import './css/<name>.css';` lines in that order.
- [ ] Step 2: Build and diff the bundled CSS against the old bundle: `npx electron-vite build && cat out/renderer/assets/*.css | wc -c` must equal the old size within the removed comment bytes, and a CDP screenshot of Solo and the Crew run must match the old one pixel for pixel.
- [ ] Step 3: Replace the token blocks in `base.css` with the spec values; set the type scale (`html { font-size: 14px }` where it is set today, nav rows 13.5px, titles 20px); unify `--t1/--t2/--t3`.
- [ ] Step 4: Sidebar rail: collapsing sets `#app.rail` (not `no-hist`) at widths above 800px; the rail shows the brand mark, Find, New Solo chat, Crew runs, and the bottom usage, models and settings icons with tooltips; Ctrl B toggles; the state is kept in `localStorage forge.sidebar`.
- [ ] Step 5: Shortcuts in `chat.ts`'s window keydown: Ctrl 1 Solo, Ctrl 2 Crew, Ctrl . build brief, Ctrl , settings; list them in the palette entries' hints.
- [ ] Step 6: Run the checks, take before/after CDP screenshots (dark and light) of Solo, Crew start, Crew run, Settings, and commit: `git commit -m "Redesign foundation: split stylesheet, Graphite tokens, comfortable type, sidebar rail, shortcuts"`.

### Task 2: Solo (worker, parallel with 3 and 4)

**Files (only these):** `src/renderer/css/solo.css`, `src/renderer/css/workspace.css`, `src/renderer/css/attachments.css`, `src/renderer/chat.ts`, `src/renderer/brief.ts`, `src/renderer/workspace.ts`, `src/renderer/attachments.ts`, `src/renderer/history.ts`, plus the Solo parts of `src/renderer/index.html` (`#chat`, `#composer-wrap`, `#brief`).

- [ ] Step 1: Thread and composer in one centred column, `max-width: 760px`; messages 15px / 1.6; assistant text full width of the column, user messages as a quiet panel bubble on the right.
- [ ] Step 2: Build brief closed by default at every width; top-bar toggle and Ctrl . open it as a right panel; remembered in `sessionStorage forge.brief`.
- [ ] Step 3: Composer: taller textarea (min 2 lines, grows to 10), one control row (attach, folder, autonomy, model, send), hint line kept.
- [ ] Step 4: Empty state, steps, changes card, approval and question cards restyled on the new tokens; motion kept.
- [ ] Step 5: Checks pass; CDP screenshots (empty chat, a seeded chat with steps and a changes card, approval) in dark and light on port 9561 with `--user-data-dir=<scratchpad>/solo-ui`.

### Task 3: Crew (worker, parallel with 2 and 4)

**Files (only these):** `src/renderer/css/crew.css`, `src/renderer/team.ts`, `src/renderer/teamStage.ts`, `src/renderer/teamReplay.ts`.

- [ ] Step 1: Crew start: goal box first; one row of agent chips ("Claude · Default · High" style) that open their model and effort selects in place; Questions and Web research as two small Off | On toggles; readiness and plan allowance in one muted line; everything else under More options; Recent runs below unchanged in function.
- [ ] Step 2: Run header: goal clamped to two lines with click to expand; status, elapsed, tokens, progress on one line; actions right.
- [ ] Step 3: Plan tasks as compact wrapping cards (number, agent dot, one-line title, status, small facts row); the live editor gets the freed height; right column unchanged in content.
- [ ] Step 4: Message box pinned at the bottom stays; every run state (planning, running, paused, awaiting approval, done) still shows its cards and buttons.
- [ ] Step 5: Checks pass; replay screenshots (`forge.teamReplay` with states `entry`, `planning`, `running`, `final`, `applied`) in dark and light on port 9562 with `--user-data-dir=<scratchpad>/crew-ui`.

### Task 4: Settings and model library (worker, parallel with 2 and 3)

**Files (only these):** `src/renderer/css/settings.css`, `src/renderer/settings.ts`, `src/renderer/skillsPanel.ts`, `src/renderer/usage.ts`, `src/renderer/library.ts`, `src/renderer/models.ts`.

- [ ] Step 1: Settings on the comfortable scale: 240px nav, 720px content column, sticky page head, rows with 16px vertical padding, Off | On pairs and selects 34px.
- [ ] Step 2: Skills, Remote access, Usage (including By agent cards) and Crew pages restyled; the model library dialog restyled on the same tokens.
- [ ] Step 3: Checks pass; CDP screenshots of every settings page and the library in dark and light on port 9563 with `--user-data-dir=<scratchpad>/settings-ui`.

### Task 5: Phone link and iPhone Safari (worker, after 2-4)

**Files (only these):** `src/renderer/css/phone.css`, `src/renderer/phone.ts`, `src/renderer/index.html` (head only), `src/main/remote.ts` (manifest and injected meta only).

- [ ] Step 1: Add `--safe-t/--safe-r/--safe-b/--safe-l` (each `env(safe-area-inset-*)`) to `:root` in `phone.css`, and replace every `env(safe-area-inset-*)` in the CSS with them.
- [ ] Step 2: `theme-color` meta updated by `phone.ts` when the theme changes; manifest colours from the dark canvas; `html, body { background: var(--bg) }`.
- [ ] Step 3: Playwright WebKit pass at 390x844 and 430x932 with `--safe-t: 47px; --safe-b: 34px` injected: chat, drawer, Crew start, Crew run, Settings, dark and light. No horizontal overflow (`document.documentElement.scrollWidth - innerWidth === 0`), the tab bar's bottom edge at the viewport bottom, headers starting at `--safe-t`, no strip of a different colour at the top or bottom.
- [ ] Step 4: Checks pass; save the WebKit screenshots to the scratchpad.

### Task 6: Verification and docs (lead)

- [ ] Step 1: Review each worker's diff against its file list (`git status`, `git diff --stat`); revert anything outside it.
- [ ] Step 2: Full checks; CDP screenshots of every screen in both themes; WebKit phone screenshots; zero renderer exceptions.
- [ ] Step 3: Update `docs/DESIGN.md` (tokens table, type, layout anatomy, shortcuts, phone safe-area variables) and refresh `docs/screenshots/forge-*.png`.
- [ ] Step 4: Commit locally in small commits (one per task). Do not push.
