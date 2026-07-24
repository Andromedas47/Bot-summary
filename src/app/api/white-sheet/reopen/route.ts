import { NextRequest, NextResponse } from "next/server";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import { createClient } from "@/lib/supabase/server";
import { normalizedMarketLabel } from "@/lib/white-sheet";
import { WhiteSheetPersistenceError } from "@/lib/white-sheet/persist";
import { reopenServerWhiteSheetCashEntry } from "@/lib/white-sheet/server";

/**
 * BR-06/BR-05: the only way a FINALIZED White Sheet entry becomes editable
 * again. Admin-only, requires a non-empty reason — never a silent overwrite.
 * Records an audit event (white_sheet_lifecycle_events); after this call the
 * entry returns to SUBMITTED and the normal upsert path works again.
 */
interface ReopenRequestBody {
  sourceId?: string;
  market?: string;
  date?: string;
  reason?: string;
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

  const body = (await req.json()) as ReopenRequestBody;
  const { sourceId, market, date, reason } = body;
  if (!sourceId || !market || !date || !reason) {
    return NextResponse.json(
      { error: "sourceId, market, date, and reason are required" },
      { status: 400 },
    );
  }

  try {
    const state = await reopenServerWhiteSheetCashEntry(
      { sourceId, marketLabelNormalized: normalizedMarketLabel(market), businessDate: date },
      actor.id,
      reason,
    );
    return NextResponse.json(state);
  } catch (err) {
    if (err instanceof WhiteSheetPersistenceError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "reopen failed" },
      { status: 500 },
    );
  }
}
