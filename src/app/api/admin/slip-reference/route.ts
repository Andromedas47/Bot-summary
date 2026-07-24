import { NextRequest, NextResponse } from "next/server";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import { ReferenceResolutionError, resolveSlipCheckReference } from "@/lib/slips/reference-resolution";
import { createClient, createServiceClient } from "@/lib/supabase/server";

/**
 * BR-02: manual reference-ID resolution for a slip_checks row that was
 * accepted but has no extracted reference. Admin-only. This route only
 * writes reference_id — it never re-implements or bypasses the existing
 * global reference-winner dedupe (resolveGloballyAcceptedCheckIds); the
 * newly-referenced check is subject to that SAME logic on its next load.
 */
interface ResolveReferenceRequestBody {
  checkId?: string;
  referenceId?: string;
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

  const body = (await req.json()) as ResolveReferenceRequestBody;
  if (!body.checkId || !body.referenceId) {
    return NextResponse.json({ error: "checkId and referenceId are required" }, { status: 400 });
  }

  try {
    const result = await resolveSlipCheckReference(createServiceClient(), {
      checkId: body.checkId,
      referenceId: body.referenceId,
      actor: actor.id,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ReferenceResolutionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "reference resolution failed" },
      { status: 500 },
    );
  }
}
