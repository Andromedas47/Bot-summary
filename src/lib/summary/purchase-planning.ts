/**
 * 📦 สรุปสำหรับวางแผนซื้อของ — purchasing-support classification.
 *
 * Pure. No Supabase import, no I/O, no money. Two independent signals are
 * combined here and nowhere else:
 *
 *   1. MARKET SELL-THROUGH — how much of what went out to the markets actually
 *      sold, from persisted produce_transactions quantities only.
 *   2. HOUSE STOCK — the P2A physical count of what is currently in the house.
 *
 * THE DAILY TIMELINE, confirmed by the operator, is what makes these two
 * additive rather than overlapping:
 *
 *   1. goods are withdrawn (เบิก) and dispatched to every market
 *   2. staff then count what is physically LEFT AT HOME  ← the snapshot
 *   3. markets sell through the day
 *   4. good returns (ชั่งคืน) and damaged returns come back
 *
 * The count happens after dispatch and before any return arrives, so the house
 * count and the good return are disjoint quantities of the same product:
 *
 *   next_day_good_stock = house_stock_after_withdrawal + good_return
 *
 * Damaged return is NEVER part of that sum — it is not sellable stock — and is
 * never subtracted from it either; it stays its own signal.
 *
 * The snapshot remains a capture-only observation (migration 0047: "Does NOT
 * post inventory ledger movements"), but the operator has confirmed it is a
 * COMPLETE house count after every market was supplied. A canonical product
 * wholly absent from that snapshot is therefore zero at home — not unknown.
 * A product that IS present but only in an incompatible unit stays unmatched.
 * House stock still cannot promote an uncertain market result into a 🟢.
 */

import { normalizedMarketLabel } from "@/lib/market";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { baseTransactionType } from "@/lib/summary/transactions";
import {
  normalizeProductName,
  normalizeRemainingUnit,
  PRODUCT_ALIASES,
} from "@/lib/summary/remaining-fruit";
import type { RoundReturnState } from "@/lib/produce/round-return-status";

// ── V1 operational thresholds ───────────────────────────────────────────────
// Initial operational thresholds, NOT universal business truth. They live here,
// named, so tuning them is a one-line reviewable change rather than a hunt.

/** Sell-through at or above this percentage is HIGH. */
export const HIGH_SELL_THROUGH_MIN_PERCENT = 70;
/** Sell-through at or above this percentage (and below HIGH) is MEDIUM. */
export const MEDIUM_SELL_THROUGH_MIN_PERCENT = 40;
/**
 * next_day_good_stock / estimated_sold_qty at or below this counts as "little
 * good stock left to sell tomorrow". Same unit on both sides by construction.
 * Read it as "less than half of what sold today is already sitting ready" —
 * NOT days of stock, and NOT an inventory-ledger assertion.
 *
 * UNRESOLVED TUNING PARAMETER. It is 0.5 and not the 0.25 an earlier draft used
 * against a different denominator, because adding the good return changed what
 * the number means. With returns in the numerator, a product at exactly the
 * HIGH threshold has a floor of (100 − 70) / 70 ≈ 0.43 from its own return
 * alone, so 0.25 would have made 🟢 unreachable below ~80% sell-through
 * regardless of the house count. 0.5 leaves the HIGH band reachable while still
 * requiring the house to be nearly empty of that product: at 70% sell-through
 * it admits a house count of only ~5% of what was withdrawn.
 *
 * There is no historical demand model behind this figure — it is an operational
 * starting point, and the one number to revisit after Production UAT.
 */
export const LOW_NEXT_DAY_STOCK_TO_SOLD_RATIO_MAX = 0.5;

/** Quantities are numeric(10,3); compare at that resolution, not at float noise. */
const QUANTITY_EPSILON = 0.0005;

/**
 * Band comparison tolerance, in percentage points.
 *
 * A day whose quantities are decimals reaches a threshold through float
 * arithmetic: 35.44 + 43.73 out against 23.751 back is exactly 70.000000% in
 * decimal but 69.99999999999999 in IEEE-754. Without this, such a day is filed
 * one band worse than the rule says while the report prints "70%" next to it.
 * Far smaller than any real quantity difference, so it can only absorb noise.
 */
const RATE_EPSILON = 1e-9;

