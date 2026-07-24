import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Minimum production-safe admin authorization for privileged financial
 * operations: void, central-price correction, White Sheet finalization, and
 * manual slip-reference resolution (locked business rules BR-03/BR-04/BR-06,
 * BR-02 manual resolution).
 *
 * Trust boundary: only `user.app_metadata` is used — it is set exclusively by
 * a service-role/Admin API caller and cannot be written by the
 * authenticated user themselves (unlike `user_metadata`, which the client SDK
 * can update and must never be treated as an authority signal).
 *
 * Bootstrap path: before any user has app_metadata.role = "admin" set (e.g.
 * on a fresh environment with no admin yet), ADMIN_USER_IDS — a server-only,
 * comma-separated list of Supabase auth user ids — grants admin. This env
 * var must never be exposed to the client and should be treated as a
 * temporary bootstrap mechanism: once real admins have app_metadata set (via
 * the Supabase Admin API, e.g. `auth.admin.updateUserById(id, { app_metadata:
 * { role: "admin" } })`), ADMIN_USER_IDS can be cleared.
 */

export class UnauthenticatedError extends Error {
  constructor() {
    super("Authentication is required for this action");
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Admin authorization is required for this action") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface AuthenticatedActor {
  id: string;
  email: string | null;
}

function bootstrapAdminIds(): ReadonlySet<string> {
  return new Set(
    (process.env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

function isAdminUser(user: User): boolean {
  if (user.app_metadata?.role === "admin") return true;
  return bootstrapAdminIds().has(user.id);
}

/** Resolves the authenticated actor from a request-scoped (cookie-session) Supabase client. */
export async function requireAuthenticatedActor(
  supabase: SupabaseClient<Database>,
): Promise<AuthenticatedActor> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new UnauthenticatedError();
  return { id: user.id, email: user.email ?? null };
}

/**
 * Resolves and authorizes the acting admin. Throws UnauthenticatedError (401)
 * if there is no session, ForbiddenError (403) if the session is not an
 * admin. Callers must map these to HTTP status codes at the API boundary —
 * page visibility alone is never sufficient authorization.
 */
export async function requireAdminActor(
  supabase: SupabaseClient<Database>,
): Promise<AuthenticatedActor> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new UnauthenticatedError();
  if (!isAdminUser(user)) throw new ForbiddenError();
  return { id: user.id, email: user.email ?? null };
}

/** Maps the two authorization errors to their HTTP status; rethrows anything else. */
export function authErrorStatus(error: unknown): 401 | 403 | null {
  if (error instanceof UnauthenticatedError) return 401;
  if (error instanceof ForbiddenError) return 403;
  return null;
}
