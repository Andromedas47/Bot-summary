import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { WhiteSheetDataError } from "@/lib/white-sheet";
import { listWhiteSheetMarketScopesForDate } from "@/lib/white-sheet/market-scopes";

/**
 * Authenticated read of human-readable White Sheet market/source options for
 * one business date. Service client stays on the server — the browser only
 * receives display labels + the scope keys needed for subsequent /api/white-sheet calls.
 */
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date is required (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    const options = await listWhiteSheetMarketScopesForDate(createServiceClient(), date);
    return NextResponse.json({ options });
  } catch (err) {
    if (err instanceof WhiteSheetDataError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "scope lookup failed" },
      { status: 500 },
    );
  }
}