/** Quantities are numeric(10,3); carry them at that resolution, never at float noise. */
function round3(value: number): number {
  // + 0 collapses -0, which a sub-epsilon subtraction can produce.
  return Math.round(value * 1000) / 1000 + 0;
}

export type SellThroughBand = "high" | "medium" | "low";

/** Operator-facing purchasing group. */
export type PurchaseStatus = "reduce" | "surplus" | "strong" | "unknown";

/**
 * Why a product cannot be given a confident sell-through. Every one of these
 * sends the product to ⚠️ ข้อมูลไม่พอประเมิน rather than to a percentage.
 */
export type PurchaseUncertaintyReason =
  /** A withdrawal carries no accountability round id — completeness unprovable. */
  | "unattributed_round"
  /** The round's return document is blocked or still open. */
  | "return_incomplete"
  /** The round produced no return evidence of any kind. */
  | "return_missing"
  /** The round's return landed, but this product/unit cell is absent from it. */
  | "product_return_absent"
  /** A return for this product exists but carries no round, so it proves nothing. */
  | "return_not_round_tagged"
  /** A session behind this product failed to parse or persisted fewer rows than it claimed. */
  | "session_integrity"
  /** good + damaged exceeds withdrawn — the day's quantities contradict themselves. */
  | "returns_exceed_withdrawal"
  /** Return or damage recorded with no withdrawal to measure it against. */
  | "no_withdrawal"
  /** A quantity was null / non-finite / negative. */
  | "invalid_quantity"
  /** A transaction type outside the known set — it must block, never vanish. */
  | "unknown_transaction_type"
  /**
   * An unresolved เบิก whose seller/market/round cannot be proven, but whose
   * product (and maybe unit) can. Never a confident 🟢/🟠/🔴 for that identity.
   */
  | "unattributable_withdrawal";

/**
 * Narrowest uncertainty an unresolved เบิก is allowed to impose.
 *
 * Built by collectUnattributableWithdrawalScopes; applied here. A report-level
 * scope fails the whole day closed. A round/product scope must not leak onto
 * unrelated identities.
 */
export type UnattributableWithdrawalScope =
  | { kind: "report" }
  | { kind: "round"; roundId: string }
  | { kind: "product"; productName: string }
  | { kind: "product_unit"; productName: string; unit: string };

/** Why a product has no house-stock number to compare against. */
export type StockSignalAbsence =
  /** No authoritative finalized snapshot exists for the date. */
  | "no_snapshot"
  /** More than one authoritative snapshot — ambiguous, never guess. */
  | "snapshot_conflict"
  /** The snapshot read failed. */
  | "unavailable"
  /** A snapshot exists but every one of its entries was unusable. */
  | "snapshot_empty"
  /** A snapshot exists but holds no safely comparable entry for this product+unit. */
  | "no_match";

export interface PurchasePlanningItem {
  productName: string;
  unit: string;
  withdrawnQuantity: number;
  goodReturnQuantity: number;
  damagedQuantity: number;
  /** null whenever the product is uncertain — never a clamped or invented number. */
  estimatedSoldQuantity: number | null;
  /** Percent. null whenever the product is uncertain. */
  sellThroughRate: number | null;
  band: SellThroughBand | null;
  status: PurchaseStatus;
  uncertaintyReasons: PurchaseUncertaintyReason[];
  /**
   * เหลือในบ้านหลังเบิก — what the house count found for this product AFTER the
   * markets were supplied. 0 when an authoritative complete snapshot exists
   * and this canonical product is wholly absent from it. null when there is
   * no snapshot, or the product is present but no unit is safely comparable.
   */
  houseStockQuantity: number | null;
  stockAbsence: StockSignalAbsence | null;
  /**
   * ของดีพร้อมขายต่อ — house_stock_after_withdrawal + good_return, the sellable
   * stock this product starts tomorrow with. Damaged return is excluded. null
   * whenever the house side could not be matched, because the good return alone
   * is not the whole of what is left.
   */
  nextDayGoodStockQuantity: number | null;
  /** next_day_good_stock / estimated_sold_qty. null unless both are known and sold > 0. */
  nextStockToSoldRatio: number | null;
  /** Several distinct withdrawal prices for one product+unit. Never affects ranking. */
  priceConflict: boolean;
}

