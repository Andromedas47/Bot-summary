import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { displayMarketName } from "@/lib/market";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import type {
  DailyClosePreflightResult,
  PreflightRound,
} from "@/lib/produce/daily-close-preflight";

export type SettlementProduceValueStatus =
  | "complete"
  | "partial"
  | "blocked"
  | "missing";

export interface SettlementProduceIdentity {
  accountabilityRoundId?: string | null;
  staffName: string;
  marketName: string;
}

function sameText(left: string | null, right: string): boolean {
  return (left ?? "").normalize("NFC").trim() === right.normalize("NFC").trim();
}

function matchingRound(
  preflight: DailyClosePreflightResult,
  identity: SettlementProduceIdentity,
): PreflightRound | null {
  if (identity.accountabilityRoundId) {
    return preflight.rounds.find(
      (round) => round.accountabilityRoundId === identity.accountabilityRoundId,
    ) ?? null;
  }

  const market = displayMarketName(identity.marketName, "");
  const matches = preflight.rounds.filter((round) =>
    sameText(round.staffName, identity.staffName)
    && displayMarketName(round.marketName ?? "", "") === market,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/** Map the trusted Produce preflight verdict; never infer completeness from money. */
export function settlementProduceValueStatus(
  preflight: DailyClosePreflightResult,
  identity: SettlementProduceIdentity,
  effectiveRowCount: number,
): SettlementProduceValueStatus {
  if (effectiveRowCount === 0) return "missing";
  const round = matchingRound(preflight, identity);
  if (!round) return "blocked";
  if (round.status === "ready") return "complete";
  return round.status === "partial" ? "partial" : "blocked";
}

export async function loadSettlementProduceValueStatus(
  supabase: SupabaseClient<Database>,
  businessDate: string,
  identity: SettlementProduceIdentity,
  effectiveRowCount: number,
): Promise<SettlementProduceValueStatus> {
  const preflight = await runDailyClosePreflight(supabase, businessDate);
  return settlementProduceValueStatus(preflight, identity, effectiveRowCount);
}
