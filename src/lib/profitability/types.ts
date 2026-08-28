/**
 * P3 profitability (COGS + profit/loss) — service contract types.
 *
 * This is the append-only RESULT record for one accountability round: what the
 * round cost, what it should have earned, and what it actually earned. It owns
 * no quantity and no cost of its own. Every figure here is read out of the 0053
 * quantity ledger, the 0054 (P2D) value ledger, the 0040 central price catalog,
 * the 0038/0043 Digital White Sheet and the P2E accountability round, and then
 * frozen. See supabase/migrations/20260809075951_p3_profitability_snapshots.sql
 * for the authoritative rules this module wraps.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * A snapshot is identified by (accountabilityRoundId, revision) and by nothing
 * else. Two rounds may share source, market, seller and business date and are
 * still two rounds, so no descriptive tuple appears anywhere in this module —
 * there is no legacy tuple path to fall back to, and none may be added.
 *
 * ── Numeric transport rule ──────────────────────────────────────────────────
 * Every money term is numeric(24,0) satang and every quantity is numeric(18,6)
 * in PostgreSQL. Both exceed what an IEEE-754 double represents exactly, and
 * PostgREST serializes a bare `numeric` as a JSON number — so the read RPC
 * casts every one of them to TEXT on the way out, deliberately (see the
 * `::text` casts throughout get_profitability_snapshot). Nothing in this module
 * may grow a `number`-typed money or quantity field: every amount, every
 * quantity and every price crosses the TypeScript boundary as a decimal STRING.
 * `revision` and `lineOrdinal` are the only numeric fields in the whole module,
 * and neither is money.
 *
 * ── null means "not provable" ───────────────────────────────────────────────
 * A NULL money term is the migration saying it could not prove that figure, and
 * it is always accompanied by a named reason in `incompleteReasons`. It is
 * never a zero. Nothing here may default, coalesce, or substitute `"0"` for an
 * absent term — doing so would turn "we do not know" into "there was none",
 * which is a different and false claim.
 */

/** The version tag this client posts. Matches the RPC's own default. */
export const PROFITABILITY_CALCULATION_VERSION = "p3:v1";

/**
 * Certification states the snapshot header can carry. Matches the migration's
 * CHECK list exactly.
 *
 * The two states are not independent of `incompleteReasons`: the migration's
 * profitability_snapshots_certified_iff_no_reasons CHECK makes CERTIFIED hold
 * exactly when the reason array is empty. This module re-checks that agreement
 * on the way in rather than trusting either field alone (see ./validate).
 */
export const PROFITABILITY_CERTIFICATION_STATES = ["INCOMPLETE", "CERTIFIED"] as const;
export type ProfitabilityCertificationState =
  (typeof PROFITABILITY_CERTIFICATION_STATES)[number];

/**
 * Every machine-readable reason record_profitability_snapshot can emit, in the
 * sorted order the RPC itself returns them (it aggregates with
 * `array_agg(DISTINCT r ORDER BY r)`).
 *
 * The first six are per-line and roll up into the header; the rest are
 * round-level and only ever appear on the header:
 *
 *   per line
 *     issue_movement_unbound          no active ISSUE movement backs this key
 *     issue_cost_unvalued             the ISSUE exists but is not fully valued in 0054
 *     issue_quantity_mismatch         ledger issue quantity <> produce-side issue quantity
 *     good_return_cost_unvalued       the GOOD_RETURN exists but is not fully valued
 *     good_return_quantity_mismatch   ledger return quantity <> produce-side return quantity
 *     missing_central_price           no 0040 price for (product, unit, business date)
 *
 *   round level
 *     no_round_activity                   the round produced no lines at all
 *     produce_item_unattributed           a produce item of this round was not attributed
 *     pending_produce_sessions            damage/returns are still being decided
 *     accountability_round_open           the round is not closed yet
 *     accountability_round_cancelled      the round was cancelled, so its money
 *                                         is an abandoned cycle rather than a
 *                                         result — cancelling voids none of the
 *                                         underlying artifacts, so every figure
 *                                         stays provable and would otherwise
 *                                         certify
 *     unsupported_round_movement          a live movement bound to the round is
 *                                         neither ISSUE, GOOD_RETURN nor REVERSAL
 *                                         (above all DAMAGED_WRITE_OFF, which
 *                                         would decrement MAIN a second time for
 *                                         stock that already left on the issue)
 *     white_sheet_missing                 no white sheet is bound to this round
 *     white_sheet_not_finalized           the white sheet exists but is not finalized
 *     missing_verified_transfers          the caller could not prove a transfer total
 *     purchasing_expenses_unattributable  the caller could not prove purchasing expenses
 *
 * This list is exhaustive and validated against on the way in. An unrecognised
 * reason means this client is older than the database it is talking to, and a
 * client that cannot name a reason cannot honestly render the snapshot that
 * carries it — so it fails closed rather than displaying a blank bullet.
 */
export const PROFITABILITY_INCOMPLETE_REASONS = [
  "accountability_round_cancelled",
  "accountability_round_open",
  "good_return_cost_unvalued",
  "good_return_quantity_mismatch",
  "issue_cost_unvalued",
  "issue_movement_unbound",
  "issue_quantity_mismatch",
  "missing_central_price",
  "missing_verified_transfers",
  "no_round_activity",
  "pending_produce_sessions",
  "produce_item_unattributed",
  "purchasing_expenses_unattributable",
  "unsupported_round_movement",
  "white_sheet_missing",
  "white_sheet_not_finalized",
] as const;
export type ProfitabilityIncompleteReason =
  (typeof PROFITABILITY_INCOMPLETE_REASONS)[number];