export interface PurchasePlanningReport {
  businessDate: string;
  items: PurchasePlanningItem[];
  /** Produce documents for the date that never landed and cannot be attributed. */
  unresolvedSessionCount: number;
  /**
   * The same unresolved documents split by their declared transaction type.
   * Presentation must use these counts instead of relabelling the day-wide
   * total as one transaction type.
   */
  unresolvedSessionCounts: UnresolvedProduceSessionCounts;
  /**
   * Set when an unresolved เบิก cannot be scoped to any product/unit/round.
   * The formatter must not emit 🟢/🟠/🔴 as trustworthy in that state.
   */
  unsafeReportReason: "unattributable_withdrawal" | null;
  /** Report-level house-stock state; per-item "no_match" is separate. */
  stockAbsence: Exclude<StockSignalAbsence, "no_match"> | null;
  /** Rows dropped because they carried no usable product+unit identity at all. */
  unidentifiedRowCount: number;
}

export interface UnresolvedProduceSessionCounts {
  withdrawal: number;
  goodReturn: number;
  damagedReturn: number;
  unknown: number;
}

/** The produce_transactions columns this report reads. */
export interface PurchaseProduceRow {
  market_name: string | null;
  product_name: string | null;
  quantity: number | null;
  unit: string | null;
  transaction_type: string;
  price_per_unit?: number | null;
  accountability_round_id?: string | null;
  /** Used only to look the row's session up in `unreliableSessionIds`. */
  session_id?: string | null;
}

/** One safely-canonicalized house-stock entry. */
export interface HouseStockEntry {
  productName: string;
  unit: string;
  quantity: number;
}

export type HouseStockSignal =
  | { status: "available"; entries: readonly HouseStockEntry[] }
  | { status: "none" }
  /** The snapshot existed but held nothing countable — not the same as no snapshot. */
  | { status: "empty" }
  | { status: "conflict" }
  | { status: "unavailable" };

export interface PurchasePlanningInput {
  businessDate: string;
  rows: readonly PurchaseProduceRow[];
  /** Per accountability round, from loadRoundReturnStatuses. */
  roundReturnStates: ReadonlyMap<string, RoundReturnState>;
  /** Rounds whose return is known to be unfinished, from the failure lifecycle. */
  incompleteReturnRounds?: ReadonlySet<string>;
  /**
   * Produce sessions whose persisted rows cannot be trusted to be all of what
   * the document said — a parser error, or fewer rows than the claimed item
   * count. Same evidence P1 Sales blocks an identity on.
   */
  unreliableSessionIds?: ReadonlySet<string>;
  /**
   * True when the day holds a still-failing return/damage document that carries
   * no round, so it cannot be blamed on any product. Such a document can only
   * ever mean MORE came back than was recorded, which inflates every sold
   * quantity — so no product may be presented as a confident 🟢 that day.
   * LOW and MEDIUM stay: an inflated sold quantity can only make a weak seller
   * look better, so a "buy less" reading is still the safe one.
   */
  hasUnattributedIncompleteReturns?: boolean;
  unresolvedSessionCount?: number;
  unresolvedSessionCounts?: UnresolvedProduceSessionCounts;
  /**
   * Unresolved เบิก documents, already reduced to the narrowest identity
   * they can prove. Empty means none of today's active เบิก failures need
   * to move a recommendation.
   */
  unattributableWithdrawalScopes?: readonly UnattributableWithdrawalScope[];
  houseStock?: HouseStockSignal;
}

/** Sentinel for "this withdrawal carries no round id". A real
 *  accountability_round_id is a uuid, so it can never equal this. */
const NO_ROUND = "no-round";

interface Cell {
  productName: string;
  unit: string;
  withdrawn: number;
  good: number;
  damaged: number;
  withdrawalRounds: Set<string>;
  /** Rounds that supplied a คืน / คืนเสีย row FOR THIS product+unit. */
  returnRounds: Set<string>;
  withdrawalPrices: Set<number>;
  reasons: Set<PurchaseUncertaintyReason>;
  sawWithdrawal: boolean;
  /** A คืน / คืนเสีย row for this cell that carries no round id. */
  sawUntaggedReturn: boolean;
}

function identityKey(productName: string, unit: string): string {
  // JSON, not a delimiter: no product name or unit can forge another pair.
  return JSON.stringify([productName, unit]);
}

