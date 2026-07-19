# Nemotron Chat — VSCode Extension

> [한국어 문서](README.ko.md)

An AI chat and coding assistant for VSCode powered by the **NVIDIA Nemotron API**.
It runs an agentic loop directly inside VSCode: the model can read and edit your
workspace, run commands, inspect diagnostics, and delegate to specialized
sub-agents until a task is done. Because API calls are made from the extension
host (Node.js), there are no CORS issues.

## Features

- **Chat sidebar** — real-time streaming responses with a collapsible
  `💭 Thinking` (reasoning) view, conversation memory, and markdown/code rendering.
- **Agentic tools** — the model works with your workspace through a ReAct-style
  tool loop:

  | Tool | What it does |
  | --- | --- |
  | `list_files` | List workspace files (glob) |
  | `read_file` | Read a file's contents |
  | `search_text` | Grep file contents (text or regex) |
  | `edit_file` | Partial edit via `<<<OLD/<<<NEW/<<<END` blocks (no whole-file rewrites) |
  | `apply_bytes` | Byte-level partial edit using before/after files (for special characters / large content) |
  | `write_file` | Create or fully replace a file |
  | `run_command` | Run a terminal command. Runs as a background job: quick commands return output inline, long ones (builds/installs/tests/servers) keep running past the timeout and return a job id instead of failing |
  | `check_command` | Poll a running command for new output and its exit status |
  | `stop_command` | Terminate a running command |
  | `get_diagnostics` | Read editor errors/warnings (with a GDScript CLI fallback) |
  | `list_symbols` | List document or workspace symbols (language server) |
  | `find_definition` | Find a symbol's definition (language server) |
  | `find_references` | Find a symbol's references (language server) |
  | `run_agent` | Delegate a sub-task to a specialized sub-agent (including image generation) |
  | `update_plan` | Create/update the task plan (checklist) |

- **Sessions** — conversations auto-save after every response and restore on
  startup. Start a new one with `/new`, browse/restore/delete past sessions with
  `/history`, and resume an interrupted task with `/continue`.
- **Plan panel** — when the model builds a multi-step plan with `update_plan`, a
  live checklist is shown at the top of the chat.
- **Slash commands** — type `/` in the input box for an autocomplete menu:

  | Command | Description |
  | --- | --- |
  | `/continue` | Continue the previous task |
  | `/new`, `/history` | New session / session history |
  | `/init` | Auto-generate or open `NEMOTRON.md` |
  | `/auto` | Toggle auto-approve mode |
  | `/agents` | Manage sub-agents (sync from NVIDIA catalog) |
  | `/model`, `/system` | Select model / edit system prompt |
  | `/temperature`, `/topp`, `/maxtokens`, `/reasoning` | Generation parameters |
  | `/rpm`, `/iterations` | Rate limit / tool-call limit |
  | `/thinking`, `/tools`, `/context` | Toggle thinking / file tools / auto-context |
  | `/autowrite`, `/autorun`, `/diff`, `/shell` | Approval and shell options |
  | `/undo` | Undo the last AI file edit |
  | `/save`, `/load` | Export/import a conversation to `.nemotron/chats/` |
  | `/usage`, `/settings`, `/apikey`, `/clear` | Utilities |

- **Approvals** — file changes are shown in a native diff view for you to allow
  or reject; auto-mode (`/auto`) skips confirmations; `/undo` restores the last
  edit (up to 20 backups). Code blocks in responses get 📋 Copy / 📝 Apply to
  Editor / ➕ New File buttons.
- **Rate limiting** — a sliding-window RPM limiter waits automatically when the
  configured request rate is exceeded.
- **NEMOTRON.md project instructions** — place a `NEMOTRON.md` file in the
  workspace root and its contents are always included in the system prompt. Run
  `/init` to have the AI analyze the project and write one for you.

## Requirements

- VSCode ≥ 1.90
- An NVIDIA API key (`nvapi-...`) from [build.nvidia.com](https://build.nvidia.com)

## Installation

### From VSIX

Download or build a `.vsix`, then in VSCode open the Extensions view →
`...` menu → **Install from VSIX…** and select the file.

### From source

```bash
cd vscode-nemotron
npm install          # install dependencies
npm run build        # produce out/extension.js (esbuild)
npm install -g @vscode/vsce
vsce package         # produce nemotron-chat-<version>.vsix
```

To develop interactively, open this folder in VSCode and press **F5**
(Run Extension) to launch a new window with the extension loaded.

## Quick Start

1. Click the **Nemotron** icon in the activity bar.
2. Run `Nemotron: Set API Key` from the Command Palette (Ctrl+Shift+P) and paste
   your `nvapi-...` key.
3. Type a message and press Enter. Run `/init` to generate project instructions
   for the AI.

## Configuration

Settings live under `nemotron.*` in `settings.json`. Common ones:

| Setting | Default | Description |
| --- | --- | --- |
| `nemotron.model` | `nvidia/nemotron-3-ultra-550b-a55b` | Model ID to use |
| `nemotron.systemPrompt` | (see settings) | System prompt |
| `nemotron.enableThinking` | `true` | Show the reasoning process |
| `nemotron.enableTools` | `true` | Allow workspace file tools |
| `nemotron.autoMode` | `false` | Auto-approve edits and commands |
| `nemotron.maxRpm` | `40` | Max API requests per minute |
| `nemotron.maxToolIterations` | `25` | Max tool-call round trips per request |
| `nemotron.agents` | (see settings) | Sub-agent definitions for `run_agent` |

See the Settings UI (`/settings`) for the full list, including temperature,
top_p, token budgets, timeouts, and diff/context options.

## Security Notes

- The extension only activates in **trusted workspaces** (it reads and writes
  files).
- File access is restricted to the current workspace; paths outside the
  workspace root are rejected.
- By default, every file write and command execution requires **approval** via a
  diff preview or a modal dialog. Auto-approve options exist but should be used
  with care.
- The API key is stored in VSCode **SecretStorage** (encrypted), not in settings.

## Development

```bash
npm run build       # one-off build (esbuild)
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
```

## API

- Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions` (OpenAI-compatible)
- Streaming SSE distinguishes `delta.reasoning_content` (thinking) from
  `delta.content` (answer).

## License

MIT — see [LICENSE](LICENSE).
