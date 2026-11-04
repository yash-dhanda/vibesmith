# Forge redesign: Graphite, comfortable, all-day

Date: 2026-11-04. Status: approved by the owner ("Yes, build it").

## Goal

Make every screen of Forge (shell, Solo, Crew start, Crew run, Settings, model library, phone link) cleaner and easier to work in for ten hours a day, without losing any feature or behaviour. Owner choices: **Graphite** look (the current grey, monochrome style, refined), **keep lots of motion**, **comfortable density**, **build brief hidden until asked**. Also: the phone link must have no gaps or overlaps on iPhone Safari and as a home-screen app.

## Non-goals

No framework change, no new dependencies, no new features beyond the layout and shortcut changes below, no backend changes except what the phone fixes need. Nothing is pushed to GitHub until the owner says so.

## Visual system (tokens)

Monochrome stays: neutral greys, hairlines, white-on-black primary action (black-on-white in light). Changes are for long sessions:

| Token | Dark now → new | Light now → new | Why |
| --- | --- | --- | --- |
| `--bg` | `#101010` → `#141414` | `#ffffff` → `#fbfbfa` | Less glare between dark canvas and text; light not paper-white |
| `--side` | `#0c0d0e` → `#111111` | `#fafafa` → `#f4f4f3` | Sidebar separated by tone, not a hard line |
| `--panel` / `--panel-2` | `#181818`/`#242424` → `#1b1b1b`/`#252525` | `#fafafa`/`#f0f0f1` → `#ffffff`/`#efefee` | Cards read as lifted |
| `--hair` / `--border` | `#252525`/`#303030` → `#262626`/`#333333` | `#e5e5e5`/`#d4d4d8` → `#e6e6e4`/`#d6d6d3` | Same weight on the new canvas |
| `--text` / `--muted` / `--faint` | `#d8d8d8`/`#a7a7a7`/`#858585` → `#d6d6d6`/`#a3a3a3`/`#808080` | `#18181b`/`#52525b`/`#71717a` → `#1c1c1e`/`#56565c`/`#737378` | Body ~11:1 (not 15:1), muted and faint still AA |

Type: UI 14px (was 13px), nav rows 13.5px, chat message body 15px / 1.6, code 13px, page titles 20px, section heads 15px, small labels 12px minimum. Spacing on a 4px scale; controls 34px tall on desktop (44px on touch). Radii unchanged (8px controls, 12px cards and dialogs).

Motion stays rich (owner choice): entrances, stagger, sheens, pulses. Durations unify to `--t1 150ms`, `--t2 220ms`, `--t3 320ms` on `--ease`. `prefers-reduced-motion` still turns it all off.

## Layout

- **Shell.** Sidebar 240px. Collapsing it leaves a 56px icon rail (wordmark mark, Find, New Solo chat, Crew runs, then usage, models and settings at the bottom) instead of hiding it, so navigation is always one click away. Every main screen has the same 52px top bar: sidebar toggle, title, then a right-aligned control cluster.
- **Shortcuts.** Ctrl K find anything, Ctrl N new Solo chat, Ctrl B sidebar, Ctrl . build brief, Ctrl 1 Solo, Ctrl 2 Crew, Ctrl , settings. Shown in tooltips and the palette.
- **Solo.** Thread and composer in one centred column, max 760px. The build brief is closed by default at every width and opens as a right panel from a top-bar toggle or Ctrl . (remembered per session). The composer is taller, with its controls (attach, folder, autonomy, model, send) on one row.
- **Crew start.** Goal box first. The three agents become one row of chips ("Claude · Default · High", "Codex · model · High", "Local · model"); clicking a chip opens its model and effort selects in place. Questions and web research are two small toggles. Readiness and plan allowance become one muted line. Everything else stays under "More options". Recent runs below, unchanged in function.
- **Crew run.** Compact header: goal clamped to two lines (click to expand), status, elapsed time, tokens and progress on one line, actions on the right. Plan tasks are a compact row of small cards (number, agent dot, title on one line, status) that wraps, so the live editor gets most of the height. Right column keeps Changing now, Crew feed, Background (collapsed), Changes. The message box stays pinned at the bottom.
- **Settings and model library.** Same structure and behaviour, new sizes and spacing; long pages get a sticky page head.

## Phone link (iPhone Safari and home-screen app)

- Safe areas come from four custom properties set once (`--safe-t/r/b/l: env(safe-area-inset-*)`) and every inset uses them, so tests can emulate a notch by overriding them.
- `theme-color` and the manifest colours follow the active theme (no dark strip above a light page, no light strip below a dark one); `html` and `body` paint the canvas colour so overscroll never shows another colour.
- No gaps: the bottom tab bar sits flush on the home indicator area, the composer sits flush on the tab bar or the keyboard, headers sit flush under the status bar, sheets reach the bottom edge. Checked in Playwright WebKit with iPhone viewports (390x844 and 430x932) and emulated insets (47px top, 34px bottom), dark and light, for chat, drawer, Crew start, Crew run and Settings.

## Process and file ownership

`styles.css` becomes an index of `@import`s, split by contiguous ranges so the cascade order is unchanged: `base.css` (tokens, base, controls, shell, sidebar), `solo.css`, `chrome.css` (page heads, toasts, dialogs, palette, project history), `settings.css` (settings, skills, previews, skeletons, library), `workspace.css` (workspace and responsive), `crew.css`, `attachments.css`, `phone.css`, `motion.css`.

1. Foundation (one owner): split, tokens, type scale, shared controls, shell with icon rail, top bar, shortcuts.
2. In parallel, each owning only its files: Solo (`solo.css`, `workspace.css`, `attachments.css`, `chat.ts`, `brief.ts`, `workspace.ts`, `attachments.ts`, `history.ts`), Crew (`crew.css`, `team.ts`, `teamStage.ts`, `teamReplay.ts`), Settings (`settings.css`, `settings.ts`, `skillsPanel.ts`, `usage.ts`, `library.ts`, `models.ts`).
3. Then the phone link (`phone.css`, `phone.ts`, `index.html` meta, `remote.ts` meta), after the screens are done.
4. Then verification: typecheck, tests, build, desktop screenshots of every screen in dark and light, phone screenshots in WebKit, `docs/DESIGN.md` updated, local commits only.

## Done means

All existing tests pass (the two sandbox-only `hub.test.ts` socket failures excepted), typecheck and build are clean, no renderer errors in the screenshot passes, every screen has before and after screenshots in both themes, the phone pass shows no gaps or horizontal overflow, and every behaviour listed in `docs/DESIGN.md` still works.