/**
 * Reporting-layer canonicalization, applied identically to market rows and to
 * house-stock entries so the two can be compared without either side silently
 * merging products. Returns null when there is no usable identity.
 *
 * House capture normalizes its product only to NFC + whitespace and never
 * applies PRODUCT_ALIASES (src/lib/physical-inventory/types.ts: "never fuzzy /
 * P0 aliases / product master"), so putting BOTH sides through this one
 * function is what makes a match safe rather than coincidental.
 */
export function canonicalIdentity(
  productName: string | null | undefined,
  unit: string | null | undefined,
): { productName: string; unit: string } | null {
  const rawName = (productName ?? "").trim();
  if (!rawName) return null;
  const name = normalizeProductName(rawName, PRODUCT_ALIASES);
  if (!name) return null;
  const normalizedUnit = normalizeRemainingUnit(unit);
  if (!normalizedUnit) return null;
  return { productName: name, unit: normalizedUnit };
}

function emptyCell(productName: string, unit: string): Cell {
  return {
    productName,
    unit,
    withdrawn: 0,
    good: 0,
    damaged: 0,
    withdrawalRounds: new Set(),
    returnRounds: new Set(),
    withdrawalPrices: new Set(),
    reasons: new Set(),
    sawWithdrawal: false,
    sawUntaggedReturn: false,
  };
}

/**
 * Round-level return evidence, per withdrawal round that fed this cell.
 *
 * A round whose return document landed still does NOT prove that every product
 * it withdrew appears in that document: P4A checks containment (a return may
 * not exceed its withdrawal) but never coverage. So a cell absent from an
 * otherwise-persisted round is "no evidence about this product", not "sold
 * out" — the single rule that keeps a missing return from becoming a false 100%.
 */
function applyRoundEvidence(
  cell: Cell,
  roundReturnStates: ReadonlyMap<string, RoundReturnState>,
  incompleteReturnRounds: ReadonlySet<string>,
): void {
  for (const roundId of cell.withdrawalRounds) {
    if (roundId === NO_ROUND) {
      cell.reasons.add("unattributed_round");
      continue;
    }
    if (incompleteReturnRounds.has(roundId)) {
      cell.reasons.add("return_incomplete");
      continue;
    }
    const state = roundReturnStates.get(roundId);
    if (state === "blocked" || state === "pending") {
      cell.reasons.add("return_incomplete");
      continue;
    }
    if (state === "none") {
      cell.reasons.add("return_missing");
      continue;
    }
    if (state !== "persisted") {
      cell.reasons.add("unattributed_round");
      continue;
    }
    if (cell.returnRounds.has(roundId)) continue;
    // A return DID come back for this product, it just is not tied to the round
    // that issued it — so it still proves nothing about completeness, but
    // saying "no return found" over the top of its own quantity would be false.
    cell.reasons.add(
      cell.sawUntaggedReturn ? "return_not_round_tagged" : "product_return_absent",
    );
  }
}

export function bandFor(rate: number): SellThroughBand {
  if (rate >= HIGH_SELL_THROUGH_MIN_PERCENT - RATE_EPSILON) return "high";
  if (rate >= MEDIUM_SELL_THROUGH_MIN_PERCENT - RATE_EPSILON) return "medium";
  return "low";
}

/**
 * House stock never upgrades a result, only holds one back.
 *
 * LOW and MEDIUM are decided by the market evidence alone — the returns already
 * prove a large share did not sell. HIGH is the only band where the house count
 * is required, because "it all sold" plus "there is still a pile at home" is not
 * a buying signal, and no stock evidence at all is not proof of an empty house.
 */
function statusFor(
  band: SellThroughBand,
  nextStockToSoldRatio: number | null,
  hasUnattributedIncompleteReturns: boolean,
): PurchaseStatus {
  if (band === "low") return "reduce";
  if (band === "medium") return "surplus";
  // No comparable house count means the next-day good stock is not knowable in
  // full — the good return is only part of it — so 🟢 is not available.
  if (nextStockToSoldRatio === null) return "surplus";
  // A return document that never landed and cannot be blamed on any product
  // inflates every sold quantity on the day. That is exactly the direction a
  // confident 🟢 must not be trusted in.
  if (hasUnattributedIncompleteReturns) return "surplus";
  return nextStockToSoldRatio <= LOW_NEXT_DAY_STOCK_TO_SOLD_RATIO_MAX
    ? "strong"
    : "surplus";
}

