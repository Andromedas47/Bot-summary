/**
 * Source-wide ownership of a guided round: who, if anyone, owns
 * (source_id, market, business_date)?
 *
 * The produce session key is per operator (`group:<source>:user:<user>`), so
 * nothing in the per-operator path can see that a SECOND member of the same LINE
 * group already opened the same market and date. This module asks the
 * source-wide question, and every guided decision that could write on behalf of
 * a round asks it FIRST:
 *
 *   - opening a guided produce session (session-opener);
 *   - the White Sheet, slip-open and settlement guards (ownership-guard).
 *
 * It lives on its own because both of those import it and journey.ts imports
 * session-opener — a shared leaf keeps the graph acyclic.
 *
 * Nothing here writes, and it never answers "nobody" when it does not know.
 * Terminalized rounds are included on purpose: ownership of a market/date does
 * not lapse when the produce session ends, because the White Sheet, slip and
 * settlement stages all come afterwards.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizedMarketLabel } from "@/lib/market";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export type GuidedRoundOwnership =
  /** No guided round in this source for the market/date. */
  | { kind: "none" }
  /** Exactly one operator owns it. */
  | { kind: "owned"; lineUserId: string; sessionKey: string }
  /**
   * More than one operator already owns a matching round. Nothing can decide
   * which one a plain-text command belongs to, so callers must fail closed.
   */
  | { kind: "ambiguous"; lineUserIds: string[] }
  /** The lookup itself failed — callers must fail closed, never fall back. */
  | { kind: "unknown" };

export type GuidedRoundOwnerQuery = {
  sourceId: string;
  marketLabelNormalized: string;
  businessDate: string;
};

/** The one question, asked of the authoritative table. */
export async function findGuidedRoundOwner(
  supabase: AnyClient,
  input: GuidedRoundOwnerQuery,
): Promise<GuidedRoundOwnership> {
  const target = normalizedMarketLabel(input.marketLabelNormalized);
  if (!target || !input.businessDate || !input.sourceId) return { kind: "none" };

  let data: Array<Record<string, unknown>> | null;
  try {
    const result = await supabase
      .from("pending_sessions")
      .select("session_key, line_user_id, market_label, entry_origin, created_at")
      .eq("source_id", input.sourceId)
      .eq("business_date", input.businessDate)
      .not("entry_origin", "is", null)
      .order("created_at", { ascending: false });
    if (result.error) return { kind: "unknown" };
    data = result.data;
  } catch {
    // Unanswerable is not "nobody owns it" — callers must fail closed.
    return { kind: "unknown" };
  }

  // Every matching owner is collected, not just the newest: taking the latest
  // row would hide a second operator standing on the same round.
  const owners = new Map<string, string>();
  for (const row of data ?? []) {
    const lineUserId = String(row.line_user_id ?? "").trim();
    if (!lineUserId) continue;
    if (normalizedMarketLabel(String(row.market_label ?? "")) !== target) continue;
    if (!owners.has(lineUserId)) {
      owners.set(lineUserId, String(row.session_key ?? ""));
    }
  }

  if (owners.size === 0) return { kind: "none" };
  if (owners.size > 1) {
    return { kind: "ambiguous", lineUserIds: [...owners.keys()].sort() };
  }
  const [lineUserId, sessionKey] = [...owners.entries()][0]!;
  return { kind: "owned", lineUserId, sessionKey };
}

/**
 * May this operator act on the round for this market/date?
 *
 * `own` means they already own it (or nobody does). Everything else is a
 * fail-closed refusal reason the caller renders in its own copy.
 */
export type GuidedOwnerCheck =
  | { kind: "vacant" }
  | { kind: "own"; sessionKey: string }
  | { kind: "other_operator" }
  | { kind: "ambiguous" }
  | { kind: "unknown" };

export async function checkGuidedRoundOwner(
  supabase: AnyClient,
  input: GuidedRoundOwnerQuery & { lineUserId: string },
): Promise<GuidedOwnerCheck> {
  const owner = await findGuidedRoundOwner(supabase, input);
  if (owner.kind === "unknown") return { kind: "unknown" };
  if (owner.kind === "ambiguous") return { kind: "ambiguous" };
  if (owner.kind === "none") return { kind: "vacant" };
  if (owner.lineUserId !== input.lineUserId) return { kind: "other_operator" };
  return { kind: "own", sessionKey: owner.sessionKey };
}
