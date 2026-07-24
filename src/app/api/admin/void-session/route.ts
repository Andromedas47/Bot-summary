import { NextRequest, NextResponse } from "next/server";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import { ProduceVoidError, voidProduceSession } from "@/lib/produce/void";
import { createClient, createServiceClient } from "@/lib/supabase/server";

/**
 * BR-03: void a produce session. Admin-only, server-authorized (UI hiding is
 * never the authorization boundary). Requires a non-empty reason; records
 * actor/timestamp/reason on the row itself (see 0037_produce_session_void.sql).
 * Hard delete is never performed — produce_transactions_all keeps the row
 * visible for audit while produce_transactions (every financial loader)
 * excludes it.
 */
interface VoidSessionRequestBody {
  sessionId?: string;
  reason?: string;
  replacementSessionId?: string | null;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  let actor;
  try {
    actor = await requireAdminActor(supabase);
  } catch (err) {
    const status = authErrorStatus(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    throw err;
  }

  const body = (await req.json()) as VoidSessionRequestBody;
  if (!body.sessionId || !body.reason) {
    return NextResponse.json({ error: "sessionId and reason are required" }, { status: 400 });
  }

  try {
    const result = await voidProduceSession(createServiceClient(), {
      sessionId: body.sessionId,
      actorId: actor.id,
      reason: body.reason,
      replacementSessionId: body.replacementSessionId,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ProduceVoidError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "void failed" },
      { status: 500 },
    );
  }
}