const STATUS_ORDER: Record<PurchaseStatus, number> = {
  reduce: 0,
  surplus: 1,
  strong: 2,
  unknown: 3,
};

function byIdentity(a: PurchasePlanningItem, b: PurchasePlanningItem): number {
  return (
    a.productName.localeCompare(b.productName, "th")
    || a.unit.localeCompare(b.unit, "th")
  );
}

function compareItems(a: PurchasePlanningItem, b: PurchasePlanningItem): number {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (byStatus !== 0) return byStatus;

  if (a.status === "unknown") return byIdentity(a, b);

  const rateA = a.sellThroughRate ?? 0;
  const rateB = b.sellThroughRate ?? 0;

  if (a.status === "strong") {
    if (rateA !== rateB) return rateB - rateA;
    return byIdentity(a, b);
  }

  // reduce and surplus both lead with the weakest seller.
  if (rateA !== rateB) return rateA - rateB;

  if (a.status === "surplus") {
    // Then the biggest pile ready to sell tomorrow, when both are comparable. A
    // product with no stock evidence cannot outrank one with a proven surplus.
    const ratioA = a.nextStockToSoldRatio;
    const ratioB = b.nextStockToSoldRatio;
    if (ratioA !== null && ratioB !== null && ratioA !== ratioB) return ratioB - ratioA;
    if (ratioA !== null && ratioB === null) return -1;
    if (ratioA === null && ratioB !== null) return 1;
  }

  if (a.withdrawnQuantity !== b.withdrawnQuantity) {
    return b.withdrawnQuantity - a.withdrawnQuantity;
  }
  return byIdentity(a, b);
}

/**
 * Canonicalizes house-stock entries onto the market's identity space and sums
 * same-unit duplicates. The authoritative snapshot is a complete house count,
 * so a canonical product with no observation at all is zero. A product that
 * appears only in an incompatible unit is NOT zero — the count exists, it
 * just cannot be compared.
 */
function indexHouseStock(signal: HouseStockSignal | undefined): {
  complete: boolean;
  byKey: Map<string, number>;
  products: Set<string>;
} {
  const empty = { complete: false, byKey: new Map<string, number>(), products: new Set<string>() };
  if (!signal) return empty;
  if (signal.status === "none" || signal.status === "conflict" || signal.status === "unavailable") {
    return empty;
  }
  if (signal.status === "empty") {
    return { complete: true, byKey: new Map(), products: new Set() };
  }
  const byKey = new Map<string, number>();
  const products = new Set<string>();
  for (const entry of signal.entries) {
    const identity = canonicalIdentity(entry.productName, entry.unit);
    if (!identity) continue;
    if (!Number.isFinite(entry.quantity) || entry.quantity < 0) continue;
    products.add(identity.productName);
    const key = identityKey(identity.productName, identity.unit);
    byKey.set(key, (byKey.get(key) ?? 0) + entry.quantity);
  }
  return { complete: true, byKey, products };
}

function matchHouseStock(
  index: ReturnType<typeof indexHouseStock>,
  productName: string,
  unit: string,
): { quantity: number | null; absence: "no_match" | null } {
  if (!index.complete) return { quantity: null, absence: "no_match" };
  const key = identityKey(productName, unit);
  if (index.byKey.has(key)) return { quantity: index.byKey.get(key) ?? 0, absence: null };
  if (index.products.has(productName)) return { quantity: null, absence: "no_match" };
  return { quantity: 0, absence: null };
}

function reportStockAbsence(
  signal: HouseStockSignal | undefined,
): Exclude<StockSignalAbsence, "no_match"> | null {
  if (!signal) return "no_snapshot";
  if (signal.status === "available" || signal.status === "empty") return null;
  if (signal.status === "none") return "no_snapshot";
  if (signal.status === "conflict") return "snapshot_conflict";
  return "unavailable";
}

