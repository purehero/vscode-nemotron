// 백그라운드 명령 실행: 오래 걸리는 명령(빌드/설치/테스트/개발서버)을
// 죽이지 않고 별도 프로세스로 띄운 뒤, check_command 로 진행 상황을 폴링한다.
// run_command 의 동기 타임아웃과 달리 완료를 기다리지 않으므로 타임아웃 실패가 없다.

import * as cp from "child_process";
import { detectShell } from "./shell";

// 조회 사이에 쌓이는 미확인 출력의 상한. 초과분은 앞쪽을 버린다(빌드 로그는 꼬리가 중요).
const MAX_BUFFER = 20_000;

export interface BgStatus {
  id: string;
  command: string;
  /** 아직 실행 중인가 */
  running: boolean;
  code: number | null;
  signal: string | null;
  elapsedMs: number;
  /** 직전 조회 이후 새로 발생한 출력 */
  newOutput: string;
  /** 버퍼 초과로 앞부분이 버려짐 */
  dropped: boolean;
  /** 해당 id 의 잡이 존재하는가 */
  exists: boolean;
}

export interface BgSummary {
  id: string;
  command: string;
  running: boolean;
  code: number | null;
  elapsedMs: number;
}

interface Job {
  id: string;
  command: string;
  proc: cp.ChildProcess;
  buffer: string;
  dropped: boolean;
  running: boolean;
  code: number | null;
  signal: string | null;
  startedAt: number;
}

/** 프로세스 트리 전체를 강제 종료(Windows 는 자식까지). */
function killTree(proc: cp.ChildProcess): void {
  try {
    if (process.platform === "win32" && proc.pid) {
      cp.spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  }
}

export class BackgroundJobs {
  private jobs = new Map<string, Job>();
  private seq = 0;

  constructor(private readonly cwd: string) {}

  /** 명령을 백그라운드로 띄우고 잡 id 를 반환한다. */
  start(command: string): string {
    const sh = detectShell();
    const proc =
      sh.kind === "bash"
        ? cp.spawn(sh.path, ["-c", command], { cwd: this.cwd, windowsHide: true })
        : cp.spawn(command, { cwd: this.cwd, shell: true, windowsHide: true });
    const id = `bg${++this.seq}`;
    const job: Job = {
      id,
      command,
      proc,
      buffer: "",
      dropped: false,
      running: true,
      code: null,
      signal: null,
      startedAt: Date.now(),
    };
    const capture = (b: Buffer) => {
      job.buffer += b.toString("utf8");
      if (job.buffer.length > MAX_BUFFER) {
        job.buffer = job.buffer.slice(job.buffer.length - MAX_BUFFER);
        job.dropped = true;
      }
    };
    proc.stdout?.on("data", capture);
    proc.stderr?.on("data", capture);
    proc.on("error", (e) => {
      job.buffer += `\nExecution error: ${e.message}`;
      job.running = false;
    });
    proc.on("close", (code, signal) => {
      job.running = false;
      job.code = code;
      job.signal = signal;
    });
    this.jobs.set(id, job);
    return id;
  }

  /**
   * 잡 상태 + 직전 조회 이후의 새 출력을 반환하고 버퍼를 비운다.
   * 이미 종료된 잡은 최종 출력을 넘겨준 뒤 목록에서 제거한다(중복 폴링 방지).
   */
  check(id: string): BgStatus {
    const job = this.jobs.get(id);
    if (!job) {
      return {
        id,
        command: "",
        running: false,
        code: null,
        signal: null,
        elapsedMs: 0,
        newOutput: "",
        dropped: false,
        exists: false,
      };
    }
    const newOutput = job.buffer;
    const dropped = job.dropped;
    job.buffer = "";
    job.dropped = false;
    const status: BgStatus = {
      id,
      command: job.command,
      running: job.running,
      code: job.code,
      signal: job.signal,
      elapsedMs: Date.now() - job.startedAt,
      newOutput,
      dropped,
      exists: true,
    };
    // 끝난 잡은 최종 조회 후 정리 → 맵 누수 방지
    if (!job.running) {
      this.jobs.delete(id);
    }
    return status;
  }

  /** 잡을 강제 종료한다. 존재하지 않으면 false. */
  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) {
      return false;
    }
    killTree(job.proc);
    job.running = false;
    return true;
  }

  /** 살아있는 잡 목록(요약). */
  list(): BgSummary[] {
    const now = Date.now();
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      command: j.command,
      running: j.running,
      code: j.code,
      elapsedMs: now - j.startedAt,
    }));
  }

  /** 모든 잡을 종료하고 비운다(세션 정리·중단 시). */
  disposeAll(): void {
    for (const job of this.jobs.values()) {
      killTree(job.proc);
    }
    this.jobs.clear();
  }
}
