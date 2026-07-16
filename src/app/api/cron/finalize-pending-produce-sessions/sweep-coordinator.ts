export const MIN_SWEEP_INTERVAL_MS = 60_000;

export type SweepCoordinationResult<T> =
  | { status: "executed" | "coalesced"; value: T }
  | { status: "rate_limited"; retryAfterMs: number };

export function createSweepCoordinator(
  minimumIntervalMs = MIN_SWEEP_INTERVAL_MS,
) {
  let activeSweep: Promise<unknown> | null = null;
  let lastStartedAtMs: number | null = null;

  return {
    async run<T>(
      task: () => Promise<T>,
      nowMs = Date.now(),
    ): Promise<SweepCoordinationResult<T>> {
      if (activeSweep) {
        return {
          status: "coalesced",
          value: await activeSweep as T,
        };
      }

      if (lastStartedAtMs !== null) {
        const elapsedMs = Math.max(0, nowMs - lastStartedAtMs);
        if (elapsedMs < minimumIntervalMs) {
          return {
            status: "rate_limited",
            retryAfterMs: minimumIntervalMs - elapsedMs,
          };
        }
      }

      lastStartedAtMs = nowMs;
      const sweep = task();
      activeSweep = sweep;
      try {
        return { status: "executed", value: await sweep };
      } finally {
        if (activeSweep === sweep) activeSweep = null;
      }
    },
  };
}
