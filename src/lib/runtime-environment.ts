// Centralized, server-only source of truth for which deployment environment
// this process is running in. Exists to stop Production and Preview workers
// from claiming each other's rows in tables they share one Supabase project
// with (see 0061_pending_session_runtime_environment.sql) — never derive
// this from a deployment URL, which is ephemeral per-build and unsuitable as
// an ownership key.

export type RuntimeEnvironment = "production" | "preview" | "development";

const KNOWN_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "production", "preview", "development",
]);

/**
 * Vercel sets VERCEL_ENV to exactly "production" | "preview" | "development"
 * on every deployment. Missing (local dev, bun test, any non-Vercel host) or
 * an unrecognized value both fail safe to "development" — never silently
 * "production", which would let a misconfigured process rejoin the exact
 * cross-environment claim race this module exists to prevent.
 */
export function getRuntimeEnvironment(): RuntimeEnvironment {
  const raw = process.env.VERCEL_ENV;
  return raw && KNOWN_ENVIRONMENTS.has(raw) ? (raw as RuntimeEnvironment) : "development";
}
