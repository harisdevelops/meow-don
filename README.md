# Meow-Don

A zero-dependency local browser workspace for the [Pi](https://pi.dev) coding agent—combining multi-repository **git worktree orchestration**, **conversation rewinding**, **live system & context telemetry**, and **10 cat-inspired themes** on top of Pi's headless JSONL RPC mode.

## Features

- **Multi-Workspace & Git Worktrees** — Launch from anywhere. Open local repositories (with native macOS folder picker), spin up isolated git worktrees on new branches, and run parallel Pi sessions concurrently with live status indicators.
- **Conversation Rewind & Forking** — Rewind to any previous user message (hover `↺ Rewind`, toolbar button, or press `Esc` twice) using Pi's session tree, restoring the prompt into the composer to edit and branch.
- **Model & Thinking Controls** — Switch models (grouped by provider) and reasoning/thinking levels independently per worktree.
- **Live Context & System Monitor** — Track context window %, token usage, estimated cost, one-click context compaction, per-session Pi RAM (with a quick stop button to reclaim memory), and host CPU/RAM/battery stats.
- **10 Cat Themes & 4 Typography Presets** — Includes official Catppuccin palettes (Mocha, Macchiato, Frappé, Latte) plus Ginger Tabby, Siamese Cream, Sakura Neko, Russian Blue, Tuxedo Cat, and Black Cat Midnight—each with its own pure-CSS ambient background animation, syntax highlighting, and selectable font pairings (*Studio*, *Claude Editorial*, *Codex/Linear*, *Technical*).
- **Low-Overhead Privacy Blur & Roaming Cat** — Optional away-blur softens the workspace when focus leaves the window while keeping the 3.2 KB `oneko.js` pixel cat sharp and enlarged.
- **Zero External Dependencies** — Pure Node.js HTTP + SSE bridge (`~40 MB` RSS) with strict LF-only UTF-8 JSONL framing and in-place DOM patching for flicker-free token streaming.

## Requirements

- [Pi](https://pi.dev) installed and available on your `PATH` (`pi --mode rpc`)
- Node.js 18+

## Quick Start

```bash
git clone https://github.com/harisdevelops/meow-don.git
cd meow-don
npm link
meow-don
```

Or run directly without linking:

```bash
node server.mjs
```

### CLI Options

```bash
meow-don --port 4000     # Use a custom port (default: 3456, auto-increments if busy)
meow-don --no-open       # Start without automatically opening the browser
meow-don --no-session    # Forward any standard Pi CLI flags directly to `pi --mode rpc`
```

## Keyboard Shortcuts

- `Enter` — Send message (`Shift+Enter` for newline)
- `⌘K` / `Ctrl+K` — Focus composer
- `Esc` — Abort active generation
- `Esc` twice (empty input) — Open Rewind modal

## Architecture

- `server.mjs` — Local Node HTTP + SSE server that lazily manages one `pi --mode rpc` subprocess per active worktree `cwd`, parses stdout with a strict LF-only byte buffer, and exposes workspace/worktree/telemetry endpoints.
- `index.html` — Self-contained single-file UI with incremental Markdown + syntax highlighting, extension UI modal support (`confirm`, `select`, `input`, `editor`), and compositor-only animations.
- `oneko.js` / `oneko.gif` — Local MIT-licensed 3.2 KB cursor-following pixel cat sprite.

## License

MIT
