// nemotron — 터미널 코딩 에이전트 (VSCode/Android Studio 의 내장 터미널에서 실행).
// 대화형 REPL: 메시지를 입력하면 스트리밍 응답 + 도구 실행.

import * as readline from "readline";
import { ChatMessage } from "../../src/nemotron";
import { loadConfig, saveConfigValue, configPath, CliConfig } from "./config";
import { runAgentTurn, AgentIO } from "./agent";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};
const paint = (c: string, s: string) => c + s + C.reset;

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, res));
}

const HELP = [
  "Commands:",
  "  /help            show this help",
  "  /key <API_KEY>   save your NVIDIA API key (~/.nemotron/config.json)",
  "  /model <id>      set the model id",
  "  /auto            toggle auto-approve for writes/commands",
  "  /verify <cmd>    set a completion-gate command (build/test); empty to disable",
  "  /clear           clear the conversation",
  "  /exit            quit",
  "",
  "Tip: set the key once via env var NVIDIA_API_KEY, or /key. Run from your project root.",
].join("\n");

async function main() {
  let cfg = loadConfig();
  const history: ChatMessage[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let currentAbort: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (currentAbort) {
      currentAbort.abort();
      process.stdout.write(paint(C.yellow, "\n⏹ stopped\n"));
    } else {
      rl.close();
      process.exit(0);
    }
  });

  process.stdout.write(
    paint(C.cyan, "nemotron") +
      paint(C.gray, ` — terminal coding agent  (cwd: ${process.cwd()})\n`) +
      paint(C.gray, "Type a message, or /help. Ctrl+C stops a running turn.\n\n")
  );
  if (!cfg.apiKey) {
    process.stdout.write(
      paint(C.yellow, "No API key found. Set it with:  /key <NVIDIA_API_KEY>  (or env NVIDIA_API_KEY)\n\n")
    );
  }

  let progressActive = false;
  const io: AgentIO = {
    writeContent: (t) => process.stdout.write(t),
    writeReasoning: (t) => process.stdout.write(paint(C.gray, t)),
    writeSystem: (t) => process.stdout.write(paint(C.yellow, "\n" + t + "\n")),
    writeTool: (t) => process.stdout.write(paint(C.cyan, "\n" + t + "\n")),
    writeProgress: (t) => {
      progressActive = true;
      process.stdout.write("\r" + paint(C.gray, "  ↳ " + t) + "\x1b[K");
    },
    endProgress: () => {
      if (progressActive) {
        process.stdout.write("\r\x1b[K");
        progressActive = false;
      }
    },
    confirm: async (summary) => {
      if (cfg.autoApprove) return true;
      const a = await ask(rl, paint(C.yellow, `\n? ${summary}\n  Run this? [y/N] `));
      return /^y(es)?$/i.test(a.trim());
    },
  };

  // 슬래시 명령 처리. true 를 반환하면 명령을 처리한 것.
  async function handleSlash(line: string): Promise<boolean> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        process.stdout.write(paint(C.gray, HELP + "\n"));
        return true;
      case "key":
        if (!arg) {
          process.stdout.write(paint(C.yellow, "Usage: /key <API_KEY>\n"));
          return true;
        }
        saveConfigValue("apiKey", arg);
        cfg = loadConfig();
        process.stdout.write(paint(C.green, `Saved API key to ${configPath()}\n`));
        return true;
      case "model":
        if (!arg) {
          process.stdout.write(paint(C.gray, `model = ${cfg.model}\n`));
          return true;
        }
        saveConfigValue("model", arg);
        cfg = loadConfig();
        process.stdout.write(paint(C.green, `model = ${cfg.model}\n`));
        return true;
      case "auto":
        cfg.autoApprove = !cfg.autoApprove;
        saveConfigValue("autoApprove", cfg.autoApprove);
        process.stdout.write(paint(C.green, `auto-approve = ${cfg.autoApprove}\n`));
        return true;
      case "verify":
        saveConfigValue("verifyCommand", arg);
        cfg = loadConfig();
        process.stdout.write(
          paint(C.green, arg ? `verify command = ${arg}\n` : "verify command cleared\n")
        );
        return true;
      case "clear":
        history.length = 0;
        process.stdout.write(paint(C.green, "conversation cleared\n"));
        return true;
      case "exit":
      case "quit":
        rl.close();
        process.exit(0);
        return true;
      default:
        process.stdout.write(paint(C.yellow, `Unknown command: /${cmd} (try /help)\n`));
        return true;
    }
  }

  // 메인 루프
  for (;;) {
    const line = await ask(rl, paint(C.cyan, "\n› "));
    const input = line.trim();
    if (!input) continue;
    if (input.startsWith("/")) {
      await handleSlash(input);
      continue;
    }
    if (!cfg.apiKey) {
      process.stdout.write(paint(C.yellow, "Set an API key first: /key <NVIDIA_API_KEY>\n"));
      continue;
    }
    history.push({ role: "user", content: input });
    currentAbort = new AbortController();
    try {
      await runAgentTurn(history, cfg, io, currentAbort.signal);
    } catch (e: any) {
      io.writeSystem(`error: ${e?.message ?? e}`);
    } finally {
      io.endProgress();
      currentAbort = null;
      process.stdout.write("\n");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
