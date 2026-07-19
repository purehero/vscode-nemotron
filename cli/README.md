# nemotron-cli

A terminal coding agent for the NVIDIA Nemotron API — the **shared core** meant to be
run from a terminal inside **VSCode** or **Android Studio** (or any terminal).

It reuses the same API client as the VSCode extension (`../src/nemotron.ts`), so
model behaviour stays identical. Add or change a tool/feature here once and both
IDEs get it (they just run this CLI in their built-in terminal).

## What it does

An interactive REPL: you type a request, it streams the model's response and runs
tool calls against your project (the current working directory):

- Files: `list_files`, `read_file`, `write_file`, `edit_file`, `apply_bytes`, `search_text`
- `run_command` — runs a shell command and **waits until it finishes** (builds,
  installs, tests included), showing elapsed time; no timeout, no polling.
- `update_plan` — a task checklist that's injected back into the prompt.
- `remember` / `update_memory` / `forget` — long-term memory saved in
  `.nemotron/memory/` and auto-injected into future prompts.

Robustness ported from the VSCode extension: streaming/empty-response/rate-limit
and transient-tool retries, truncated-write protection, auto-continue when the
model stops mid-task, a completion gate (`/verify <build-or-test-cmd>`), and
context-budget trimming (old tool outputs are compacted to stay within
`maxContextChars`).

Editing quality of life:

- **Diff preview** — every write/edit shows a colorized diff before you approve.
- **Whitespace-tolerant edits** — `edit_file` still matches when indentation or
  spacing differs slightly, so edits fail far less often.
- **`read_file` line ranges** — `offset`/`limit` to read a slice of a big file.
- **`/undo`** — revert the last file edit (restores or deletes as appropriate).
- **`/diag <cmd>`** — runs after every edit (e.g. `npx tsc --noEmit`); if it
  reports problems, the output is fed back so the model fixes them. The CLI
  suggests a command for your project type on startup.
- **Sessions** — the conversation auto-saves to `.nemotron/session.json`; reopen
  and `/resume` to continue where you left off.

File writes and commands ask for confirmation, and the CLI checks in when it has
made a lot of tool calls in one turn. Toggle **auto mode** with `/auto` (or
**Shift+Tab**) to auto-approve writes/commands **and** keep working past the
tool-call limit (up to a hard safety cap) without stopping to ask.

**Keyboard while it's working:** **ESC** pauses at the next safe point (between
steps), **ESC again** stops the turn, **Enter** resumes; **Shift+Tab** toggles
auto mode. `Ctrl+C` also stops (press again at the prompt to quit).

## Run it (needs Node 18+, works on Windows & macOS)

```bash
cd cli
node build.mjs                 # bundle -> dist/nemotron.cjs  (esbuild from repo root)
export NVIDIA_API_KEY=nvapi-…  # or use /key inside the REPL
cd /path/to/your/project       # run from the project you want to work in
node /path/to/cli/dist/nemotron.cjs
```

Inside the REPL: `/help`, `/key <API_KEY>`, `/model <id>`, `/auto`, `/clear`, `/exit`.
`Ctrl+C` stops a running turn; again to quit. Config is saved to `~/.nemotron/config.json`.

## Standalone binaries (no Node required — for Windows & macOS)

Uses [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) to cross-compile from one machine:

```bash
cd cli
node build.mjs
npx @yao-pkg/pkg dist/nemotron.cjs \
  --targets node18-win-x64,node18-macos-arm64,node18-macos-x64 \
  --out-path bin
# -> bin/nemotron-win-x64.exe, bin/nemotron-macos-arm64, bin/nemotron-macos-x64
```

Put the binary on your PATH and run `nemotron` from any project directory.

## Using it from an IDE (approach A — terminal)

- **VSCode**: open the integrated terminal (`` Ctrl+` ``) and run `nemotron`.
- **Android Studio**: open the Terminal tool window and run `nemotron`.

No IDE plugin is required for this mode — the CLI is the whole product. Richer
in-editor integration (native diff, live diagnostics) can be layered on later.

## Status

Working core. Ported from the VSCode extension: files/search/run tools, memory,
plan, retries, completion gate, context trimming.

Not yet ported (planned): `run_agent` (sub-agents — needs an agents config),
model-based summarization of old tool output (the CLI uses rule-based compaction
for now), and `get_diagnostics` (the extension uses the IDE language server; the
CLI would need `tsc`/`eslint`/per-language checks instead).

The tool-call parser is currently duplicated from the extension (`src/tools.ts`);
a later step will extract it into a shared module for a single source of truth.
