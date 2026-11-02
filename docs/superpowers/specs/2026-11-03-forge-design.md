# Forge: desktop code editor with an autonomous local/API AI agent

Date: 2026-11-03

## Goal

A desktop code editor (not a website, not an extension) with a built-in autonomous coding agent. The agent reads and edits real files, runs commands, and uses either local models (Ollama) or API-key providers.

## Decisions

- Stack: Electron + Monaco + TypeScript. One language for UI, file access, terminal, agent loop.
- Autonomy: three modes, switchable per session: `ask-all`, `auto-edit`, `full-auto`.
- Models: configurable per provider, not hardcoded. Laptop (RTX 5070, 8GB) runs an 8B-class model. Desktop (3090 Ti, 24GB) runs a ~27B-class model.
- Out of scope for v1: LSP, debugger, extensions, multi-window, second-model review pass.

## Architecture

- **Main process (Node):** file access, terminals (`node-pty`), git, agent loop. The agent keeps running if the UI reloads.
- **Renderer:** Monaco editor, file tree, tabs, `xterm.js` terminal, agent panel (goal box, live step log, mode switch, stop button).
- **IPC:** renderer sends `agent:start {goal, mode, model}`; main emits `agent:event` and `approval:request`.
- **Model layer:** one interface, many providers: Ollama (`localhost:11434`), Anthropic, OpenAI, OpenRouter. Vercel AI SDK. API keys in OS keychain via Electron `safeStorage`.

## Agent loop

1. Git checkpoint on a hidden ref (working tree untouched). No repo: ask, then `git init`.
2. Loop: model call, tool call, validate, autonomy gate, execute, result to model and to UI.
3. Gate returns `ask`: UI shows approve/deny, loop waits.
4. End: run the project's verify command. Pass = done. Fail = real output goes back to the model.
5. Stop button aborts via `AbortController`.

Tools: `read_file`, `edit_file`, `list_dir`, `search` (ripgrep), `run_command`.

Caps: 50 steps, 30 minutes, token budget. A cap or a stuck loop (same failing call 3 times, or no file change in N steps) ends the run with a summary.

## Hallucination guards

Deterministic checks, not model self-review.

- `edit_file` takes old text and new text. Matching tiers: exact, whitespace-tolerant, fuzzy. Fails on no match or multiple matches. Returns a diff.
- Syntax check (tree-sitter) after every edit. A broken file is reverted.
- Read-before-edit enforced in code: edit rejected unless the file was read this run and is unchanged since.
- Closed-world tool check: unknown tool names or args are rejected with a plain error. Near-miss tool names are fuzzy-matched for small models.
- Tool-call parser accepts JSON and XML-tag formats (some Qwen models emit XML).
- Ollama `num_ctx` set explicitly to 16k-32k. Default is too small and causes truncation that looks like hallucination.
- Typecheck/tests after edits catch invented functions and attributes.
- Package existence check against the registry before `npm install` / `pip install`.
- Path jail: every path resolved (including symlinks) and confined to the open project folder.
- `full-auto` requires a verify command; without one nothing checks the model's work.

## Error handling

- Ollama down or model missing: clear message, no retry loop.
- API 429/5xx: backoff, 3 tries, then stop.
- Tool errors return to the model as text so it can recover.
- App crash mid-run: checkpoint ref survives. "Undo last run" button restores it.

## Testing (Vitest)

- Unit: edit matching, path jail (`../`, symlinks), gate table (mode x tool), tool-call parser.
- Integration: scripted fake model replays tool calls through the real loop.
- Eval script: 10 fixed tasks scored against any configured model on this harness. Public benchmarks do not test this tool loop, so this picks the "best" model.

## Build order

1. Shell: Electron + Monaco + file tree + tabs + terminal. Opens and edits real files.
2. Agent core: one provider, 3 tools, `ask-all` mode.
3. Ollama, all tools, all guards, all 3 modes.
4. Checkpoint/undo, verify loop, eval script.

## Model notes

- Laptop: `qwen3:8b` (Q4, ~5.2GB). 8GB GPU has ~1.9GB used by the desktop, so a 9B (~6.6GB) does not fit. Run Ollama with `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` to save VRAM.
- Desktop: Qwen ~27B class (tag to be verified on ollama.com/library before pulling).
- Third-party benchmarks and Ollama tool-calling reports for Qwen models are mixed; the eval script decides.
