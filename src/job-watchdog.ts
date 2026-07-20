export interface JobWatchdog {
  clear(): void;
}

/**
 * Arms a one-shot timer that runs `onTimeout` unless `clear()` is called first.
 * `timeoutMs <= 0` disables it and returns a no-op handle.
 *
 * Used as a hard self-kill for a wedged job: ComfyUI can deadlock (e.g. in VAE
 * decode — GPU idle, uninterruptible), after which the job never completes,
 * pins its inFlight slot forever, and the whole replica is stuck reporting
 * not-ready. Exiting the process lets the orchestrator (AutoDL) redeploy a
 * fresh replica.
 */
export function armJobWatchdog(
  timeoutMs: number,
  onTimeout: () => void
): JobWatchdog {
  if (timeoutMs <= 0) {
    return { clear() {} };
  }
  const timer = setTimeout(onTimeout, timeoutMs);
  return {
    clear() {
      clearTimeout(timer);
    },
  };
}
