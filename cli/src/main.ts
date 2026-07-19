// nemotron — 터미널 코딩 에이전트 (VSCode/Android Studio 의 내장 터미널에서 실행).
// 대화형 REPL: 메시지를 입력하면 스트리밍 응답 + 도구 실행.

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { ChatMessage } from "../../src/nemotron";
import { loadConfig, saveConfigValue, configPath } from "./config";
import { runAgentTurn, AgentIO } from "./agent";
import { PlanItem } from "./tools";
import { saveSession, loadSession, clearSession } from "./session";

/** 프로젝트 유형을 보고 진단 명령 기본값을 추정한다(제안용). */
function suggestDiagnostics(root: string): string {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  if (has("tsconfig.json")) return "npx tsc --noEmit";
  if (has("build.gradle") || has("build.gradle.kts")) return "./gradlew compileDebugKotlin -q";
  if (has("Cargo.toml")) return "cargo check";
  if (has("go.mod")) return "go build ./...";
  if (has("pyproject.toml") || has("requirements.txt")) return "ruff check .";
  return "";
}

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
  "  /auto            toggle auto mode: auto-approve writes/commands + keep going past the tool-call limit",
  "  /verify <cmd>    set a completion-gate command (build/test); empty to disable",
  "  /diag <cmd>      run this after each edit and feed problems back; empty to disable",
  "  /undo            revert the last file edit",
  "  /resume          restore the previous conversation for this project",
  "  /clear           clear the conversation",
  "  /exit            quit",
  "",
  "Keys (while it's working): ESC = pause, ESC again = stop, Enter = resume;  Shift+Tab = toggle auto mode.",
  "Tip: set the key once via env var NVIDIA_API_KEY, or /key. Run from your project root.",
].join("\n");

