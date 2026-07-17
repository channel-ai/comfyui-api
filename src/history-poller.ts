import { FastifyBaseLogger } from "fastify";

/**
 * Polls for a prompt's outputs on an adjustable interval. A maxTries of 0
 * means poll until stopped.
 */
export class HistoryEndpointPoller<T> {
  private promptId: string;
  private log: FastifyBaseLogger;
  private maxTries: number;
  private interval: number;
  private getOutputs: () => Promise<T | null>;
  private currentTries: number = 0;
  private stopped: boolean = false;
  private sleepTimer: NodeJS.Timeout | null = null;
  private resolveCurrentSleep: (() => void) | null = null;
  constructor(options: {
    promptId: string;
    log: FastifyBaseLogger;
    maxTries: number;
    interval: number;
    getOutputs: () => Promise<T | null>;
  }) {
    this.promptId = options.promptId;
    this.log = options.log;
    this.maxTries = options.maxTries;
    this.interval = options.interval;
    this.getOutputs = options.getOutputs;
  }
  async poll(): Promise<T | null> {
    while (
      !this.stopped &&
      (this.currentTries < this.getMaxTries() || this.maxTries === 0)
    ) {
      this.log.debug(
        `Polling history endpoint for prompt ${this.promptId}, try ${
          this.currentTries
        } of ${this.getMaxTries()}`
      );
      const outputs = await this.getOutputs();
      if (outputs) {
        return outputs;
      }
      this.currentTries++;
      this.log.debug(
        `Polling history endpoint for prompt ${
          this.promptId
        }, sleep for ${this.getInterval()}ms`
      );
      await new Promise<void>((resolve) => {
        this.resolveCurrentSleep = resolve;
        this.sleepTimer = setTimeout(resolve, this.getInterval());
      });
    }
    return null;
  }

  getInterval(): number {
    return this.interval;
  }

  getMaxTries(): number {
    return this.maxTries;
  }

  setInterval(interval: number, skipCurrentTimeout: boolean = true): void {
    this.interval = interval;
    if (skipCurrentTimeout && this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    if (skipCurrentTimeout && this.resolveCurrentSleep) {
      this.resolveCurrentSleep();
      this.resolveCurrentSleep = null;
    }
  }

  setMaxTries(maxTries: number, reset: boolean = true): void {
    this.maxTries = maxTries;
    if (reset) {
      this.currentTries = 0;
    }
  }

  stop(): void {
    /**
     * A dedicated flag, NOT setMaxTries(currentTries): that reset currentTries
     * to 0, and if currentTries was still 0 it set maxTries to 0 — the
     * "poll forever" sentinel — turning stop() into an infinite zero-interval
     * hot loop that pinned the CPU.
     */
    this.stopped = true;
    this.setInterval(0);
  }
}
