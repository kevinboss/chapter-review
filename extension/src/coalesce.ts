/**
 * Runs a load one at a time, always toward the newest request. A request while
 * a load runs aborts it: that load stops short of publishing at its next check
 * of the signal, and a single further load follows however many requests
 * arrived meanwhile. A burst of manifest writes thus ends in one load of the
 * final state, rather than one full load per write running side by side.
 */
export class Coalescer {
  private requested = false;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly load: (signal: AbortSignal) => Promise<void>) {}

  /** Settles once a load begun after this request has finished. */
  request(): Promise<void> {
    this.requested = true;
    this.controller?.abort();
    this.running ??= this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        this.controller = new AbortController();
        await this.load(this.controller.signal);
      }
    } finally {
      this.running = undefined;
      this.controller = undefined;
    }
  }
}

/** Resolves once the signal aborts, so a load can stop waiting on work it no longer needs. */
export function aborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    signal.addEventListener("abort", () => { resolve(undefined); }, { once: true });
  });
}