async function main() {
  let cfg = loadConfig();
  const history: ChatMessage[] = [];
  const plan: PlanItem[] = [];
  const undoStack: { path: string; prior: string | null }[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let currentAbort: AbortController | null = null;
  let turnActive = false;
  let turnPaused = false;
  let resumeWaiters: (() => void)[] = [];
  const resumeTurn = () => {
    turnPaused = false;
    const waiters = resumeWaiters;
    resumeWaiters = [];
    waiters.forEach((r) => r());
  };
  const stopTurn = () => {
    currentAbort?.abort();
    resumeTurn(); // 일시정지 대기 중이면 깨워서 중단되게
  };

  rl.on("SIGINT", () => {
    if (currentAbort) {
      stopTurn();
      process.stdout.write(paint(C.yellow, "\n⏹ stopped\n"));
    } else {
      rl.close();
      process.exit(0);
    }
  });

  // 키 입력: ESC(1회 일시정지 / 2회 정지), Shift+Tab(auto 토글), 일시정지 중 Enter=재개
  readline.emitKeypressEvents(process.stdin, rl);
  process.stdin.on("keypress", (_str, key) => {
    if (!key) return;
    // Shift+Tab → auto 모드 토글 (언제든)
    if (key.name === "tab" && key.shift) {
      cfg.autoApprove = !cfg.autoApprove;
      saveConfigValue("autoApprove", cfg.autoApprove);
      process.stdout.write(
        paint(C.green, `\n⚡ auto mode = ${cfg.autoApprove ? "ON" : "off"}\n`)
      );
      return;
    }
    if (!turnActive) return;
    if (key.name === "escape") {
      if (!turnPaused) {
        turnPaused = true;
        process.stdout.write(
          paint(C.yellow, "\n⏸ paused — ESC again to stop, Enter to resume\n")
        );
      } else {
        process.stdout.write(paint(C.yellow, "\n⏹ stopped\n"));
        stopTurn();
      }
      return;
    }
    if (key.name === "return" && turnPaused) {
      process.stdout.write(paint(C.green, "▶ resumed\n"));
      resumeTurn();
    }
  });
  // 작업 중에도 키 입력이 잡히도록 raw 모드 유지(종료 시 복원)
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* 비TTY(파이프)면 무시 */
    }
  }
  const restoreTty = () => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
  };
  process.on("exit", restoreTty);

  process.stdout.write(
    paint(C.cyan, "nemotron") +
      paint(C.gray, ` — terminal coding agent  (cwd: ${process.cwd()})\n`) +
      paint(C.gray, "Type a message, or /help.  ESC = pause (ESC again = stop) · Shift+Tab = auto mode\n\n")
  );
  if (!cfg.apiKey) {
    process.stdout.write(
      paint(C.yellow, "No API key found. Set it with:  /key <NVIDIA_API_KEY>  (or env NVIDIA_API_KEY)\n")
    );
  }
  if (loadSession(process.cwd())) {
    process.stdout.write(paint(C.gray, "A previous session for this project exists — /resume to continue it.\n"));
  }
  if (!cfg.diagnosticsCommand) {
    const sug = suggestDiagnostics(process.cwd());
    if (sug) {
      process.stdout.write(
        paint(C.gray, `Tip: auto-check edits with  /diag ${sug}\n`)
      );
    }
  }
  process.stdout.write("\n");

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
    confirm: async (summary, diff) => {
      if (diff) {
        const colored = diff
          .split("\n")
          .map((l) =>
            l.startsWith("+ ")
              ? paint(C.green, l)
              : l.startsWith("- ")
                ? paint(C.red, l)
                : paint(C.gray, l)
          )
          .join("\n");
        process.stdout.write("\n" + colored + "\n");
      }
      if (cfg.autoApprove) return true;
      const a = await ask(rl, paint(C.yellow, `? ${summary}\n  Apply? [y/N] `));
      return /^y(es)?$/i.test(a.trim());
    },
    onBackup: (rel, prior) => undoStack.push({ path: rel, prior }),
    checkpoint: async () => {
      while (turnPaused && !currentAbort?.signal.aborted) {
        await new Promise<void>((res) => resumeWaiters.push(res));
      }
    },
    confirmContinue: async (count) => {
      if (cfg.autoApprove) return true;
      const a = await ask(
        rl,
        paint(C.yellow, `\n⚠️ ${count} tool calls so far. Keep going? [y/N] (or /auto for automatic) `)
      );
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
        process.stdout.write(
          paint(
            C.green,
            `auto mode = ${cfg.autoApprove ? "ON ⚡ (auto-approve + auto-extend the tool-call limit)" : "off"}\n`
          )
        );
        return true;
      case "verify":
        saveConfigValue("verifyCommand", arg);
        cfg = loadConfig();
        process.stdout.write(
          paint(C.green, arg ? `verify command = ${arg}\n` : "verify command cleared\n")
        );
        return true;
      case "diag":
        saveConfigValue("diagnosticsCommand", arg);
        cfg = loadConfig();
        process.stdout.write(
          paint(C.green, arg ? `diagnostics command = ${arg}\n` : "diagnostics disabled\n")
        );
        return true;
      case "undo": {
        const last = undoStack.pop();
        if (!last) {
          process.stdout.write(paint(C.yellow, "nothing to undo\n"));
          return true;
        }
        const abs = path.resolve(process.cwd(), last.path);
        try {
          if (last.prior === null) {
            fs.rmSync(abs, { force: true });
            process.stdout.write(paint(C.green, `undo: removed ${last.path} (was newly created)\n`));
          } else {
            fs.writeFileSync(abs, last.prior, "utf8");
            process.stdout.write(paint(C.green, `undo: restored ${last.path}\n`));
          }
        } catch (e: any) {
          process.stdout.write(paint(C.red, `undo failed: ${e?.message ?? e}\n`));
        }
        return true;
      }
      case "resume": {
        const s = loadSession(process.cwd());
        if (!s) {
          process.stdout.write(paint(C.yellow, "no saved session for this project\n"));
          return true;
        }
        history.length = 0;
        history.push(...s.history);
        plan.length = 0;
        plan.push(...s.plan);
        process.stdout.write(
          paint(C.green, `resumed session (${s.history.length} messages, saved ${s.savedAt})\n`)
        );
        return true;
      }
      case "clear":
        history.length = 0;
        plan.length = 0;
        clearSession(process.cwd());
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
    turnActive = true;
    try {
      await runAgentTurn(history, plan, cfg, io, currentAbort.signal);
    } catch (e: any) {
      io.writeSystem(`error: ${e?.message ?? e}`);
    } finally {
      turnActive = false;
      turnPaused = false;
      resumeWaiters = [];
      io.endProgress();
      currentAbort = null;
      saveSession(process.cwd(), history, plan); // 종료 후 /resume 으로 이어가기
      process.stdout.write("\n");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
