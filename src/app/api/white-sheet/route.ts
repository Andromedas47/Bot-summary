import { NextRequest, NextResponse } from "next/server";
import { normalizedMarketLabel, WhiteSheetDataError } from "@/lib/white-sheet";
import { WhiteSheetPersistenceError } from "@/lib/white-sheet/persist";
import {
  loadServerDigitalWhiteSheetPageModel,
  saveServerWhiteSheetCashEntry,
} from "@/lib/white-sheet/server";

/**
 * Authenticated read/write boundary for the Digital White Sheet cash/expense
 * entry — protected by the existing session check in src/proxy.ts (every
 * non-webhook/cron API route already requires a logged-in Backoffice
 * session; no new role system is introduced here).
 *
 * marketKey is not a persisted identity (see
 * docs/core-white-sheet-integration.md); the raw `market` label is threaded
 * through as the calculation-only marketKey too, and the persistence layer
 * separately normalizes it for the actual (source_id, normalized market
 * label, business_date) uniqueness key.
 */
export async function GET(req: NextRequest) {
  const sourceId = req.nextUrl.searchParams.get("sourceId");
  const market = req.nextUrl.searchParams.get("market");
  const date = req.nextUrl.searchParams.get("date");

  if (!sourceId || !market || !date) {
    return NextResponse.json(
      { error: "sourceId, market, and date are required" },
      { status: 400 },
    );
  }

  try {
    const pageModel = await loadServerDigitalWhiteSheetPageModel({
      sourceId,
      marketKey: market,
      marketLabel: market,
      businessDate: date,
    });
    return NextResponse.json(pageModel);
  } catch (err) {
    if (err instanceof WhiteSheetDataError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "load failed" },
      { status: 500 },
    );
  }
}

interface WhiteSheetCashEntryRequestBody {
  sourceId?: string;
  market?: string;
  date?: string;
  labor?: number;
  locationFee?: number;
  bag?: number;
  snack?: number;
  other?: number;
  otherNote?: string | null;
  actualCashSubmitted?: number;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as WhiteSheetCashEntryRequestBody;
  const { sourceId, market, date } = body;

  if (!sourceId || !market || !date) {
    return NextResponse.json(
      { error: "sourceId, market, and date are required" },
      { status: 400 },
    );
  }

  try {
    await saveServerWhiteSheetCashEntry({
      sourceId,
      marketLabelNormalized: normalizedMarketLabel(market),
      businessDate: date,
      labor: body.labor ?? 0,
      locationFee: body.locationFee ?? 0,
      bag: body.bag ?? 0,
      snack: body.snack ?? 0,
      other: body.other ?? 0,
      otherNote: body.otherNote,
      actualCashSubmitted: body.actualCashSubmitted ?? 0,
    });

    // STEP 6 requirement: a successful save reloads the canonical summary
    // (operational loader + the entry just saved + calculateDigitalWhiteSheet),
    // rather than returning the raw persisted row.
    const pageModel = await loadServerDigitalWhiteSheetPageModel({
      sourceId,
      marketKey: market,
      marketLabel: market,
      businessDate: date,
    });
    return NextResponse.json(pageModel);
  } catch (err) {
    if (err instanceof WhiteSheetPersistenceError || err instanceof WhiteSheetDataError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "save failed" },
      { status: 500 },
    );
  }
}