/**
 * Source artifact classes the lineage table records. Matches the migration's
 * profitability_snapshot_sources.artifact_kind CHECK list exactly.
 *
 * Two of these — 'settlement_finalization' and 'pending_session' — are legal in
 * the CHECK but are not written by record_profitability_snapshot as it stands.
 * They are kept here because the column accepts them, so a row carrying one is
 * a valid row this client must be able to read rather than reject.
 */
export const PROFITABILITY_ARTIFACT_KINDS = [
  "produce_item",
  "produce_session",
  "inventory_movement",
  "inventory_movement_line",
  "inventory_cost_movement_line",
  "central_selling_price",
  "white_sheet_cash_entry",
  "white_sheet_lifecycle_event",
  "settlement_entry",
  "settlement_finalization",
  "transfer_reconciliation",
  "slip_batch",
  "slip_evidence",
  "manual_slip_session",
  "purchase_receipt",
  "pending_session",
] as const;
export type ProfitabilityArtifactKind = (typeof PROFITABILITY_ARTIFACT_KINDS)[number];

/**
 * One produce item bound to one 0054 balance key.
 *
 * SQL deliberately never derives product_key/unit_key from produce_items text
 * (0053:311-313 reserves that resolver to the application), so the caller
 * supplies the binding and the RPC verifies it. Every field is required and
 * non-blank; the RPC refuses the whole call otherwise.
 */
export interface ProfitabilityQuantityAttribution {
  /** A produce item (produce_transactions.id) that belongs to this round. */
  produceItemId: string;
  locationCode: string;
  productKey: string;
  unitKey: string;
}

/**
 * One snapshot line: one (locationCode, productKey, unitKey) — the 0054 balance
 * key, verbatim, so two units of one product are two lines that never combine.
 */
export interface ProfitabilitySnapshotLine {
  /** 1-based ordering within the snapshot. Not money. */
  lineOrdinal: number;
  locationCode: string;
  productKey: string;
  unitKey: string;

  /** Produce-side quantities. Exact decimal strings; NOT NULL in the table. */
  issuedQuantity: string;
  goodReturnQuantity: string;
  damagedQuantity: string;
  /** issued - goodReturn - damaged. The RPC raises rather than let this go negative. */
  soldQuantity: string;
  /** Ledger-side issue quantity. null when no active ISSUE movement backs this key. */
  issuedLedgerQuantity: string | null;

  /** 0040 central price for the round's business date. null when there is none. */
  priceSatang: string | null;

  /** Money, exact satang as decimal strings. null means "not provable". */
  issuedCostSatang: string | null;
  goodReturnCostSatang: string | null;
  damageLossSatang: string | null;
  /** Residual of one proven total (issued - returned - damaged), never a third rounding. */
  cogsSoldSatang: string | null;
  expectedMoneySatang: string | null;

  /** The per-line subset of the reasons; rolls up into the header's set. */
  incompleteReasons: ProfitabilityIncompleteReason[];
}

/** One lineage row: a source artifact that contributed to the snapshot. */
export interface ProfitabilitySnapshotSource {
  artifactKind: ProfitabilityArtifactKind;
  artifactId: string;
}

/**
 * A frozen profitability result at one revision.
 *
 * Every money and quantity field is a decimal string or null. `null` is always
 * "not provable" and is always paired with a reason in `incompleteReasons`; it
 * is never zero and must never be rendered as one.
 */
export interface ProfitabilitySnapshot {
  snapshotId: string;
  accountabilityRoundId: string;
  /** Monotonic per round, starting at 1. Not money. */
  revision: number;
  calculationVersion: string;
  /** sha256 hex of every input that can move a number. */
  inputHash: string;
  certificationState: ProfitabilityCertificationState;
  /** Empty exactly when CERTIFIED — the validator enforces the agreement. */
  incompleteReasons: ProfitabilityIncompleteReason[];
  /** Set once, from NULL, when a later revision supersedes this one. */
  supersededBySnapshotId: string | null;
  createdAt: string;

  /** Round totals, quantities. */
  issuedQuantity: string | null;
  goodReturnQuantity: string | null;
  damagedQuantity: string | null;
  soldQuantity: string | null;

  /** Round totals, money in exact satang. null means "not provable". */
  issuedCostSatang: string | null;
  goodReturnCostSatang: string | null;
  damageLossSatang: string | null;
  cogsSoldSatang: string | null;
  expectedMoneySatang: string | null;
  standardMarginSatang: string | null;
  approvedExpensesSatang: string | null;
  approvedWagesSatang: string | null;
  purchasingExpensesSatang: string | null;
  expectedOperatingPlSatang: string | null;
  verifiedTransfersSatang: string | null;
  actualCashSatang: string | null;
  shortageOverageSatang: string | null;
  realizedPlSatang: string | null;

  lines: ProfitabilitySnapshotLine[];
  sources: ProfitabilitySnapshotSource[];
}

/**
 * Result of recording (or replaying) a snapshot.
 *
 * `replayed: true` means the deterministic dedupe key already existed: nothing
 * was written and the identifiers below are the ORIGINAL snapshot's. It is not
 * an error and must not be retried into a new revision.
 */
export interface ProfitabilityPostingResult {
  replayed: boolean;
  snapshotId: string;
  accountabilityRoundId: string;
  revision: number;
  certificationState: ProfitabilityCertificationState;
  incompleteReasons: ProfitabilityIncompleteReason[];
}
