import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { reviewWorkRound, type ReviewAction } from "@/lib/work-round/review-service";

function actorFromRequest(req: NextRequest): string | null {
  return req.headers.get("x-reviewer-email") ?? req.headers.get("x-user-email") ?? null;
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await req.json() as Record<string, unknown>
    : Object.fromEntries((await req.formData()).entries());

  const workRoundId = String(payload.work_round_id ?? "");
  const action = String(payload.action ?? "") as ReviewAction;
  const reason = payload.reason == null ? null : String(payload.reason);
  const returnTo = String(payload.return_to ?? "/work-rounds");

  if (!workRoundId) return NextResponse.json({ error: "work_round_id required" }, { status: 400 });
  if (action !== "approve" && action !== "needs_correction") {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }

  const supabase = await createServiceClient();
  const result = await reviewWorkRound(supabase, {
    workRoundId,
    action,
    reason,
    actor: actorFromRequest(req),
  });

  if (!result.ok) {
    if (contentType.includes("application/json")) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const url = new URL(returnTo, req.url);
    url.searchParams.set("review_error", result.error);
    return NextResponse.redirect(url, { status: 303 });
  }

  if (contentType.includes("application/json")) {
    return NextResponse.json({ ok: true, finalizeStatus: result.finalizeStatus ?? null });
  }
  return NextResponse.redirect(new URL(returnTo, req.url), { status: 303 });
}
