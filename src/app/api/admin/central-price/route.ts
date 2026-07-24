import { NextRequest, NextResponse } from "next/server";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import { createClient } from "@/lib/supabase/server";
import { CentralPriceError } from "@/lib/white-sheet/pricing";
import {
  getServerCentralPrice,
  getServerCentralPriceHistory,
  setServerCentralPrice,
} from "@/lib/white-sheet/server";

/**
 * BR-01/BR-04: central daily selling price, global across markets.
 * Reading is open to any authenticated session (see src/proxy.ts — every
 * non-webhook/cron route already requires a session). Setting/correcting
 * requires an admin session (src/lib/auth/admin.ts) — never trusts a
 * client-calculated total, only productName/unit/businessDate/priceBaht/reason.
 */
export async function GET(req: NextRequest) {
  const productName = req.nextUrl.searchParams.get("productName");
  const unit = req.nextUrl.searchParams.get("unit");
  const businessDate = req.nextUrl.searchParams.get("businessDate");
  const includeHistory = req.nextUrl.searchParams.get("history") === "1";

  if (!productName || !unit || !businessDate) {
    return NextResponse.json(
      { error: "productName, unit, and businessDate are required" },
      { status: 400 },
    );
  }

  try {
    const identity = { productName, unit, businessDate };
    const price = await getServerCentralPrice(identity);
    const history = includeHistory ? await getServerCentralPriceHistory(identity) : undefined;
    return NextResponse.json({ price, history });
  } catch (err) {
    if (err instanceof CentralPriceError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "central price query failed" },
      { status: 500 },
    );
  }
}

interface SetCentralPriceRequestBody {
  productName?: string;
  unit?: string;
  businessDate?: string;
  priceBaht?: number;
  reason?: string | null;
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

  const body = (await req.json()) as SetCentralPriceRequestBody;
  const { productName, unit, businessDate, priceBaht, reason } = body;
  if (!productName || !unit || !businessDate || priceBaht === undefined) {
    return NextResponse.json(
      { error: "productName, unit, businessDate, and priceBaht are required" },
      { status: 400 },
    );
  }

  try {
    const record = await setServerCentralPrice({
      identity: { productName, unit, businessDate },
      priceBaht,
      actor: actor.id,
      reason,
    });
    return NextResponse.json(record);
  } catch (err) {
    if (err instanceof CentralPriceError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "set central price failed" },
      { status: 500 },
    );
  }
}
