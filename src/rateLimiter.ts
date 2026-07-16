// 슬라이딩 윈도우 방식 요청 속도 제한기(RPM).
// 최근 60초 안의 요청 수가 maxRpm 을 넘지 않도록 acquire() 에서 대기시킨다.

function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

export class RateLimiter {
  private times: number[] = [];

  constructor(private readonly windowMs = 60_000) {}

  /** 지금 보낼 수 있으면 0, 아니면 대기해야 할 ms 를 반환(예약하지 않음). */
  private waitTime(maxRpm: number): number {
    const now = Date.now();
    while (this.times.length && now - this.times[0] >= this.windowMs) {
      this.times.shift();
    }
    if (this.times.length < maxRpm) {
      return 0;
    }
    return this.windowMs - (now - this.times[0]) + 5;
  }

  /**
   * 슬롯을 확보할 때까지 대기한 뒤 요청 시각을 기록한다.
   * @param maxRpm 0 이하이면 제한 없음.
   * @param opts.signal 취소 시 AbortError 로 reject.
   * @param opts.onWait 대기가 시작될 때 한 번 호출(예상 대기 ms).
   */
  async acquire(
    maxRpm: number,
    opts: { signal?: AbortSignal; onWait?: (ms: number) => void } = {}
  ): Promise<void> {
    if (!maxRpm || maxRpm <= 0) {
      return;
    }
    let notified = false;
    while (true) {
      const w = this.waitTime(maxRpm);
      if (w <= 0) {
        break;
      }
      if (!notified) {
        notified = true;
        opts.onWait?.(w);
      }
      await sleep(w, opts.signal);
    }
    this.times.push(Date.now());
  }
}
