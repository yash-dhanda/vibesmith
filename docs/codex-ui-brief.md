# Forge UI/UX brief (for Codex)

You own the **entire visual and interaction layer**. Claude owns the backend and new capabilities. Work in parallel without stepping on each other.

## What Forge is

Desktop app (Electron 45, electron-vite, TypeScript, vanilla DOM, no UI framework) where a **non-programmer ("vibe coder")** describes software in chat and an AI agent builds it on their PC. Feels like Claude desktop / ChatGPT / Codex, not like an IDE. The code editor and terminal exist but are hidden behind a "Workspace" button. The user never has to read code.

Works offline: local models via Ollama (Forge downloads and manages the engine itself, model library like LM Studio), or cloud models via the user's own API keys (Anthropic, OpenAI, OpenRouter). Linux + Windows. MIT, public repo `yash-dhanda/vibesmith`.

## Ownership (hard boundary)

| You (Codex) | Claude |
|---|---|
| `src/renderer/**` (HTML, CSS, TS), `build/icon.*`, fonts, any new renderer assets | `src/main/**`, `src/preload/**`, `src/eval/**`, `.github/**`, `package.json` deps for the backend |

- **Do not edit `src/main/**` or `src/preload/index.ts`.** The preload `window.forge` API is the contract. Read `src/preload/index.ts` for every available call and event. Claude only adds to it, never breaks it. New calls are listed in `docs/API-CHANGES.md` (Claude appends there).
- If you need a backend capability that does not exist, write it in `docs/UI-REQUESTS.md` (one bullet: what the UI needs, the data shape you would like). Claude builds it and replies in `docs/API-CHANGES.md`. Until then, hide that UI behind `typeof window.forge.x === 'function'`.
- Work on branch `ui/redesign` (use a git worktree). Claude works on `master`. Rebase on `master` often. Small commits.
- You may add renderer-only dependencies, but justify each: the app must stay fast to start and fully **offline** (no CDN, no remote fonts or images; the CSP in `index.html` forbids it). Prefer none.

## Current state (what exists)

Renderer files (~2900 lines): `main.ts` (shell, shortcuts, theme), `chat.ts` (thread, composer, tool rows, approval cards, undo card, meters), `history.ts` (chat sidebar), `settings.ts` (Claude-style dialog: General/Models/Agent/Usage/Shortcuts/About), `library.ts` (model library: Installed / Discover / Hugging Face + downloads strip), `usage.ts`, `models.ts` (picker), `ui.ts` (toasts, dialogs, confirm), `format.ts` (markdown renderer, tested), `icons.ts` (own SVG set), `styles.css` (all tokens at the top).

Design language now: warm neutral dark/light, ember accent (`#d98259` dark / `#c0592e` light), Geist + Geist Mono bundled, grain overlay, tinted shadows. Treat it as a **starting point, not a constraint**. You may change palette, type, layout, motion, icons, everything, as long as it stays warm, calm, and non-generic.

Screens: welcome/first-run (engine download, model pick), empty state ("What are we building?"), chat thread with collapsed agent steps, approval cards (ask-all / auto-edit / full-auto modes), "N files changed + Undo" card, background runs per chat with notifications, token / tok-s / context meters, Workspace drawer (file tree + Monaco + xterm), Settings, Model library, Usage (millions of tokens).

## The goal: best UI/UX, something newish

The audience cannot read code and does not know what a "tool call" is. The interface should make **what the AI is doing and what it built legible to a non-programmer**, and feel like a product from 2027, not a ChatGPT clone. Ideas to push (pick, combine, or beat them; you have design freedom):

1. **Run as a story, not a log.** Replace "read_file / edit_file / run_command" rows with plain-language steps ("Reading your login page", "Adding a dark mode toggle", "Running the tests") with live progress, grouped into phases, collapsible to a one-line summary. Raw detail on demand.
2. **A living "what we're building" surface.** Per chat/project: a card or side panel showing the project as a thing (name, what it does, files as friendly cards, last change), not a file tree. Optional live preview pane for web projects (sandboxed iframe via a file/URL the backend provides).
3. **Plan as a checklist the user can steer.** A to-do the agent updates as it works; user can reorder, skip, add. (Backend events for this are coming; design the UI now.)
4. **Diff for humans.** Before/after visual summary of changes ("3 files changed: added a button, changed a colour"), with Undo per change and per file, not a code diff first.
5. **Command palette (Ctrl K) as the primary navigator**: chats, models, settings, actions, "switch to full-auto", "open project folder".
6. **Fluid, purposeful motion.** Streaming text that settles, spring-based panel transitions, skeletons not spinners, reduced-motion support. Nothing gratuitous.
7. **Model and hardware honesty.** Clear, friendly surfacing of "this model fits your GPU / runs partly on CPU / will be slow", tokens/sec, context fullness, cost for cloud models.
8. Anything else you think is genuinely new and useful for vibe coders. Show taste.

## Hard requirements

- Light and dark themes, both polished. System-follow option stays.
- Responsive from ~900 px to ultrawide; sidebar collapses; sensible minimum window.
- Keyboard-first and accessible: visible focus, roles/labels, contrast AA, `prefers-reduced-motion`.
- No layout overflow from wide code blocks / long words (past bug; keep `min-width:0` discipline).
- The `[hidden]{display:none!important}` rule stays; never rely on `hidden` with a `display` override.
- All user text rendered through the escaping markdown renderer in `format.ts`; no `innerHTML` with unescaped model output. Do not weaken the CSP.
- Never expose API keys or file paths beyond what the bridge already gives.
- Keep every existing capability reachable (approvals, undo, stop, rename/delete/search/export chat, model picker, library, settings, usage, shortcuts Ctrl N/K/L/B/J/,/Esc).
- Fast: cold start to interactive in under ~1.5 s on a laptop; a 500-message chat scrolls smoothly (virtualise or window long threads if needed).

## How to verify (do this, don't guess)

```bash
npm install
npm run typecheck && npm test        # must stay green (format.test.ts covers the markdown renderer)
FORGE_PROJECT=/tmp/some-project npx electron . --remote-debugging-port=9223
```

Drive the running app over CDP (`http://127.0.0.1:9223/json`) with Playwright/`chrome-remote-interface`, take screenshots with `Page.captureScreenshot` (not OS-level screenshots), and check light + dark, empty state, long chat, approval card, settings, model library, narrow window. Include before/after screenshots in your PR. A clean first-run profile: add `--user-data-dir=/tmp/forge-fresh`.

You can run a model locally if Ollama is installed (`ollama pull qwen3:0.6b` is enough for UI work), or use the mock events in `src/main/agent` tests to fake streams.

## Deliverable

PR from `ui/redesign` into `master` with: the redesign, updated `README.md` screenshots, a short `docs/DESIGN.md` (principles, tokens, components, motion rules), and `docs/UI-REQUESTS.md` listing every backend hook you want next.
