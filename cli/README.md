# nemotron-cli

A terminal coding agent for the NVIDIA Nemotron API — the **shared core** meant to be
run from a terminal inside **VSCode** or **Android Studio** (or any terminal).

It reuses the same API client as the VSCode extension (`../src/nemotron.ts`), so
model behaviour stays identical. Add or change a tool/feature here once and both
IDEs get it (they just run this CLI in their built-in terminal).

## What it does

An interactive REPL: you type a request, it streams the model's response and runs
tool calls against your project (the current working directory):

- `list_files`, `read_file`, `write_file`, `edit_file`, `search_text`
- `run_command` — runs a shell command and **waits until it finishes** (builds,
  installs, tests included), showing elapsed time; no timeout, no polling.

File writes and commands ask for confirmation unless auto-approve is on (`/auto`).

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

MVP. The tool-call parser is currently duplicated from the extension
(`src/tools.ts`); a later step will extract it into a shared module so there is a
single source of truth for both.
