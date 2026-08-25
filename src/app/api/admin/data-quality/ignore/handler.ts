import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import { ignoreDataQualityIssue } from "@/lib/data-quality/inbox";
import type { Database } from "@/types/database";

/**
 * Data Quality Inbox — mark an issue ignored (suppressed, not silenced — see
 * src/lib/data-quality/inbox.ts module doc). Admin-only, server-authorized,
 * same pattern as /api/admin/data-quality/resolve.
 *
 * See ../resolve/handler.ts for why this logic lives apart from route.ts
 * (which statically imports the shared, sometimes-differently-mocked
 * `@/lib/supabase/server`).
 */
interface IgnoreRequestBody {
  issueKey?: string;
  note?: string;
}

export async function handleIgnoreRequest(
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

  const body = (await req.json()) as IgnoreRequestBody;
  const issueKey = body.issueKey?.trim();
  const note = body.note?.trim();
  if (!issueKey || !note) {
    return NextResponse.json({ error: "issueKey and note are required" }, { status: 400 });
  }

  try {
    const row = await ignoreDataQualityIssue(serviceClient, issueKey, actor, note);
    return NextResponse.json(row);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ignore failed" },
      { status: 500 },
    );
  }
}
