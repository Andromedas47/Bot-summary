import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import { resolveDataQualityIssue } from "@/lib/data-quality/inbox";
import type { Database } from "@/types/database";

/**
 * Data Quality Inbox — mark an issue resolved. Admin-only, server-authorized
 * (same pattern as /api/admin/void-session and /api/admin/central-price):
 * the cookie-session client only ever proves WHO is asking, every actual
 * write goes through the service-role client.
 *
 * Deliberately kept in its own file, apart from route.ts: route.ts statically
 * imports `@/lib/supabase/server` for the real createClient()/
 * createServiceClient(), and several OTHER test files in this suite mock
 * that exact shared path with an incompatible shape (Bun's mock.module
 * registry is process-wide, not file-scoped — a plain `import("./route")`
 * from a test can end up statically link-failing against a different file's
 * mock, even if the test never calls the offending export). This module has
 * no such import, so route.test.ts can test the auth gate + business logic
 * directly with a plain fake `{ auth: { getUser } }` object with zero risk
 * of that cross-file conflict.
 */
interface ResolveRequestBody {
  issueKey?: string;
  note?: string;
}

export async function handleResolveRequest(
  req: NextRequest,
  supabase: SupabaseClient<Database>,
  serviceClient: SupabaseClient<Database>,
) {
  let actor;
  try {
    actor = await requireAdminActor(supabase);
  } catch (err) {
    const status = authErrorStatus(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    throw err;
  }

  const body = (await req.json()) as ResolveRequestBody;
  const issueKey = body.issueKey?.trim();
  const note = body.note?.trim();
  if (!issueKey || !note) {
    return NextResponse.json({ error: "issueKey and note are required" }, { status: 400 });
  }

  try {
    const row = await resolveDataQualityIssue(serviceClient, issueKey, actor, note);
    return NextResponse.json(row);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "resolve failed" },
      { status: 500 },
    );
  }
}
