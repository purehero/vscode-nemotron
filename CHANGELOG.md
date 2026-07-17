# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Screen capture + vision (macOS): the AI can capture a specific app's window
  with the `capture_screen` tool (target by app name, or the full screen),
  send it to an NVIDIA vision model (`nemotron.visionModel`), and get back a
  text analysis — useful for verifying GUI/layout/visual bugs. Gated by
  `nemotron.enableScreenCapture`; requires VS Code Screen Recording (and
  Accessibility, for per-app capture) permission.
- Automatic retry for transient/signal tool failures: `run_command` calls that
  die from a signal (e.g. SIGKILL/SIGTERM/SIGSEGV) or a crashed shell are
  retried (up to 2×, with backoff), instead of failing immediately. Common on
  macOS.
- Long-term memory: the AI can save lessons, preferences, and project
  conventions across sessions with the `remember`, `update_memory`, and
  `forget` tools. Saved memories (`.nemotron/memory/`) are auto-injected into
  the prompt so it stops repeating the same mistakes. Toggle with
  `nemotron.enableMemory`; cap injection with `nemotron.maxMemoryChars`.

### Changed

- The chat view now registers itself in the right-hand Secondary Side Bar
  declaratively (`viewsContainers.secondarySidebar`, like Claude Code) instead
  of moving itself at runtime. Requires VSCode 1.106+.

## [0.2.1] - 2026-07-16

Initial public release.

### Added

- Chat sidebar with streaming responses and a collapsible reasoning (thinking) view.
- Agentic tool loop: `list_files`, `read_file`, `search_text`, `edit_file`
  (exact-match partial edits), `apply_bytes` (byte-level edits), `write_file`,
  `run_command` (persistent bash session), `get_diagnostics` (with GDScript CLI
  fallback), `list_symbols`, `find_definition`, `find_references` (language
  server), `run_agent` (sub-agents, incl. image generation), `update_plan`
  (live plan checklist).
- `/model` and `/agents` can fetch the live model catalog from the NVIDIA API.
- Sessions: auto-save after every response and tool round, restore on startup,
  interrupted-task detection with one-click continue (`/continue`).
- Robust agent loop: empty-response retry, malformed-tool-call retry,
  "Task completed." completion protocol with automatic continuation
  (bilingual EN/KO detection).
- Approvals: native diff preview, auto-approve mode (`/auto`), `/undo`
  (up to 20 backups).
- Sliding-window RPM limiter, tool-iteration budget, token usage report.
- `NEMOTRON.md` project instructions with AI-generated bootstrap (`/init`).
- 24 slash commands, input history (↑/↓), plan panel, session top bar,
  build version tag in the UI.

[Unreleased]: https://github.com/purehero/vscode-nemotron/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/purehero/vscode-nemotron/releases/tag/v0.2.1
