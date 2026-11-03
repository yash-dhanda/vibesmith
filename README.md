# Forge

A desktop app that builds software for you. Describe what you want in a chat; an AI agent creates and edits the files on your computer, runs commands and tests, and asks you for what it still needs. It works with local models through Ollama or with your own API keys (Anthropic, OpenAI, OpenRouter).

The editor, file tree and terminal exist but stay hidden behind the **Workspace** button. The app opens as a chat.

## Download

Installers for Linux (`.AppImage`, `.deb`) and Windows (`.exe`) are on the [Releases page](https://github.com/yash-dhanda/vibesmith/releases). They contain only the app, no AI model.

On first start Forge opens its **model library**, like LM Studio:

1. It finds an AI engine on your computer, or downloads the open-source one (Ollama, about 1.5 GB) into its own folder and runs it privately. Nothing is installed system-wide.
2. You pick a model. The library shows which ones fit your graphics card and memory, downloads with progress and a cancel button, and also searches Hugging Face for community models.
3. After that it works fully offline. Cloud models (your own API keys) are optional.

The installers are not code-signed, so Windows SmartScreen and some Linux desktops will warn on first run. Choose "More info, Run anyway" (Windows) or make the AppImage executable (`chmod +x Forge-*.AppImage`).

## Run it from source

```bash
npm install
npm run dev                           # development
scripts/install-desktop.sh            # adds Forge to the app menu and a `forge` command
npm run dist                          # builds the installers for this system into release/
```

For local models install [Ollama](https://ollama.com) and pull one, for example `ollama pull qwen3:8b`. On Arch use the GPU build (`ollama-cuda`); the plain `ollama` package runs on the CPU and is several times slower. Settings > Models shows what Ollama is doing.

## What it does

- **Chats and history.** Every chat is saved, grouped by day, searchable, renamable (double-click). Each chat belongs to one folder.
- **Builds real files.** Asking for something creates the files in your folder, then Forge asks for anything it needs. Secrets go into a `.env` file, never into the chat.
- **Autonomy you choose.** *Ask first* (asks before every change and command), *Auto-edit* (edits freely, asks before commands except safe ones like `npm test`), *Full auto* (needs a project check).
- **Undo.** Each run is snapshotted with git first; the "files changed" card has an Undo button.
- **Checks its own work.** After editing it runs your project's check (`npm test` is detected) and feeds failures back; without one it reviews its own work once.
- **Background work.** Chats keep running while you look at another one. You get a notification when one finishes or needs approval.
- **Long jobs.** Steps and time per run are configurable (up to 200 steps and 2 hours). Old tool output is shrunk automatically when the model's memory fills.
- **Usage.** Tokens read and written, tokens per second, memory use, and a lifetime total with a per-model breakdown (Settings > Usage).

## Safety

All file access is confined to the chat's folder, including through symlinks and new folders. Commands like `sudo`, recursive deletes of `/` or `~`, disk formatting and pipe-to-shell are refused in every mode. Package names are looked up in the npm or PyPI registry before an install. API keys are stored encrypted by the OS keychain and the app refuses to store them if none is available.

## Data

Chats, usage and settings live in `~/.config/forge` (Settings > About opens it). Nothing leaves your computer except requests to the model provider you pick.

## Develop

```bash
npm test          # unit tests
npm run typecheck
npm run eval      # scores a model on 13 real tasks: EVAL_MODEL=ollama:qwen3:8b npm run eval
```

Layout: `src/main` (Electron main process, agent loop, tools, providers), `src/renderer` (the UI), `src/eval` (the task suite).
