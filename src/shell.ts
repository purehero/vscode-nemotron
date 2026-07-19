// 지속 터미널 세션: run_command 사이에 cd/가상환경/환경변수가 유지된다.
// 명령 뒤에 센티널 echo 를 붙여 완료 시점과 종료코드를 감지한다.

import * as cp from "child_process";
import * as fs from "fs";

const SENTINEL = "__NEMO_DONE__";
const PROMPT_MARK = "__NEMO_PS__>";
const MAX_OUTPUT = 20_000;

export interface ShellInfo {
  kind: "bash" | "cmd";
  path: string;
}

let cachedShell: ShellInfo | undefined;

/** 로컬 bash(Git Bash 포함)를 찾는다. 없으면 cmd.exe 로 폴백. */
export function detectShell(): ShellInfo {
  if (cachedShell) {
    return cachedShell;
  }
  if (process.platform !== "win32") {
    cachedShell = { kind: "bash", path: "/bin/bash" };
    return cachedShell;
  }
  const candidates = [
    process.env["ProgramFiles"] &&
      process.env["ProgramFiles"] + "\\Git\\bin\\bash.exe",
    process.env["ProgramFiles(x86)"] &&
      process.env["ProgramFiles(x86)"] + "\\Git\\bin\\bash.exe",
    process.env["LOCALAPPDATA"] &&
      process.env["LOCALAPPDATA"] + "\\Programs\\Git\\bin\\bash.exe",
    "C:\\Git\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        cachedShell = { kind: "bash", path: c };
        return cachedShell;
      }
    } catch {
      /* ignore */
    }
  }
  cachedShell = { kind: "cmd", path: "cmd.exe" };
  return cachedShell;
}

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  /** 셸 세션이 명령 도중 예기치 않게 종료됨(시그널 등) — 재시도 대상 */
  crashed?: boolean;
}

export class PersistentShell {
  private proc?: cp.ChildProcess;
  private starting?: Promise<cp.ChildProcess>;

  constructor(private readonly cwd: string) {}

  dispose(): void {
    const p = this.proc;
    this.proc = undefined;
    if (!p) {
      return;
    }
    try {
      if (process.platform === "win32" && p.pid) {
        // 자식 프로세스까지 트리 전체 강제 종료
        cp.spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        p.kill("SIGKILL");
      }
    } catch {
      /* ignore */
    }
  }

  private alive(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  /** 셸을 (재)기동하고 시작 배너를 소진한다. */
  private async ensure(): Promise<cp.ChildProcess> {
    if (this.alive()) {
      return this.proc!;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = new Promise((resolve) => {
      const sh = detectShell();
      const proc =
        sh.kind === "cmd"
          ? cp.spawn(sh.path, ["/Q", "/K"], { cwd: this.cwd, windowsHide: true })
          : cp.spawn(sh.path, [], { cwd: this.cwd, windowsHide: true });
      this.proc = proc;
      proc.on("close", () => {
        if (this.proc === proc) {
          this.proc = undefined;
        }
      });
      // 시작 배너/프롬프트를 센티널로 씻어낸다
      let buf = "";
      const onData = (b: Buffer) => {
        buf += b.toString("utf8");
        if (buf.includes(SENTINEL)) {
          cleanup();
          resolve(proc);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        proc.stderr?.off("data", onData);
        this.starting = undefined;
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(proc); // 배너가 없어도 계속 진행
      }, 3000);
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.stdin?.write(
        sh.kind === "cmd"
          ? `prompt __NEMO_PS__$G\r\necho ${SENTINEL}\r\n`
          : `echo ${SENTINEL}\n`
      );
    });
    return this.starting;
  }

  async run(command: string, timeoutMs: number): Promise<ShellResult> {
    const proc = await this.ensure();
    const sh = detectShell();
    return new Promise((resolve) => {
      let out = "";
      const doneRe = new RegExp(SENTINEL + "(-?\\d+)");
      const onData = (b: Buffer) => {
        out += b.toString("utf8");
        if (out.length > MAX_OUTPUT * 2) {
          cleanup();
          this.dispose(); // 폭주 출력 → 세션 재시작
          resolve({
            code: null,
            output: out.slice(0, MAX_OUTPUT) + "\n…(output truncated, shell restarted)",
            timedOut: false,
          });
          return;
        }
        const m = out.match(doneRe);
        if (m) {
          cleanup();
          // 센티널 이후 제거 + 프롬프트 마커 제거
          const cut = out.slice(0, out.search(doneRe));
          const cleaned = cut
            .split(/\r?\n/)
            .map((l) =>
              l.startsWith(PROMPT_MARK) ? l.slice(PROMPT_MARK.length) : l
            )
            .filter((l) => !l.includes(SENTINEL) && !l.startsWith("prompt __NEMO_PS__"))
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          resolve({
            code: Number(m[1]),
            output: cleaned.slice(0, MAX_OUTPUT),
            timedOut: false,
          });
        }
      };
      const onClose = () => {
        cleanup();
        resolve({
          code: null,
          output: out.slice(0, MAX_OUTPUT) + "\n(shell session ended)",
          timedOut: false,
          crashed: true, // 명령 도중 셸이 죽음 → 다음 실행 때 재기동, 재시도 대상
        });
      };
      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        proc.stderr?.off("data", onData);
        proc.off("exit", onClose);
        proc.off("close", onClose);
      };
      // exit: 자식이 stdio 파이프를 잡고 있어도 셸 종료 즉시 감지
      proc.on("exit", onClose);
      proc.on("close", onClose);
      // timeoutMs <= 0 → 무제한(명령이 끝날 때까지 대기, 죽이지 않음)
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              cleanup();
              this.dispose(); // 멈춘 명령 → 세션 재시작
              resolve({
                code: null,
                output: out.slice(0, MAX_OUTPUT),
                timedOut: true,
              });
            }, timeoutMs)
          : undefined;
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      const suffix =
        sh.kind === "cmd"
          ? `\r\necho ${SENTINEL}%errorlevel%\r\n`
          : `\necho ${SENTINEL}$?\n`;
      proc.stdin?.write(command + suffix);
    });
  }
}