function indexUnattributableScopes(
  scopes: readonly UnattributableWithdrawalScope[],
): {
  reportUnsafe: boolean;
  productUnits: Set<string>;
  products: Set<string>;
  rounds: Set<string>;
} {
  const productUnits = new Set<string>();
  const products = new Set<string>();
  const rounds = new Set<string>();
  let reportUnsafe = false;
  for (const scope of scopes) {
    if (scope.kind === "report") reportUnsafe = true;
    else if (scope.kind === "product_unit") {
      productUnits.add(identityKey(scope.productName, scope.unit));
    } else if (scope.kind === "product") {
      products.add(scope.productName);
    } else {
      rounds.add(scope.roundId);
    }
  }
  return { reportUnsafe, productUnits, products, rounds };
}

function cellHitByUnattributable(
  cell: Cell,
  index: ReturnType<typeof indexUnattributableScopes>,
): boolean {
  if (index.reportUnsafe) return true;
  if (index.productUnits.has(identityKey(cell.productName, cell.unit))) return true;
  if (index.products.has(cell.productName)) return true;
  for (const roundId of cell.withdrawalRounds) {
    if (roundId !== NO_ROUND && index.rounds.has(roundId)) return true;
  }
  return false;
}

export function buildPurchasePlanningReport(
  input: PurchasePlanningInput,
): PurchasePlanningReport {
  const incompleteReturnRounds = input.incompleteReturnRounds ?? new Set<string>();
  const unreliableSessionIds = input.unreliableSessionIds ?? new Set<string>();
  const hasUnattributedIncompleteReturns = input.hasUnattributedIncompleteReturns ?? false;
  const cells = new Map<string, Cell>();
  let unidentifiedRowCount = 0;

  for (const row of input.rows) {
    if (isQaMarketLabel(normalizedMarketLabel(row.market_name))) continue;

    const identity = canonicalIdentity(row.product_name, row.unit);
    if (!identity) {
      unidentifiedRowCount += 1;
      continue;
    }

    const key = identityKey(identity.productName, identity.unit);
    const cell = cells.get(key) ?? emptyCell(identity.productName, identity.unit);
    cells.set(key, cell);

    // A session that failed to parse, or persisted fewer rows than it claimed,
    // may have dropped a return line — so its products cannot be ranked.
    if (row.session_id && unreliableSessionIds.has(row.session_id)) {
      cell.reasons.add("session_integrity");
    }

    const bucket = baseTransactionType(row.transaction_type);
    if (!bucket) {
      // Must block its identity rather than disappear from the denominator.
      cell.reasons.add("unknown_transaction_type");
      continue;
    }

    const roundId = row.accountability_round_id?.trim() || NO_ROUND;
    const quantity = row.quantity;
    const usable = typeof quantity === "number" && Number.isFinite(quantity) && quantity >= 0;
    if (!usable) cell.reasons.add("invalid_quantity");

    if (bucket === "เบิก") {
      cell.sawWithdrawal = true;
      cell.withdrawalRounds.add(roundId);
      if (usable) cell.withdrawn += quantity;
      const price = row.price_per_unit;
      if (typeof price === "number" && Number.isFinite(price)) cell.withdrawalPrices.add(price);
      continue;
    }

    if (roundId !== NO_ROUND) cell.returnRounds.add(roundId);
    else cell.sawUntaggedReturn = true;
    if (!usable) continue;
    if (bucket === "คืน") cell.good += quantity;
    else cell.damaged += quantity;
  }

  const stockIndex = indexHouseStock(input.houseStock);
  const stockAbsence = reportStockAbsence(input.houseStock);
  const unattributable = indexUnattributableScopes(
    input.unattributableWithdrawalScopes ?? [],
  );
  if (!unattributable.reportUnsafe) {
    for (const roundId of unattributable.rounds) {
      let matched = false;
      for (const cell of cells.values()) {
        if (cell.withdrawalRounds.has(roundId)) {
          matched = true;
          break;
        }
      }
      // A bound เบิก whose round has no persisted product set cannot be
      // narrowed. Poisoning nothing would leave the day looking complete.
      if (!matched) unattributable.reportUnsafe = true;
    }
  }

  const items: PurchasePlanningItem[] = [];
  for (const [, cell] of cells) {
    applyRoundEvidence(cell, input.roundReturnStates, incompleteReturnRounds);

    // Carried at the column's own numeric(10,3) resolution, so 45.9 − 35.4 is
    // 10.5 rather than 10.499999999999996. This is a resolution choice, not a
    // clamp: an impossible quantity still blocks the product below.
    const withdrawn = round3(cell.withdrawn);
    const good = round3(cell.good);
    const damaged = round3(cell.damaged);

    if (!cell.sawWithdrawal || withdrawn <= 0) cell.reasons.add("no_withdrawal");
    if (good + damaged > withdrawn + QUANTITY_EPSILON) {
      cell.reasons.add("returns_exceed_withdrawal");
    }
    if (cellHitByUnattributable(cell, unattributable)) {
      cell.reasons.add("unattributable_withdrawal");
    }

    const uncertain = cell.reasons.size > 0;
    // Guarded by the two checks above: withdrawn > 0 and returns <= withdrawn,
    // so this can be neither a division by zero nor a negative quantity. It is
    // never clamped — an impossible number blocks the product instead.
    const estimatedSold = uncertain ? null : round3(withdrawn - good - damaged);
    const rate = estimatedSold === null ? null : (estimatedSold / withdrawn) * 100;

    const matched = matchHouseStock(stockIndex, cell.productName, cell.unit);
    const houseStockQuantity = matched.quantity;
    const itemStockAbsence: StockSignalAbsence | null = stockAbsence
      ?? matched.absence;
    // The house was counted AFTER the markets were supplied and BEFORE any
    // return came back, so these two are disjoint quantities of one product and
    // add up. Damaged return is excluded: it is not sellable stock. It is not
    // subtracted either — it never entered this sum.
    const nextDayGoodStockQuantity =
      houseStockQuantity === null ? null : round3(houseStockQuantity + good);
    const nextStockToSoldRatio =
      nextDayGoodStockQuantity !== null && estimatedSold !== null && estimatedSold > 0
        ? nextDayGoodStockQuantity / estimatedSold
        : null;

    const band = rate === null ? null : bandFor(rate);
    items.push({
      productName: cell.productName,
      unit: cell.unit,
      withdrawnQuantity: withdrawn,
      goodReturnQuantity: good,
      damagedQuantity: damaged,
      estimatedSoldQuantity: estimatedSold,
      sellThroughRate: rate,
      band,
      status: band === null
        ? "unknown"
        : statusFor(band, nextStockToSoldRatio, hasUnattributedIncompleteReturns),
      uncertaintyReasons: [...cell.reasons].sort(),
      houseStockQuantity,
      stockAbsence: itemStockAbsence,
      nextDayGoodStockQuantity,
      nextStockToSoldRatio,
      priceConflict: cell.withdrawalPrices.size > 1,
    });
  }

  // A เบิก that named a product/unit the day never persisted still has to
  // appear as unknown — omitting it would look like the product was never
  // withdrawn.
  if (!unattributable.reportUnsafe) {
    for (const scope of input.unattributableWithdrawalScopes ?? []) {
      if (scope.kind !== "product_unit") continue;
      const key = identityKey(scope.productName, scope.unit);
      if (cells.has(key)) continue;
      const matched = matchHouseStock(stockIndex, scope.productName, scope.unit);
      items.push({
        productName: scope.productName,
        unit: scope.unit,
        withdrawnQuantity: 0,
        goodReturnQuantity: 0,
        damagedQuantity: 0,
        estimatedSoldQuantity: null,
        sellThroughRate: null,
        band: null,
        status: "unknown",
        uncertaintyReasons: ["unattributable_withdrawal"],
        houseStockQuantity: matched.quantity,
        stockAbsence: stockAbsence ?? matched.absence,
        nextDayGoodStockQuantity: matched.quantity === null ? null : round3(matched.quantity),
        nextStockToSoldRatio: null,
        priceConflict: false,
      });
    }
  }

  items.sort(compareItems);

  return {
    businessDate: input.businessDate,
    items,
    unresolvedSessionCount: input.unresolvedSessionCount ?? 0,
    unresolvedSessionCounts: input.unresolvedSessionCounts ?? {
      withdrawal: 0,
      goodReturn: 0,
      damagedReturn: 0,
      unknown: 0,
    },
    unsafeReportReason: unattributable.reportUnsafe ? "unattributable_withdrawal" : null,
    stockAbsence,
    unidentifiedRowCount,
  };
}
