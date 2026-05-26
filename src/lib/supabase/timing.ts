import { logger } from "@/lib/logger";

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV === "production") return fn();
  const t0 = performance.now();
  const result = await fn();
  logger.debug(`[db] ${label}`, { ms: `${(performance.now() - t0).toFixed(1)}ms` });
  return result;
}
